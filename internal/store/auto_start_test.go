package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestSyncAutoStartIsIdempotentLWWAndAcknowledgedExactly(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-auto-start-subject")
	defer db.Close()
	operation := func(id string, enabled bool, wallMs, counter int64) AutoStartOperation {
		return AutoStartOperation{ID: id, Enabled: enabled, OccurredAt: now, HLCWallMs: wallMs, HLCCounter: counter}
	}

	empty, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0001"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if empty.AutoStartBreaks || empty.AutoStartAcknowledgements == nil || len(empty.AutoStartAcknowledgements) != 0 {
		t.Fatalf("default auto-start state = %#v", empty)
	}

	request := SyncRequest{DeviceID: "device-0001", AutoStartOperations: []AutoStartOperation{
		operation("auto-start-operation-a", false, now.UnixMilli(), 0),
		operation("auto-start-operation-z", true, now.UnixMilli(), 0),
	}}
	first, err := userStore.Sync(ctx, db, userID, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed || first.Revision != 1 || !first.AutoStartBreaks || len(first.AutoStartAcknowledgements) != 2 {
		t.Fatalf("first auto-start sync = %#v", first)
	}
	if first.AutoStartAcknowledgements[0] != (AutoStartAcknowledgement{OperationID: "auto-start-operation-a", Outcome: "ignored", Reason: "superseded by newer auto-start operation"}) ||
		first.AutoStartAcknowledgements[1] != (AutoStartAcknowledgement{OperationID: "auto-start-operation-z", Outcome: "applied", Reason: ""}) {
		t.Fatalf("first auto-start acknowledgements = %#v", first.AutoStartAcknowledgements)
	}

	retry, err := userStore.Sync(ctx, db, userID, request, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if retry.Changed || retry.Revision != 1 || retry.AutoStartBreaks != first.AutoStartBreaks || len(retry.AutoStartAcknowledgements) != 2 {
		t.Fatalf("auto-start retry = %#v", retry)
	}
	for index := range first.AutoStartAcknowledgements {
		if retry.AutoStartAcknowledgements[index] != first.AutoStartAcknowledgements[index] {
			t.Fatalf("retry acknowledgement %d = %#v, want %#v", index, retry.AutoStartAcknowledgements[index], first.AutoStartAcknowledgements[index])
		}
	}

	stale, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-9999", AutoStartOperations: []AutoStartOperation{
		operation("auto-start-operation-stale", false, now.UnixMilli()-1, 99),
	}}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !stale.AutoStartBreaks || stale.Revision != 2 || stale.AutoStartAcknowledgements[0].Outcome != "ignored" {
		t.Fatalf("stale auto-start operation = %#v", stale)
	}

	newer, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0002", AutoStartOperations: []AutoStartOperation{
		operation("auto-start-operation-newer", false, now.UnixMilli(), 1),
	}}, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if newer.AutoStartBreaks || newer.Revision != 3 || newer.AutoStartAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("newer auto-start operation = %#v", newer)
	}
	if newer.ServerHLCWallMs != now.Add(3*time.Second).UnixMilli() || newer.ServerHLCCounter != 0 {
		t.Fatalf("server HLC = (%d,%d)", newer.ServerHLCWallMs, newer.ServerHLCCounter)
	}
}

