package main

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/config"
	"pomodorough/internal/server"
	"pomodorough/internal/store"
)

func gracefulSSEFixture(t *testing.T) (*server.Server, string, string) {
	t.Helper()
	dataDir := t.TempDir()
	userStore, err := store.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte(strings.Repeat("r48-s04-grace-", 3)[:32])
	cfg := config.Config{
		ListenAddr: "127.0.0.1:0", DataDir: dataDir, WebRoot: t.TempDir(),
		PublicURL: "https://pomodorough.example", AppSecret: secret,
	}
	application, err := server.New(cfg, userStore, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	userID := authn.UserID(secret, "https://accounts.google.com", "r48-s04-subject")
	db, err := userStore.OpenUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	profile := store.Profile{ID: userID, Issuer: "https://accounts.google.com", Subject: "r48-s04-subject"}
	if err := store.UpsertProfile(context.Background(), db, profile, now); err != nil {
		t.Fatal(err)
	}
	access, accessHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	session := store.Session{ID: "native-session", Kind: "native", DeviceID: "device-s04", Platform: "ios"}
	record := store.TokenRecord{Hash: accessHash, Kind: "access"}
	session.CreatedAt = now
	session.ExpiresAt = now.Add(time.Hour)
	record.CreatedAt = now
	record.ExpiresAt = now.Add(time.Hour)
	if err := store.CreateSession(context.Background(), db, session, []store.TokenRecord{record}); err != nil {
		t.Fatal(err)
	}
	return application, userID, access
}

func openGracefulSSE(t *testing.T, baseURL, token string) (*http.Response, *bufio.Scanner) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, baseURL+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		t.Fatalf("open SSE status=%d", response.StatusCode)
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "data:") {
				return response, scanner
			}
			continue
		}
		break
	}
	response.Body.Close()
	t.Fatal("no initial SSE revision before deadline")
	return nil, nil
}

func assertGracefulStreamClosed(t *testing.T, scanner *bufio.Scanner) {
	t.Helper()
	done := make(chan bool, 1)
	go func() {
		for scanner.Scan() {
			text := scanner.Text()
			if text == "" || text[0] == ':' || len(text) >= 6 && text[:6] == "event:" {
				continue
			}
			done <- false
			return
		}
		done <- true
	}()
	select {
	case closed := <-done:
		if !closed {
			t.Fatal("stream published after shutdown")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not reach EOF after shutdown")
	}
}

func TestR48S04HealthySSEAllowsGracefulShutdown(t *testing.T) {
	application, _, token := gracefulSSEFixture(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := &http.Server{Handler: application.Handler()}
	httpServer.RegisterOnShutdown(application.Shutdown)
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.Serve(listener) }()
	baseURL := "http://" + listener.Addr().String()
	first, firstScan := openGracefulSSE(t, baseURL, token)
	defer first.Body.Close()
	second, secondScan := openGracefulSSE(t, baseURL, token)
	defer second.Body.Close()
	shutdownDone := make(chan error, 1)
	go func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		shutdownDone <- httpServer.Shutdown(shutdownCtx)
	}()
	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("graceful shutdown with healthy SSE: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("healthy SSE blocked graceful shutdown past deadline")
	}
	assertGracefulStreamClosed(t, firstScan)
	assertGracefulStreamClosed(t, secondScan)
	select {
	case err := <-serveErrors:
		if err != http.ErrServerClosed {
			t.Fatalf("Serve after shutdown=%v want ErrServerClosed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("server remained active after graceful shutdown")
	}
}

func TestR48S04StuckFiniteRetainsTimeout(t *testing.T) {
	started := make(chan struct{})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := &http.Server{Handler: http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	})}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.Serve(listener) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		_, _ = http.Get("http://" + listener.Addr().String())
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("stuck fixture never started")
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err == nil || !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Fatalf("stuck shutdown error=%v want deadline exceeded", err)
	}
	_ = httpServer.Close()
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("stuck finite handler was not force-closed")
	}
}
