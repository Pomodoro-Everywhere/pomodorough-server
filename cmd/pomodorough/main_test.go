package main

import (
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"pomodorough/internal/config"
	"pomodorough/internal/server"
	"pomodorough/internal/store"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestAwaitShutdownReturnsServeFailuresAndAcceptsNormalClosure(t *testing.T) {
	t.Run("serve failure", func(t *testing.T) {
		serveErrors := make(chan error, 1)
		serveErrors <- errors.New("accept failed")

		err := awaitShutdown(&http.Server{}, serveErrors, testLogger())
		if err == nil || err.Error() != "accept failed" {
			t.Fatalf("awaitShutdown error = %v, want accept failed", err)
		}
	})

	t.Run("normal closure", func(t *testing.T) {
		serveErrors := make(chan error, 1)
		serveErrors <- http.ErrServerClosed

		if err := awaitShutdown(&http.Server{}, serveErrors, testLogger()); err != nil {
			t.Fatalf("awaitShutdown normal closure: %v", err)
		}
	})
}

func TestRunServerReportsOccupiedListenAddressBeforeUsingApplication(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	cfg := config.Config{ListenAddr: listener.Addr().String()}
	err = runServer(cfg, nil, testLogger())
	if err == nil || !strings.Contains(err.Error(), "listen on "+cfg.ListenAddr) {
		t.Fatalf("runServer error = %v, want occupied-listen error", err)
	}
}

func TestRunServerServesApplicationUntilTerminationSignal(t *testing.T) {
	dataDir := t.TempDir()
	userStore, err := store.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		ListenAddr: "127.0.0.1:0",
		DataDir:    dataDir,
		WebRoot:    t.TempDir(),
		PublicURL:  "https://pomodorough.example",
		AppSecret:  []byte("0123456789abcdef0123456789abcdef"),
	}
	application, err := server.New(cfg, userStore, testLogger())
	if err != nil {
		t.Fatal(err)
	}

	signalSent := make(chan error, 1)
	go func() {
		time.Sleep(100 * time.Millisecond)
		process, findErr := os.FindProcess(os.Getpid())
		if findErr != nil {
			signalSent <- findErr
			return
		}
		signalSent <- process.Signal(syscall.SIGTERM)
	}()

	if err := runServer(cfg, application, testLogger()); err != nil {
		t.Fatalf("runServer after SIGTERM: %v", err)
	}
	if err := <-signalSent; err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}
}

func TestAwaitShutdownForceClosesConnectionsAfterGracePeriod(t *testing.T) {
	originalTimeout := gracefulShutdownTimeout
	gracefulShutdownTimeout = 20 * time.Millisecond
	defer func() { gracefulShutdownTimeout = originalTimeout }()

	requestStarted := make(chan struct{})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := &http.Server{Handler: http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(requestStarted)
		<-request.Context().Done()
	})}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.Serve(listener) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		_, _ = http.Get("http://" + listener.Addr().String())
	}()
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("request did not reach shutdown fixture")
	}

	shutdownDone := make(chan error, 1)
	go func() { shutdownDone <- awaitShutdown(httpServer, serveErrors, testLogger()) }()
	time.Sleep(50 * time.Millisecond)
	process, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}

	if err := <-shutdownDone; err == nil || !strings.Contains(err.Error(), "graceful shutdown: context deadline exceeded") {
		t.Fatalf("awaitShutdown error = %v, want graceful-shutdown timeout", err)
	}
	select {
	case <-clientDone:
	case <-time.After(time.Second):
		t.Fatal("forced close did not cancel the active request")
	}
}

func TestAwaitShutdownStopsListeningServerAfterTerminationSignal(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.Serve(listener) }()

	signalSent := make(chan error, 1)
	go func() {
		time.Sleep(100 * time.Millisecond)
		process, findErr := os.FindProcess(os.Getpid())
		if findErr != nil {
			signalSent <- findErr
			return
		}
		signalSent <- process.Signal(syscall.SIGTERM)
	}()

	if err := awaitShutdown(httpServer, serveErrors, testLogger()); err != nil {
		t.Fatalf("awaitShutdown after SIGTERM: %v", err)
	}
	if err := <-signalSent; err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}
	select {
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("Serve after shutdown = %v, want http.ErrServerClosed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("HTTP server remained active after shutdown")
	}
}
