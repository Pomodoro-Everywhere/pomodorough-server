package server

import (
	"testing"
	"time"

	"pomodorough/internal/store"
)

// S67: per-domain caps alone allow 5*maximum ops in one envelope.
// The total across domains must stay within twice the per-domain maximum.
func TestS67SyncTotalOperationCap(t *testing.T) {
	full := operationBatch{
		commands:               make([]syncCommandJSON, 256),
		taskOperations:         make([]syncTaskOperationJSON, 256),
		durationOperations:     make([]syncDurationOperationJSON, 256),
		autoStartOperations:    make([]syncAutoStartOperationJSON, 256),
		selectedTaskOperations: make([]syncSelectedTaskOperationJSON, 256),
		maximum:                256,
	}
	if full.operationCount() != 1280 {
		t.Fatalf("operationCount = %d, want 1280", full.operationCount())
	}
	if full.validCount() {
		t.Fatal("5x256 operations accepted; want total-cap rejection")
	}
	small := operationBatch{commands: make([]syncCommandJSON, 1), maximum: 256}
	if !small.validCount() {
		t.Fatal("single operation rejected; want acceptance")
	}
}

func TestS67SyncEnvelopeRejectsTotalOverflow(t *testing.T) {
	payload := syncRequestJSON{
		DeviceID: "device-0001", LastRevision: int64Pointer(0),
		Commands:               make([]syncCommandJSON, 256),
		TaskOperations:         make([]syncTaskOperationJSON, 256),
		DurationOperations:     make([]syncDurationOperationJSON, 256),
		AutoStartOperations:    make([]syncAutoStartOperationJSON, 256),
		SelectedTaskOperations: make([]syncSelectedTaskOperationJSON, 256),
	}
	if validSyncEnvelope(payload) {
		t.Fatal("sync envelope with 1280 operations accepted; want rejection")
	}
	payload = validSyncRequestJSON(time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC))
	if !validSyncEnvelope(payload) {
		t.Fatal("minimal sync envelope rejected; want acceptance")
	}
}

func TestS67BootstrapEnvelopeRejectsTotalOverflow(t *testing.T) {
	payload := bootstrapResolutionRequestJSON{
		RequestID: "request-0001", DeviceID: "device-0001",
		ExpectedRevision: int64Pointer(0), Strategy: store.BootstrapMerge,
		Commands: []syncCommandJSON{}, TaskOperations: []syncTaskOperationJSON{},
		DurationOperations: []syncDurationOperationJSON{},
	}
	overflow := operationBatch{
		commands:           make([]syncCommandJSON, 4096),
		taskOperations:     make([]syncTaskOperationJSON, 4096),
		durationOperations: make([]syncDurationOperationJSON, 1),
		maximum:            4096,
	}
	if validBootstrapEnvelope(payload, overflow) {
		t.Fatal("bootstrap envelope with 8193 operations accepted; want rejection")
	}
	empty := operationBatch{maximum: 4096}
	if !validBootstrapEnvelope(payload, empty) {
		t.Fatal("empty bootstrap envelope rejected; want acceptance")
	}
}
