package server

import (
	"fmt"
	"net/http"
	"regexp"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
	"pomodorough/internal/timer"
)

const maxSyncBody = 1 << 20

var (
	idPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	platformPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$`)
	validTypes      = map[string]struct{}{"start": {}, "pause": {}, "resume": {}, "finish": {}, "cancel": {}, "clear": {}}
	validPhases     = map[string]struct{}{"focus": {}, "short_break": {}, "long_break": {}}
)

type syncRequestJSON struct {
	DeviceID     string            `json:"deviceId"`
	LastRevision int64             `json:"lastRevision"`
	Commands     []syncCommandJSON `json:"commands"`
}

type syncCommandJSON struct {
	ID                string `json:"id"`
	DeviceSequence    int64  `json:"deviceSequence"`
	TimerID           string `json:"timerId"`
	Type              string `json:"type"`
	Phase             string `json:"phase"`
	PlannedDurationMs int64  `json:"plannedDurationMs"`
	OccurredAt        string `json:"occurredAt"`
	HLCWallMs         int64  `json:"hlcWallMs"`
	HLCCounter        int64  `json:"hlcCounter"`
	ObservedElapsedMs int64  `json:"observedElapsedMs"`
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, identity principal) {
	csrfToken := ""
	if identity.Method == "cookie" {
		if cookie, err := r.Cookie(authn.CSRFCookie); err == nil {
			hash := authn.HashString(cookie.Value)
			if cookie.Value != "" && authn.EqualHash(hash[:], identity.CSRFHash) {
				csrfToken = cookie.Value
			}
		}
		if csrfToken == "" {
			var err error
			csrfToken, err = authn.RandomString(32)
			if err != nil {
				s.internalAPIError(w, "generate replacement CSRF token", err)
				return
			}
			db, err := s.store.OpenExistingUser(r.Context(), identity.UserID)
			if err != nil {
				writeAPIError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			hash := authn.HashString(csrfToken)
			err = store.UpdateCSRF(r.Context(), db, identity.SessionID, hash)
			db.Close()
			if err != nil {
				s.internalAPIError(w, "replace CSRF token", err)
				return
			}
			setCSRFCookie(w, csrfToken, time.Now().Add(webSessionLifetime))
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{
			"id": identity.Profile.ID, "email": identity.Profile.Email, "name": identity.Profile.Name, "avatarUrl": identity.Profile.AvatarURL,
		},
		"csrfToken": csrfToken,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, identity principal) {
	db, err := s.store.OpenExistingUser(r.Context(), identity.UserID)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	err = store.RevokeSession(r.Context(), db, identity.SessionID, time.Now())
	db.Close()
	if err != nil {
		s.internalAPIError(w, "revoke session", err)
		return
	}
	if identity.Method == "cookie" {
		clearSessionCookies(w)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request, identity principal) {
	var request struct {
		DeviceID string `json:"deviceId"`
	}
	if err := decodeJSON(w, r, 64<<10, &request); err != nil || !validID(request.DeviceID) {
		writeAPIError(w, http.StatusBadRequest, "invalid request")
		return
	}
	db, err := s.store.OpenExistingUser(r.Context(), identity.UserID)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	err = store.RevokeDevice(r.Context(), db, request.DeviceID, time.Now())
	db.Close()
	if err != nil {
		s.internalAPIError(w, "revoke device", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request, identity principal) {
	request, err := parseSyncRequest(w, r, time.Now())
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid sync request")
		return
	}
	if identity.Method == "bearer" && !authn.EqualString(identity.DeviceID, request.DeviceID) {
		writeAPIError(w, http.StatusForbidden, "device mismatch")
		return
	}
	db, err := s.store.OpenExistingUser(r.Context(), identity.UserID)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	result, err := s.store.Sync(r.Context(), db, identity.UserID, request, time.Now())
	db.Close()
	if err != nil {
		s.internalAPIError(w, "sync timer commands", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
	if len(request.Commands) > 0 {
		s.hub.publish(identity.UserID, result.Revision)
	}
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request, identity principal) {
	db, err := s.store.OpenExistingUser(r.Context(), identity.UserID)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	history, _, err := store.History(r.Context(), db, time.Now())
	db.Close()
	if err != nil {
		s.internalAPIError(w, "read timer history", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": history})
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request, identity principal) {
	updates, unsubscribe := s.hub.subscribe(identity.UserID)
	defer unsubscribe()
	db, err := s.store.OpenExistingUser(r.Context(), identity.UserID)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	_, revision, err := store.History(r.Context(), db, time.Now())
	db.Close()
	if err != nil {
		s.internalAPIError(w, "read stream revision", err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	writeRevision := func(value int64) error {
		_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := fmt.Fprintf(w, "event: revision\ndata: {\"revision\":%d}\n\n", value); err != nil {
			return err
		}
		return controller.Flush()
	}
	if err := writeRevision(revision); err != nil {
		return
	}
	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case revision := <-updates:
			if err := writeRevision(revision); err != nil {
				return
			}
		case <-keepalive.C:
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
		}
	}
}

func parseSyncRequest(w http.ResponseWriter, r *http.Request, now time.Time) (store.SyncRequest, error) {
	var payload syncRequestJSON
	if err := decodeJSON(w, r, maxSyncBody, &payload); err != nil {
		return store.SyncRequest{}, err
	}
	if !validID(payload.DeviceID) || payload.LastRevision < 0 || len(payload.Commands) > 256 {
		return store.SyncRequest{}, fmt.Errorf("invalid sync envelope")
	}
	request := store.SyncRequest{DeviceID: payload.DeviceID, LastRevision: payload.LastRevision, Commands: make([]timer.Command, 0, len(payload.Commands))}
	for _, input := range payload.Commands {
		if !validID(input.ID) || !validID(input.TimerID) || input.DeviceSequence <= 0 {
			return store.SyncRequest{}, fmt.Errorf("invalid command identity")
		}
		if _, valid := validTypes[input.Type]; !valid {
			return store.SyncRequest{}, fmt.Errorf("invalid command type")
		}
		if _, valid := validPhases[input.Phase]; !valid {
			return store.SyncRequest{}, fmt.Errorf("invalid command phase")
		}
		if input.PlannedDurationMs < int64(time.Minute/time.Millisecond) || input.PlannedDurationMs > int64(4*time.Hour/time.Millisecond) {
			return store.SyncRequest{}, fmt.Errorf("invalid timer duration")
		}
		if input.HLCWallMs <= 0 || input.HLCWallMs > now.Add(5*time.Minute).UnixMilli() || input.HLCCounter < 0 {
			return store.SyncRequest{}, fmt.Errorf("invalid hybrid clock")
		}
		occurredAt, err := time.Parse(time.RFC3339Nano, input.OccurredAt)
		if err != nil {
			return store.SyncRequest{}, fmt.Errorf("invalid occurrence time")
		}
		request.Commands = append(request.Commands, timer.Command{
			ID: input.ID, DeviceID: payload.DeviceID, DeviceSequence: input.DeviceSequence, TimerID: input.TimerID,
			Type: input.Type, Phase: input.Phase, PlannedDurationMs: input.PlannedDurationMs, OccurredAt: occurredAt,
			HLCWallMs: input.HLCWallMs, HLCCounter: input.HLCCounter, ObservedElapsedMs: input.ObservedElapsedMs,
		})
	}
	return request, nil
}

func validID(value string) bool {
	return idPattern.MatchString(value)
}

func validPlatform(value string) bool {
	return platformPattern.MatchString(value)
}
