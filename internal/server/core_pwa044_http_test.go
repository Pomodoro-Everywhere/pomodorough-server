package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestCorePWA044HTTPFixture(t *testing.T) {
	fixture := newServerFixture(t)
	server := httptest.NewServer(fixture.handler)
	defer server.Close()
	output := os.Getenv("CORE_PWA044_HTTP_FIXTURE")
	if output == "" {
		response := postAuthenticatedJSON(t, fixture, "/api/v1/sync", validSyncRequestJSON(time.Now().UTC().Truncate(time.Millisecond)))
		if response.Code != http.StatusOK {
			t.Fatalf("Start HTTP status: %d %s", response.Code, response.Body.String())
		}
		return
	}
	encoded, err := json.Marshal(map[string]any{
		"url": server.URL, "userID": fixture.userID, "accessToken": fixture.accessToken,
		"csrfToken": fixture.csrfToken, "deviceID": fixture.deviceID, "nowMs": time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(90 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-t.Context().Done():
			t.Fatal(t.Context().Err())
		case <-deadline.C:
			t.Fatal("PWA HTTP fixture was not released")
		case <-ticker.C:
			if _, err := os.Stat(output + ".stop"); err == nil {
				return
			}
		}
	}
}
