package server

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPStreamRequiresAuthenticationAndIgnoresLastEventIDOnReconnect(t *testing.T) {
	fixture := newServerFixture(t)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/stream", nil)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated stream status = %d, want 401", response.Code)
	}

	testServer := httptest.NewServer(fixture.handler)
	defer testServer.Close()
	for _, lastEventID := range []string{"999", "0"} {
		ctx, cancel := serverTestContext(t)
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, testServer.URL+"/api/v1/stream", nil)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
		request.Header.Set("Last-Event-ID", lastEventID)
		streamResponse, err := http.DefaultClient.Do(request)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		if streamResponse.StatusCode != http.StatusOK || streamResponse.Header.Get("Content-Type") != "text/event-stream" {
			streamResponse.Body.Close()
			cancel()
			t.Fatalf("stream response = %d %q", streamResponse.StatusCode, streamResponse.Header.Get("Content-Type"))
		}
		if revision := scanNextRevision(t, bufio.NewScanner(streamResponse.Body)); revision != 0 {
			streamResponse.Body.Close()
			cancel()
			t.Fatalf("Last-Event-ID %q initial revision = %d, want current 0", lastEventID, revision)
		}
		streamResponse.Body.Close()
		cancel()
	}
}

func TestHTTPStreamSuppressesDuplicatesAndSendsKeepalive(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.streamKeepaliveInterval = 10 * time.Millisecond
	testServer := httptest.NewServer(fixture.handler)
	defer testServer.Close()
	ctx, cancel := serverTestContext(t)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, testServer.URL+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	if revision := scanNextRevision(t, scanner); revision != 0 {
		t.Fatalf("initial revision = %d, want 0", revision)
	}
	fixture.application.hub.publish(fixture.userID, 1, 1)
	fixture.application.hub.publish(fixture.userID, 1, 1)
	if revision := scanNextRevision(t, scanner); revision != 1 {
		t.Fatalf("first published revision = %d, want 1", revision)
	}
	fixture.application.hub.publish(fixture.userID, 1, 1)
	fixture.application.hub.publish(fixture.userID, 1, 2)
	if revision := scanNextRevision(t, scanner); revision != 2 {
		t.Fatalf("next published revision = %d, want 2", revision)
	}
	for scanner.Scan() {
		if scanner.Text() == ": keepalive" {
			return
		}
	}
	t.Fatal("stream closed before keepalive")
}

func TestHTTPLogoutClosesExistingSessionStream(t *testing.T) {
	fixture := newServerFixture(t)
	streamDone := startOpenNativeStream(t, fixture)

	request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/logout", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d body=%s", response.Code, response.Body.String())
	}
	assertStreamHandlerReturns(t, streamDone)
}

func TestHTTPDeviceRevocationClosesExistingDeviceStream(t *testing.T) {
	fixture := newServerFixture(t)
	streamDone := startOpenNativeStream(t, fixture)

	request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/auth/revoke-device", map[string]string{"deviceId": fixture.deviceID})
	addWebAuthentication(request, fixture)
	addValidCSRF(request, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("device revocation status = %d body=%s", response.Code, response.Body.String())
	}
	assertStreamHandlerReturns(t, streamDone)
}

func startOpenNativeStream(t *testing.T, fixture serverFixture) <-chan struct{} {
	t.Helper()
	fixture.application.streamKeepaliveInterval = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/stream", nil).WithContext(ctx)
	writer := &openStreamWriter{header: make(http.Header), flushed: make(chan struct{}, 1)}
	done := make(chan struct{})
	go func() {
		fixture.application.handleStream(writer, request, principal{
			UserID: fixture.userID, SessionID: "native-session", DeviceID: fixture.deviceID, Method: "bearer", Generation: 1,
		})
		close(done)
	}()
	select {
	case <-writer.flushed:
	case <-done:
		t.Fatal("stream handler returned before initial revision flush")
	case <-time.After(2 * time.Second):
		t.Fatal("stream handler did not flush initial revision")
	}
	return done
}

func assertStreamHandlerReturns(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("revoked authenticated stream remained open")
	}
}

func TestHTTPStreamWriteFailureReturnsAndUnsubscribes(t *testing.T) {
	fixture := newServerFixture(t)
	w := &failingStreamWriter{header: make(http.Header)}
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/stream", nil)
	fixture.application.handleStream(w, request, principal{UserID: fixture.userID, Generation: 1})
	if w.flushes != 1 {
		t.Fatalf("stream flush attempts = %d, want 1", w.flushes)
	}
	fixture.application.hub.mu.Lock()
	subscribers := len(fixture.application.hub.subscribers[revisionScope{userID: fixture.userID, generation: 1}])
	fixture.application.hub.mu.Unlock()
	if subscribers != 0 {
		t.Fatalf("subscribers after write failure = %d, want 0", subscribers)
	}
}

func scanNextRevision(t *testing.T, scanner *bufio.Scanner) int64 {
	t.Helper()
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: {\"revision\":") {
			continue
		}
		var revision int64
		if _, err := fmt.Sscanf(line, "data: {\"revision\":%d}", &revision); err != nil {
			t.Fatalf("parse revision line %q: %v", line, err)
		}
		return revision
	}
	t.Fatalf("stream ended before revision: %v", scanner.Err())
	return 0
}

type failingStreamWriter struct {
	header  http.Header
	body    bytes.Buffer
	status  int
	flushes int
}

type openStreamWriter struct {
	header  http.Header
	flushed chan struct{}
}

func (w *openStreamWriter) Header() http.Header { return w.header }

func (w *openStreamWriter) WriteHeader(int) {}

func (w *openStreamWriter) Write(body []byte) (int, error) { return len(body), nil }

func (w *openStreamWriter) FlushError() error {
	select {
	case w.flushed <- struct{}{}:
	default:
	}
	return nil
}

func (w *failingStreamWriter) Header() http.Header { return w.header }

func (w *failingStreamWriter) WriteHeader(status int) { w.status = status }

func (w *failingStreamWriter) Write(body []byte) (int, error) { return w.body.Write(body) }

func (w *failingStreamWriter) FlushError() error {
	w.flushes++
	return errors.New("forced stream flush failure")
}
