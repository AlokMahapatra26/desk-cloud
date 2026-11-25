package deskcloud

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"
)

type httpError struct {
	Status int
	Msg    string
}

func (e *httpError) Error() string { return e.Msg }

var mimeTypes = map[string]string{
	// Video
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".webm": "video/webm",
	".mov":  "video/quicktime",
	".mkv":  "video/x-matroska",
	".avi":  "video/x-msvideo",
	".wmv":  "video/x-ms-wmv",
	".flv":  "video/x-flv",
	".ts":   "video/mp2t",
	".3gp":  "video/3gpp",
	// Audio
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
	".ogg":  "audio/ogg",
	".opus": "audio/opus",
	".wav":  "audio/wav",
	".flac": "audio/flac",
	// Images
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".avif": "image/avif",
	// Documents & Text
	".pdf":  "application/pdf",
	".txt":  "text/plain; charset=utf-8",
	".md":   "text/markdown; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".csv":  "text/csv; charset=utf-8",
	".log":  "text/plain; charset=utf-8",
	".srt":  "text/plain; charset=utf-8",
	".vtt":  "text/vtt; charset=utf-8",
	".xml":  "application/xml; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".js":   "application/javascript; charset=utf-8",
	// Archives
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz":  "application/gzip",
	".7z":  "application/x-7z-compressed",
	".rar": "application/vnd.rar",
}

var (
	videoExts = map[string]bool{".mp4": true, ".m4v": true, ".webm": true, ".mov": true, ".mkv": true, ".avi": true, ".wmv": true, ".flv": true, ".ts": true, ".3gp": true}
	audioExts = map[string]bool{".mp3": true, ".m4a": true, ".aac": true, ".ogg": true, ".opus": true, ".wav": true, ".flac": true}
	imageExts = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".svg": true, ".bmp": true, ".avif": true}
	docExts   = map[string]bool{".pdf": true, ".txt": true, ".md": true, ".json": true, ".csv": true, ".log": true, ".srt": true, ".vtt": true, ".xml": true}
)

func GetMimeType(filePath string) string {
	ext := strings.ToLower(filepath.Ext(filePath))
	if m, ok := mimeTypes[ext]; ok {
		return m
	}
	return "application/octet-stream"
}

func GetMediaCategory(name string, isDir bool) string {
	if isDir {
		return "folder"
	}
	ext := strings.ToLower(filepath.Ext(name))
	if videoExts[ext] {
		return "video"
	}
	if audioExts[ext] {
		return "audio"
	}
	if imageExts[ext] {
		return "image"
	}
	if docExts[ext] {
		return "doc"
	}
	return "file"
}

