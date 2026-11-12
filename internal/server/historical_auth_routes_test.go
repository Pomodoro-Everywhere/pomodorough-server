package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

func historicalBoundary(target any, cause error) *r51S01BoundaryContext {
	boundary := newR51S01Boundary(context.Background(), cause)
	boundary.rotateEntry = runtime.FuncForPC(reflect.ValueOf(target).Pointer()).Entry()
	return boundary
}

func historicalPersistenceRequest(t *testing.T, kind string) (serverFixture, *http.Request) {
	t.Helper()
	if kind == "web" {
		verifier, sign := testGoogleVerifier(t)
		token := sign(testGoogleClaims("web-client", "bound-nonce", time.Now().Add(time.Hour)))
		fixture, sealed := newExchangeFixture(t, succeedingTokenServer(t, token))
		fixture.application.webVerifier = verifier
		request := httptest.NewRequest(http.MethodGet, "/auth/google/callback?code=auth-code&state=bound-state", nil)
		request.AddCookie(&http.Cookie{Name: authn.OAuthStateCookie, Value: sealed})
		return fixture, request
	}
	fixture := newServerFixture(t)
	sign := r51S02EnableNative(t, &fixture)
	if kind == "challenge" {
		return fixture, httptest.NewRequest(http.MethodPost, "/api/v1/auth/google/challenge", nil)
	}
	sealed := r51S02SealedChallenge(t, fixture, "bound-nonce")
	token := sign(testGoogleClaims("native-client", "bound-nonce", time.Now().Add(time.Hour)))
	request, _ := newJSONRequest(t, http.MethodPost, "/api/v1/auth/google/exchange", map[string]string{
		"idToken": token, "challenge": sealed, "deviceId": "native-device", "platform": "ios",
	})
	return fixture, request
}

func TestHistoricalPersistenceRoutesCancelAtActualStoreBoundary(t *testing.T) {
	cases := []struct {
		kind, operation string
		target          any
	}{
		{"challenge", "persist native challenge", (*store.Store).CreateNativeChallenge},
		{"native", "open native user account", (*store.Store).OpenUser},
		{"native", "consume native challenge", (*store.Store).ConsumeNativeChallengeAndCreateSession},
		{"web", "open user account", (*store.Store).OpenUser},
		{"web", "update user profile", store.UpsertProfile},
		{"web", "create web session", store.CreateSession},
	}
	for _, test := range cases {
		for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
			t.Run(test.operation+"/"+cause.Error(), func(t *testing.T) {
				transport := initMockSentry(t)
				fixture, request := historicalPersistenceRequest(t, test.kind)
				logs := r49S08CaptureLogs(fixture.application)
				boundary := historicalBoundary(test.target, cause)
				response := httptest.NewRecorder()
				fixture.handler.ServeHTTP(response, request.WithContext(boundary))
				if !boundary.triggered {
					t.Fatal("store boundary was not reached")
				}
				if response.Code != 500 {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
				if !strings.Contains(logs.String(), `msg="`+test.operation+` canceled"`) || strings.Contains(logs.String(), "level=ERROR") {
					t.Fatalf("wrong diagnostic: %s", logs.String())
				}
				sentry.Flush(2 * time.Second)
				if len(transport.Events()) != 0 {
					t.Fatal("canceled persistence reported a fault")
				}
				if got := fixture.application.metrics.canceledCount(request.Method, request.Method+" "+request.URL.Path); got != 1 {
					t.Fatalf("cancellations=%d", got)
				}
			})
		}
	}
}

func TestHistoricalR50S08FullMeRouteCancelsReplacementOnly(t *testing.T) {
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded} {
		t.Run(cause.Error(), func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			before := r50S08SessionCSRFHash(t, fixture)
			request := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
			request.AddCookie(&http.Cookie{Name: authn.WebSessionCookie, Value: fixture.webToken})
			request.Header.Set("Idempotency-Key", "r50-s08-wire-key")
			boundary := historicalBoundary((*store.Store).UpdateCSRFForGeneration, cause)
			response := httptest.NewRecorder()
			fixture.handler.ServeHTTP(response, request.WithContext(boundary))
			if !boundary.triggered {
				t.Fatal("route did not reach CSRF replacement")
			}
			r50S08AssertHelperWire(t, response)
			if !reflect.DeepEqual(before, r50S08SessionCSRFHash(t, fixture)) {
				t.Fatal("canceled route changed CSRF hash")
			}
			sentry.Flush(2 * time.Second)
			if len(transport.Events()) != 0 {
				t.Fatal("canceled replacement reported")
			}
			if fixture.application.metrics.canceledCount(http.MethodGet, "GET /api/v1/me") != 1 {
				t.Fatal("missing cancellation metric")
			}
		})
	}
}
