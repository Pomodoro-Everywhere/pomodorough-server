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
	webSessionLifetime    = 30 * 24 * time.Hour
	accessTokenLifetime   = 15 * time.Minute
	refreshTokenLifetime  = 30 * 24 * time.Hour
	nativeChallengeDomain = "google-native-exchange-v1"
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

type oauthStateResult struct {
	state     authn.OAuthState
	sealed    string
	expiresAt time.Time
}

type webSessionResult struct {
	sessionToken string
	csrfToken    string
	expiresAt    time.Time
}

type nativeSessionResult struct {
	accessToken   string
	refreshToken  string
	accessExpiry  time.Time
	refreshExpiry time.Time
}

type authOperationFailure struct {
	operation string
	err       error
}

type googleAuthenticationFailure struct {
	status     int
	logMessage string
	err        error
}

func (s *Server) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.WebAuthEnabled() {
		http.Error(w, "Google authentication unavailable", http.StatusServiceUnavailable)
		return
	}
	result, failure := s.createOAuthState(safeReturnPath(r.URL.Query().Get("return")))
	if failure != nil {
		s.internalError(w, r, failure.operation, failure.err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     authn.OAuthStateCookie,
		Value:    result.sealed,
		Path:     "/auth/google",
		Expires:  result.expiresAt,
		MaxAge:   int(authn.OAuthStateLifetime.Seconds()),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	authorizationURL := s.oauthConfig.AuthCodeURL(
		result.state.State,
		oauth2.S256ChallengeOption(result.state.CodeVerifier),
		oauth2.SetAuthURLParam("nonce", result.state.Nonce),
		oauth2.SetAuthURLParam("prompt", "select_account"),
	)
	http.Redirect(w, r, authorizationURL, http.StatusFound)
}

func (s *Server) createOAuthState(returnTo string) (oauthStateResult, *authOperationFailure) {
	stateValue, err := authn.RandomString(32)
	if err != nil {
		return oauthStateResult{}, &authOperationFailure{"generate OAuth state", err}
	}
	nonce, err := authn.RandomString(32)
	if err != nil {
		return oauthStateResult{}, &authOperationFailure{"generate OAuth nonce", err}
	}
	verifier, err := authn.RandomString(32)
	if err != nil {
		return oauthStateResult{}, &authOperationFailure{"generate PKCE verifier", err}
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
		return oauthStateResult{}, &authOperationFailure{"seal OAuth state", err}
	}
	return oauthStateResult{state: state, sealed: sealed, expiresAt: expiresAt}, nil
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
	code := r.URL.Query().Get("code")
	if err != nil || !authn.EqualString(state.State, r.URL.Query().Get("state")) || code == "" {
		http.Error(w, "Invalid authentication state", http.StatusBadRequest)
		return
	}
	googleContext, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	identity, googleFailure := s.exchangeAndVerifyGoogle(googleContext, code, state)
	if googleFailure != nil {
		if googleFailure.logMessage != "" {
			s.logger.Warn(googleFailure.logMessage, "error", googleFailure.err)
		}
		http.Error(w, "Authentication failed", googleFailure.status)
		return
	}
	session, failure := s.persistWebAccount(r.Context(), identity)
	if failure != nil {
		s.internalError(w, r, failure.operation, failure.err)
		return
	}
	setSessionCookie(w, session.sessionToken, session.expiresAt)
	setCSRFCookie(w, session.csrfToken, session.expiresAt)
	http.Redirect(w, r, state.ReturnTo, http.StatusSeeOther)
}

func (s *Server) exchangeAndVerifyGoogle(ctx context.Context, code string, state authn.OAuthState) (googleIdentity, *googleAuthenticationFailure) {
	oauthToken, err := s.oauthConfig.Exchange(ctx, code, oauth2.VerifierOption(state.CodeVerifier))
	if err != nil {
		return googleIdentity{}, &googleAuthenticationFailure{
			status: http.StatusBadGateway, logMessage: "Google OAuth exchange failed", err: err,
		}
	}
	rawIDToken, ok := oauthToken.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return googleIdentity{}, &googleAuthenticationFailure{status: http.StatusBadGateway}
	}
	identity, err := s.verifyGoogleIDToken(
		ctx,
		rawIDToken,
		s.webVerifier,
		state.Nonce,
		map[string]struct{}{s.cfg.GoogleWebClientID: {}},
	)
	if err != nil {
		return googleIdentity{}, &googleAuthenticationFailure{
			status: http.StatusUnauthorized, logMessage: "Google ID token verification failed", err: err,
		}
	}
	return identity, nil
}

func (s *Server) persistWebAccount(ctx context.Context, identity googleIdentity) (webSessionResult, *authOperationFailure) {
	userID := authn.UserID(s.cfg.AppSecret, identity.Issuer, identity.Subject)
	unlock := s.store.LockUser(userID)
	defer unlock()
	db, err := s.store.OpenUser(ctx, userID)
	if err != nil {
		return webSessionResult{}, &authOperationFailure{"open user account", err}
	}
	defer db.Close()
	profile := store.Profile{ID: userID, Issuer: identity.Issuer, Subject: identity.Subject, Email: identity.Email, Name: identity.Name, AvatarURL: identity.AvatarURL}
	if err := store.UpsertProfile(ctx, db, profile, time.Now()); err != nil {
		return webSessionResult{}, &authOperationFailure{"update user profile", err}
	}
	sessionToken, sessionHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		return webSessionResult{}, &authOperationFailure{"generate web session", err}
	}
	csrfToken, err := authn.RandomString(32)
	if err != nil {
		return webSessionResult{}, &authOperationFailure{"generate CSRF token", err}
	}
	sessionID, err := authn.RandomString(32)
	if err != nil {
		return webSessionResult{}, &authOperationFailure{"generate session id", err}
	}
	now := time.Now()
	expiresAt := now.Add(webSessionLifetime)
	csrfHash := authn.HashString(csrfToken)
	if err := store.CreateSession(ctx, db, store.Session{
		ID: sessionID, Kind: "web", Platform: "web", CSRFHash: csrfHash[:], CreatedAt: now, ExpiresAt: expiresAt,
	}, []store.TokenRecord{{Hash: sessionHash, Kind: "web", CreatedAt: now, ExpiresAt: expiresAt}}); err != nil {
		return webSessionResult{}, &authOperationFailure{"create web session", err}
	}
	return webSessionResult{sessionToken: sessionToken, csrfToken: csrfToken, expiresAt: expiresAt}, nil
}

