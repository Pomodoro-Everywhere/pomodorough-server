package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
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
		s.writeGoogleCallbackFailure(w, r, googleFailure)
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

// writeGoogleCallbackFailure keeps the 401/502 wire but logs bounded
// cause classes only. Raw OAuth exchange errors carry provider bodies
// and token URLs up to 12KB; raw verify errors carry unverified claims.
// Both stay out of logs. Exchange stays WARN plus one sampled Sentry
// event; verify stays WARN with a static reason and no event.
// Cancellation stays INFO with no event.
func (s *Server) writeGoogleCallbackFailure(w http.ResponseWriter, r *http.Request, failure *googleAuthenticationFailure) {
	if failure == nil {
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}
	if failure.err != nil && isRequestCancellation(failure.err, r.Context()) {
		s.logger.Info("Google OAuth exchange canceled", "cause", monitoringCause(failure.err))
		http.Error(w, "Authentication failed", failure.status)
		return
	}
	if failure.status == http.StatusBadGateway {
		cause := "missing_token"
		reportErr := failure.err
		if reportErr != nil {
			cause = monitoringCause(reportErr)
		} else {
			reportErr = errors.New("missing Google ID token")
		}
		s.logger.Warn("Google OAuth exchange failed", "cause", cause)
		reportInternalErrorToErrorMonitoring(reportErr, r, "Google OAuth exchange failed")
		http.Error(w, "Authentication failed", failure.status)
		return
	}
	reason := googleVerifyFailureReason(failure.err)
	if reason == nativeTokenReasonAudience {
		s.logger.Debug("Google ID token audience classified", "cause", reason)
	}
	s.logger.Warn("Google ID token verification failed", "reason", reason)
	http.Error(w, "Authentication failed", failure.status)
}