func TestSyncAutoStartRejectsChangedPayloadDeviceAndBatchDuplicates(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "sync-auto-start-immutable-subject")
	defer db.Close()
	operation := AutoStartOperation{ID: "auto-start-operation-0001", Enabled: true, OccurredAt: now, HLCWallMs: now.UnixMilli(), HLCCounter: 4}
	first, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0001", AutoStartOperations: []AutoStartOperation{operation}}, now)
	if err != nil {
		t.Fatal(err)
	}

	changed := operation
	changed.Enabled = false
	conflict, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0001", AutoStartOperations: []AutoStartOperation{changed}}, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Changed || conflict.Revision != first.Revision || !conflict.AutoStartBreaks || conflict.AutoStartAcknowledgements[0] != (AutoStartAcknowledgement{
		OperationID: operation.ID, Outcome: "rejected", Reason: "operation ID already used with different payload",
	}) {
		t.Fatalf("changed auto-start payload = %#v", conflict)
	}

	deviceConflict, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0002", AutoStartOperations: []AutoStartOperation{operation}}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if deviceConflict.Changed || deviceConflict.AutoStartAcknowledgements[0].Outcome != "rejected" {
		t.Fatalf("changed auto-start device = %#v", deviceConflict)
	}

	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-0001", AutoStartOperations: []AutoStartOperation{operation, operation}}, now); err == nil {
		t.Fatal("duplicate auto-start IDs succeeded")
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM auto_start_operations`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("auto-start operation count = %d, %v; want 1", count, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE auto_start_operations SET enabled = 0 WHERE id = ?`, operation.ID); err == nil {
		t.Fatal("auto-start operation was mutable")
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM auto_start_operations WHERE id = ?`, operation.ID); err == nil {
		t.Fatal("auto-start operation was deletable")
	}
}

func TestBootstrapAutoStartOmissionEmptyReplaceMergeKeepAndIdempotency(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-auto-start-subject")
	defer db.Close()
	seed := AutoStartOperation{ID: "auto-start-operation-remote", Enabled: true, OccurredAt: now, HLCWallMs: now.UnixMilli()}
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-remote", AutoStartOperations: []AutoStartOperation{seed}}, now); err != nil {
		t.Fatal(err)
	}

	omitted := BootstrapResolutionRequest{
		RequestID: "resolution-auto-omitted", DeviceID: "device-local", ExpectedRevision: 1, Strategy: BootstrapReplaceRemote,
	}
	preserved, err := userStore.ResolveBootstrap(ctx, db, userID, omitted, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if preserved.Changed || preserved.Revision != 1 || !preserved.AutoStartBreaks || len(preserved.AutoStartAcknowledgements) != 0 {
		t.Fatalf("omitted auto-start replacement = %#v", preserved)
	}

	presentEmpty := BootstrapResolutionRequest{
		RequestID: "resolution-auto-empty", DeviceID: "device-local", ExpectedRevision: 1, Strategy: BootstrapReplaceRemote,
		AutoStartOperations: []AutoStartOperation{}, AutoStartOperationsPresent: true,
	}
	cleared, err := userStore.ResolveBootstrap(ctx, db, userID, presentEmpty, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !cleared.Changed || cleared.Revision != 2 || cleared.AutoStartBreaks || len(cleared.AutoStartAcknowledgements) != 0 {
		t.Fatalf("present-empty auto-start replacement = %#v", cleared)
	}

	mergeOperation := AutoStartOperation{ID: "auto-start-operation-merge", Enabled: true, OccurredAt: now.Add(3 * time.Second), HLCWallMs: now.Add(3 * time.Second).UnixMilli()}
	mergeRequest := BootstrapResolutionRequest{
		RequestID: "resolution-auto-merge", DeviceID: "device-local", ExpectedRevision: 2, Strategy: BootstrapMerge,
		AutoStartOperations: []AutoStartOperation{mergeOperation}, AutoStartOperationsPresent: true,
	}
	merged, err := userStore.ResolveBootstrap(ctx, db, userID, mergeRequest, now.Add(3*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !merged.AutoStartBreaks || merged.Revision != 3 || merged.AutoStartAcknowledgements[0] != (AutoStartAcknowledgement{OperationID: mergeOperation.ID, Outcome: "applied"}) {
		t.Fatalf("merged auto-start result = %#v", merged)
	}
	retry, err := userStore.ResolveBootstrap(ctx, db, userID, mergeRequest, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if retry.Changed || retry.Revision != merged.Revision || retry.ServerTime != merged.ServerTime || retry.AutoStartAcknowledgements[0] != merged.AutoStartAcknowledgements[0] {
		t.Fatalf("auto-start bootstrap retry = %#v, want %#v", retry, merged)
	}

	changedPresence := omitted
	changedPresence.RequestID = "resolution-auto-presence"
	changedPresence.ExpectedRevision = 3
	firstPresence, err := userStore.ResolveBootstrap(ctx, db, userID, changedPresence, now.Add(4*time.Second))
	if err != nil || firstPresence.Changed {
		t.Fatalf("omitted presence request = %#v, %v", firstPresence, err)
	}
	changedPresence.AutoStartOperations = []AutoStartOperation{}
	changedPresence.AutoStartOperationsPresent = true
	if _, err := userStore.ResolveBootstrap(ctx, db, userID, changedPresence, now.Add(5*time.Second)); !errors.Is(err, ErrRequestIDConflict) {
		t.Fatalf("presence hash conflict = %v, want ErrRequestIDConflict", err)
	}

	keep := BootstrapResolutionRequest{
		RequestID: "resolution-auto-keep", DeviceID: "device-local", ExpectedRevision: 3, Strategy: BootstrapKeepRemote,
		AutoStartOperations: []AutoStartOperation{mergeOperation}, AutoStartOperationsPresent: true,
	}
	if _, err := userStore.ResolveBootstrap(ctx, db, userID, keep, now); err == nil {
		t.Fatal("keep_remote accepted nonempty auto-start operations")
	}
}

func TestBootstrapLegacyOmittedAutoStartHashReplaysStoredResponse(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-legacy-auto-start-hash-subject")
	defer db.Close()
	request := BootstrapResolutionRequest{
		RequestID: "resolution-legacy-auto-start", DeviceID: "device-0001", ExpectedRevision: 0, Strategy: BootstrapKeepRemote,
	}
	legacyPayload := `{"DeviceID":"device-0001","ExpectedRevision":0,"Strategy":"keep_remote","Commands":[],"TaskOperations":[],"DurationOperations":[]}`
	legacyHash := sha256.Sum256([]byte(legacyPayload))
	legacyResponse := `{"acknowledgements":[],"taskAcknowledgements":[],"durationAcknowledgements":[],"revision":42,"canonicalTimer":null,"history":[],"tasks":[],"durationsMs":{"focus":1500000,"short_break":300000,"long_break":900000},"serverTime":"legacy-stored-response","serverHlcWallMs":7,"serverHlcCounter":2}`
	if _, err := db.ExecContext(ctx, `INSERT INTO bootstrap_resolutions(request_id, payload_hash, response_json, created_at_ms)
		VALUES (?, ?, ?, ?)`, request.RequestID, legacyHash[:], legacyResponse, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}

	replayed, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Revision != 42 || replayed.ServerTime != "legacy-stored-response" || replayed.ServerHLCWallMs != 7 || replayed.ServerHLCCounter != 2 {
		t.Fatalf("legacy replay = %#v", replayed)
	}
	if replayed.AutoStartAcknowledgements == nil || len(replayed.AutoStartAcknowledgements) != 0 || replayed.AutoStartBreaks {
		t.Fatalf("legacy response compatibility fields = %#v/%t", replayed.AutoStartAcknowledgements, replayed.AutoStartBreaks)
	}

	presentEmpty := request
	presentEmpty.AutoStartOperations = []AutoStartOperation{}
	presentEmpty.AutoStartOperationsPresent = true
	if _, err := userStore.ResolveBootstrap(ctx, db, userID, presentEmpty, now.Add(2*time.Hour)); !errors.Is(err, ErrRequestIDConflict) {
		t.Fatalf("present-empty retry error = %v, want ErrRequestIDConflict", err)
	}
}

func TestBootstrapLegacyReplayNormalizesZeroServerHLC(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-legacy-zero-hlc-subject")
	defer db.Close()
	request := BootstrapResolutionRequest{
		RequestID: "resolution-legacy-zero-hlc", DeviceID: "device-0001", ExpectedRevision: 0, Strategy: BootstrapKeepRemote,
	}
	legacyPayload := `{"DeviceID":"device-0001","ExpectedRevision":0,"Strategy":"keep_remote","Commands":[],"TaskOperations":[],"DurationOperations":[]}`
	legacyHash := sha256.Sum256([]byte(legacyPayload))
	serverTime := now.UTC().Format(time.RFC3339Nano)
	legacyResponse := fmt.Sprintf(
		`{"acknowledgements":[],"taskAcknowledgements":[],"durationAcknowledgements":[],"revision":0,"canonicalTimer":null,"history":[],"tasks":[],"durationsMs":{"focus":1500000,"short_break":300000,"long_break":900000},"serverTime":%q,"serverHlcWallMs":0,"serverHlcCounter":0}`,
		serverTime,
	)
	if _, err := db.ExecContext(ctx, `INSERT INTO bootstrap_resolutions(request_id, payload_hash, response_json, created_at_ms)
		VALUES (?, ?, ?, ?)`, request.RequestID, legacyHash[:], legacyResponse, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}

	replayed, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if replayed.ServerHLCWallMs != now.UnixMilli() || replayed.ServerHLCCounter != 0 {
		t.Fatalf("legacy replay server HLC = (%d,%d), want (%d,0)", replayed.ServerHLCWallMs, replayed.ServerHLCCounter, now.UnixMilli())
	}
}

func TestBootstrapAutoStartReplacementRollbackRestoresRowsAndGuard(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "bootstrap-auto-start-rollback-subject")
	defer db.Close()
	remote := AutoStartOperation{ID: "auto-start-operation-remote", Enabled: true, OccurredAt: now, HLCWallMs: now.UnixMilli()}
	if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-remote", AutoStartOperations: []AutoStartOperation{remote}}, now); err != nil {
		t.Fatal(err)
	}
	invalid := AutoStartOperation{ID: "auto-start-operation-invalid", Enabled: false, OccurredAt: now, HLCWallMs: -1}
	_, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "resolution-auto-rollback", DeviceID: "device-local", ExpectedRevision: 1, Strategy: BootstrapReplaceRemote,
		AutoStartOperations: []AutoStartOperation{invalid}, AutoStartOperationsPresent: true,
	}, now.Add(time.Second))
	if err == nil {
		t.Fatal("invalid auto-start replacement succeeded")
	}
	var remoteCount, invalidCount, flags, revision int
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM auto_start_operations WHERE id = ?`, remote.ID).Scan(&remoteCount)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM auto_start_operations WHERE id = ?`, invalid.ID).Scan(&invalidCount)
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM maintenance_flags`).Scan(&flags)
	db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision)
	if remoteCount != 1 || invalidCount != 0 || flags != 0 || revision != 1 {
		t.Fatalf("rollback state remote=%d invalid=%d flags=%d revision=%d", remoteCount, invalidCount, flags, revision)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM auto_start_operations WHERE id = ?`, remote.ID); err == nil {
		t.Fatal("auto-start delete guard remained disabled after rollback")
	}
}