func (s *Server) handleNativeChallenge(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.NativeAuthEnabled() {
		writeAPIError(w, http.StatusServiceUnavailable, "Google authentication unavailable")
		return
	}
	nonce, err := authn.RandomString(32)
	if err != nil {
		s.internalAPIError(w, r, "generate native nonce", err)
		return
	}
	issuedAt := time.Now()
	expiresAt := issuedAt.Add(authn.ChallengeLifetime)
	challenge := authn.NativeChallenge{Nonce: nonce, ExpiresAt: expiresAt.Unix()}
	sealed, err := s.codec.Seal("native-challenge", challenge)
	if err != nil {
		s.internalAPIError(w, r, "seal native challenge", err)
		return
	}
	digest := store.HashNativeChallenge(nativeChallengeDomain, sealed)
	if err := s.store.CreateNativeChallenge(r.Context(), digest, nativeChallengeDomain, issuedAt, time.Unix(challenge.ExpiresAt, 0)); err != nil {
		s.internalAPIError(w, r, "persist native challenge", err)
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
	digest := store.HashNativeChallenge(nativeChallengeDomain, request.Challenge)
	session, failure := s.persistNativeAccount(r.Context(), identity, request.DeviceID, request.Platform, digest)
	if failure != nil {
		if isUnauthorized(failure.err) {
			writeAPIError(w, http.StatusUnauthorized, "invalid challenge")
			return
		}
		s.internalAPIError(w, r, failure.operation, failure.err)
		return
	}
	writeJSON(w, http.StatusOK, nativeTokenResponse(session.accessToken, session.refreshToken, session.accessExpiry, session.refreshExpiry))
}

func (s *Server) persistNativeAccount(ctx context.Context, identity googleIdentity, deviceID, platform string, challengeDigest [32]byte) (nativeSessionResult, *authOperationFailure) {
	userID := authn.UserID(s.cfg.AppSecret, identity.Issuer, identity.Subject)
	unlock := s.store.LockUser(userID)
	defer unlock()
	db, err := s.store.OpenUser(ctx, userID)
	if err != nil {
		return nativeSessionResult{}, &authOperationFailure{"open native user account", err}
	}
	defer db.Close()
	now := time.Now()
	profile := store.Profile{ID: userID, Issuer: identity.Issuer, Subject: identity.Subject, Email: identity.Email, Name: identity.Name, AvatarURL: identity.AvatarURL}
	accessToken, refreshToken, session, tokens, err := newNativeSession(userID, deviceID, platform, now)
	if err != nil {
		return nativeSessionResult{}, &authOperationFailure{"generate native session", err}
	}
	consumption := store.NativeChallengeConsumption{
		Digest: challengeDigest, Domain: nativeChallengeDomain, Now: now, Profile: profile, Session: session, Tokens: tokens,
	}
	if err := s.store.ConsumeNativeChallengeAndCreateSession(ctx, db, consumption); err != nil {
		return nativeSessionResult{}, &authOperationFailure{"consume native challenge", err}
	}
	return nativeSessionResult{
		accessToken: accessToken, refreshToken: refreshToken,
		accessExpiry: tokens[0].ExpiresAt, refreshExpiry: tokens[1].ExpiresAt,
	}, nil
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
		s.internalAPIError(w, r, "generate access token", err)
		return
	}
	refreshToken, refreshHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		s.internalAPIError(w, r, "generate refresh token", err)
		return
	}
	access := store.TokenRecord{Hash: accessHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(accessTokenLifetime)}
	refresh := store.TokenRecord{Hash: refreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(refreshTokenLifetime)}
	if err := store.RotateRefresh(r.Context(), db, oldHash, access, refresh, now); err != nil {
		// Warn-only: reuse is an expected client-driven 401 (replay/retry) with the
		// family already revoked in the store; Sentry stays reserved for internal failures below.
		if errors.Is(err, store.ErrRefreshReuse) {
			s.logger.Warn("refresh token reuse revoked session family")
		}
		if isUnauthorized(err) || errors.Is(err, store.ErrRefreshReuse) {
			writeAPIError(w, http.StatusUnauthorized, "invalid refresh token")
			return
		}
		s.internalAPIError(w, r, "rotate refresh token", err)
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

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	s.logger.Error(operation, "error", err)
	reportInternalErrorToErrorMonitoring(err, r, operation)
	http.Error(w, "Internal Server Error", http.StatusInternalServerError)
}

func (s *Server) internalAPIError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	s.logger.Error(operation, "error", err)
	reportInternalErrorToErrorMonitoring(err, r, operation)
	writeAPIError(w, http.StatusInternalServerError, "internal server error")
}
