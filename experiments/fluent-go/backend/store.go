package main

// JSON-file storage for the experiment (the Python stack uses SQLite).
// One file holds the snapshot, model weights and sessions; writes are
// atomic (temp file + rename) and guarded by a RWMutex.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type session struct {
	Username  string    `json:"username"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type storeFile struct {
	Snapshot map[string][]map[string]any `json:"snapshot"`
	Weights  map[string]float64          `json:"weights"`
	Sessions map[string]session          `json:"sessions"`
}

type Store struct {
	mu   sync.RWMutex
	path string
	data storeFile
}

func LoadStore(path string) (*Store, error) {
	s := &Store{path: path}
	f, err := os.Open(path)
	if err == nil {
		defer f.Close()
		dec := json.NewDecoder(f)
		dec.UseNumber()
		if err := dec.Decode(&s.data); err != nil {
			return nil, err
		}
	} else if os.IsNotExist(err) {
		s.data = storeFile{
			Snapshot: SeedSnapshot(time.Now().UTC()),
			Weights:  DefaultWeights(),
			Sessions: map[string]session{},
		}
		if err := s.save(); err != nil {
			return nil, err
		}
	} else {
		return nil, err
	}
	if s.data.Snapshot == nil {
		s.data.Snapshot = SeedSnapshot(time.Now().UTC())
	}
	if s.data.Weights == nil {
		s.data.Weights = map[string]float64{}
	}
	for k, v := range DefaultWeights() {
		if _, ok := s.data.Weights[k]; !ok {
			s.data.Weights[k] = v
		}
	}
	if s.data.Sessions == nil {
		s.data.Sessions = map[string]session{}
	}
	return s, nil
}

// save persists the store; caller must hold the write lock (except
// during LoadStore, before the store is shared).
func (s *Store) save() error {
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) Analyzed() []map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Analyze(s.data.Snapshot, s.data.Weights)
}

func (s *Store) Weights() map[string]float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]float64{}
	for k, v := range s.data.Weights {
		out[k] = v
	}
	return out
}

func (s *Store) UpdateWeights(update map[string]float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range update {
		s.data.Weights[k] = v
	}
	return s.save()
}

func (s *Store) ReplaceSnapshot(snapshot map[string][]map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Snapshot = snapshot
	return s.save()
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateSession(username string) (string, time.Time, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, err
	}
	token := hex.EncodeToString(buf)
	expires := time.Now().UTC().Add(7 * 24 * time.Hour)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC()
	for hash, sess := range s.data.Sessions {
		if sess.ExpiresAt.Before(now) {
			delete(s.data.Sessions, hash)
		}
	}
	s.data.Sessions[tokenHash(token)] = session{Username: username, ExpiresAt: expires}
	if err := s.save(); err != nil {
		return "", time.Time{}, err
	}
	return token, expires, nil
}

func (s *Store) SessionUser(token string) string {
	if token == "" {
		return ""
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.data.Sessions[tokenHash(token)]
	if !ok || sess.ExpiresAt.Before(time.Now().UTC()) {
		return ""
	}
	return sess.Username
}

func (s *Store) DeleteSession(token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data.Sessions, tokenHash(token))
	_ = s.save()
}
