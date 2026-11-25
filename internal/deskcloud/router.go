package deskcloud

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
)

type ServerOptions struct {
	PublicFS      fs.FS
	TunnelManager TunnelManager
	PowerRunner   PowerRunner
}

func sendCompressedBytes(w http.ResponseWriter, r *http.Request, status int, contentType string, raw []byte, cacheControl string) {
	if cacheControl != "" {
		w.Header().Set("Cache-Control", cacheControl)
	}
	if len(raw) >= 512 && r != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		if _, err := gz.Write(raw); err == nil && gz.Close() == nil {
			w.Header().Set("Content-Type", contentType)
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
			w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
			w.WriteHeader(status)
			_, _ = w.Write(buf.Bytes())
			return
		}
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func sendJSON(w http.ResponseWriter, status int, data any) {
	body, _ := json.Marshal(data)
	sendCompressedBytes(w, nil, status, "application/json; charset=utf-8", body, "")
}

func sendJSONGzip(w http.ResponseWriter, r *http.Request, status int, data any) {
	body, _ := json.Marshal(data)
	sendCompressedBytes(w, r, status, "application/json; charset=utf-8", body, "")
}

func readJSONBody(r *http.Request, dst any) error {
	limited := io.LimitReader(r.Body, 1024*1024+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return &httpError{Status: http.StatusBadRequest, Msg: "Failed to read request body"}
	}
	if len(raw) > 1024*1024 {
		return &httpError{Status: http.StatusRequestEntityTooLarge, Msg: "Request body too large"}
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return &httpError{Status: http.StatusBadRequest, Msg: "Invalid JSON body"}
	}
	return nil
}

func handleAPIError(w http.ResponseWriter, err error) {
	var he *httpError
	if errors.As(err, &he) {
		sendJSON(w, he.Status, map[string]string{"error": he.Msg})
		return
	}
	if errors.Is(err, os.ErrExist) {
		sendJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if errors.Is(err, os.ErrPermission) {
		sendJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

func NewHandler(cfg *Config, opts ServerOptions) http.Handler {
	auth := NewAuthManager(cfg)
	uploads := NewUploadManager()
	runPower := opts.PowerRunner
	if runPower == nil {
		runPower = ExecutePowerAction
	}

	var rootsMu sync.RWMutex

	requireWritable := func() error {
		if cfg.Readonly {
			return &httpError{Status: http.StatusForbidden, Msg: "Server is running in read-only mode"}
		}
		return nil
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pathname := r.URL.Path
		q := r.URL.Query()

		// Static UI assets
		if r.Method == http.MethodGet && (pathname == "/" || pathname == "/app.js" || pathname == "/styles.css") {
			if opts.PublicFS == nil {
				sendJSON(w, http.StatusNotFound, map[string]string{"error": "Static assets unavailable"})
				return
			}
			clean := strings.TrimPrefix(pathname, "/")
			if clean == "" {
				clean = "index.html"
			}
			content, err := fs.ReadFile(opts.PublicFS, clean)
			if err != nil {
				sendJSON(w, http.StatusNotFound, map[string]string{"error": "Not found"})
				return
			}
			sendCompressedBytes(w, r, http.StatusOK, GetMimeType(clean), content, "no-cache")
			return
		}

		// Auth status & login/logout
		if pathname == "/api/auth/status" && r.Method == http.MethodGet {
			sendJSON(w, http.StatusOK, map[string]any{
				"authEnabled":    cfg.AuthEnabled,
				"authenticated":  auth.IsAuthenticated(r),
				"readonly":       cfg.Readonly,
				"powerEnabled":   cfg.AllowPower && !cfg.Readonly && cfg.AuthEnabled,
				"chunkSizeBytes": cfg.ChunkSizeBytes,
			})
			return
		}

		if pathname == "/api/auth/login" && r.Method == http.MethodPost {
			allowed, ip, retrySec := auth.CheckRateLimit(r)
			if !allowed {
				w.Header().Set("Retry-After", strconv.Itoa(retrySec))
				sendJSON(w, http.StatusTooManyRequests, map[string]string{
					"error": "Too many attempts. Try again later.",
				})
				return
			}
			var body struct {
				Password string `json:"password"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			if !auth.VerifyPassword(body.Password) {
				auth.RecordFailedAttempt(ip)
				sendJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid password"})
				return
			}
			auth.ClearAttempts(ip)
			http.SetCookie(w, auth.CreateSessionCookie(r))
			sendJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}

		if pathname == "/api/auth/logout" && r.Method == http.MethodPost {
			http.SetCookie(w, auth.ClearSessionCookie())
			sendJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}

		if !strings.HasPrefix(pathname, "/api/") {
			sendJSON(w, http.StatusNotFound, map[string]string{"error": "Not found"})
			return
		}

		if !auth.IsAuthenticated(r) {
			sendJSON(w, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
			return
		}

		switch {
		case pathname == "/api/roots" && r.Method == http.MethodGet:
			rootsMu.RLock()
			rootsCopy := SerializeRoots(cfg.Roots)
			rootsMu.RUnlock()
			sendJSON(w, http.StatusOK, map[string]any{"roots": rootsCopy})

		case pathname == "/api/system/browse" && r.Method == http.MethodGet:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			res, err := BrowseSystemDirs(q.Get("path"))
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSONGzip(w, r, http.StatusOK, res)

		case pathname == "/api/roots/add" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			var body struct {
				Path string `json:"path"`
				Name string `json:"name"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			rootsMu.Lock()
			added, allRoots, err := AddRoot(cfg, body.Path, body.Name)
			rootsMu.Unlock()
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, map[string]any{"ok": true, "root": added, "roots": allRoots})

		case pathname == "/api/roots/remove" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			var body struct {
				ID string `json:"id"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			rootsMu.Lock()
			allRoots, err := RemoveRoot(cfg, body.ID)
			rootsMu.Unlock()
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, map[string]any{"ok": true, "roots": allRoots})

		case pathname == "/api/tunnel/status" && r.Method == http.MethodGet:
			if opts.TunnelManager == nil {
				sendJSON(w, http.StatusOK, TunnelStatus{Status: "stopped"})
				return
			}
			sendJSON(w, http.StatusOK, opts.TunnelManager.GetStatus())

		case pathname == "/api/tunnel/start" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			if opts.TunnelManager == nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "Tunnel manager unavailable"})
				return
			}
			st, err := opts.TunnelManager.Start()
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, st)

		case pathname == "/api/tunnel/stop" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			if opts.TunnelManager == nil {
				sendJSON(w, http.StatusInternalServerError, map[string]string{"error": "Tunnel manager unavailable"})
				return
			}
			st, err := opts.TunnelManager.Stop()
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, st)

		case pathname == "/api/power" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			if !cfg.AllowPower {
				sendJSON(w, http.StatusForbidden, map[string]string{"error": "Remote power control is disabled. Start with --allow-power to enable."})
				return
			}
			if !cfg.AuthEnabled {
				sendJSON(w, http.StatusForbidden, map[string]string{"error": "Remote power control requires authentication."})
				return
			}
			var body struct {
				Action   string `json:"action"`
				Password string `json:"password"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			if !auth.VerifyPassword(body.Password) {
				sendJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid password confirmation"})
				return
			}
			res, err := runPower(body.Action)
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSONGzip(w, r, http.StatusOK, res)

		case pathname == "/api/list" && r.Method == http.MethodGet:
			rootsMu.RLock()
			rootsCopy := append([]Root(nil), cfg.Roots...)
			rootsMu.RUnlock()
			if len(rootsCopy) == 0 {
				sendJSON(w, http.StatusOK, ListResponse{
					Root:        nil,
					Roots:       []RootInfo{},
					Path:        "",
					Breadcrumbs: []Breadcrumb{},
					Items:       []FileEntry{},
					Total:       0,
					Page:        1,
					Limit:       100,
					TotalPages:  1,
				})
				return
			}
			res, err := ListDirectory(rootsCopy, q)
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSONGzip(w, r, http.StatusOK, res)

		case pathname == "/api/stream" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
			rootsMu.RLock()
			rootsCopy := append([]Root(nil), cfg.Roots...)
			rootsMu.RUnlock()
			if err := StreamFile(w, r, rootsCopy, q, false); err != nil {
				handleAPIError(w, err)
			}

		case pathname == "/api/thumb" && r.Method == http.MethodGet:
			rootsMu.RLock()
			rootsCopy := append([]Root(nil), cfg.Roots...)
			rootsMu.RUnlock()
			if err := ServeThumbnail(w, r, rootsCopy, q); err != nil {
				handleAPIError(w, err)
			}

		case pathname == "/api/download" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
			rootsMu.RLock()
			rootsCopy := append([]Root(nil), cfg.Roots...)
			rootsMu.RUnlock()
			if err := StreamFile(w, r, rootsCopy, q, true); err != nil {
				handleAPIError(w, err)
			}

		case pathname == "/api/mkdir" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			var body struct {
				Root string `json:"root"`
				Path string `json:"path"`
				Name string `json:"name"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			rootsMu.RLock()
			rootsCopy := append([]Root(nil), cfg.Roots...)
			rootsMu.RUnlock()
			createdPath, err := CreateFolder(rootsCopy, body.Root, body.Path, body.Name)
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, map[string]any{"ok": true, "path": createdPath})

		case pathname == "/api/rename" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			var body struct {
				Root    string `json:"root"`
				Path    string `json:"path"`
				NewName string `json:"newName"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			rootsMu.RLock()
			rootsCopy := append([]Root(nil), cfg.Roots...)
			rootsMu.RUnlock()
			newPath, err := RenameItem(rootsCopy, body.Root, body.Path, body.NewName)
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, map[string]any{"ok": true, "path": newPath})

		case pathname == "/api/delete" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			var body struct {
				Root string `json:"root"`
				Path string `json:"path"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			rootsMu.RLock()
			rootsCopy := append([]Root(nil), cfg.Roots...)
			rootsMu.RUnlock()
			if err := DeleteItem(rootsCopy, body.Root, body.Path); err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, map[string]bool{"ok": true})

		case pathname == "/api/upload/init" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			var body struct {
				Root        string `json:"root"`
				Path        string `json:"path"`
				Filename    string `json:"filename"`
				TotalChunks int    `json:"totalChunks"`
				TotalSize   int64  `json:"totalSize"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			rootsMu.RLock()
			rootsCopy := append([]Root(nil), cfg.Roots...)
			rootsMu.RUnlock()
			uploadID, err := uploads.InitUpload(rootsCopy, body.Root, body.Path, body.Filename, body.TotalChunks, body.TotalSize)
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, map[string]string{"uploadId": uploadID})

		case pathname == "/api/upload/chunk" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			idx, err := strconv.Atoi(q.Get("index"))
			if err != nil {
				sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid chunk index"})
				return
			}
			rec, tot, err := uploads.ReceiveChunk(r, q.Get("uploadId"), idx)
			if err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, map[string]int{"received": rec, "totalChunks": tot})

		case pathname == "/api/upload/complete" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			var body struct {
				UploadID string `json:"uploadId"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			if err := uploads.CompleteUpload(body.UploadID); err != nil {
				handleAPIError(w, err)
				return
			}
			sendJSON(w, http.StatusOK, map[string]bool{"ok": true})

		case pathname == "/api/upload/cancel" && r.Method == http.MethodPost:
			if err := requireWritable(); err != nil {
				handleAPIError(w, err)
				return
			}
			var body struct {
				UploadID string `json:"uploadId"`
			}
			if err := readJSONBody(r, &body); err != nil {
				handleAPIError(w, err)
				return
			}
			uploads.CancelUpload(body.UploadID)
			sendJSON(w, http.StatusOK, map[string]bool{"ok": true})

		default:
			sendJSON(w, http.StatusNotFound, map[string]string{"error": "API endpoint not found"})
		}
	})
}

