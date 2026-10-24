package main

// Kontur v2 experiment: Go (stdlib only) backend + Fluent-glass frontend.
// Runs side by side with the Python stack: Python listens on :8000,
// this server defaults to :8080.

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func main() {
	dataFile := envOr("DATA_FILE", "data/store.json")
	store, err := LoadStore(dataFile)
	if err != nil {
		log.Fatalf("storage: %v", err)
	}
	srv := &Server{
		store:        store,
		adminUser:    envOr("ADMIN_USERNAME", "admin"),
		adminPass:    os.Getenv("ADMIN_PASSWORD"),
		cookieSecure: strings.EqualFold(envOr("COOKIE_SECURE", "false"), "true"),
		limiter:      newRateLimiter(),
		webDir:       envOr("WEB_DIR", "../frontend/dist"),
	}
	if srv.adminPass == "" {
		log.Printf("WARNING: ADMIN_PASSWORD is not set; password login is disabled")
	}
	port := envOr("PORT", "8080")
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("kontur-v2 (go, stdlib) listening on http://localhost:%s (data: %s)", port, dataFile)
	log.Fatal(server.ListenAndServe())
}