func isInsideRoot(rootPath, candidatePath string) bool {
	rel, err := filepath.Rel(rootPath, candidatePath)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

func normalizeRelativeSegments(relPath string) ([]string, error) {
	raw := strings.TrimSpace(strings.ReplaceAll(relPath, "\\", "/"))
	if raw == "" || raw == "/" {
		return nil, nil
	}
	parts := strings.Split(raw, "/")
	var segments []string
	for _, seg := range parts {
		if seg == "" {
			continue
		}
		if seg == "." || seg == ".." {
			return nil, &httpError{Status: http.StatusBadRequest, Msg: "Invalid path segment"}
		}
		segments = append(segments, seg)
	}
	return segments, nil
}

type resolvedPath struct {
	Root     Root
	AbsPath  string
	RelPath  string
	Segments []string
}

func ResolveSafePath(roots []Root, rootID, relPath string, mustExist bool) (*resolvedPath, error) {
	if len(roots) == 0 {
		return nil, &httpError{Status: http.StatusBadRequest, Msg: "Invalid storage root"}
	}
	root := roots[0]
	for _, r := range roots {
		if r.ID == rootID {
			root = r
			break
		}
	}

	segments, err := normalizeRelativeSegments(relPath)
	if err != nil {
		return nil, err
	}

	parts := append([]string{root.Path}, segments...)
	joined := filepath.Clean(filepath.Join(parts...))
	if !isInsideRoot(root.Path, joined) {
		return nil, &httpError{Status: http.StatusForbidden, Msg: "Path escapes storage root"}
	}

	if mustExist {
		realPath, err := filepath.EvalSymlinks(joined)
		if err != nil {
			return nil, &httpError{Status: http.StatusNotFound, Msg: "Path not found"}
		}
		if !isInsideRoot(root.Path, realPath) {
			return nil, &httpError{Status: http.StatusForbidden, Msg: "Symlink escapes storage root"}
		}
		return &resolvedPath{
			Root:     root,
			AbsPath:  realPath,
			RelPath:  strings.Join(segments, "/"),
			Segments: segments,
		}, nil
	}

	parentDir := filepath.Dir(joined)
	realParent, err := filepath.EvalSymlinks(parentDir)
	if err != nil {
		return nil, &httpError{Status: http.StatusNotFound, Msg: "Parent directory not found"}
	}
	if !isInsideRoot(root.Path, realParent) {
		return nil, &httpError{Status: http.StatusForbidden, Msg: "Parent path escapes storage root"}
	}

	return &resolvedPath{
		Root:     root,
		AbsPath:  filepath.Join(realParent, filepath.Base(joined)),
		RelPath:  strings.Join(segments, "/"),
		Segments: segments,
	}, nil
}

func naturalLess(a, b string) bool {
	al := strings.ToLower(a)
	bl := strings.ToLower(b)
	ia, ib := 0, 0
	for ia < len(al) && ib < len(bl) {
		ca, cb := rune(al[ia]), rune(bl[ib])
		if unicode.IsDigit(ca) && unicode.IsDigit(cb) {
			ja, jb := ia, ib
			for ja < len(al) && unicode.IsDigit(rune(al[ja])) {
				ja++
			}
			for jb < len(bl) && unicode.IsDigit(rune(bl[jb])) {
				jb++
			}
			na, _ := strconv.Atoi(al[ia:ja])
			nb, _ := strconv.Atoi(bl[ib:jb])
			if na != nb {
				return na < nb
			}
			ia, ib = ja, jb
			continue
		}
		if ca != cb {
			return ca < cb
		}
		ia++
		ib++
	}
	return len(al) < len(bl)
}

type FileEntry struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	IsDir    bool    `json:"isDir"`
	Category string  `json:"category"`
	Size     int64   `json:"size"`
	Mtime    float64 `json:"mtime"`
	Mime     string  `json:"mime"`
}

type Breadcrumb struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type ListResponse struct {
	Root        *RootInfo    `json:"root"`
	Roots       []RootInfo   `json:"roots"`
	Path        string       `json:"path"`
	Breadcrumbs []Breadcrumb `json:"breadcrumbs"`
	Items       []FileEntry  `json:"items"`
	Total       int          `json:"total"`
	Page        int          `json:"page"`
	Limit       int          `json:"limit"`
	TotalPages  int          `json:"totalPages"`
}

