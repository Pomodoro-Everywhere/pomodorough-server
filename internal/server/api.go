package server

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

const (
	maxSyncBody      = 1 << 20
	maxBootstrapBody = 32 << 20
)

var (
	idPattern                = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	platformPattern          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$`)
	validTypes               = map[string]struct{}{"start": {}, "pause": {}, "resume": {}, "finish": {}, "cancel": {}, "clear": {}}
	validPhases              = map[string]struct{}{"focus": {}, "short_break": {}, "long_break": {}}
	validTaskOperationTypes  = map[string]struct{}{"upsert": {}, "delete": {}}
	validBootstrapStrategies = map[string]struct{}{
		store.BootstrapKeepRemote: {}, store.BootstrapReplaceRemote: {}, store.BootstrapMerge: {},
	}
)

type syncRequestJSON struct {
	DeviceID           string                      `json:"deviceId"`
	LastRevision       *int64                      `json:"lastRevision"`
	Commands           []syncCommandJSON           `json:"commands"`
	TaskOperations     []syncTaskOperationJSON     `json:"taskOperations,omitempty"`
	DurationOperations []syncDurationOperationJSON `json:"durationOperations,omitempty"`
}

type syncCommandJSON struct {
	ID                string `json:"id"`
	DeviceSequence    *int64 `json:"deviceSequence"`
	TimerID           string `json:"timerId"`
	TaskID            string `json:"taskId,omitempty"`
	Type              string `json:"type"`
	Phase             string `json:"phase"`
	PlannedDurationMs *int64 `json:"plannedDurationMs"`
	OccurredAt        string `json:"occurredAt"`
	HLCWallMs         *int64 `json:"hlcWallMs"`
	HLCCounter        *int64 `json:"hlcCounter"`
	ObservedElapsedMs *int64 `json:"observedElapsedMs"`
}

type syncTaskOperationJSON struct {
	ID         string `json:"id"`
	TaskID     string `json:"taskId"`
	Type       string `json:"type"`
	Title      string `json:"title,omitempty"`
	OccurredAt string `json:"occurredAt"`
	HLCWallMs  *int64 `json:"hlcWallMs"`
	HLCCounter *int64 `json:"hlcCounter"`
}

type syncDurationOperationJSON struct {
	ID         string `json:"id"`
	Phase      string `json:"phase"`
	DurationMs *int64 `json:"durationMs"`
	OccurredAt string `json:"occurredAt"`
	HLCWallMs  *int64 `json:"hlcWallMs"`
	HLCCounter *int64 `json:"hlcCounter"`
}

type bootstrapResolutionRequestJSON struct {
	RequestID          string                      `json:"requestId"`
	DeviceID           string                      `json:"deviceId"`
	ExpectedRevision   *int64                      `json:"expectedRevision"`
	Strategy           string                      `json:"strategy"`
	Commands           []syncCommandJSON           `json:"commands"`
	TaskOperations     []syncTaskOperationJSON     `json:"taskOperations"`
	DurationOperations []syncDurationOperationJSON `json:"durationOperations"`
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
		s.internalAPIError(w, "sync account mutations", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
	if result.Changed {
		s.hub.publish(identity.UserID, result.Revision)
	}
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request, identity principal) {
	db, err := s.store.OpenExistingUser(r.Context(), identity.UserID)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	result, err := s.store.Bootstrap(r.Context(), db, identity.UserID, time.Now())
	db.Close()
	if err != nil {
		s.internalAPIError(w, "read bootstrap snapshot", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleBootstrapResolve(w http.ResponseWriter, r *http.Request, identity principal) {
	now := time.Now()
	request, err := parseBootstrapResolutionRequest(w, r, now)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid bootstrap resolution request")
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
	result, err := s.store.ResolveBootstrap(r.Context(), db, identity.UserID, request, now)
	db.Close()
	if errors.Is(err, store.ErrRevisionConflict) {
		writeAPIError(w, http.StatusConflict, "revision conflict")
		return
	}
	if errors.Is(err, store.ErrRequestIDConflict) {
		writeAPIError(w, http.StatusConflict, "request ID conflict")
		return
	}
	if err != nil {
		s.internalAPIError(w, "resolve bootstrap history", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
	if result.Changed {
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
	if !validID(payload.DeviceID) || payload.LastRevision == nil || *payload.LastRevision < 0 || payload.Commands == nil || len(payload.Commands) > 256 || len(payload.TaskOperations) > 256 || len(payload.DurationOperations) > 256 {
		return store.SyncRequest{}, fmt.Errorf("invalid sync envelope")
	}
	request, err := parseOperations(payload.DeviceID, payload.Commands, payload.TaskOperations, payload.DurationOperations, 256, now)
	if err != nil {
		return store.SyncRequest{}, err
	}
	request.LastRevision = *payload.LastRevision
	return request, nil
}

func parseBootstrapResolutionRequest(w http.ResponseWriter, r *http.Request, now time.Time) (store.BootstrapResolutionRequest, error) {
	var payload bootstrapResolutionRequestJSON
	if err := decodeJSON(w, r, maxBootstrapBody, &payload); err != nil {
		return store.BootstrapResolutionRequest{}, err
	}
	_, validStrategy := validBootstrapStrategies[payload.Strategy]
	if !validID(payload.RequestID) || !validID(payload.DeviceID) || payload.ExpectedRevision == nil || *payload.ExpectedRevision < 0 || !validStrategy ||
		payload.Commands == nil || payload.TaskOperations == nil || payload.DurationOperations == nil ||
		len(payload.Commands) > 4096 || len(payload.TaskOperations) > 4096 || len(payload.DurationOperations) > 4096 {
		return store.BootstrapResolutionRequest{}, fmt.Errorf("invalid bootstrap resolution envelope")
	}
	if payload.Strategy == store.BootstrapKeepRemote && (len(payload.Commands) != 0 || len(payload.TaskOperations) != 0 || len(payload.DurationOperations) != 0) {
		return store.BootstrapResolutionRequest{}, fmt.Errorf("keep_remote requires empty operation arrays")
	}
	operations, err := parseOperations(payload.DeviceID, payload.Commands, payload.TaskOperations, payload.DurationOperations, 4096, now)
	if err != nil {
		return store.BootstrapResolutionRequest{}, err
	}
	return store.BootstrapResolutionRequest{
		RequestID: payload.RequestID, DeviceID: payload.DeviceID, ExpectedRevision: *payload.ExpectedRevision, Strategy: payload.Strategy,
		Commands: operations.Commands, TaskOperations: operations.TaskOperations, DurationOperations: operations.DurationOperations,
	}, nil
}

func parseOperations(deviceID string, commands []syncCommandJSON, taskOperations []syncTaskOperationJSON, durationOperations []syncDurationOperationJSON, maximum int, now time.Time) (store.SyncRequest, error) {
	if len(commands) > maximum || len(taskOperations) > maximum || len(durationOperations) > maximum {
		return store.SyncRequest{}, fmt.Errorf("too many operations")
	}
	request := store.SyncRequest{
		DeviceID:           deviceID,
		Commands:           make([]timer.Command, 0, len(commands)),
		TaskOperations:     make([]task.Operation, 0, len(taskOperations)),
		DurationOperations: make([]store.DurationOperation, 0, len(durationOperations)),
	}
	seenCommandIDs := make(map[string]struct{}, len(commands))
	seenTaskOperationIDs := make(map[string]struct{}, len(taskOperations))
	seenDurationOperationIDs := make(map[string]struct{}, len(durationOperations))
	for _, input := range commands {
		if !validID(input.ID) || !validID(input.TimerID) || input.DeviceSequence == nil || *input.DeviceSequence <= 0 {
			return store.SyncRequest{}, fmt.Errorf("invalid command identity")
		}
		if _, duplicate := seenCommandIDs[input.ID]; duplicate {
			return store.SyncRequest{}, fmt.Errorf("duplicate command identity")
		}
		seenCommandIDs[input.ID] = struct{}{}
		if _, valid := validTypes[input.Type]; !valid {
			return store.SyncRequest{}, fmt.Errorf("invalid command type")
		}
		if input.TaskID != "" && (!validID(input.TaskID) || input.Type != "start" || input.Phase != "focus") {
			return store.SyncRequest{}, fmt.Errorf("invalid task association")
		}
		if _, valid := validPhases[input.Phase]; !valid {
			return store.SyncRequest{}, fmt.Errorf("invalid command phase")
		}
		if input.PlannedDurationMs == nil || *input.PlannedDurationMs < int64(time.Minute/time.Millisecond) || *input.PlannedDurationMs > int64(4*time.Hour/time.Millisecond) {
			return store.SyncRequest{}, fmt.Errorf("invalid timer duration")
		}
		if input.HLCWallMs == nil || *input.HLCWallMs <= 0 || *input.HLCWallMs > now.Add(5*time.Minute).UnixMilli() || input.HLCCounter == nil || *input.HLCCounter < 0 || input.ObservedElapsedMs == nil {
			return store.SyncRequest{}, fmt.Errorf("invalid hybrid clock")
		}
		occurredAt, err := time.Parse(time.RFC3339Nano, input.OccurredAt)
		if err != nil {
			return store.SyncRequest{}, fmt.Errorf("invalid occurrence time")
		}
		request.Commands = append(request.Commands, timer.Command{
			ID: input.ID, DeviceID: deviceID, DeviceSequence: *input.DeviceSequence, TimerID: input.TimerID,
			TaskID: input.TaskID,
			Type:   input.Type, Phase: input.Phase, PlannedDurationMs: *input.PlannedDurationMs, OccurredAt: occurredAt,
			HLCWallMs: *input.HLCWallMs, HLCCounter: *input.HLCCounter, ObservedElapsedMs: *input.ObservedElapsedMs,
		})
	}
	for _, input := range taskOperations {
		if !validID(input.ID) || !validID(input.TaskID) {
			return store.SyncRequest{}, fmt.Errorf("invalid task operation identity")
		}
		if _, duplicate := seenTaskOperationIDs[input.ID]; duplicate {
			return store.SyncRequest{}, fmt.Errorf("duplicate task operation identity")
		}
		seenTaskOperationIDs[input.ID] = struct{}{}
		if _, valid := validTaskOperationTypes[input.Type]; !valid {
			return store.SyncRequest{}, fmt.Errorf("invalid task operation type")
		}
		title := ""
		if input.Type == "upsert" {
			title = task.NormalizeTitle(input.Title)
			if title == "" || len([]byte(title)) > 512 || task.ID(title) != input.TaskID {
				return store.SyncRequest{}, fmt.Errorf("invalid task title")
			}
		} else if input.Title != "" {
			return store.SyncRequest{}, fmt.Errorf("delete task operation has title")
		}
		if input.HLCWallMs == nil || *input.HLCWallMs <= 0 || *input.HLCWallMs > now.Add(5*time.Minute).UnixMilli() || input.HLCCounter == nil || *input.HLCCounter < 0 {
			return store.SyncRequest{}, fmt.Errorf("invalid task operation clock")
		}
		occurredAt, err := time.Parse(time.RFC3339Nano, input.OccurredAt)
		if err != nil {
			return store.SyncRequest{}, fmt.Errorf("invalid task occurrence time")
		}
		request.TaskOperations = append(request.TaskOperations, task.Operation{
			ID: input.ID, DeviceID: deviceID, TaskID: input.TaskID, Type: input.Type, Title: title,
			OccurredAt: occurredAt, HLCWallMs: *input.HLCWallMs, HLCCounter: *input.HLCCounter,
		})
	}
	for _, input := range durationOperations {
		if !validID(input.ID) {
			return store.SyncRequest{}, fmt.Errorf("invalid duration operation identity")
		}
		if _, duplicate := seenDurationOperationIDs[input.ID]; duplicate {
			return store.SyncRequest{}, fmt.Errorf("duplicate duration operation identity")
		}
		seenDurationOperationIDs[input.ID] = struct{}{}
		if _, valid := validPhases[input.Phase]; !valid {
			return store.SyncRequest{}, fmt.Errorf("invalid duration phase")
		}
		if input.DurationMs == nil || *input.DurationMs < 60_000 || *input.DurationMs > 10_800_000 || *input.DurationMs%60_000 != 0 {
			return store.SyncRequest{}, fmt.Errorf("invalid duration value")
		}
		if input.HLCWallMs == nil || *input.HLCWallMs < 0 || *input.HLCWallMs > now.Add(5*time.Minute).UnixMilli() || input.HLCCounter == nil || *input.HLCCounter < 0 {
			return store.SyncRequest{}, fmt.Errorf("invalid duration operation clock")
		}
		occurredAt, err := time.Parse(time.RFC3339Nano, input.OccurredAt)
		if err != nil {
			return store.SyncRequest{}, fmt.Errorf("invalid duration occurrence time")
		}
		request.DurationOperations = append(request.DurationOperations, store.DurationOperation{
			ID: input.ID, DeviceID: deviceID, Phase: input.Phase, DurationMs: *input.DurationMs,
			OccurredAt: occurredAt, HLCWallMs: *input.HLCWallMs, HLCCounter: *input.HLCCounter,
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
