package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

const (
	webSessionLifetime   = 30 * 24 * time.Hour
	accessTokenLifetime  = 15 * time.Minute
	refreshTokenLifetime = 30 * 24 * time.Hour
)

type googleIdentity struct {
	Issuer    string
	Subject   string
	Email     string
	Name      string
	AvatarURL string
}

type googleClaims struct {
	Nonce           string `json:"nonce"`
	Email           string `json:"email"`
	EmailVerified   bool   `json:"email_verified"`
	Name            string `json:"name"`
	Picture         string `json:"picture"`
	AuthorizedParty string `json:"azp"`
}

func (s *Server) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.WebAuthEnabled() {
		http.Error(w, "Google authentication unavailable", http.StatusServiceUnavailable)
		return
	}
	returnTo := safeReturnPath(r.URL.Query().Get("return"))
	stateValue, err := authn.RandomString(32)
	if err != nil {
		s.internalError(w, "generate OAuth state", err)
		return
	}
	nonce, err := authn.RandomString(32)
	if err != nil {
		s.internalError(w, "generate OAuth nonce", err)
		return
	}
	verifier, err := authn.RandomString(32)
	if err != nil {
		s.internalError(w, "generate PKCE verifier", err)
		return
	}
	expiresAt := time.Now().Add(authn.OAuthStateLifetime)
	state := authn.OAuthState{
		State:        stateValue,
		Nonce:        nonce,
		CodeVerifier: verifier,
		ReturnTo:     returnTo,
		ExpiresAt:    expiresAt.Unix(),
	}
	sealed, err := s.codec.Seal("oauth-state", state)
	if err != nil {
		s.internalError(w, "seal OAuth state", err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     authn.OAuthStateCookie,
		Value:    sealed,
		Path:     "/auth/google",
		Expires:  expiresAt,
		MaxAge:   int(authn.OAuthStateLifetime.Seconds()),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	authorizationURL := s.oauthConfig.AuthCodeURL(
		stateValue,
		oauth2.S256ChallengeOption(verifier),
		oauth2.SetAuthURLParam("nonce", nonce),
		oauth2.SetAuthURLParam("prompt", "select_account"),
	)
	http.Redirect(w, r, authorizationURL, http.StatusFound)
}

func (s *Server) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.WebAuthEnabled() {
		http.Error(w, "Google authentication unavailable", http.StatusServiceUnavailable)
		return
	}
	cookie, err := r.Cookie(authn.OAuthStateCookie)
	clearOAuthStateCookie(w)
	if err != nil {
		http.Error(w, "Invalid authentication state", http.StatusBadRequest)
		return
	}
	state, err := s.codec.OpenOAuthState(cookie.Value, time.Now())
	if err != nil || !authn.EqualString(state.State, r.URL.Query().Get("state")) || r.URL.Query().Get("code") == "" {
		http.Error(w, "Invalid authentication state", http.StatusBadRequest)
		return
	}
	googleContext, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	oauthToken, err := s.oauthConfig.Exchange(googleContext, r.URL.Query().Get("code"), oauth2.VerifierOption(state.CodeVerifier))
	if err != nil {
		s.logger.Warn("Google OAuth exchange failed", "error", err)
		http.Error(w, "Authentication failed", http.StatusBadGateway)
		return
	}
	rawIDToken, ok := oauthToken.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		http.Error(w, "Authentication failed", http.StatusBadGateway)
		return
	}
	identity, err := s.verifyGoogleIDToken(googleContext, rawIDToken, s.webVerifier, state.Nonce, map[string]struct{}{s.cfg.GoogleWebClientID: {}})
	if err != nil {
		s.logger.Warn("Google ID token verification failed", "error", err)
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}
	userID := authn.UserID(s.cfg.AppSecret, identity.Issuer, identity.Subject)
	unlock := s.store.LockUser(userID)
	defer unlock()
	db, err := s.store.OpenUser(r.Context(), userID)
	if err != nil {
		s.internalError(w, "open user account", err)
		return
	}
	defer db.Close()
	profile := store.Profile{ID: userID, Issuer: identity.Issuer, Subject: identity.Subject, Email: identity.Email, Name: identity.Name, AvatarURL: identity.AvatarURL}
	if err := store.UpsertProfile(r.Context(), db, profile, time.Now()); err != nil {
		s.internalError(w, "update user profile", err)
		return
	}
	sessionToken, sessionHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		s.internalError(w, "generate web session", err)
		return
	}
	csrfToken, err := authn.RandomString(32)
	if err != nil {
		s.internalError(w, "generate CSRF token", err)
		return
	}
	sessionID, err := authn.RandomString(32)
	if err != nil {
		s.internalError(w, "generate session id", err)
		return
	}
	now := time.Now()
	expiresAt := now.Add(webSessionLifetime)
	csrfHash := authn.HashString(csrfToken)
	if err := store.CreateSession(r.Context(), db, store.Session{
		ID: sessionID, Kind: "web", Platform: "web", CSRFHash: csrfHash[:], CreatedAt: now, ExpiresAt: expiresAt,
	}, []store.TokenRecord{{Hash: sessionHash, Kind: "web", CreatedAt: now, ExpiresAt: expiresAt}}); err != nil {
		s.internalError(w, "create web session", err)
		return
	}
	setSessionCookie(w, sessionToken, expiresAt)
	setCSRFCookie(w, csrfToken, expiresAt)
	http.Redirect(w, r, state.ReturnTo, http.StatusSeeOther)
}

