package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pomodorough/internal/config"
	"pomodorough/internal/server"
	"pomodorough/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	dataDirLock, err := store.AcquireDataDirLock(cfg.DataDir)
	if err != nil {
		logger.Error("lock storage", "error", err)
		os.Exit(1)
	}
	defer dataDirLock.Close()
	userStore, err := store.New(cfg.DataDir)
	if err != nil {
		logger.Error("initialize storage", "error", err)
		os.Exit(1)
	}
	application, err := server.New(cfg, userStore, logger)
	if err != nil {
		logger.Error("initialize server", "error", err)
		os.Exit(1)
	}

	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		logger.Error("listen", "address", cfg.ListenAddr, "error", err)
		os.Exit(1)
	}
	httpServer := &http.Server{
		Handler:           application.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      35 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	serveErrors := make(chan error, 1)
	go func() {
		logger.Info("server listening", "address", cfg.ListenAddr, "public_url", cfg.PublicURL)
		serveErrors <- httpServer.Serve(listener)
	}()

	signals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	select {
	case <-signals.Done():
		logger.Info("shutdown requested")
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server stopped", "error", err)
			os.Exit(1)
		}
		return
	}

	shutdownContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		_ = httpServer.Close()
		os.Exit(1)
	}
	logger.Info("server stopped")
}
