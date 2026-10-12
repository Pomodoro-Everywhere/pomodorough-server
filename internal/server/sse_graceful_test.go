package server

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func openGraceStream(t *testing.T, url, token string) (*http.Response, *bufio.Scanner) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url+"/api/v1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		t.Fatalf("open SSE status=%d", response.StatusCode)
	}
	scanner := bufio.NewScanner(response.Body)
	if revision := scanNextRevision(t, scanner); revision != 0 {
		response.Body.Close()
		t.Fatalf("initial revision=%d want 0", revision)
	}
	return response, scanner
}

func assertGraceStreamClosed(t *testing.T, scanner *bufio.Scanner) {
	t.Helper()
	done := make(chan bool, 1)
	go func() {
		for scanner.Scan() {
			text := scanner.Text()
			if text == "" || text[0] == ':' || len(text) >= 6 && text[:6] == "event:" {
				continue
			}
			done <- false
			return
		}
		done <- true
	}()
	select {
	case closed := <-done:
		if !closed {
			t.Fatal("stream published after shutdown")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not reach EOF after shutdown")
	}
}
func hubSubscriberCount(application *Server) int {
	application.hub.mu.Lock()
	defer application.hub.mu.Unlock()
	count := 0
	for _, subs := range application.hub.subscribers {
		count += len(subs)
	}
	return count
}

func streamPermitCount(application *Server, userID string) int {
	application.streamLimiter.mu.Lock()
	defer application.streamLimiter.mu.Unlock()
	return application.streamLimiter.active[userID]
}

func TestR48S04HealthySSEShutdownEndsStreams(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.streamKeepaliveInterval = time.Hour
	testServer := httptest.NewServer(fixture.handler)
	defer testServer.Close()
	first, firstScan := openGraceStream(t, testServer.URL, fixture.accessToken)
	defer first.Body.Close()
	second, secondScan := openGraceStream(t, testServer.URL, fixture.accessToken)
	defer second.Body.Close()
	if got := hubSubscriberCount(fixture.application); got != 2 {
		t.Fatalf("subscribers=%d want 2", got)
	}
	if got := streamPermitCount(fixture.application, fixture.userID); got != 2 {
		t.Fatalf("permits=%d want 2", got)
	}
	fixture.application.Shutdown()
	assertGraceStreamClosed(t, firstScan)
	assertGraceStreamClosed(t, secondScan)
	deadline := time.Now().Add(2 * time.Second)
	for hubSubscriberCount(fixture.application) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := hubSubscriberCount(fixture.application); got != 0 {
		t.Fatalf("subscribers after shutdown=%d want 0", got)
	}
	deadline = time.Now().Add(2 * time.Second)
	for streamPermitCount(fixture.application, fixture.userID) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := streamPermitCount(fixture.application, fixture.userID); got != 0 {
		t.Fatalf("permits after shutdown=%d want 0", got)
	}
	request, _ := http.NewRequest(http.MethodGet, testServer.URL+"/healthz", nil)
	finite, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	finite.Body.Close()
	if finite.StatusCode != http.StatusOK {
		t.Fatalf("finite status=%d want 200", finite.StatusCode)
	}
}

func TestR48S04PostShutdownStreamsDoNotBlock(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.streamKeepaliveInterval = time.Hour
	testServer := httptest.NewServer(fixture.handler)
	defer testServer.Close()
	fixture.application.Shutdown()
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, scanner := openGraceStream(t, testServer.URL, fixture.accessToken)
		defer response.Body.Close()
		assertGraceStreamClosed(t, scanner)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("post-shutdown stream blocked graceful finish")
	}
}

func TestR48S04HubShutdownIsIdempotent(t *testing.T) {
	hub := newRevisionHub()
	updates, unsubscribe := hub.subscribe("account", 1)
	defer unsubscribe()
	hub.shutdown()
	if _, open := <-updates; open {
		t.Fatal("stream remained open after shutdown")
	}
	hub.shutdown()
	closed, release := hub.subscribe("account", 1)
	defer release()
	if _, open := <-closed; open {
		t.Fatal("post-shutdown subscribe remained open")
	}
}
