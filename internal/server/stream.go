package server

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"pomodorough/internal/store"
)

type revisionStream struct {
	w          http.ResponseWriter
	controller *http.ResponseController
	logger     *slog.Logger
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request, identity principal) {
	release, allowed := s.streamLimiter.acquire(identity.UserID)
	if !allowed {
		s.writeRateLimit(w, r, "account_stream", 30*time.Second)
		return
	}
	defer release()
	updates, unsubscribe := s.hub.subscribe(identity.UserID, identity.Generation, identity.SessionID, identity.DeviceID)
	defer unsubscribe()
	revision, err := s.currentStreamRevision(r, identity)
	if isUnauthorized(err) {
		writeAPIError(w, r, http.StatusUnauthorized, "unauthorized")
		return
	}
	if errors.Is(err, store.ErrRevisionExhausted) {
		writeAPIError(w, r, http.StatusConflict, "revision exhausted")
		return
	}
	if err != nil {
		s.internalAPIError(w, r, "read stream revision", err)
		return
	}
	setStreamHeaders(w)
	stream := revisionStream{w: w, controller: http.NewResponseController(w), logger: s.logger}
	stream.serve(r, updates, revision, s.streamKeepaliveInterval)
}

func (s *Server) currentStreamRevision(r *http.Request, identity principal) (int64, error) {
	_, revision, changed, err := s.store.HistoryForGeneration(
		r.Context(), identity.UserID, identity.Generation, time.Now(),
	)
	if err == nil && changed {
		s.hub.publish(identity.UserID, identity.Generation, revision)
	}
	return revision, err
}

func setStreamHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
}

func (stream revisionStream) serve(r *http.Request, updates <-chan int64, revision int64, keepaliveInterval time.Duration) {
	if err := stream.writeRevision(revision); err != nil {
		stream.logWriteError("write stream revision", err)
		return
	}
	lastSent := revision
	keepalive := time.NewTicker(keepaliveInterval)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case revision, open := <-updates:
			if !open {
				return
			}
			if revision > lastSent {
				if err := stream.writeRevision(revision); err != nil {
					stream.logWriteError("write stream revision", err)
					return
				}
				lastSent = revision
			}
		case <-keepalive.C:
			if err := stream.writeKeepalive(); err != nil {
				stream.logWriteError("write stream keepalive", err)
				return
			}
		}
	}
}

func (stream revisionStream) writeRevision(value int64) error {
	if err := stream.controller.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(stream.w, "event: revision\ndata: {\"revision\":%d}\n\n", value); err != nil {
		return err
	}
	return stream.controller.Flush()
}

func (stream revisionStream) writeKeepalive() error {
	if err := stream.controller.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return err
	}
	if _, err := fmt.Fprint(stream.w, ": keepalive\n\n"); err != nil {
		return err
	}
	return stream.controller.Flush()
}

func (stream revisionStream) logWriteError(operation string, err error) {
	if stream.logger == nil {
		return
	}
	stream.logger.Warn(operation, "error", err)
}
