package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type r49S04Neighbor struct {
	name    string
	pattern string
	target  string
	serve   func(app *Server, w http.ResponseWriter, r *http.Request, identity principal)
}

func r49S04Neighbors() []r49S04Neighbor {
	return []r49S04Neighbor{
		{"me", "GET /api/v1/me", "https://pomodorough.egigoka.me/api/v1/me",
			func(app *Server, w http.ResponseWriter, r *http.Request, identity principal) {
				app.handleMe(w, r, identity)
			}},
		{"bootstrap", "GET /api/v1/bootstrap", "https://pomodorough.egigoka.me/api/v1/bootstrap",
			func(app *Server, w http.ResponseWriter, r *http.Request, identity principal) {
				app.handleBootstrap(w, r, identity)
			}},
		{"history", "GET /api/v1/history", "https://pomodorough.egigoka.me/api/v1/history",
			func(app *Server, w http.ResponseWriter, r *http.Request, identity principal) {
				app.handleHistory(w, r, identity)
			}},
	}
}

func r49S04CanceledRequest(t *testing.T, neighbor r49S04Neighbor) (*http.Request, context.CancelFunc) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, neighbor.target, nil)
	request.Pattern = neighbor.pattern
	canceled, cancel := context.WithCancel(request.Context())
	cancel()
	withCanceled := request.WithContext(canceled)
	withCanceled.Pattern = neighbor.pattern
	return withCanceled, cancel
}

func r49S04DeadlineRequest(t *testing.T, neighbor r49S04Neighbor) (*http.Request, context.CancelFunc) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, neighbor.target, nil)
	request.Pattern = neighbor.pattern
	expired, cancel := context.WithDeadline(request.Context(), time.Now().Add(-time.Second))
	withExpired := request.WithContext(expired)
	withExpired.Pattern = neighbor.pattern
	return withExpired, cancel
}

func r49S04LiveRequest(neighbor r49S04Neighbor) *http.Request {
	request := httptest.NewRequest(http.MethodGet, neighbor.target, nil)
	request.Pattern = neighbor.pattern
	return request
}

func r49S04DropAccountMetadata(t *testing.T, fixture serverFixture) {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`DROP TABLE account_metadata`); err != nil {
		t.Fatal(err)
	}
}

func TestR49S04CanceledNeighborsDoNotReport(t *testing.T) {
	for _, neighbor := range r49S04Neighbors() {
		t.Run(neighbor.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			identity := authenticateFixturePrincipal(t, fixture)
			request, cancel := r49S04CanceledRequest(t, neighbor)
			defer cancel()
			response := httptest.NewRecorder()
			neighbor.serve(fixture.application, response, request, identity)
			assertCanceledWire(t, response)
			assertNoSentry(t, transport)
			if got := fixture.application.metrics.canceledCount(http.MethodGet, neighbor.pattern); got != 1 {
				t.Fatalf("canceled count = %d, want 1", got)
			}
		})
	}
}

func TestR49S04DeadlineNeighborsDoNotReport(t *testing.T) {
	for _, neighbor := range r49S04Neighbors() {
		t.Run(neighbor.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			identity := authenticateFixturePrincipal(t, fixture)
			request, cancel := r49S04DeadlineRequest(t, neighbor)
			defer cancel()
			response := httptest.NewRecorder()
			neighbor.serve(fixture.application, response, request, identity)
			assertCanceledWire(t, response)
			assertNoSentry(t, transport)
			if got := fixture.application.metrics.canceledCount(http.MethodGet, neighbor.pattern); got != 1 {
				t.Fatalf("canceled count = %d, want 1", got)
			}
		})
	}
}

func TestR49S04GenuineNeighborFailuresStillReport(t *testing.T) {
	cases := r49S04Neighbors()
	for _, neighbor := range cases {
		t.Run(neighbor.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			identity := authenticateFixturePrincipal(t, fixture)
			if neighbor.name == "me" {
				r49S04DropAccountMetadata(t, fixture)
			} else {
				dropTimerCommands(t, fixture)
			}
			response := httptest.NewRecorder()
			neighbor.serve(fixture.application, response, r49S04LiveRequest(neighbor), identity)
			r43S09AssertInternal(t, response, transport.Events())
			if got := fixture.application.metrics.canceledCount(http.MethodGet, neighbor.pattern); got != 0 {
				t.Fatalf("canceled count = %d, want 0 for genuine failure", got)
			}
		})
	}
}

func TestR49S04PostAuthMiddlewareCancellation(t *testing.T) {
	for _, neighbor := range r49S04Neighbors() {
		t.Run(neighbor.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			live := httptest.NewRequest(http.MethodGet, neighbor.target, nil)
			live.Header.Set("Authorization", "Bearer "+fixture.accessToken)
			live.Pattern = neighbor.pattern
			response := httptest.NewRecorder()
			handler := fixture.application.requireAuth(func(w http.ResponseWriter, r *http.Request, identity principal) {
				canceled, cancel := context.WithCancel(r.Context())
				cancel()
				defer cancel()
				canceledRequest := r.WithContext(canceled)
				canceledRequest.Pattern = neighbor.pattern
				neighbor.serve(fixture.application, w, canceledRequest, identity)
			})
			handler.ServeHTTP(response, live)
			assertCanceledWire(t, response)
			assertNoSentry(t, transport)
			if got := fixture.application.metrics.canceledCount(http.MethodGet, neighbor.pattern); got != 1 {
				t.Fatalf("canceled count = %d, want 1", got)
			}
		})
	}
}

func TestR49S04CanceledNeighborsRace(t *testing.T) {
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	identity := authenticateFixturePrincipal(t, fixture)
	var group sync.WaitGroup
	for _, neighbor := range r49S04Neighbors() {
		for range 5 {
			group.Add(1)
			go func() {
				defer group.Done()
				request, cancel := r49S04CanceledRequest(t, neighbor)
				defer cancel()
				neighbor.serve(fixture.application, httptest.NewRecorder(), request, identity)
			}()
		}
	}
	group.Wait()
	assertNoSentry(t, transport)
	for _, neighbor := range r49S04Neighbors() {
		if got := fixture.application.metrics.canceledCount(http.MethodGet, neighbor.pattern); got != 5 {
			t.Fatalf("%s canceled count = %d, want 5", neighbor.name, got)
		}
	}
}