func ListDirectory(roots []Root, q url.Values) (*ListResponse, error) {
	rootID := q.Get("root")
	if rootID == "" {
		rootID = "0"
	}
	relPath := q.Get("path")
	search := strings.ToLower(strings.TrimSpace(q.Get("search")))
	typeFilter := q.Get("type")
	if typeFilter == "" {
		typeFilter = "all"
	}
	sortBy := q.Get("sort")
	if sortBy == "" {
		sortBy = "name"
	}
	order := q.Get("order")
	if order == "" {
		order = "asc"
	}
	pageNum := 1
	if p, err := strconv.Atoi(q.Get("page")); err == nil && p >= 1 {
		pageNum = p
	}
	limitNum := 100
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l >= 1 {
		if l > 500 {
			limitNum = 500
		} else {
			limitNum = l
		}
	}

	resolved, err := ResolveSafePath(roots, rootID, relPath, true)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(resolved.AbsPath)
	if err != nil || !info.IsDir() {
		return nil, &httpError{Status: http.StatusBadRequest, Msg: "Target is not a directory"}
	}

	dirents, err := os.ReadDir(resolved.AbsPath)
	if err != nil {
		return nil, err
	}

	var preFiltered []os.DirEntry
	for _, d := range dirents {
		name := d.Name()
		if search != "" && !strings.Contains(strings.ToLower(name), search) {
			continue
		}
		if typeFilter != "all" {
			cat := GetMediaCategory(name, d.IsDir())
			if cat != typeFilter && !(typeFilter == "folder" && d.IsDir()) {
				continue
			}
		}
		preFiltered = append(preFiltered, d)
	}

	validEntries := make([]FileEntry, 0, len(preFiltered))
	for _, d := range preFiltered {
		fullPath := filepath.Join(resolved.AbsPath, d.Name())
		st, err := os.Stat(fullPath)
		if err != nil {
			continue
		}
		isDir := st.IsDir()
		itemRel := d.Name()
		if resolved.RelPath != "" {
			itemRel = resolved.RelPath + "/" + d.Name()
		}
		size := int64(0)
		mime := "inode/directory"
		if !isDir {
			size = st.Size()
			mime = GetMimeType(d.Name())
		}
		validEntries = append(validEntries, FileEntry{
			Name:     d.Name(),
			Path:     itemRel,
			IsDir:    isDir,
			Category: GetMediaCategory(d.Name(), isDir),
			Size:     size,
			Mtime:    float64(st.ModTime().UnixMilli()),
			Mime:     mime,
		})
	}

	desc := order == "desc"
	sort.Slice(validEntries, func(i, j int) bool {
		a, b := validEntries[i], validEntries[j]
		if a.IsDir != b.IsDir {
			return a.IsDir
		}
		var less bool
		switch sortBy {
		case "size":
			if a.Size == b.Size {
				less = naturalLess(a.Name, b.Name)
			} else {
				less = a.Size < b.Size
			}
		case "mtime":
			if a.Mtime == b.Mtime {
				less = naturalLess(a.Name, b.Name)
			} else {
				less = a.Mtime < b.Mtime
			}
		case "type":
			if a.Category == b.Category {
				less = naturalLess(a.Name, b.Name)
			} else {
				less = a.Category < b.Category
			}
		default:
			less = naturalLess(a.Name, b.Name)
		}
		if desc {
			return !less
		}
		return less
	})

	total := len(validEntries)
	totalPages := (total + limitNum - 1) / limitNum
	if totalPages < 1 {
		totalPages = 1
	}
	safePage := pageNum
	if safePage > totalPages {
		safePage = totalPages
	}
	startIdx := (safePage - 1) * limitNum
	endIdx := startIdx + limitNum
	if endIdx > total {
		endIdx = total
	}
	items := validEntries[startIdx:endIdx]
	if items == nil {
		items = []FileEntry{}
	}

	breadcrumbs := []Breadcrumb{{Name: resolved.Root.Name, Path: ""}}
	acc := ""
	for _, seg := range resolved.Segments {
		if acc == "" {
			acc = seg
		} else {
			acc = acc + "/" + seg
		}
		breadcrumbs = append(breadcrumbs, Breadcrumb{Name: seg, Path: acc})
	}

	rootInfos := make([]RootInfo, 0, len(roots))
	for _, r := range roots {
		rootInfos = append(rootInfos, RootInfo{ID: r.ID, Name: r.Name})
	}

	return &ListResponse{
		Root:        &RootInfo{ID: resolved.Root.ID, Name: resolved.Root.Name},
		Roots:       rootInfos,
		Path:        resolved.RelPath,
		Breadcrumbs: breadcrumbs,
		Items:       items,
		Total:       total,
		Page:        safePage,
		Limit:       limitNum,
		TotalPages:  totalPages,
	}, nil
}

