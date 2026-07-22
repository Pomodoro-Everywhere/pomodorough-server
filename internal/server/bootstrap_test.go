package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"pomodorough/internal/store"
)

func TestHTTPBootstrapPreviewIsReadOnlyAndKeepRemoteDoesNotPublish(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	syncPayload := validSyncRequestJSON(now)
	if response := postAuthenticatedJSON(t, fixture, "/api/v1/sync", syncPayload); response.Code != http.StatusOK {
		t.Fatalf("seed sync status=%d body=%s", response.Code, response.Body.String())
	}
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	var beforeLastSeen int64
	if err := db.QueryRow(`SELECT last_seen_at_ms FROM devices WHERE id = ?`, fixture.deviceID).Scan(&beforeLastSeen); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	revisions, unsubscribe := fixture.application.hub.subscribe(fixture.userID)
	defer unsubscribe()

	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/bootstrap", nil)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET bootstrap status=%d body=%s", response.Code, response.Body.String())
	}
	var preview store.SyncResult
	if err := json.NewDecoder(response.Body).Decode(&preview); err != nil {
		t.Fatal(err)
	}
	if preview.Revision != 1 || len(preview.Acknowledgements) != 0 || len(preview.TaskAcknowledgements) != 0 || len(preview.DurationAcknowledgements) != 0 || preview.CanonicalTimer == nil {
		t.Fatalf("bootstrap preview = %#v", preview)
	}
	assertNoRevision(t, revisions)

	db, err = fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	var afterLastSeen int64
	if err := db.QueryRow(`SELECT last_seen_at_ms FROM devices WHERE id = ?`, fixture.deviceID).Scan(&afterLastSeen); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	if afterLastSeen != beforeLastSeen {
		t.Fatalf("preview updated device last_seen: %d -> %d", beforeLastSeen, afterLastSeen)
	}

	keep := emptyBootstrapResolutionJSON("resolution-http-keep-0001", fixture.deviceID, 1, store.BootstrapKeepRemote)
	first := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", keep)
	if first.Code != http.StatusOK {
		t.Fatalf("keep_remote status=%d body=%s", first.Code, first.Body.String())
	}
	retry := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", keep)
	if retry.Code != http.StatusOK || retry.Body.String() != first.Body.String() {
		t.Fatalf("keep_remote retry status=%d first=%s retry=%s", retry.Code, first.Body.String(), retry.Body.String())
	}
	assertNoRevision(t, revisions)
}