func (s *Server) handleNativeChallenge(w http.ResponseWriter, _ *http.Request) {
	if !s.cfg.NativeAuthEnabled() {
		writeAPIError(w, http.StatusServiceUnavailable, "Google authentication unavailable")
		return
	}
	nonce, err := authn.RandomString(32)
	if err != nil {
		s.internalAPIError(w, "generate native nonce", err)
		return
	}
	expiresAt := time.Now().Add(authn.ChallengeLifetime)
	challenge := authn.NativeChallenge{Nonce: nonce, ExpiresAt: expiresAt.Unix()}
	sealed, err := s.codec.Seal("native-challenge", challenge)
	if err != nil {
		s.internalAPIError(w, "seal native challenge", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge": sealed,
		"nonce":     nonce,
		"expiresAt": expiresAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleNativeExchange(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.NativeAuthEnabled() {
		writeAPIError(w, http.StatusServiceUnavailable, "Google authentication unavailable")
		return
	}
	var request struct {
		IDToken   string `json:"idToken"`
		Challenge string `json:"challenge"`
		DeviceID  string `json:"deviceId"`
		Platform  string `json:"platform"`
	}
	if err := decodeJSON(w, r, 1<<20, &request); err != nil || request.IDToken == "" || request.Challenge == "" || !validID(request.DeviceID) || !validPlatform(request.Platform) {
		writeAPIError(w, http.StatusBadRequest, "invalid request")
		return
	}
	challenge, err := s.codec.OpenNativeChallenge(request.Challenge, time.Now())
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "invalid challenge")
		return
	}
	googleContext, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	identity, err := s.verifyGoogleIDToken(googleContext, request.IDToken, s.nativeVerifier, challenge.Nonce, s.cfg.GoogleNativeClientIDSet)
	if err != nil {
		s.logger.Warn("native Google ID token verification failed", "error", err)
		writeAPIError(w, http.StatusUnauthorized, "invalid Google token")
		return
	}
	userID := authn.UserID(s.cfg.AppSecret, identity.Issuer, identity.Subject)
	unlock := s.store.LockUser(userID)
	defer unlock()
	db, err := s.store.OpenUser(r.Context(), userID)
	if err != nil {
		s.internalAPIError(w, "open native user account", err)
		return
	}
	defer db.Close()
	profile := store.Profile{ID: userID, Issuer: identity.Issuer, Subject: identity.Subject, Email: identity.Email, Name: identity.Name, AvatarURL: identity.AvatarURL}
	if err := store.UpsertProfile(r.Context(), db, profile, time.Now()); err != nil {
		s.internalAPIError(w, "update native user profile", err)
		return
	}
	accessToken, refreshToken, session, tokens, err := newNativeSession(userID, request.DeviceID, request.Platform, time.Now())
	if err != nil {
		s.internalAPIError(w, "generate native session", err)
		return
	}
	if err := store.CreateSession(r.Context(), db, session, tokens); err != nil {
		s.internalAPIError(w, "create native session", err)
		return
	}
	writeJSON(w, http.StatusOK, nativeTokenResponse(accessToken, refreshToken, tokens[0].ExpiresAt, tokens[1].ExpiresAt))
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var request struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := decodeJSON(w, r, 64<<10, &request); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid request")
		return
	}
	userID, oldHash, err := authn.ParseOpaqueToken(request.RefreshToken)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	unlock := s.store.LockUser(userID)
	defer unlock()
	db, err := s.store.OpenExistingUser(r.Context(), userID)
	if err != nil {
		writeAPIError(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	defer db.Close()
	now := time.Now()
	accessToken, accessHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		s.internalAPIError(w, "generate access token", err)
		return
	}
	refreshToken, refreshHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		s.internalAPIError(w, "generate refresh token", err)
		return
	}
	access := store.TokenRecord{Hash: accessHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(accessTokenLifetime)}
	refresh := store.TokenRecord{Hash: refreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(refreshTokenLifetime)}
	if err := store.RotateRefresh(r.Context(), db, oldHash, access, refresh, now); err != nil {
		if errors.Is(err, store.ErrRefreshReuse) {
			s.logger.Warn("refresh token reuse revoked session family", "user_id", userID)
		}
		if isUnauthorized(err) || errors.Is(err, store.ErrRefreshReuse) {
			writeAPIError(w, http.StatusUnauthorized, "invalid refresh token")
			return
		}
		s.internalAPIError(w, "rotate refresh token", err)
		return
	}
	writeJSON(w, http.StatusOK, nativeTokenResponse(accessToken, refreshToken, access.ExpiresAt, refresh.ExpiresAt))
}

