package server

import (
	"net/http"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

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
			writeAPIError(w, http.StatusUnauthorized, "unauthorized")
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
			writeAPIError(w, http.StatusForbidden, "forbidden")
			return
		}
		s.handleDeleteAccount(w, r, identity)
	})
}
