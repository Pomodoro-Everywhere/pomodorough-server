package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPublicAuthenticationRateLimitReturns429AndRetryAfter(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.authIPLimiter = newWindowRateLimiter(1, time.Minute)
	for attempt := 1; attempt <= 2; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/google/challenge", nil)
		request.RemoteAddr = "198.51.100.9:4321"
		response := httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request)
		if attempt == 1 && response.Code == http.StatusTooManyRequests {
			t.Fatalf("first request was rate limited: %s", response.Body.String())
		}
		if attempt == 2 {
			if response.Code != http.StatusTooManyRequests {
				t.Fatalf("second status = %d body=%s", response.Code, response.Body.String())
			}
			if response.Header().Get("Retry-After") != "60" {
				t.Fatalf("Retry-After = %q, want 60", response.Header().Get("Retry-After"))
			}
		}
	}
}

func TestAuthenticatedAccountRateLimitIsPerAccount(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.accountLimiter = newWindowRateLimiter(1, time.Minute)
	for attempt := 1; attempt <= 2; attempt++ {
		request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
		addWebAuthentication(request, fixture)
		response := httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request)
		if attempt == 1 && response.Code != http.StatusOK {
			t.Fatalf("first status = %d body=%s", response.Code, response.Body.String())
		}
		if attempt == 2 && response.Code != http.StatusTooManyRequests {
			t.Fatalf("second status = %d body=%s", response.Code, response.Body.String())
		}
	}
}

func TestStreamConcurrentLimitReturns429(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.streamLimiter = newConcurrentLimiter(0)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/stream", nil)
	ctx, cancel := context.WithTimeout(request.Context(), 50*time.Millisecond)
	defer cancel()
	request = request.WithContext(ctx)
	addWebAuthentication(request, fixture)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("stream status = %d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Retry-After") == "" {
		t.Fatal("stream response omitted Retry-After")
	}
}

func TestClientIPTrustsForwardingOnlyFromLoopbackProxy(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "https://example.test", nil)
	request.RemoteAddr = "127.0.0.1:9876"
	request.Header.Set("X-Forwarded-For", "203.0.113.7, 127.0.0.1")
	if got := clientIP(request); got != "203.0.113.7" {
		t.Fatalf("loopback proxy clientIP = %q", got)
	}
	request.RemoteAddr = "198.51.100.2:9876"
	if got := clientIP(request); got != "198.51.100.2" {
		t.Fatalf("untrusted proxy clientIP = %q", got)
	}
}
