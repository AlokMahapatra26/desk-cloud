package deskcloud

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"
)

var tryCloudflareRe = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

type TunnelStatus struct {
	Status string  `json:"status"`
	URL    *string `json:"url"`
	Error  *string `json:"error"`
}

type TunnelManager interface {
	GetStatus() TunnelStatus
	Start() (TunnelStatus, error)
	Stop() (TunnelStatus, error)
}

func GetDownloadAsset(platform, arch string) (file string, archive bool, err error) {
	switch platform {
	case "linux":
		switch arch {
		case "amd64", "x64":
			return "cloudflared-linux-amd64", false, nil
		case "arm64":
			return "cloudflared-linux-arm64", false, nil
		case "arm":
			return "cloudflared-linux-arm", false, nil
		}
	case "windows", "win32":
		switch arch {
		case "amd64", "x64":
			return "cloudflared-windows-amd64.exe", false, nil
		case "386", "ia32":
			return "cloudflared-windows-386.exe", false, nil
		}
	case "darwin":
		switch arch {
		case "amd64", "x64":
			return "cloudflared-darwin-amd64.tgz", true, nil
		case "arm64":
			return "cloudflared-darwin-arm64.tgz", true, nil
		}
	}
	return "", false, fmt.Errorf("unsupported platform/arch for auto-download: %s/%s", platform, arch)
}

func isExecutable(binPath string) bool {
	cmd := exec.Command(binPath, "--version")
	return cmd.Run() == nil
}

func EnsureCloudflaredBinary() (string, error) {
	if path, err := exec.LookPath("cloudflared"); err == nil && isExecutable(path) {
		return path, nil
	}

	home, _ := os.UserHomeDir()
	targetDir := filepath.Join(home, ".storage-server", "bin")
	exeName := "cloudflared"
	if runtime.GOOS == "windows" {
		exeName = "cloudflared.exe"
	}
	localBin := filepath.Join(targetDir, exeName)
	if isExecutable(localBin) {
		return localBin, nil
	}

	file, archive, err := GetDownloadAsset(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	dlURL := "https://github.com/cloudflare/cloudflared/releases/latest/download/" + file

	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return "", err
	}

	resp, err := http.Get(dlURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("failed to download cloudflared (%s)", resp.Status)
	}

	if archive {
		tgzPath := filepath.Join(targetDir, file)
		out, err := os.Create(tgzPath)
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(out, resp.Body)
		out.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if err := exec.Command("tar", "-xzf", tgzPath, "-C", targetDir).Run(); err != nil {
			return "", err
		}
		_ = os.Remove(tgzPath)
	} else {
		out, err := os.Create(localBin)
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(out, resp.Body)
		out.Close()
		if copyErr != nil {
			return "", copyErr
		}
	}

	if runtime.GOOS != "windows" {
		_ = os.Chmod(localBin, 0o755)
	}
	return localBin, nil
}

type DefaultTunnelManager struct {
	getPort func() int
	mu      sync.Mutex
	cmd     *exec.Cmd
	state   TunnelStatus
}

func NewTunnelManager(getPort func() int) *DefaultTunnelManager {
	return &DefaultTunnelManager{
		getPort: getPort,
		state:   TunnelStatus{Status: "stopped"},
	}
}

func (t *DefaultTunnelManager) GetStatus() TunnelStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

func (t *DefaultTunnelManager) Start() (TunnelStatus, error) {
	t.mu.Lock()
	if t.state.Status == "running" {
		st := t.state
		t.mu.Unlock()
		return st, nil
	}
	t.state = TunnelStatus{Status: "starting"}
	t.mu.Unlock()

	bin, err := EnsureCloudflaredBinary()
	if err != nil {
		msg := err.Error()
		t.mu.Lock()
		t.state = TunnelStatus{Status: "error", Error: &msg}
		t.mu.Unlock()
		return t.GetStatus(), err
	}

	port := 8080
	if t.getPort != nil {
		port = t.getPort()
	}

	cmd := exec.Command(bin, "tunnel", "--url", fmt.Sprintf("http://127.0.0.1:%d", port), "--no-autoupdate")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return t.GetStatus(), err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return t.GetStatus(), err
	}
	if err := cmd.Start(); err != nil {
		msg := err.Error()
		t.mu.Lock()
		t.state = TunnelStatus{Status: "error", Error: &msg}
		t.mu.Unlock()
		return t.GetStatus(), err
	}

	t.mu.Lock()
	t.cmd = cmd
	t.mu.Unlock()

	urlCh := make(chan string, 1)
	scanPipe := func(r io.Reader) {
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				if match := tryCloudflareRe.FindString(string(buf[:n])); match != "" {
					select {
					case urlCh <- match:
					default:
					}
				}
			}
			if err != nil {
				return
			}
		}
	}
	go scanPipe(stdout)
	go scanPipe(stderr)

	doneCh := make(chan error, 1)
	go func() {
		doneCh <- cmd.Wait()
	}()

	select {
	case foundURL := <-urlCh:
		t.mu.Lock()
		t.state = TunnelStatus{Status: "running", URL: &foundURL}
		t.mu.Unlock()
		go func() {
			<-doneCh
			t.mu.Lock()
			if t.cmd == cmd {
				t.cmd = nil
				if t.state.Status == "running" {
					t.state = TunnelStatus{Status: "stopped"}
				}
			}
			t.mu.Unlock()
		}()
		return t.GetStatus(), nil
	case waitErr := <-doneCh:
		if waitErr == nil {
			waitErr = fmt.Errorf("cloudflared exited unexpectedly")
		}
		msg := waitErr.Error()
		t.mu.Lock()
		if t.cmd == cmd {
			t.cmd = nil
		}
		t.state = TunnelStatus{Status: "error", Error: &msg}
		t.mu.Unlock()
		return t.GetStatus(), waitErr
	case <-time.After(30 * time.Second):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		err := fmt.Errorf("timed out waiting for Cloudflare Tunnel URL")
		msg := err.Error()
		t.mu.Lock()
		t.state = TunnelStatus{Status: "error", Error: &msg}
		t.mu.Unlock()
		return t.GetStatus(), err
	}
}

func (t *DefaultTunnelManager) Stop() (TunnelStatus, error) {
	t.mu.Lock()
	cmd := t.cmd
	t.cmd = nil
	t.state = TunnelStatus{Status: "stopped"}
	t.mu.Unlock()

	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	return t.GetStatus(), nil
}

