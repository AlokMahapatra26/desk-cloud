package deskcloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	thumbSem      = make(chan struct{}, 4)
	ffmpegOnce    sync.Once
	ffmpegBinPath string
)

func getFfmpeg() string {
	ffmpegOnce.Do(func() {
		if p, err := exec.LookPath("ffmpeg"); err == nil {
			ffmpegBinPath = p
		}
	})
	return ffmpegBinPath
}

func thumbCacheDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".storage-server", "thumbs")
}

func downscaleNearestBilinear(src image.Image, maxW int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= maxW || sw <= 0 || sh <= 0 {
		return src
	}
	nw := maxW
	nh := (sh * nw) / sw
	if nh < 1 {
		nh = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))

	switch s := src.(type) {
	case *image.YCbCr:
		for y := 0; y < nh; y++ {
			sy := b.Min.Y + (y*sh)/nh
			dyOff := y * dst.Stride
			for x := 0; x < nw; x++ {
				sx := b.Min.X + (x*sw)/nw
				yi := s.YOffset(sx, sy)
				ci := s.COffset(sx, sy)
				r, g, bl := color.YCbCrToRGB(s.Y[yi], s.Cb[ci], s.Cr[ci])
				di := dyOff + x*4
				dst.Pix[di] = r
				dst.Pix[di+1] = g
				dst.Pix[di+2] = bl
				dst.Pix[di+3] = 255
			}
		}
	case *image.RGBA:
		for y := 0; y < nh; y++ {
			sy := b.Min.Y + (y*sh)/nh
			dyOff := y * dst.Stride
			for x := 0; x < nw; x++ {
				sx := b.Min.X + (x*sw)/nw
				si := s.PixOffset(sx, sy)
				di := dyOff + x*4
				copy(dst.Pix[di:di+4], s.Pix[si:si+4])
			}
		}
	case *image.NRGBA:
		for y := 0; y < nh; y++ {
			sy := b.Min.Y + (y*sh)/nh
			dyOff := y * dst.Stride
			for x := 0; x < nw; x++ {
				sx := b.Min.X + (x*sw)/nw
				si := s.PixOffset(sx, sy)
				di := dyOff + x*4
				copy(dst.Pix[di:di+4], s.Pix[si:si+4])
			}
		}
	default:
		for y := 0; y < nh; y++ {
			sy := b.Min.Y + (y*sh)/nh
			for x := 0; x < nw; x++ {
				sx := b.Min.X + (x*sw)/nw
				dst.Set(x, y, src.At(sx, sy))
			}
		}
	}
	return dst
}

func generateGoImageThumb(absPath, outPath string) bool {
	f, err := os.Open(absPath)
	if err != nil {
		return false
	}
	defer f.Close()

	img, _, err := image.Decode(f)
	if err != nil {
		return false
	}
	resized := downscaleNearestBilinear(img, 320)
	tmpPath := fmt.Sprintf("%s.%d.tmp.jpg", outPath, time.Now().UnixNano())
	out, err := os.Create(tmpPath)
	if err != nil {
		return false
	}
	err = jpeg.Encode(out, resized, &jpeg.Options{Quality: 76})
	out.Close()
	if err != nil {
		_ = os.Remove(tmpPath)
		return false
	}
	if err := os.Rename(tmpPath, outPath); err != nil {
		_ = os.Remove(tmpPath)
		return false
	}
	return true
}

func generateFfmpegThumb(absPath, outPath string, isVideo bool) bool {
	ff := getFfmpeg()
	if ff == "" {
		return false
	}
	tmpPath := fmt.Sprintf("%s.%d.tmp.jpg", outPath, time.Now().UnixNano())
	run := func(args ...string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, ff, args...).Run()
	}

	var err error
	if isVideo {
		err = run("-y", "-ss", "00:00:01", "-i", absPath, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "6", tmpPath)
		if err != nil {
			err = run("-y", "-i", absPath, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "6", tmpPath)
		}
	} else {
		err = run("-y", "-i", absPath, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "6", tmpPath)
	}
	if err != nil {
		_ = os.Remove(tmpPath)
		return false
	}
	if err := os.Rename(tmpPath, outPath); err != nil {
		_ = os.Remove(tmpPath)
		return false
	}
	return true
}

func ServeThumbnail(w http.ResponseWriter, r *http.Request, roots []Root, q url.Values) error {
	rootID := q.Get("root")
	if rootID == "" {
		rootID = "0"
	}
	resolved, err := ResolveSafePath(roots, rootID, q.Get("path"), true)
	if err != nil {
		return err
	}
	st, err := os.Stat(resolved.AbsPath)
	if err != nil || st.IsDir() {
		w.WriteHeader(http.StatusNotFound)
		return nil
	}

	mime := GetMimeType(resolved.AbsPath)
	isVideo := strings.HasPrefix(mime, "video/")
	isImage := strings.HasPrefix(mime, "image/")
	if !isVideo && !isImage {
		w.WriteHeader(http.StatusNotFound)
		return nil
	}

	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%d", resolved.AbsPath, st.ModTime().UnixMilli(), st.Size())))
	key := hex.EncodeToString(sum[:])
	dir := thumbCacheDir()
	outPath := filepath.Join(dir, key+".jpg")

	if _, err := os.Stat(outPath); err != nil {
		_ = os.MkdirAll(dir, 0o755)
		thumbSem <- struct{}{}
		_, statErr := os.Stat(outPath)
		if statErr != nil {
			if isImage {
				if !generateGoImageThumb(resolved.AbsPath, outPath) {
					_ = generateFfmpegThumb(resolved.AbsPath, outPath, false)
				}
			} else {
				_ = generateFfmpegThumb(resolved.AbsPath, outPath, true)
			}
		}
		<-thumbSem
	}

	if _, err := os.Stat(outPath); err == nil {
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		http.ServeFile(w, r, outPath)
		return nil
	}

	if isImage && st.Size() <= 1500*1024 {
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "private, max-age=86400")
		http.ServeFile(w, r, resolved.AbsPath)
		return nil
	}

	w.WriteHeader(http.StatusNotFound)
	return nil
}

