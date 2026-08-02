package server

import (
	"net/http"
	"testing"
	"time"
)

func TestUUIDv7TimestampIsOpaqueToOperationClockValidation(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	payload := validSyncRequestJSON(now)
	payload.Commands[0].ID = "ffffffff-ffff-7fff-bfff-ffffffffffff"
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	parsed, err := parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatalf("valid HLC with maximum UUIDv7 timestamp rejected: %v", err)
	}
	if parsed.Commands[0].ID != payload.Commands[0].ID ||
		parsed.Commands[0].OccurredAt != now ||
		parsed.Commands[0].HLCWallMs != now.UnixMilli() {
		t.Fatalf("UUIDv7 identity changed operation clock: %#v", parsed.Commands[0])
	}

	payload.Commands[0].ID = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f"
	payload.Commands[0].OccurredAt = now.Add(maxClockSkew + time.Millisecond).Format(time.RFC3339Nano)
	payload.Commands[0].HLCWallMs = int64Pointer(now.Add(maxClockSkew + time.Millisecond).UnixMilli())
	request, response = newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	if _, err := parseSyncRequest(response, request, now); err == nil {
		t.Fatal("old UUIDv7 timestamp bypassed future HLC rejection")
	}
}
