package server

import (
	"net/http"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

// Legacy web markers may predate verified issuance. This read-only endpoint
// confirms an existing receipt without falling through to live account deletion.
func (s *Server) handleAccountDeletionReceipt(w http.ResponseWriter, r *http.Request) {
	userID, credential, err := requestCredential(r)
	if err != nil {
		writeAPIError(w, r, http.StatusUnauthorized, "unauthorized")
		return
	}
	if allowed, retryAfter := s.accountLimiter.allow(userID, time.Now()); !allowed {
		s.writeRateLimit(w, r, "account", retryAfter)
		return
	}
	receipt, err := s.store.CommittedDeletionReceipt(userID, credential)
	if err != nil {
		s.internalAPIError(w, r, "read deletion receipt", err)
		return
	}
	if receipt.Generation == 0 {
		writeAPIError(w, r, http.StatusNotFound, "deletion receipt not found")
		return
	}
	identity := principal{UserID: userID, Generation: receipt.Generation,
		Method: credential.Method, CSRFHash: receipt.CSRFHash}
	if !validAccountIncarnation(w, r, identity) {
		return
	}
	if identity.Method == "cookie" && !s.validCSRF(r, identity) {
		writeAPIError(w, r, http.StatusForbidden, "forbidden")
		return
	}
	// DeleteUserWithReceipt can still be purging after committing its receipt.
	// Ready must verify that purge before local queues can be discarded.
	if err := s.store.Ready(r.Context()); err != nil {
		w.Header().Set("Retry-After", "1")
		writeAPIError(w, r, http.StatusServiceUnavailable, "deletion cleanup pending")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func requestCredential(r *http.Request) (string, store.DeletionCredential, error) {
	var token string
	credential := store.DeletionCredential{Method: "cookie"}
	if authorization := r.Header.Get("Authorization"); authorization != "" {
		var err error
		token, err = authn.BearerToken(authorization)
		if err != nil {
			return "", credential, store.ErrUnauthorized
		}
		credential.Method = "bearer"
	} else {
		cookie, err := r.Cookie(authn.WebSessionCookie)
		if err != nil {
			return "", credential, store.ErrUnauthorized
		}
		token = cookie.Value
	}
	userID, hash, err := authn.ParseOpaqueToken(token)
	credential.TokenHash = hash
	return userID, credential, err
}

func (s *Server) requireAccountDeletion() http.Handler {
	liveDeletion := s.requireMutation(s.handleDeleteAccount)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, credential, err := requestCredential(r)
		if err != nil {
			writeAPIError(w, r, http.StatusUnauthorized, "unauthorized")
			return
		}
		receipt, err := s.store.CommittedDeletionReceipt(userID, credential)
		if err != nil {
			s.internalAPIError(w, r, "read deletion receipt", err)
			return
		}
		if receipt.Generation == 0 {
			liveDeletion.ServeHTTP(w, r)
			return
		}
		identity := principal{
			UserID: userID, Generation: receipt.Generation, Method: credential.Method,
			CSRFHash: receipt.CSRFHash, Credential: credential,
		}
		if allowed, retryAfter := s.accountLimiter.allow(userID, time.Now()); !allowed {
			s.writeRateLimit(w, r, "account", retryAfter)
			return
		}
		if identity.Method == "cookie" && !s.validCSRF(r, identity) {
			writeAPIError(w, r, http.StatusForbidden, "forbidden")
			return
		}
		s.handleDeleteAccount(w, r, identity)
	})
}