func (s *Server) verifyGoogleIDToken(ctx context.Context, rawToken string, verifier *oidc.IDTokenVerifier, expectedNonce string, allowedAudiences map[string]struct{}) (googleIdentity, error) {
	idToken, err := verifier.Verify(ctx, rawToken)
	if err != nil {
		return googleIdentity{}, err
	}
	if idToken.Issuer != googleIssuer && idToken.Issuer != "accounts.google.com" {
		return googleIdentity{}, errors.New("unexpected Google issuer")
	}
	if idToken.Expiry.Before(time.Now()) {
		return googleIdentity{}, errors.New("expired Google token")
	}
	if len(idToken.Audience) == 0 {
		return googleIdentity{}, errors.New("missing Google audience")
	}
	for _, audience := range idToken.Audience {
		if _, allowed := allowedAudiences[audience]; !allowed {
			return googleIdentity{}, errors.New("unexpected Google audience")
		}
	}
	var claims googleClaims
	if err := idToken.Claims(&claims); err != nil {
		return googleIdentity{}, fmt.Errorf("decode Google claims: %w", err)
	}
	if claims.AuthorizedParty != "" {
		if _, allowed := allowedAudiences[claims.AuthorizedParty]; !allowed {
			return googleIdentity{}, errors.New("unexpected Google authorized party")
		}
	} else if len(idToken.Audience) > 1 {
		return googleIdentity{}, errors.New("missing Google authorized party")
	}
	if expectedNonce == "" || !authn.EqualString(claims.Nonce, expectedNonce) {
		return googleIdentity{}, errors.New("Google nonce mismatch")
	}
	if !claims.EmailVerified || idToken.Subject == "" || claims.Email == "" {
		return googleIdentity{}, errors.New("unverified Google identity")
	}
	return googleIdentity{
		Issuer: googleIssuer, Subject: idToken.Subject, Email: claims.Email, Name: claims.Name, AvatarURL: claims.Picture,
	}, nil
}

func newNativeSession(userID, deviceID, platform string, now time.Time) (string, string, store.Session, []store.TokenRecord, error) {
	accessToken, accessHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		return "", "", store.Session{}, nil, err
	}
	refreshToken, refreshHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		return "", "", store.Session{}, nil, err
	}
	sessionID, err := authn.RandomString(32)
	if err != nil {
		return "", "", store.Session{}, nil, err
	}
	accessExpires := now.Add(accessTokenLifetime)
	refreshExpires := now.Add(refreshTokenLifetime)
	session := store.Session{ID: sessionID, Kind: "native", DeviceID: deviceID, Platform: platform, CreatedAt: now, ExpiresAt: refreshExpires}
	tokens := []store.TokenRecord{
		{Hash: accessHash, Kind: "access", CreatedAt: now, ExpiresAt: accessExpires},
		{Hash: refreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: refreshExpires},
	}
	return accessToken, refreshToken, session, tokens, nil
}

func nativeTokenResponse(accessToken, refreshToken string, accessExpires, refreshExpires time.Time) map[string]any {
	return map[string]any{
		"accessToken":           accessToken,
		"accessTokenExpiresAt":  accessExpires.UTC().Format(time.RFC3339),
		"refreshToken":          refreshToken,
		"refreshTokenExpiresAt": refreshExpires.UTC().Format(time.RFC3339),
	}
}

func safeReturnPath(value string) string {
	if value == "" || len(value) > 1024 {
		return "/"
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || !strings.HasPrefix(parsed.Path, "/") || strings.HasPrefix(parsed.Path, "//") || strings.Contains(parsed.Path, `\`) {
		return "/"
	}
	return parsed.RequestURI()
}

func setSessionCookie(w http.ResponseWriter, token string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: authn.WebSessionCookie, Value: token, Path: "/", Expires: expiresAt, MaxAge: int(time.Until(expiresAt).Seconds()),
		Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
}

func setCSRFCookie(w http.ResponseWriter, token string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: authn.CSRFCookie, Value: token, Path: "/", Expires: expiresAt, MaxAge: int(time.Until(expiresAt).Seconds()),
		Secure: true, HttpOnly: false, SameSite: http.SameSiteLaxMode,
	})
}

func clearOAuthStateCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: authn.OAuthStateCookie, Value: "", Path: "/auth/google", MaxAge: -1, Expires: time.Unix(1, 0),
		Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookies(w http.ResponseWriter) {
	for _, cookie := range []*http.Cookie{
		{Name: authn.WebSessionCookie, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(1, 0), Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode},
		{Name: authn.CSRFCookie, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(1, 0), Secure: true, HttpOnly: false, SameSite: http.SameSiteLaxMode},
	} {
		http.SetCookie(w, cookie)
	}
}

func (s *Server) internalError(w http.ResponseWriter, operation string, err error) {
	s.logger.Error(operation, "error", err)
	http.Error(w, "Internal Server Error", http.StatusInternalServerError)
}

func (s *Server) internalAPIError(w http.ResponseWriter, operation string, err error) {
	s.logger.Error(operation, "error", err)
	writeAPIError(w, http.StatusInternalServerError, "internal server error")
}
