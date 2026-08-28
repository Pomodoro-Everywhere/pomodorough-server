package server

import (
	"errors"
	"net/http"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, identity principal) {
	if err := s.store.ValidateAccountGeneration(r.Context(), identity.UserID, identity.Generation); err != nil {
		if isUnauthorized(err) {
			writeAPIError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		s.internalAPIError(w, "validate account generation", err)
		return
	}
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
			hash := authn.HashString(csrfToken)
			err = s.store.UpdateCSRFForGeneration(r.Context(), identity.UserID, identity.Generation, identity.SessionID, hash)
			if err != nil {
				if isUnauthorized(err) {
					writeAPIError(w, http.StatusUnauthorized, "unauthorized")
					return
				}
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
	err := s.store.RevokeSessionForGeneration(r.Context(), identity.UserID, identity.Generation, identity.SessionID, time.Now())
	if err != nil {
		if isUnauthorized(err) {
			writeAPIError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		s.internalAPIError(w, "revoke session", err)
		return
	}
	s.hub.disconnectSession(identity.UserID, identity.Generation, identity.SessionID)
	if identity.Method == "cookie" {
		clearSessionCookies(w)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request, identity principal) {
	var request struct {
		Confirmation string `json:"confirmation"`
	}
	if err := decodeJSON(w, r, 64<<10, &request); err != nil || request.Confirmation != "DELETE" {
		writeAPIError(w, http.StatusBadRequest, "type DELETE to confirm account deletion")
		return
	}
	if err := s.store.DeleteUserForGeneration(r.Context(), identity.UserID, identity.Generation); err != nil {
		if isUnauthorized(err) {
			writeAPIError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		s.internalAPIError(w, "delete account", err)
		return
	}
	s.hub.disconnect(identity.UserID, identity.Generation)
	s.logger.Info("account deleted")
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
	err := s.store.RevokeDeviceForGeneration(r.Context(), identity.UserID, identity.Generation, request.DeviceID, time.Now())
	if err != nil {
		if isUnauthorized(err) {
			writeAPIError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		s.internalAPIError(w, "revoke device", err)
		return
	}
	s.hub.disconnectDevice(identity.UserID, identity.Generation, request.DeviceID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request, identity principal) {
	request, err := parseSyncRequest(w, r, time.Now())
	if err != nil {
		if isRequestRuntimeError(err) {
			s.internalAPIError(w, "validate sync request with shared core", err)
			return
		}
		writeAPIError(w, http.StatusBadRequest, "invalid sync request")
		return
	}
	if identity.Method == "bearer" && !authn.EqualString(identity.DeviceID, request.DeviceID) {
		writeAPIError(w, http.StatusForbidden, "device mismatch")
		return
	}
	result, err := s.store.SyncForGeneration(r.Context(), identity.UserID, identity.Generation, request, time.Now())
	if isUnauthorized(err) {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if errors.Is(err, store.ErrRevisionExhausted) {
		writeAPIError(w, http.StatusConflict, "revision exhausted")
		return
	}
	if err != nil {
		s.internalAPIError(w, "sync account mutations", err)
		return
	}
	s.logger.Info("sync applied",
		"changed", result.Changed,
		"revision", result.Revision,
		"timer_commands", len(request.Commands),
		"task_operations", len(request.TaskOperations),
		"duration_operations", len(request.DurationOperations),
		"auto_start_operations", len(request.AutoStartOperations),
		"selected_task_operations", len(request.SelectedTaskOperations),
	)
	writeJSON(w, http.StatusOK, result)
	if result.Changed {
		s.hub.publish(identity.UserID, identity.Generation, result.Revision)
	}
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request, identity principal) {
	result, err := s.store.BootstrapForGeneration(r.Context(), identity.UserID, identity.Generation, time.Now())
	if isUnauthorized(err) {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if errors.Is(err, store.ErrRevisionExhausted) {
		writeAPIError(w, http.StatusConflict, "revision exhausted")
		return
	}
	if err != nil {
		s.internalAPIError(w, "read bootstrap snapshot", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
	if result.Changed {
		s.hub.publish(identity.UserID, identity.Generation, result.Revision)
	}
}

func (s *Server) handleBootstrapResolve(w http.ResponseWriter, r *http.Request, identity principal) {
	now := time.Now()
	request, err := parseBootstrapResolutionRequest(w, r, now)
	if err != nil {
		if isRequestRuntimeError(err) {
			s.internalAPIError(w, "validate bootstrap resolution with shared core", err)
			return
		}
		writeAPIError(w, http.StatusBadRequest, "invalid bootstrap resolution request")
		return
	}
	if identity.Method == "bearer" && !authn.EqualString(identity.DeviceID, request.DeviceID) {
		writeAPIError(w, http.StatusForbidden, "device mismatch")
		return
	}
	result, err := s.store.ResolveBootstrapForGeneration(r.Context(), identity.UserID, identity.Generation, request, now)
	if isUnauthorized(err) {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if errors.Is(err, store.ErrRevisionConflict) {
		writeAPIError(w, http.StatusConflict, "revision conflict")
		return
	}
	if errors.Is(err, store.ErrRequestIDConflict) {
		writeAPIError(w, http.StatusConflict, "request ID conflict")
		return
	}
	if errors.Is(err, store.ErrRevisionExhausted) {
		writeAPIError(w, http.StatusConflict, "revision exhausted")
		return
	}
	if err != nil {
		s.internalAPIError(w, "resolve bootstrap history", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
	if result.Changed {
		s.hub.publish(identity.UserID, identity.Generation, result.Revision)
	}
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request, identity principal) {
	history, revision, changed, err := s.store.HistoryForGeneration(r.Context(), identity.UserID, identity.Generation, time.Now())
	if isUnauthorized(err) {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if errors.Is(err, store.ErrRevisionExhausted) {
		writeAPIError(w, http.StatusConflict, "revision exhausted")
		return
	}
	if err != nil {
		s.internalAPIError(w, "read timer history", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": history})
	if changed {
		s.hub.publish(identity.UserID, identity.Generation, revision)
	}
}