func TestHTTPBootstrapMergeIsIdempotentAndMapsConflicts(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	title := "Bootstrap task"
	operation := validTaskOperationJSON(now, title)
	command := validSyncRequestJSON(now).Commands[0]
	command.TaskID = operation.TaskID
	payload := emptyBootstrapResolutionJSON("resolution-http-merge-0001", fixture.deviceID, 0, store.BootstrapMerge)
	payload.Commands = []syncCommandJSON{command}
	payload.TaskOperations = []syncTaskOperationJSON{operation}
	payload.DurationOperations = []syncDurationOperationJSON{validDurationOperationJSON(now, "short_break", 600_000)}
	revisions, unsubscribe := fixture.application.hub.subscribe(fixture.userID)
	defer unsubscribe()

	first := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", payload)
	if first.Code != http.StatusOK {
		t.Fatalf("merge status=%d body=%s", first.Code, first.Body.String())
	}
	var result store.SyncResult
	if err := json.Unmarshal(first.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 || result.CanonicalTimer == nil || len(result.Tasks) != 1 || result.DurationsMs.ShortBreak != 600_000 || result.Acknowledgements[0].Outcome != "applied" || result.TaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("merge response = %#v", result)
	}
	receiveRevision(t, revisions, 1)

	retry := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", payload)
	if retry.Code != http.StatusOK || retry.Body.String() != first.Body.String() {
		t.Fatalf("merge retry status=%d first=%s retry=%s", retry.Code, first.Body.String(), retry.Body.String())
	}
	assertNoRevision(t, revisions)

	changed := payload
	changed.DurationOperations = append([]syncDurationOperationJSON(nil), payload.DurationOperations...)
	changed.DurationOperations[0].DurationMs = int64Pointer(1_200_000)
	conflict := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", changed)
	if conflict.Code != http.StatusConflict || strings.TrimSpace(conflict.Body.String()) != `{"error":"request ID conflict"}` {
		t.Fatalf("request ID conflict status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	stale := emptyBootstrapResolutionJSON("resolution-http-stale-0001", fixture.deviceID, 0, store.BootstrapMerge)
	staleConflict := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", stale)
	if staleConflict.Code != http.StatusConflict || strings.TrimSpace(staleConflict.Body.String()) != `{"error":"revision conflict"}` {
		t.Fatalf("revision conflict status=%d body=%s", staleConflict.Code, staleConflict.Body.String())
	}
	assertNoRevision(t, revisions)
}

func TestHTTPBootstrapReplaceAndBearerDeviceMatch(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	if response := postAuthenticatedJSON(t, fixture, "/api/v1/sync", validSyncRequestJSON(now)); response.Code != http.StatusOK {
		t.Fatalf("seed sync status=%d body=%s", response.Code, response.Body.String())
	}
	payload := emptyBootstrapResolutionJSON("resolution-http-replace-0001", fixture.deviceID, 1, store.BootstrapReplaceRemote)
	payload.Commands = []syncCommandJSON{{
		ID: "command-replacement", DeviceSequence: int64Pointer(1), TimerID: "timer-replacement", Type: "start", Phase: "focus",
		PlannedDurationMs: int64Pointer(25 * 60_000), OccurredAt: now.Add(time.Second).Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(now.Add(time.Second).UnixMilli()), HLCCounter: int64Pointer(0), ObservedElapsedMs: int64Pointer(0),
	}}
	revisions, unsubscribe := fixture.application.hub.subscribe(fixture.userID)
	defer unsubscribe()
	response := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", payload)
	if response.Code != http.StatusOK {
		t.Fatalf("replace status=%d body=%s", response.Code, response.Body.String())
	}
	var result store.SyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Revision != 2 || result.CanonicalTimer == nil || result.CanonicalTimer.ID != "timer-replacement" {
		t.Fatalf("replace response = %#v", result)
	}
	receiveRevision(t, revisions, 2)
	db, err := fixture.userStore.OpenExistingUser(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var oldCount, newCount int
	db.QueryRow(`SELECT COUNT(*) FROM timer_commands WHERE id = 'command-0001'`).Scan(&oldCount)
	db.QueryRow(`SELECT COUNT(*) FROM timer_commands WHERE id = 'command-replacement'`).Scan(&newCount)
	if oldCount != 0 || newCount != 1 {
		t.Fatalf("replace command counts old=%d new=%d", oldCount, newCount)
	}

	mismatch := emptyBootstrapResolutionJSON("resolution-http-mismatch-0001", "device-0002", 2, store.BootstrapKeepRemote)
	mismatchResponse := postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", mismatch)
	if mismatchResponse.Code != http.StatusForbidden || !strings.Contains(mismatchResponse.Body.String(), "device mismatch") {
		t.Fatalf("device mismatch status=%d body=%s", mismatchResponse.Code, mismatchResponse.Body.String())
	}
}

func TestHTTPConcurrentBootstrapCASPublishesOneRevision(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	payloads := []bootstrapResolutionRequestJSON{
		emptyBootstrapResolutionJSON("resolution-http-concurrent-0001", fixture.deviceID, 0, store.BootstrapMerge),
		emptyBootstrapResolutionJSON("resolution-http-concurrent-0002", fixture.deviceID, 0, store.BootstrapMerge),
	}
	payloads[0].DurationOperations = []syncDurationOperationJSON{validDurationOperationJSON(now, "focus", 1_200_000)}
	payloads[1].DurationOperations = []syncDurationOperationJSON{validDurationOperationJSON(now, "short_break", 600_000)}
	payloads[1].DurationOperations[0].ID = "duration-operation-0002"
	revisions, unsubscribe := fixture.application.hub.subscribe(fixture.userID)
	defer unsubscribe()

	responses := make([]*httptest.ResponseRecorder, len(payloads))
	start := make(chan struct{})
	var wait sync.WaitGroup
	for index := range payloads {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			responses[index] = postAuthenticatedJSON(t, fixture, "/api/v1/bootstrap/resolve", payloads[index])
		}(index)
	}
	close(start)
	wait.Wait()
	ok, conflict := 0, 0
	for _, response := range responses {
		switch response.Code {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			conflict++
		default:
			t.Fatalf("concurrent status=%d body=%s", response.Code, response.Body.String())
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("concurrent statuses ok=%d conflict=%d", ok, conflict)
	}
	receiveRevision(t, revisions, 1)
	assertNoRevision(t, revisions)
}

func TestHTTPSyncRejectsChangedAndDuplicateTimerTaskIDs(t *testing.T) {
	fixture := newServerFixture(t)
	now := time.Now().UTC()
	payload := validSyncRequestJSON(now)
	taskOperation := validTaskOperationJSON(now, "Immutable task")
	payload.TaskOperations = []syncTaskOperationJSON{taskOperation}
	payload.Commands[0].TaskID = taskOperation.TaskID
	if response := postAuthenticatedJSON(t, fixture, "/api/v1/sync", payload); response.Code != http.StatusOK {
		t.Fatalf("initial sync status=%d body=%s", response.Code, response.Body.String())
	}
	changed := payload
	changed.Commands = append([]syncCommandJSON(nil), payload.Commands...)
	changed.TaskOperations = append([]syncTaskOperationJSON(nil), payload.TaskOperations...)
	changed.Commands[0].ObservedElapsedMs = int64Pointer(12)
	changed.TaskOperations[0].HLCCounter = int64Pointer(1)
	response := postAuthenticatedJSON(t, fixture, "/api/v1/sync", changed)
	if response.Code != http.StatusOK {
		t.Fatalf("changed ID sync status=%d body=%s", response.Code, response.Body.String())
	}
	var result store.SyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 || result.Acknowledgements[0].Outcome != "rejected" || result.TaskAcknowledgements[0].Outcome != "rejected" {
		t.Fatalf("changed immutable sync response = %#v", result)
	}

	duplicate := validSyncRequestJSON(now)
	duplicate.Commands = append(duplicate.Commands, duplicate.Commands[0])
	duplicateResponse := postAuthenticatedJSON(t, fixture, "/api/v1/sync", duplicate)
	if duplicateResponse.Code != http.StatusBadRequest {
		t.Fatalf("duplicate command status=%d body=%s", duplicateResponse.Code, duplicateResponse.Body.String())
	}
	duplicate = validSyncRequestJSON(now)
	duplicate.Commands = []syncCommandJSON{}
	duplicate.TaskOperations = []syncTaskOperationJSON{taskOperation, taskOperation}
	duplicateResponse = postAuthenticatedJSON(t, fixture, "/api/v1/sync", duplicate)
	if duplicateResponse.Code != http.StatusBadRequest {
		t.Fatalf("duplicate task status=%d body=%s", duplicateResponse.Code, duplicateResponse.Body.String())
	}
}

func TestHTTPBootstrapResolveRequiresMutationAuthenticationAndCompleteArrays(t *testing.T) {
	fixture := newServerFixture(t)
	payload := emptyBootstrapResolutionJSON("resolution-http-auth-0001", fixture.deviceID, 0, store.BootstrapKeepRemote)
	request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me/api/v1/bootstrap/resolve", payload)
	addWebAuthentication(request, fixture)
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("bootstrap resolve without CSRF status=%d body=%s", response.Code, response.Body.String())
	}

	body := []byte(`{"requestId":"resolution-http-invalid","deviceId":"device-0001","expectedRevision":0,"strategy":"keep_remote","commands":[]}`)
	request = httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/bootstrap/resolve", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response = httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("incomplete bootstrap arrays status=%d body=%s", response.Code, response.Body.String())
	}
}

func emptyBootstrapResolutionJSON(requestID, deviceID string, expectedRevision int64, strategy string) bootstrapResolutionRequestJSON {
	return bootstrapResolutionRequestJSON{
		RequestID: requestID, DeviceID: deviceID, ExpectedRevision: int64Pointer(expectedRevision), Strategy: strategy,
		Commands: []syncCommandJSON{}, TaskOperations: []syncTaskOperationJSON{}, DurationOperations: []syncDurationOperationJSON{},
	}
}

func postAuthenticatedJSON(t *testing.T, fixture serverFixture, path string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	request, response := newJSONRequest(t, http.MethodPost, "https://pomodorough.egigoka.me"+path, payload)
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	fixture.handler.ServeHTTP(response, request)
	return response
}
