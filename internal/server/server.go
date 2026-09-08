package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"pomodorough/internal/authn"
	"pomodorough/internal/config"
	"pomodorough/internal/sharedcore"
	"pomodorough/internal/store"
)

const googleIssuer = "https://accounts.google.com"

type Server struct {
	cfg                     config.Config
	store                   *store.Store
	codec                   *authn.Codec
	appSecretDigest         [32]byte
	readinessCore           readinessCore
	readinessTimeout        time.Duration
	logger                  *slog.Logger
	oauthConfig             *oauth2.Config
	webVerifier             *oidc.IDTokenVerifier
	nativeVerifier          *oidc.IDTokenVerifier
	hub                     *revisionHub
	streamKeepaliveInterval time.Duration
	authIPLimiter           *windowRateLimiter
	clientIPs               clientIPPolicy
	accountLimiter          *windowRateLimiter
	streamLimiter           *concurrentLimiter
	metrics                 *requestMetrics
}

type principal struct {
	UserID     string
	Profile    store.Profile
	SessionID  string
	DeviceID   string
	Method     string
	CSRFHash   []byte
	Generation int64
	Credential store.DeletionCredential
}

type authenticatedHandler func(http.ResponseWriter, *http.Request, principal)

func New(cfg config.Config, userStore *store.Store, logger *slog.Logger) (*Server, error) {
	if len(cfg.AppSecret) < 32 {
		return nil, errors.New("APP_SECRET must be at least 32 bytes")
	}
	cfg.AppSecret = append([]byte(nil), cfg.AppSecret...)
	codec, err := authn.NewCodec(cfg.AppSecret)
	if err != nil {
		return nil, fmt.Errorf("initialize transient token codec: %w", err)
	}
	clientIPs, valid := newClientIPPolicy(cfg.TrustedProxyCIDRs, cfg.TrustedProxyHops)
	if !valid {
		return nil, errors.New("trusted proxy configuration is incomplete or invalid")
	}
	keySetContext := oidc.ClientContext(context.Background(), &http.Client{Timeout: 10 * time.Second})
	keySet := oidc.NewRemoteKeySet(keySetContext, "https://www.googleapis.com/oauth2/v3/certs")
	s := &Server{
		cfg:                     cfg,
		store:                   userStore,
		codec:                   codec,
		appSecretDigest:         readinessKeyDigest(cfg.AppSecret),
		readinessTimeout:        readinessCheckTimeout,
		logger:                  logger,
		hub:                     newRevisionHub(),
		streamKeepaliveInterval: 20 * time.Second,
		authIPLimiter:           newWindowRateLimiter(30, time.Minute),
		clientIPs:               clientIPs,
		accountLimiter:          newWindowRateLimiter(240, time.Minute),
		streamLimiter:           newConcurrentLimiter(4),
		metrics:                 newRequestMetrics(),
		oauthConfig: &oauth2.Config{
			ClientID:     cfg.GoogleWebClientID,
			ClientSecret: cfg.GoogleWebClientSecret,
			RedirectURL:  cfg.PublicURL + "/auth/google/callback",
			Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
			Endpoint: oauth2.Endpoint{
				AuthURL:  "https://accounts.google.com/o/oauth2/v2/auth",
				TokenURL: "https://oauth2.googleapis.com/token",
			},
		},
		webVerifier: oidc.NewVerifier(googleIssuer, keySet, &oidc.Config{
			ClientID: cfg.GoogleWebClientID,
		}),
		nativeVerifier: oidc.NewVerifier(googleIssuer, keySet, &oidc.Config{
			SkipClientIDCheck: true,
		}),
	}
	return s, nil
}

func NewForTraffic(cfg config.Config, userStore *store.Store, logger *slog.Logger, core *sharedcore.Core) (*Server, error) {
	if core == nil {
		return nil, errors.New("shared core runtime is required")
	}
	application, err := New(cfg, userStore, logger)
	if err != nil {
		return nil, err
	}
	application.readinessCore = core
	return application, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /readyz", s.handleReady)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /openapi.yaml", s.handleOpenAPISpec)
	mux.Handle("GET /auth/google/start", s.rateLimitByIP(http.HandlerFunc(s.handleGoogleStart)))
	mux.Handle("GET /auth/google/callback", s.rateLimitByIP(http.HandlerFunc(s.handleGoogleCallback)))
	mux.Handle("POST /api/v1/auth/google/challenge", s.rateLimitByIP(http.HandlerFunc(s.handleNativeChallenge)))
	mux.Handle("POST /api/v1/auth/google/exchange", s.rateLimitByIP(http.HandlerFunc(s.handleNativeExchange)))
	mux.Handle("POST /api/v1/auth/refresh", s.rateLimitByIP(http.HandlerFunc(s.handleRefresh)))
	mux.Handle("GET /api/v1/me", s.requireAuth(s.handleMe))
	mux.Handle("POST /api/v1/auth/logout", s.requireMutation(s.handleLogout))
	mux.Handle("DELETE /api/v1/account", s.requireAccountDeletion())
	mux.Handle("POST /api/v1/auth/revoke-device", s.requireMutation(s.handleRevokeDevice))
	mux.Handle("POST /api/v1/sync", s.requireMutation(s.handleSync))
	mux.Handle("GET /api/v1/bootstrap", s.requireAuth(s.handleBootstrap))
	mux.Handle("POST /api/v1/bootstrap/resolve", s.requireMutation(s.handleBootstrapResolve))
	mux.Handle("GET /api/v1/history", s.requireAuth(s.handleHistory))
	mux.Handle("GET /api/v1/stream", s.requireAuth(s.handleStream))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeAPIError(w, r, http.StatusNotFound, "not found")
	})
	mux.HandleFunc("/api", func(w http.ResponseWriter, r *http.Request) {
		writeAPIError(w, r, http.StatusNotFound, "not found")
	})
	mux.HandleFunc("/auth/", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Not Found", http.StatusNotFound)
	})
	mux.HandleFunc("/auth", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Not Found", http.StatusNotFound)
	})
	mux.HandleFunc("/", s.handleStatic)
	return s.recoverMiddleware(s.loggingMiddleware(s.securityMiddleware(mux)))
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) requireAuth(next authenticatedHandler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity, err := s.authenticate(r)
		if err != nil {
			writeAPIError(w, r, http.StatusUnauthorized, "unauthorized")
			return
		}
		if allowed, retryAfter := s.accountLimiter.allow(identity.UserID, time.Now()); !allowed {
			s.writeRateLimit(w, r, "account", retryAfter)
			return
		}
		if !validAccountIncarnation(w, r, identity) {
			return
		}
		next(w, r, identity)
	})
}

