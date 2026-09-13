package server

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// S66: present-but-empty taskId must reject for every command type.
// Explicit "" is not omission; omission omits the key entirely.
func TestS66PresentEmptyTaskIDRejectedForAllTypes(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	for _, commandType := range []string{"start", "pause", "resume", "finish", "cancel", "clear", "retarget"} {
		t.Run(commandType, func(t *testing.T) {
			body := fmt.Sprintf(`{"deviceId":"device-0001","lastRevision":0,"commands":[{`+
				`"id":"command-0001","deviceSequence":1,"timerId":"timer-000001",`+
				`"taskId":"","type":%q,"phase":"focus","plannedDurationMs":1500000,`+
				`"occurredAt":%q,"hlcWallMs":%d,"hlcCounter":0,"observedElapsedMs":0}]}`,
				commandType, now.Format(time.RFC3339Nano), now.UnixMilli())
			request := httptest.NewRequest("POST", "/api/v1/sync", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			if _, err := parseSyncRequest(httptest.NewRecorder(), request, now); err == nil {
				t.Fatalf("%s with present-but-empty taskId accepted; want rejection", commandType)
			}
		})
	}
}

func TestS66OmittedTaskIDStillAcceptedForNonRetarget(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	body := fmt.Sprintf(`{"deviceId":"device-0001","lastRevision":0,"commands":[{`+
		`"id":"command-0001","deviceSequence":1,"timerId":"timer-000001",`+
		`"type":"pause","phase":"focus","plannedDurationMs":1500000,`+
		`"occurredAt":%q,"hlcWallMs":%d,"hlcCounter":0,"observedElapsedMs":0}]}`,
		now.Format(time.RFC3339Nano), now.UnixMilli())
	request := httptest.NewRequest("POST", "/api/v1/sync", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if _, err := parseSyncRequest(httptest.NewRecorder(), request, now); err != nil {
		t.Fatalf("omitted taskId rejected: %v", err)
	}
}
