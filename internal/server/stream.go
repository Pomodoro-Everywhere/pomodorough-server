package server

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"pomodorough/internal/store"
)

type revisionStream struct {
	w          http.ResponseWriter
	controller *http.ResponseController
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
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if errors.Is(err, store.ErrRevisionExhausted) {
		writeAPIError(w, http.StatusConflict, "revision exhausted")
		return
	}
	if err != nil {
		s.internalAPIError(w, r, "read stream revision", err)
		return
	}
	setStreamHeaders(w)
	stream := revisionStream{w: w, controller: http.NewResponseController(w)}
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
					return
				}
				lastSent = revision
			}
		case <-keepalive.C:
			if err := stream.writeKeepalive(); err != nil {
				return
			}
		}
	}
}

func (stream revisionStream) writeRevision(value int64) error {
	_ = stream.controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if _, err := fmt.Fprintf(stream.w, "event: revision\ndata: {\"revision\":%d}\n\n", value); err != nil {
		return err
	}
	return stream.controller.Flush()
}

func (stream revisionStream) writeKeepalive() error {
	_ = stream.controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if _, err := fmt.Fprint(stream.w, ": keepalive\n\n"); err != nil {
		return err
	}
	return stream.controller.Flush()
}
