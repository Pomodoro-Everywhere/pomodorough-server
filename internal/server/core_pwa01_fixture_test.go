package server

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"
)

// The JS regression suite consumes real handler responses without a listening server.
func TestCorePWA01ServerResponseFixture(t *testing.T) {
	output := os.Getenv("CORE_PWA01_SERVER_FIXTURE")
	if output == "" {
		t.Skip("The PWA claim regression suite requests this fixture.")
	}
	fixture := newServerFixture(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	request := validSyncRequestJSON(now)
	first := postAuthenticatedJSON(t, fixture, "/api/v1/sync", request)
	duplicate := postAuthenticatedJSON(t, fixture, "/api/v1/sync", request)
	if first.Code != http.StatusOK || duplicate.Code != http.StatusOK {
		t.Fatalf("Start responses: %d %s; duplicate: %d %s", first.Code, first.Body.String(), duplicate.Code, duplicate.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(first.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.MarshalIndent(map[string]any{
		"source": "TestCorePWA01ServerResponseFixture/httptest", "nowMs": now.UnixMilli(),
		"request": request, "response": json.RawMessage(first.Body.Bytes()),
		"duplicate":   json.RawMessage(duplicate.Body.Bytes()),
		"responseRaw": first.Body.String(), "duplicateRaw": duplicate.Body.String(),
		"user": map[string]any{"id": fixture.userID, "accountIncarnation": payload["accountIncarnation"]},
	}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}
