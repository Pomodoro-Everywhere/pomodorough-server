package server

import (
	"net/http"
	"testing"
	"time"

	"pomodorough/internal/store"
)

func TestParseOperationClockAcceptsBoundariesAndOldOfflineOperations(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		occurredAt time.Time
		wallMs     int64
		counter    int64
		legacy     bool
	}{
		{name: "current", occurredAt: now, wallMs: now.UnixMilli()},
		{name: "future boundary", occurredAt: now.Add(maxClockSkew), wallMs: now.Add(maxClockSkew).UnixMilli()},
		{name: "maximum counter", occurredAt: now, wallMs: now.UnixMilli(), counter: maxSafeInteger},
		{name: "old offline operation", occurredAt: now.Add(-365 * 24 * time.Hour), wallMs: now.Add(-365 * 24 * time.Hour).UnixMilli()},
		{name: "clock skew boundary", occurredAt: now.Add(-maxClockSkew), wallMs: now.UnixMilli()},
		{name: "legacy sentinel", occurredAt: time.Unix(0, 0).UTC(), wallMs: 0, legacy: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			wallMs, counter := test.wallMs, test.counter
			if _, err := parseOperationClock(test.occurredAt.Format(time.RFC3339Nano), &wallMs, &counter, test.legacy, now); err != nil {
				t.Fatalf("parseOperationClock rejected boundary: %v", err)
			}
		})
	}
}

func TestParseSyncRequestAcceptsMaximumSafeSequenceAndCounter(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	payload := validSyncRequestJSON(now)
	payload.Commands[0].DeviceSequence = int64Pointer(maxSafeInteger)
	payload.Commands[0].HLCCounter = int64Pointer(maxSafeInteger)
	request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
	parsed, err := parseSyncRequest(response, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Commands[0].DeviceSequence != maxSafeInteger || parsed.Commands[0].HLCCounter != maxSafeInteger {
		t.Fatalf("parsed boundary command = %#v", parsed.Commands[0])
	}
}

func TestRevisionRequestBoundsAcceptMaximumAndRejectMaximumPlusOne(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	for _, testCase := range []struct {
		name  string
		parse func(*testing.T, int64) error
	}{
		{
			name: "lastRevision",
			parse: func(t *testing.T, revision int64) error {
				payload := validSyncRequestJSON(now)
				payload.LastRevision = int64Pointer(revision)
				request, response := newJSONRequest(t, http.MethodPost, "/api/v1/sync", payload)
				_, err := parseSyncRequest(response, request, now)
				return err
			},
		},
		{
			name: "expectedRevision",
			parse: func(t *testing.T, revision int64) error {
				payload := bootstrapResolutionRequestJSON{
					RequestID: "resolution-revision-bound", DeviceID: "device-0001", ExpectedRevision: int64Pointer(revision),
					Strategy: store.BootstrapKeepRemote, Commands: []syncCommandJSON{}, TaskOperations: []syncTaskOperationJSON{}, DurationOperations: []syncDurationOperationJSON{},
				}
				request, response := newJSONRequest(t, http.MethodPost, "/api/v1/bootstrap/resolve", payload)
				_, err := parseBootstrapResolutionRequest(response, request, now)
				return err
			},
		},
	} {
		t.Run(testCase.name+"/maximum", func(t *testing.T) {
			if err := testCase.parse(t, store.MaxSafeRevision); err != nil {
				t.Fatalf("maximum rejected: %v", err)
			}
		})
		t.Run(testCase.name+"/maximum-plus-one", func(t *testing.T) {
			if err := testCase.parse(t, store.MaxSafeRevision+1); err == nil {
				t.Fatal("maximum plus one accepted")
			}
		})
	}
}
