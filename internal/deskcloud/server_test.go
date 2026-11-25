package deskcloud

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type testEnv struct {
	tmpDir    string
	rootsFile string
	server    *httptest.Server
}

func newTestEnv(t *testing.T, readonly, allowPower, omitDir bool, tm TunnelManager, pr PowerRunner) *testEnv {
	t.Helper()
	tmpDir := t.TempDir()
	rootsFile := filepath.Join(tmpDir, "roots.json")
	args := []string{"--port", "0", "--host", "127.0.0.1", "--password", "test-pass", "--roots-file", rootsFile}
	if !omitDir {
		args = append(args, "--dir", tmpDir)
	}
	if readonly {
		args = append(args, "--readonly")
	}
	if allowPower {
		args = append(args, "--allow-power")
	}

	cfg, err := ParseConfig(args, map[string]string{})
	if err != nil {
		t.Fatalf("ParseConfig failed: %v", err)
	}
	handler := NewHandler(cfg, ServerOptions{
		TunnelManager: tm,
		PowerRunner:   pr,
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	return &testEnv{
		tmpDir:    tmpDir,
		rootsFile: rootsFile,
		server:    srv,
	}
}

func loginTest(t *testing.T, baseURL, password string) (*http.Response, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"password": password})
	resp, err := http.Post(baseURL+"/api/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("login request failed: %v", err)
	}
	var cookie string
	for _, c := range resp.Cookies() {
		if c.Name == CookieName {
			cookie = c.Name + "=" + c.Value
		}
	}
	return resp, cookie
}

func doReq(t *testing.T, method, url, cookie string, body io.Reader, contentType string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatalf("NewRequest failed: %v", err)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do failed: %v", err)
	}
	return resp
}

func TestAuthAndLogout(t *testing.T) {
	env := newTestEnv(t, false, false, false, nil, nil)

	unauth, err := http.Get(env.server.URL + "/api/list")
	if err != nil {
		t.Fatal(err)
	}
	unauth.Body.Close()
	if unauth.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", unauth.StatusCode)
	}

	bad, _ := loginTest(t, env.server.URL, "wrong")
	bad.Body.Close()
	if bad.StatusCode != 401 {
		t.Fatalf("expected 401 on wrong pass, got %d", bad.StatusCode)
	}

	good, cookie := loginTest(t, env.server.URL, "test-pass")
	good.Body.Close()
	if good.StatusCode != 200 || cookie == "" {
		t.Fatalf("expected 200 and session cookie, got %d (%q)", good.StatusCode, cookie)
	}

	authed := doReq(t, http.MethodGet, env.server.URL+"/api/list", cookie, nil, "")
	authed.Body.Close()
	if authed.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", authed.StatusCode)
	}

	logout := doReq(t, http.MethodPost, env.server.URL+"/api/auth/logout", cookie, nil, "")
	logout.Body.Close()
	if logout.StatusCode != 200 {
		t.Fatalf("expected 200 on logout, got %d", logout.StatusCode)
	}
}

func TestPaginationSearchAndRangeStreaming(t *testing.T) {
	env := newTestEnv(t, false, false, false, nil, nil)
	for i := 0; i < 120; i++ {
		ext := ".txt"
		if i%2 == 0 {
			ext = ".mp4"
		}
		_ = os.WriteFile(filepath.Join(env.tmpDir, fmt.Sprintf("item_%03d%s", i, ext)), []byte("0123456789abcdef"), 0o644)
	}

	_, cookie := loginTest(t, env.server.URL, "test-pass")
	resp := doReq(t, http.MethodGet, env.server.URL+"/api/list?type=video&page=1&limit=50", cookie, nil, "")
	defer resp.Body.Close()
	var list ListResponse
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if list.Total != 60 || len(list.Items) != 50 {
		t.Fatalf("expected total=60 items=50, got total=%d items=%d", list.Total, len(list.Items))
	}

	// Range request
	req, _ := http.NewRequest(http.MethodGet, env.server.URL+"/api/stream?path=item_000.mp4", nil)
	req.Header.Set("Cookie", cookie)
	req.Header.Set("Range", "bytes=0-4")
	rResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer rResp.Body.Close()
	if rResp.StatusCode != 206 {
		t.Fatalf("expected 206, got %d", rResp.StatusCode)
	}
	chunk, _ := io.ReadAll(rResp.Body)
	if string(chunk) != "01234" {
		t.Fatalf("expected 01234, got %q", string(chunk))
	}

	// Path traversal blocked
	trav := doReq(t, http.MethodGet, env.server.URL+"/api/stream?path=../../etc/passwd", cookie, nil, "")
	trav.Body.Close()
	if trav.StatusCode != 400 && trav.StatusCode != 403 {
		t.Fatalf("expected 400/403 on path traversal, got %d", trav.StatusCode)
	}
}