func StreamFile(w http.ResponseWriter, r *http.Request, roots []Root, q url.Values, download bool) error {
	rootID := q.Get("root")
	if rootID == "" {
		rootID = "0"
	}
	resolved, err := ResolveSafePath(roots, rootID, q.Get("path"), true)
	if err != nil {
		return err
	}
	f, err := os.Open(resolved.AbsPath)
	if err != nil {
		return err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.IsDir() {
		return &httpError{Status: http.StatusBadRequest, Msg: "Target is not a file"}
	}

	disposition := "inline"
	if download {
		disposition = "attachment"
	}
	filename := filepath.Base(resolved.AbsPath)
	encodedName := strings.ReplaceAll(url.PathEscape(filename), "*", "%2A")

	w.Header().Set("Content-Type", GetMimeType(resolved.AbsPath))
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disposition, encodedName))
	w.Header().Set("Cache-Control", "private, max-age=3600")

	http.ServeContent(w, r, filename, st.ModTime(), f)
	return nil
}

// --- Chunked Upload Manager ---

type uploadSession struct {
	uploadID    string
	sessionDir  string
	targetPath  string
	totalChunks int
	totalSize   int64
	received    map[int]bool
}

type UploadManager struct {
	tempRoot string
	mu       sync.Mutex
	sessions map[string]*uploadSession
}

func NewUploadManager() *UploadManager {
	return &UploadManager{
		tempRoot: filepath.Join(os.TempDir(), "storage-server-uploads"),
		sessions: make(map[string]*uploadSession),
	}
}

func validateEntryName(name, label string) error {
	if name == "" || strings.Contains(name, "/") || strings.Contains(name, "\\") || name == "." || name == ".." {
		return &httpError{Status: http.StatusBadRequest, Msg: "Invalid " + label}
	}
	return nil
}

func (u *UploadManager) InitUpload(roots []Root, rootID, dirPath, filename string, totalChunks int, totalSize int64) (string, error) {
	if err := validateEntryName(filename, "filename"); err != nil {
		return "", err
	}
	if rootID == "" {
		rootID = "0"
	}
	targetRel := filename
	if dirPath != "" {
		targetRel = dirPath + "/" + filename
	}
	resolved, err := ResolveSafePath(roots, rootID, targetRel, false)
	if err != nil {
		return "", err
	}
	if totalChunks < 1 || totalChunks > 100000 {
		return "", &httpError{Status: http.StatusBadRequest, Msg: "Invalid totalChunks"}
	}

	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	uploadID := hex.EncodeToString(b)
	sessionDir := filepath.Join(u.tempRoot, uploadID)
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		return "", err
	}

	u.mu.Lock()
	u.sessions[uploadID] = &uploadSession{
		uploadID:    uploadID,
		sessionDir:  sessionDir,
		targetPath:  resolved.AbsPath,
		totalChunks: totalChunks,
		totalSize:   totalSize,
		received:    make(map[int]bool),
	}
	u.mu.Unlock()

	return uploadID, nil
}

func (u *UploadManager) ReceiveChunk(r *http.Request, uploadID string, idx int) (int, int, error) {
	u.mu.Lock()
	sess, ok := u.sessions[uploadID]
	u.mu.Unlock()
	if !ok {
		return 0, 0, &httpError{Status: http.StatusNotFound, Msg: "Upload session not found"}
	}
	if idx < 0 || idx >= sess.totalChunks {
		return 0, 0, &httpError{Status: http.StatusBadRequest, Msg: "Invalid chunk index"}
	}

	chunkPath := filepath.Join(sess.sessionDir, fmt.Sprintf("chunk_%d", idx))
	f, err := os.Create(chunkPath)
	if err != nil {
		return 0, 0, err
	}
	_, copyErr := io.Copy(f, r.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return 0, 0, copyErr
	}
	if closeErr != nil {
		return 0, 0, closeErr
	}

	u.mu.Lock()
	sess.received[idx] = true
	rec := len(sess.received)
	tot := sess.totalChunks
	u.mu.Unlock()

	return rec, tot, nil
}

