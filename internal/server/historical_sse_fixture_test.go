package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHistoricalStreamCompletionAcknowledgesServerReturn(t *testing.T) {
	fixture := &protocolFixture{}
	done, entered, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	fixture.streamHandlers.Store("stream", done)
	handler := fixture.trackStreamHandlers(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(entered)
		<-release
	}))
	request := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil)
	request.Header.Set("X-Test-Stream-ID", "stream")
	go handler.ServeHTTP(httptest.NewRecorder(), request)
	<-entered
	select {
	case <-done:
		t.Fatal("completion acknowledged before server handler returned")
	default:
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("missing server completion acknowledgement")
	}
}

func TestHistoricalSSEReconnectReleasesAccountPermit(t *testing.T) {
	fixture := newStreamingProtocolFixture(t)
	client := fixture.clients[3]
	for range 30 {
		client.stream.close(t)
		fixture.application.streamLimiter.mu.Lock()
		active := fixture.application.streamLimiter.active[fixture.userID]
		fixture.application.streamLimiter.mu.Unlock()
		if active != 3 {
			t.Fatalf("active streams=%d after close, want 3", active)
		}
		client.stream = fixture.openRevisionStream(t, client)
		client.stream.waitAtLeast(t, 0)
	}
}