func TestChunkedUploadMkdirRenameDeleteAndReadonly(t *testing.T) {
	env := newTestEnv(t, false, false, false, nil, nil)
	_, cookie := loginTest(t, env.server.URL, "test-pass")

	mk := doReq(t, http.MethodPost, env.server.URL+"/api/mkdir", cookie, strings.NewReader(`{"name":"Movies"}`), "application/json")
	mk.Body.Close()
	if mk.StatusCode != 200 {
		t.Fatalf("mkdir failed: %d", mk.StatusCode)
	}

	initRes := doReq(t, http.MethodPost, env.server.URL+"/api/upload/init", cookie, strings.NewReader(`{"path":"Movies","filename":"clip.txt","totalChunks":2,"totalSize":11}`), "application/json")
	var initData struct {
		UploadID string `json:"uploadId"`
	}
	_ = json.NewDecoder(initRes.Body).Decode(&initData)
	initRes.Body.Close()

	c0 := doReq(t, http.MethodPost, fmt.Sprintf("%s/api/upload/chunk?uploadId=%s&index=0", env.server.URL, initData.UploadID), cookie, strings.NewReader("hello "), "application/octet-stream")
	c0.Body.Close()
	c1 := doReq(t, http.MethodPost, fmt.Sprintf("%s/api/upload/chunk?uploadId=%s&index=1", env.server.URL, initData.UploadID), cookie, strings.NewReader("world"), "application/octet-stream")
	c1.Body.Close()

	comp := doReq(t, http.MethodPost, env.server.URL+"/api/upload/complete", cookie, strings.NewReader(fmt.Sprintf(`{"uploadId":%q}`, initData.UploadID)), "application/json")
	comp.Body.Close()
	if comp.StatusCode != 200 {
		t.Fatalf("upload complete failed: %d", comp.StatusCode)
	}

	saved, err := os.ReadFile(filepath.Join(env.tmpDir, "Movies", "clip.txt"))
	if err != nil || string(saved) != "hello world" {
		t.Fatalf("expected 'hello world', got %q (err=%v)", string(saved), err)
	}

	// Readonly blocks writes
	roEnv := newTestEnv(t, true, false, false, nil, nil)
	_, roCookie := loginTest(t, roEnv.server.URL, "test-pass")
	roMk := doReq(t, http.MethodPost, roEnv.server.URL+"/api/mkdir", roCookie, strings.NewReader(`{"name":"Nope"}`), "application/json")
	roMk.Body.Close()
	if roMk.StatusCode != 403 {
		t.Fatalf("expected 403 in readonly mode, got %d", roMk.StatusCode)
	}
}

func TestPowerControl(t *testing.T) {
	cmd, _, err := GetPowerCommand("shutdown", "windows")
	if err != nil || cmd != "shutdown" {
		t.Fatalf("unexpected windows command: %s (%v)", cmd, err)
	}
	if _, _, err := GetPowerCommand("invalid", "linux"); err == nil {
		t.Fatal("expected error for invalid power action")
	}

	offEnv := newTestEnv(t, false, false, false, nil, nil)
	_, offCookie := loginTest(t, offEnv.server.URL, "test-pass")
	denied := doReq(t, http.MethodPost, offEnv.server.URL+"/api/power", offCookie, strings.NewReader(`{"action":"sleep","password":"test-pass"}`), "application/json")
	denied.Body.Close()
	if denied.StatusCode != 403 {
		t.Fatalf("expected 403 when --allow-power is off, got %d", denied.StatusCode)
	}

	var called []string
	onEnv := newTestEnv(t, false, true, false, nil, func(action string) (map[string]any, error) {
		called = append(called, action)
		return map[string]any{"ok": true, "action": action}, nil
	})
	_, onCookie := loginTest(t, onEnv.server.URL, "test-pass")
	okRes := doReq(t, http.MethodPost, onEnv.server.URL+"/api/power", onCookie, strings.NewReader(`{"action":"shutdown","password":"test-pass"}`), "application/json")
	okRes.Body.Close()
	if okRes.StatusCode != 200 || len(called) != 1 || called[0] != "shutdown" {
		t.Fatalf("expected 200 and shutdown recorded, got %d (%v)", okRes.StatusCode, called)
	}
}