func (u *UploadManager) CompleteUpload(uploadID string) error {
	u.mu.Lock()
	sess, ok := u.sessions[uploadID]
	if ok {
		delete(u.sessions, uploadID)
	}
	u.mu.Unlock()
	if !ok {
		return &httpError{Status: http.StatusNotFound, Msg: "Upload session not found"}
	}
	defer os.RemoveAll(sess.sessionDir)

	if len(sess.received) != sess.totalChunks {
		return &httpError{Status: http.StatusBadRequest, Msg: fmt.Sprintf("Missing chunks (%d/%d)", len(sess.received), sess.totalChunks)}
	}

	partTarget := fmt.Sprintf("%s.part-%s", sess.targetPath, uploadID)
	out, err := os.Create(partTarget)
	if err != nil {
		return err
	}
	for i := 0; i < sess.totalChunks; i++ {
		chunkPath := filepath.Join(sess.sessionDir, fmt.Sprintf("chunk_%d", i))
		in, err := os.Open(chunkPath)
		if err != nil {
			out.Close()
			os.Remove(partTarget)
			return err
		}
		_, copyErr := io.Copy(out, in)
		in.Close()
		if copyErr != nil {
			out.Close()
			os.Remove(partTarget)
			return copyErr
		}
	}
	if err := out.Close(); err != nil {
		os.Remove(partTarget)
		return err
	}
	if err := os.Rename(partTarget, sess.targetPath); err != nil {
		os.Remove(partTarget)
		return err
	}
	return nil
}

func (u *UploadManager) CancelUpload(uploadID string) {
	u.mu.Lock()
	sess, ok := u.sessions[uploadID]
	if ok {
		delete(u.sessions, uploadID)
	}
	u.mu.Unlock()
	if ok {
		_ = os.RemoveAll(sess.sessionDir)
	}
}

func CreateFolder(roots []Root, rootID, dirPath, name string) (string, error) {
	if err := validateEntryName(name, "folder name"); err != nil {
		return "", err
	}
	if rootID == "" {
		rootID = "0"
	}
	targetRel := name
	if dirPath != "" {
		targetRel = dirPath + "/" + name
	}
	resolved, err := ResolveSafePath(roots, rootID, targetRel, false)
	if err != nil {
		return "", err
	}
	if err := os.Mkdir(resolved.AbsPath, 0o755); err != nil {
		if errors.Is(err, os.ErrExist) {
			return "", &httpError{Status: http.StatusConflict, Msg: "Folder already exists"}
		}
		return "", err
	}
	return resolved.RelPath, nil
}

func RenameItem(roots []Root, rootID, oldRelPath, newName string) (string, error) {
	if err := validateEntryName(newName, "new name"); err != nil {
		return "", err
	}
	if rootID == "" {
		rootID = "0"
	}
	oldResolved, err := ResolveSafePath(roots, rootID, oldRelPath, true)
	if err != nil {
		return "", err
	}
	if oldResolved.RelPath == "" {
		return "", &httpError{Status: http.StatusBadRequest, Msg: "Cannot rename root directory"}
	}
	newRel := newName
	if len(oldResolved.Segments) > 1 {
		newRel = strings.Join(oldResolved.Segments[:len(oldResolved.Segments)-1], "/") + "/" + newName
	}
	newResolved, err := ResolveSafePath(roots, rootID, newRel, false)
	if err != nil {
		return "", err
	}
	if err := os.Rename(oldResolved.AbsPath, newResolved.AbsPath); err != nil {
		return "", err
	}
	return newResolved.RelPath, nil
}

func DeleteItem(roots []Root, rootID, targetRel string) error {
	if rootID == "" {
		rootID = "0"
	}
	resolved, err := ResolveSafePath(roots, rootID, targetRel, true)
	if err != nil {
		return err
	}
	if resolved.RelPath == "" {
		return &httpError{Status: http.StatusBadRequest, Msg: "Cannot delete root directory"}
	}
	return os.RemoveAll(resolved.AbsPath)
}
