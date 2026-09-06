package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pomodorough/internal/config"
	"pomodorough/internal/server"
	"pomodorough/internal/sharedcore"
	"pomodorough/internal/store"
)

var gracefulShutdownTimeout = 15 * time.Second

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	defer captureMainPanic(logger)
	identity, err := currentBuildIdentity()
	if err != nil {
		failStartup(logger, "invalid build identity", err)
	}
	if isVersionRequest(os.Args[1:]) {
		if _, err := fmt.Fprintln(os.Stdout, identity.String()); err != nil {
			failStartup(logger, "write build identity", err)
		}
		return
	}
	cfg, err := config.Load()
	if err != nil {
		failStartup(logger, "invalid configuration", err)
	}
	flushMonitoring := initErrorMonitoring(identity, cfg.SentryDSN, logger)
	defer flushMonitoring()
	core, err := sharedcore.Default(context.Background())
	if err != nil {
		failStartup(logger, "initialize shared core", err)
	}
	defer core.Close(context.Background())
	dataDirLock, err := store.AcquireDataDirLock(cfg.DataDir)
	if err != nil {
		failStartup(logger, "lock storage", err)
	}
	defer dataDirLock.Close()
	userStore, err := store.NewWithDeletionLedger(cfg.DataDir, cfg.DeletionLedgerDir)
	if err != nil {
		failStartup(logger, "initialize storage", err)
	}
	application, err := server.NewForTraffic(cfg, userStore, logger, core)
	if err != nil {
		failStartup(logger, "initialize server", err)
	}
	if err := runServer(cfg, application, logger); err != nil {
		failStartup(logger, "server stopped", err)
	}
}

func runServer(cfg config.Config, application *server.Server, logger *slog.Logger) error {
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return errors.New("listen on " + cfg.ListenAddr + ": " + err.Error())
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
	if err := awaitShutdown(httpServer, serveErrors, logger); err != nil {
		return err
	}
	logger.Info("server stopped")
	return nil
}

func awaitShutdown(httpServer *http.Server, serveErrors <-chan error, logger *slog.Logger) error {
	signals, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	select {
	case <-signals.Done():
		logger.Info("shutdown requested")
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), gracefulShutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownContext); err != nil {
		_ = httpServer.Close()
		return errors.New("graceful shutdown: " + err.Error())
	}
	return nil
}
