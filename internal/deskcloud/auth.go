package deskcloud

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	CookieName    = "storage_session"
	sessionTTL    = 7 * 24 * time.Hour
	maxAttempts   = 12
	attemptWindow = time.Minute
)

type attemptEntry struct {
	count   int
	resetAt time.Time
}

type AuthManager struct {
	authEnabled   bool
	passwordHash  [32]byte
	sessionSecret []byte

	mu       sync.Mutex
	attempts map[string]*attemptEntry
}

func NewAuthManager(cfg *Config) *AuthManager {
	am := &AuthManager{
		authEnabled:   cfg.AuthEnabled,
		sessionSecret: cfg.SessionSecret,
		attempts:      make(map[string]*attemptEntry),
	}
	if cfg.AuthEnabled {
		am.passwordHash = sha256.Sum256([]byte(cfg.Password))
	}
	return am
}

func (a *AuthManager) VerifyPassword(candidate string) bool {
	if !a.authEnabled {
		return true
	}
	h := sha256.Sum256([]byte(candidate))
	return subtle.ConstantTimeCompare(h[:], a.passwordHash[:]) == 1
}

type tokenPayload struct {
	Iat int64 `json:"iat"`
	Exp int64 `json:"exp"`
}

func (a *AuthManager) signToken(p tokenPayload) string {
	raw, _ := json.Marshal(p)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, a.sessionSecret)
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig
}

func (a *AuthManager) verifyToken(token string) bool {
	dot := strings.IndexByte(token, '.')
	if dot <= 0 {
		return false
	}
	payload := token[:dot]
	sig := token[dot+1:]

	mac := hmac.New(sha256.New, a.sessionSecret)
	mac.Write([]byte(payload))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	if len(sig) != len(expected) || subtle.ConstantTimeCompare([]byte(sig), []byte(expected)) != 1 {
		return false
	}

	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return false
	}
	var data tokenPayload
	if err := json.Unmarshal(raw, &data); err != nil {
		return false
	}
	return data.Exp > 0 && time.Now().UnixMilli() <= data.Exp
}

func (a *AuthManager) IsAuthenticated(r *http.Request) bool {
	if !a.authEnabled {
		return true
	}
	c, err := r.Cookie(CookieName)
	if err != nil {
		return false
	}
	return a.verifyToken(c.Value)
}

func (a *AuthManager) CreateSessionCookie(r *http.Request) *http.Cookie {
	now := time.Now()
	token := a.signToken(tokenPayload{
		Iat: now.UnixMilli(),
		Exp: now.Add(sessionTTL).UnixMilli(),
	})
	isHTTPS := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	return &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isHTTPS,
	}
}

func (a *AuthManager) ClearSessionCookie() *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   0,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
}

func getClientIP(r *http.Request) string {
	if cf := strings.TrimSpace(r.Header.Get("Cf-Connecting-Ip")); cf != "" {
		return cf
	}
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "unknown"
}

func (a *AuthManager) CheckRateLimit(r *http.Request) (allowed bool, ip string, retryAfterSec int) {
	ip = getClientIP(r)
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()

	entry, ok := a.attempts[ip]
	if !ok || now.After(entry.resetAt) {
		return true, ip, 0
	}
	if entry.count >= maxAttempts {
		sec := int(entry.resetAt.Sub(now).Seconds()) + 1
		if sec < 1 {
			sec = 1
		}
		return false, ip, sec
	}
	return true, ip, 0
}

func (a *AuthManager) RecordFailedAttempt(ip string) {
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()

	entry, ok := a.attempts[ip]
	if !ok || now.After(entry.resetAt) {
		a.attempts[ip] = &attemptEntry{count: 1, resetAt: now.Add(attemptWindow)}
	} else {
		entry.count++
	}
}

func (a *AuthManager) ClearAttempts(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.attempts, ip)
}