// googleVerifyFailureReason extracts the bounded taxonomy from a web
// verify error. Typed client rejections return their static reason;
// provider outages return provider_unavailable; anything else collapses
// to monitoringCause so logs stay bounded and PII-free.
func googleVerifyFailureReason(err error) string {
	if err == nil {
		return "invalid_token"
	}
	var clientErr *googleTokenClientError
	if errors.As(err, &clientErr) && clientErr.reason != "" {
		return clientErr.reason
	}
	var providerErr *googleKeyProviderError
	if errors.As(err, &providerErr) {
		return nativeTokenReasonProvider
	}
	cause := monitoringCause(err)
	if cause == "" || cause == "internal" {
		return "invalid_token"
	}
	return cause
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
		writeAPIError(w, r, http.StatusServiceUnavailable, "Google authentication unavailable")
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
	writeJSON(w, r, http.StatusOK, map[string]any{
		"challenge": sealed,
		"nonce":     nonce,
		"expiresAt": expiresAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleNativeExchange(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.NativeAuthEnabled() {
		writeAPIError(w, r, http.StatusServiceUnavailable, "Google authentication unavailable")
		return
	}
	var request struct {
		IDToken   string `json:"idToken"`
		Challenge string `json:"challenge"`
		DeviceID  string `json:"deviceId"`
		Platform  string `json:"platform"`
	}
	if err := decodeJSON(w, r, 1<<20, &request); err != nil || request.IDToken == "" || request.Challenge == "" || !validID(request.DeviceID) || !validPlatform(request.Platform) {
		writeAPIError(w, r, http.StatusBadRequest, "invalid request")
		return
	}
	challenge, err := s.codec.OpenNativeChallenge(request.Challenge, time.Now())
	if err != nil {
		writeAPIError(w, r, http.StatusUnauthorized, "invalid challenge")
		return
	}
	googleContext, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	identity, err := s.verifyGoogleIDToken(googleContext, request.IDToken, s.nativeVerifier, challenge.Nonce, s.cfg.GoogleNativeClientIDSet)
	if err != nil {
		s.writeNativeVerifyFailure(w, r, err)
		return
	}
	digest := store.HashNativeChallenge(nativeChallengeDomain, request.Challenge)
	session, failure := s.persistNativeAccount(r.Context(), identity, request.DeviceID, request.Platform, digest)
	if failure != nil {
		if isUnauthorized(failure.err) {
			writeAPIError(w, r, http.StatusUnauthorized, "invalid challenge")
			return
		}
		s.internalAPIError(w, r, failure.operation, failure.err)
		return
	}
	writeJSON(w, r, http.StatusOK, nativeTokenResponse(session.accessToken, session.refreshToken, session.accessExpiry, session.refreshExpiry))
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
		writeAPIError(w, r, http.StatusBadRequest, "invalid request")
		return
	}
	userID, oldHash, err := authn.ParseOpaqueToken(request.RefreshToken)
	if err != nil {
		writeAPIError(w, r, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	unlock := s.store.LockUser(userID)
	defer unlock()
	db, err := s.store.OpenExistingUser(r.Context(), userID)
	if err != nil {
		s.writeRefreshOpenError(w, r, err)
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
		s.writeRefreshRotationError(w, r, userID, err)
		return
	}
	writeJSON(w, r, http.StatusOK, nativeTokenResponse(accessToken, refreshToken, access.ExpiresAt, refresh.ExpiresAt))
}

func (s *Server) writeRefreshRotationError(w http.ResponseWriter, r *http.Request, userID string, err error) {
	var revoked *store.RefreshReuseError
	if errors.As(err, &revoked) {
		s.hub.disconnectSession(userID, revoked.Generation, revoked.SessionID)
		// Reuse is an expected client-driven 401. Do not report credentials or session identities.
		s.logger.Warn("refresh token reuse revoked session family")
		s.logger.Debug("refresh rotation classified", "cause", "reuse_detected")
	}
	if isUnauthorized(err) || errors.Is(err, store.ErrRefreshReuse) {
		writeAPIError(w, r, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	if isRequestCancellation(err, r.Context()) {
		s.writeCanceledInternalError(w, r, "rotate refresh token", err)
		return
	}
	s.internalAPIError(w, r, "rotate refresh token", err)
}

func (s *Server) writeRefreshOpenError(w http.ResponseWriter, r *http.Request, err error) {
	if isUnauthorized(err) {
		writeAPIError(w, r, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	if isRequestCancellation(err, r.Context()) {
		s.writeCanceledInternalError(w, r, "open user account for refresh", err)
		return
	}
	s.internalAPIError(w, r, "open user account for refresh", err)
}

func (s *Server) verifyGoogleIDToken(ctx context.Context, rawToken string, verifier *oidc.IDTokenVerifier, expectedNonce string, allowedAudiences map[string]struct{}) (googleIdentity, error) {
	if err := checkGoogleTokenFormat(rawToken); err != nil {
		return googleIdentity{}, &googleTokenClientError{reason: nativeTokenReasonMalformed, err: err}
	}
	// oidc flattens key-set errors with %v, which drops the wrap chain.
	// The observing key set records a provider failure in the per-request
	// slot before that flattening, so classification stays typed.
	verifyCtx, outcome := withGoogleVerifyOutcome(ctx)
	idToken, err := verifier.Verify(verifyCtx, rawToken)
	if err != nil {
		if outcome.providerFailure != nil {
			return googleIdentity{}, outcome.providerFailure
		}
		return googleIdentity{}, classifyGoogleVerifyError(err)
	}
	return checkGoogleTokenClaims(idToken, expectedNonce, allowedAudiences)
}

func checkGoogleTokenClaims(idToken *oidc.IDToken, expectedNonce string, allowedAudiences map[string]struct{}) (googleIdentity, error) {
	client := func(reason string, err error) (googleIdentity, error) {
		return googleIdentity{}, &googleTokenClientError{reason: reason, err: err}
	}
	if idToken.Issuer != googleIssuer && idToken.Issuer != "accounts.google.com" {
		return client(nativeTokenReasonIssuer, errors.New("unexpected Google issuer"))
	}
	if idToken.Expiry.Before(time.Now()) {
		return client(nativeTokenReasonExpired, errors.New("expired Google token"))
	}
	if len(idToken.Audience) == 0 {
		return client(nativeTokenReasonAudience, errors.New("missing Google audience"))
	}
	for _, audience := range idToken.Audience {
		if _, allowed := allowedAudiences[audience]; !allowed {
			return client(nativeTokenReasonAudience, errors.New("unexpected Google audience"))
		}
	}
	var claims googleClaims
	if err := idToken.Claims(&claims); err != nil {
		return client(nativeTokenReasonClaims, err)
	}
	if claims.AuthorizedParty != "" {
		if _, allowed := allowedAudiences[claims.AuthorizedParty]; !allowed {
			return client(nativeTokenReasonAudience, errors.New("unexpected Google authorized party"))
		}
	} else if len(idToken.Audience) > 1 {
		return client(nativeTokenReasonAudience, errors.New("missing Google authorized party"))
	}
	if expectedNonce == "" || !authn.EqualString(claims.Nonce, expectedNonce) {
		return client(nativeTokenReasonNonce, errors.New("Google nonce mismatch"))
	}
	if !claims.EmailVerified || idToken.Subject == "" || claims.Email == "" {
		return client(nativeTokenReasonIdentity, errors.New("unverified Google identity"))
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

// Native token rejection taxonomy. Every reason is a static allowlist
// value: raw tokens, challenges, emails, and provider bodies never enter
// logs or monitoring through this path. R51-S02 narrows the earlier S22
// outage reporting to genuine key-provider failures.
const (
	nativeTokenReasonMalformed = "malformed_token"
	nativeTokenReasonSignature = "invalid_signature"
	nativeTokenReasonExpired   = "expired_token"
	nativeTokenReasonIssuer    = "invalid_issuer"
	nativeTokenReasonAudience  = "invalid_audience"
	nativeTokenReasonClaims    = "invalid_claims"
	nativeTokenReasonNonce     = "invalid_nonce"
	nativeTokenReasonIdentity  = "unverified_identity"
	nativeTokenReasonProvider  = "provider_unavailable"
	nativeTokenReasonCanceled  = "request_canceled"
)

// googleTokenClientError marks an expected client-driven token rejection:
// malformed syntax, bad signature, or failed claims. It carries no Sentry
// report; the bounded reason is the whole diagnostic.
type googleTokenClientError struct {
	reason string
	err    error
}

func (e *googleTokenClientError) Error() string { return "invalid Google ID token: " + e.reason }
func (e *googleTokenClientError) Unwrap() error { return e.err }

// googleKeyProviderError marks a genuine Google key-set outage: the JWKS
// transport failed or returned a non-200 status. It keeps the existing
// Sentry report and lets the client retry with an unconsumed challenge.
type googleKeyProviderError struct {
	status int
	err    error
}

func (e *googleKeyProviderError) Error() string {
	if e.status != 0 {
		return fmt.Sprintf("Google key set unavailable: HTTP %d", e.status)
	}
	return "Google key set unavailable"
}

func (e *googleKeyProviderError) Unwrap() error { return e.err }

// keyProviderTransport converts JWKS fetch failures into the typed
// provider error at the HTTP boundary, before oidc flattens the status
// and body into an untyped string. Non-200 bodies are discarded here and
// never logged or reported. Key verification itself stays with oidc.
type keyProviderTransport struct {
	base http.RoundTripper
}

func (t *keyProviderTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(request)
	if err != nil {
		return nil, &googleKeyProviderError{err: err}
	}
	if response.StatusCode != http.StatusOK {
		_ = response.Body.Close()
		return nil, &googleKeyProviderError{status: response.StatusCode, err: errors.New("key set request failed")}
	}
	return response, nil
}

// googleVerifyOutcome carries the key-set classification across the oidc
// verify call, which stringifies key-set errors and drops their wrap
// chain. One slot per verification request, so concurrent exchanges never
// share classification state.
type googleVerifyOutcome struct {
	providerFailure error
}

type googleVerifyOutcomeKey struct{}

func withGoogleVerifyOutcome(ctx context.Context) (context.Context, *googleVerifyOutcome) {
	outcome := &googleVerifyOutcome{}
	return context.WithValue(ctx, googleVerifyOutcomeKey{}, outcome), outcome
}

// observingKeySet delegates verification to the wrapped key set and
// records genuine key-provider failures in the request slot while the
// typed error chain is still intact. Signature and claim rejections leave
// the slot empty and classify as expected client errors.
type observingKeySet struct {
	inner oidc.KeySet
}

func (k *observingKeySet) VerifySignature(ctx context.Context, jwt string) ([]byte, error) {
	payload, err := k.inner.VerifySignature(ctx, jwt)
	if err == nil {
		return payload, nil
	}
	outcome, ok := ctx.Value(googleVerifyOutcomeKey{}).(*googleVerifyOutcome)
	if ok && outcome != nil {
		var providerErr *googleKeyProviderError
		if errors.As(err, &providerErr) {
			outcome.providerFailure = providerErr
		}
	}
	return nil, err
}

// checkGoogleTokenFormat rejects structurally malformed tokens before any
// key fetch, so garbage never triggers a provider round trip.
func checkGoogleTokenFormat(rawToken string) error {
	parts := strings.Split(rawToken, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return errors.New("token must have three segments")
	}
	if header, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil || len(header) == 0 {
		return errors.New("token header is not base64url")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) == 0 {
		return errors.New("token payload is not base64url")
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return errors.New("token payload is not JSON")
	}
	if _, err := base64.RawURLEncoding.DecodeString(parts[2]); err != nil {
		return errors.New("token signature is not base64url")
	}
	return nil
}

// classifyGoogleVerifyError separates expected token rejection from key
// provider outage using only errors.Is and errors.As. Untyped verify
// failures that survive format, provider, cancellation, and expiry checks
// are signature-envelope rejections, fail closed as client errors.
func classifyGoogleVerifyError(err error) error {
	var providerErr *googleKeyProviderError
	if errors.As(err, &providerErr) {
		return providerErr
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	var expired *oidc.TokenExpiredError
	if errors.As(err, &expired) {
		return &googleTokenClientError{reason: nativeTokenReasonExpired, err: err}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &googleKeyProviderError{err: err}
	}
	return &googleTokenClientError{reason: nativeTokenReasonSignature, err: err}
}

// isNativeVerifyCanceled reports client-driven cancellation: a canceled
// chain or a dead request context. A live-context verify timeout stays a
// provider outage so slow key fetches keep their Sentry report.
func isNativeVerifyCanceled(err error, r *http.Request) bool {
	if errors.Is(err, context.Canceled) {
		return true
	}
	if r == nil {
		return false
	}
	return errors.Is(r.Context().Err(), context.Canceled) || errors.Is(r.Context().Err(), context.DeadlineExceeded)
}

// writeNativeVerifyFailure keeps the 401 wire for every verification
// outcome but splits the diagnostic: expected client rejection and
// cancellation stay Sentry-free with static WARN/INFO reasons, while a
// genuine provider outage keeps the ERROR log plus one sampled event.
// The challenge stays unconsumed on all three paths, so the client can
// retry without a new challenge.
func (s *Server) writeNativeVerifyFailure(w http.ResponseWriter, r *http.Request, err error) {
	if isNativeVerifyCanceled(err, r) {
		s.logger.Info("native Google ID token verification canceled", "reason", nativeTokenReasonCanceled)
		if s.metrics != nil && r != nil {
			s.metrics.observeCancellation(r.Method, r.Pattern)
		}
		writeAPIError(w, r, http.StatusUnauthorized, "invalid Google token")
		return
	}
	var clientErr *googleTokenClientError
	if errors.As(err, &clientErr) {
		if clientErr.reason == nativeTokenReasonAudience {
			s.logger.Debug("native verify audience classified", "cause", nativeTokenReasonAudience)
		}
		s.logger.Warn("native Google ID token verification failed", "reason", clientErr.reason)
		writeAPIError(w, r, http.StatusUnauthorized, "invalid Google token")
		return
	}
	s.logger.Error("native Google ID token verification failed", "reason", nativeTokenReasonProvider)
	reportInternalErrorToErrorMonitoring(err, r, "native Google ID token verification failed")
	writeAPIError(w, r, http.StatusUnauthorized, "invalid Google token")
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
	s.logger.Error(operation, "cause", monitoringCause(err))
	reportInternalErrorToErrorMonitoring(err, r, operation)
	http.Error(w, "Internal Server Error", http.StatusInternalServerError)
}

func (s *Server) internalAPIError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	s.logger.Error(operation, "cause", monitoringCause(err))
	reportInternalErrorToErrorMonitoring(err, r, operation)
	echoIdempotencyKey(w, r)
	writeAPIError(w, r, http.StatusInternalServerError, "internal server error")
}

// echoIdempotencyKey returns the client-supplied idempotency key so
// retried requests can match responses without resubmitting work.
func echoIdempotencyKey(w http.ResponseWriter, r *http.Request) {
	if r == nil {
		return
	}
	if key := r.Header.Get("Idempotency-Key"); key != "" {
		w.Header().Set("Idempotency-Key", key)
	}
}
