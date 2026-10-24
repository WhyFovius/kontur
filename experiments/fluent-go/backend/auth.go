package main

// Authentication for the experiment: admin password from the
// environment (constant-time compare), server-side sessions in an
// HttpOnly cookie, optional HTTP Basic for API clients, and a simple
// per-IP login rate limiter — same contract as the Python stack.

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

func hashEq(a, b string) bool {
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

func (s *Server) verifyAdmin(username, password string) bool {
	if s.adminPass == "" {
		return false
	}
	okUser := hashEq(username, s.adminUser)
	okPass := hashEq(password, s.adminPass)
	return okUser && okPass
}

const (
	loginAttemptLimit   = 8
	loginWindowSeconds  = 900
)

type attemptWindow struct {
	started time.Time
	count   int
}

type rateLimiter struct {
	mu       sync.Mutex
	attempts map[string]*attemptWindow
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{attempts: map[string]*attemptWindow{}}
}

func (rl *rateLimiter) limited(key string) (bool, int) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	w, ok := rl.attempts[key]
	if !ok {
		return false, 0
	}
	elapsed := time.Since(w.started).Seconds()
	if elapsed >= loginWindowSeconds {
		delete(rl.attempts, key)
		return false, 0
	}
	if w.count >= loginAttemptLimit {
		return true, loginWindowSeconds - int(elapsed)
	}
	return false, 0
}

func (rl *rateLimiter) fail(key string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	w, ok := rl.attempts[key]
	if !ok || time.Since(w.started).Seconds() >= loginWindowSeconds {
		rl.attempts[key] = &attemptWindow{started: time.Now(), count: 1}
		return
	}
	w.count++
}

func (rl *rateLimiter) clear(key string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.attempts, key)
}

func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// currentUser resolves the caller: a present-but-invalid Basic header
// is rejected outright; otherwise the session cookie decides.
func (s *Server) currentUser(r *http.Request) (string, bool) {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "basic ") {
		username, password, ok := r.BasicAuth()
		if ok && s.verifyAdmin(username, password) {
			return s.adminUser, true
		}
		return "", false
	}
	cookie, err := r.Cookie("churn_session")
	if err != nil {
		return "", false
	}
	username := s.store.SessionUser(cookie.Value)
	return username, username != ""
}