func (s *Server) requireMutation(next authenticatedHandler) http.Handler {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request, identity principal) {
		if identity.Method == "cookie" && !s.validCSRF(r, identity) {
			writeAPIError(w, r, http.StatusForbidden, "forbidden")
			return
		}
		next(w, r, identity)
	})
}

func (s *Server) rateLimitByIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if allowed, retryAfter := s.authIPLimiter.allow(s.clientIPs.clientIP(r), time.Now()); !allowed {
			s.writeRateLimit(w, r, "ip", retryAfter)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) writeRateLimit(w http.ResponseWriter, r *http.Request, scope string, retryAfter time.Duration) {
	seconds := int64((retryAfter + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	// Log only the route pattern: raw paths can carry user identity material.
	s.logger.Warn("request rate limited", "scope", scope, "method", r.Method, "route", metricRoute(r.Method, r.Pattern))
	writeAPIError(w, r, http.StatusTooManyRequests, "rate limit exceeded")
}

func (s *Server) authenticate(r *http.Request) (principal, error) {
	userID, credential, err := requestCredential(r)
	if err != nil {
		return principal{}, store.ErrUnauthorized
	}
	expectedKind := "web"
	if credential.Method == "bearer" {
		expectedKind = "access"
	}
	db, err := s.store.OpenExistingUser(r.Context(), userID)
	if err != nil {
		return principal{}, store.ErrUnauthorized
	}
	defer db.Close()
	info, err := store.Authenticate(r.Context(), db, credential.TokenHash, expectedKind, time.Now())
	if err != nil || !authn.EqualString(info.Profile.ID, userID) {
		return principal{}, store.ErrUnauthorized
	}
	return principal{
		UserID:     userID,
		Profile:    info.Profile,
		SessionID:  info.SessionID,
		DeviceID:   info.DeviceID,
		Method:     credential.Method,
		CSRFHash:   info.CSRFHash,
		Generation: info.Generation,
		Credential: credential,
	}, nil
}

func (s *Server) validCSRF(r *http.Request, identity principal) bool {
	if r.Header.Get("Origin") != s.cfg.PublicURL {
		return false
	}
	cookie, err := r.Cookie(authn.CSRFCookie)
	if err != nil || cookie.Value == "" {
		return false
	}
	header := r.Header.Get("X-CSRF-Token")
	if !authn.EqualString(header, cookie.Value) {
		return false
	}
	hash := authn.HashString(header)
	return authn.EqualHash(hash[:], identity.CSRFHash)
}

func (s *Server) securityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' https://*.ingest.sentry.io https://*.ingest.de.sentry.io https://*.ingest.us.sentry.io; script-src 'self' https://browser.sentry-cdn.com; style-src 'self'; manifest-src 'self'; worker-src 'self' blob:")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &responseRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		duration := time.Since(started)
		s.metrics.observe(r.Method, r.Pattern, recorder.status, duration)
		// Log only the route pattern: raw paths can carry user identity material.
		s.logger.Info("http request",
			"method", r.Method,
			"route", metricRoute(r.Method, r.Pattern),
			"status", recorder.status,
			"bytes", recorder.bytes,
			"duration_ms", duration.Milliseconds(),
		)
	})
}

func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.Error("panic serving request", "error", recovered, "stack", string(debug.Stack()))
				reportPanicToErrorMonitoring(recovered, r)
				if strings.HasPrefix(r.URL.Path, "/api/") {
					writeAPIError(w, r, http.StatusInternalServerError, "internal server error")
				} else {
					http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				}
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
	wrote  bool
}

func (r *responseRecorder) WriteHeader(status int) {
	if r.wrote {
		return
	}
	r.status = status
	r.wrote = true
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	if !r.wrote {
		r.WriteHeader(http.StatusOK)
	}
	written, err := r.ResponseWriter.Write(body)
	r.bytes += written
	return written, err
}

func (r *responseRecorder) Flush() {
	if !r.wrote {
		r.WriteHeader(http.StatusOK)
	}
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (r *responseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		reportInternalErrorToErrorMonitoring(err, r, "encode JSON response")
	}
}

func writeAPIError(w http.ResponseWriter, r *http.Request, status int, message string) {
	writeJSON(w, r, status, map[string]string{"error": message})
}

func isUnauthorized(err error) bool {
	return errors.Is(err, store.ErrUnauthorized) || errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrAccountDeleted) ||
		errors.Is(err, store.ErrAccountGenerationChanged) || errors.Is(err, authn.ErrInvalidToken)
}
