package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestR49S04DeadlineMiddlewareNeighborsDoNotReport(t *testing.T) {
	for _, neighbor := range r49S04Neighbors() {
		t.Run(neighbor.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			live := httptest.NewRequest(http.MethodGet, neighbor.target, nil)
			live.Header.Set("Authorization", "Bearer "+fixture.accessToken)
			live.Pattern = neighbor.pattern
			response := httptest.NewRecorder()
			handler := fixture.application.requireAuth(func(w http.ResponseWriter, r *http.Request, identity principal) {
				expired, cancel := r49S04DeadlineRequest(t, neighbor)
				defer cancel()
				neighbor.serve(fixture.application, w, expired, identity)
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
