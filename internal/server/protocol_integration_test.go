package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pomodorough/internal/config"
	"pomodorough/internal/integrationuser"
	"pomodorough/internal/store"
	"pomodorough/internal/task"
)

type protocolClient struct {
	name        string
	deviceID    string
	accessToken string
	httpClient  *http.Client
	revision    int64
	stream      *protocolRevisionStream
}

type protocolNativeStore struct {
	client                 *protocolClient
	commands               []syncCommandJSON
	taskOperations         []syncTaskOperationJSON
	durationOperations     []syncDurationOperationJSON
	autoStartOperations    []syncAutoStartOperationJSON
	selectedTaskOperations []syncSelectedTaskOperationJSON
}

func (s *protocolNativeStore) payload() syncRequestJSON {
	return syncRequestJSON{
		DeviceID: s.client.deviceID, LastRevision: int64Pointer(s.client.revision),
		Commands:               append([]syncCommandJSON(nil), s.commands...),
		TaskOperations:         append([]syncTaskOperationJSON(nil), s.taskOperations...),
		DurationOperations:     append([]syncDurationOperationJSON(nil), s.durationOperations...),
		AutoStartOperations:    append([]syncAutoStartOperationJSON(nil), s.autoStartOperations...),
		SelectedTaskOperations: append([]syncSelectedTaskOperationJSON(nil), s.selectedTaskOperations...),
	}
}

func (s *protocolNativeStore) apply(t *testing.T, result store.SyncResult) {
	t.Helper()
	validateProtocolAcknowledgements(t, commandJSONIDs(s.commands), acknowledgementIDs(result.Acknowledgements))
	validateProtocolAcknowledgements(t, taskOperationJSONIDs(s.taskOperations), taskAcknowledgementIDs(result.TaskAcknowledgements))
	validateProtocolAcknowledgements(t, durationOperationJSONIDs(s.durationOperations), durationAcknowledgementIDs(result.DurationAcknowledgements))
	validateProtocolAcknowledgements(t, autoStartOperationJSONIDs(s.autoStartOperations), autoStartAcknowledgementIDs(result.AutoStartAcknowledgements))
	validateProtocolAcknowledgements(t, selectedTaskOperationJSONIDs(s.selectedTaskOperations), selectedTaskAcknowledgementIDs(result.SelectedTaskAcknowledgements))
	s.commands = nil
	s.taskOperations = nil
	s.durationOperations = nil
	s.autoStartOperations = nil
	s.selectedTaskOperations = nil
}

func (s *protocolNativeStore) pendingCount() int {
	return len(s.commands) + len(s.taskOperations) + len(s.durationOperations) + len(s.autoStartOperations) + len(s.selectedTaskOperations)
}

type protocolRevisionStream struct {
	cancel    context.CancelFunc
	body      io.ReadCloser
	revisions chan int64
}

type protocolFixture struct {
	application *Server
	server      *httptest.Server
	userStore   *store.Store
	userID      string
	clients     []*protocolClient
	mu          sync.Mutex
	identifier  int64
	logicalTime time.Time
	sequences   map[string]int64
}

func newProtocolFixture(t *testing.T) *protocolFixture {
	t.Helper()
	dataDir := t.TempDir()
	secret := []byte(strings.Repeat("protocol-integration-secret-", 2))
	devices := []integrationuser.Device{
		{Name: "pwa", DeviceID: "device-pwa", Platform: "web"},
		{Name: "ios", DeviceID: "device-ios", Platform: "ios"},
		{Name: "linux", DeviceID: "device-linux", Platform: "linux"},
		{Name: "android", DeviceID: "device-android", Platform: "android"},
	}
	credentials, err := integrationuser.Provision(context.Background(), integrationuser.Request{
		DataDir: dataDir, AppSecret: secret, Subject: "protocol-integration-subject", Devices: devices, TTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	userStore, err := store.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	webRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(webRoot, "openapi.yaml"), []byte("openapi: 3.0.3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webRoot, "index.html"), []byte("<!doctype html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	application, err := New(config.Config{
		PublicURL: "https://integration.invalid", WebRoot: webRoot, AppSecret: secret, GoogleNativeClientIDSet: map[string]struct{}{},
	}, userStore, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	testServer := httptest.NewServer(application.Handler())
	fixture := &protocolFixture{
		application: application, server: testServer, userStore: userStore, userID: credentials.UserID,
		logicalTime: time.Now().UTC().Add(-time.Minute), sequences: make(map[string]int64),
	}
	for _, credential := range credentials.Clients {
		fixture.clients = append(fixture.clients, &protocolClient{
			name: credential.Name, deviceID: credential.DeviceID, accessToken: credential.AccessToken,
			httpClient: &http.Client{Timeout: 5 * time.Second},
		})
	}
	for _, client := range fixture.clients {
		client.stream = fixture.openRevisionStream(t, client)
	}
	t.Cleanup(func() {
		for _, client := range fixture.clients {
			if client.stream != nil {
				client.stream.close()
			}
		}
		testServer.Close()
	})
	return fixture
}

func (f *protocolFixture) nextID(prefix string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.identifier++
	return fmt.Sprintf("%s-%08d", prefix, f.identifier)
}

func (f *protocolFixture) nextTime() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logicalTime = f.logicalTime.Add(time.Millisecond)
	return f.logicalTime
}

func (f *protocolFixture) nextSequence(deviceID string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sequences[deviceID]++
	return f.sequences[deviceID]
}

func (f *protocolFixture) command(client *protocolClient, timerID, commandType, phase string, durationMs, observedMs int64, taskID string, at time.Time) syncCommandJSON {
	return syncCommandJSON{
		ID: f.nextID("command"), DeviceSequence: int64Pointer(f.nextSequence(client.deviceID)), TimerID: timerID, TaskID: taskID,
		Type: commandType, Phase: phase, PlannedDurationMs: int64Pointer(durationMs), OccurredAt: at.Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0), ObservedElapsedMs: int64Pointer(observedMs),
	}
}

func (f *protocolFixture) syncPayload(client *protocolClient) syncRequestJSON {
	return syncRequestJSON{DeviceID: client.deviceID, LastRevision: int64Pointer(client.revision), Commands: []syncCommandJSON{}}
}

func (f *protocolFixture) doJSON(client *protocolClient, path string, payload any) (int, []byte, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	request, err := http.NewRequest(http.MethodPost, f.server.URL+path, bytes.NewReader(encoded))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.accessToken)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	return response.StatusCode, body, err
}

func (f *protocolFixture) doSync(client *protocolClient, payload syncRequestJSON) (store.SyncResult, int, error) {
	status, body, err := f.doJSON(client, "/api/v1/sync", payload)
	if err != nil || status != http.StatusOK {
		return store.SyncResult{}, status, fmt.Errorf("sync status=%d body=%s: %w", status, body, err)
	}
	var result store.SyncResult
	if err := json.Unmarshal(body, &result); err != nil {
		return store.SyncResult{}, status, err
	}
	client.revision = result.Revision
	return result, status, nil
}

func (f *protocolFixture) sync(t *testing.T, client *protocolClient, payload syncRequestJSON) store.SyncResult {
	t.Helper()
	result, _, err := f.doSync(client, payload)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *protocolFixture) pull(t *testing.T, client *protocolClient) store.SyncResult {
	t.Helper()
	return f.sync(t, client, f.syncPayload(client))
}

func (f *protocolFixture) openRevisionStream(t *testing.T, client *protocolClient) *protocolRevisionStream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, f.server.URL+"/api/v1/stream", nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+client.accessToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		cancel()
		t.Fatalf("open SSE status=%d body=%s", response.StatusCode, body)
	}
	stream := &protocolRevisionStream{cancel: cancel, body: response.Body, revisions: make(chan int64, 64)}
	go func() {
		defer close(stream.revisions)
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var event struct {
				Revision int64 `json:"revision"`
			}
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) == nil {
				stream.revisions <- event.Revision
			}
		}
	}()
	return stream
}

func (s *protocolRevisionStream) waitAtLeast(t *testing.T, revision int64) {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case observed, ok := <-s.revisions:
			if !ok {
				t.Fatal("SSE stream closed before expected revision")
			}
			if observed >= revision {
				return
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for SSE revision %d", revision)
		}
	}
}

func (s *protocolRevisionStream) close() {
	s.cancel()
	_ = s.body.Close()
}

func comparableProtocolState(result store.SyncResult) string {
	encoded, _ := json.Marshal(map[string]any{
		"revision": result.Revision, "canonicalTimer": result.CanonicalTimer, "history": result.History,
		"tasks": result.Tasks, "durationsMs": result.DurationsMs, "autoStartBreaks": result.AutoStartBreaks, "selectedTaskId": result.SelectedTaskID,
	})
	return string(encoded)
}

func validateProtocolAcknowledgements(t *testing.T, sent, acknowledged []string) {
	t.Helper()
	if len(sent) != len(acknowledged) {
		t.Fatalf("acknowledgement count = %d, want %d", len(acknowledged), len(sent))
	}
	expected := make(map[string]struct{}, len(sent))
	for _, id := range sent {
		expected[id] = struct{}{}
	}
	for _, id := range acknowledged {
		if _, ok := expected[id]; !ok {
			t.Fatalf("unexpected acknowledgement ID %q", id)
		}
		delete(expected, id)
	}
	if len(expected) != 0 {
		t.Fatalf("missing acknowledgement IDs: %#v", expected)
	}
}

func commandJSONIDs(values []syncCommandJSON) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].ID
	}
	return result
}

func taskOperationJSONIDs(values []syncTaskOperationJSON) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].ID
	}
	return result
}

func durationOperationJSONIDs(values []syncDurationOperationJSON) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].ID
	}
	return result
}

func autoStartOperationJSONIDs(values []syncAutoStartOperationJSON) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].ID
	}
	return result
}

func selectedTaskOperationJSONIDs(values []syncSelectedTaskOperationJSON) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].ID
	}
	return result
}

func acknowledgementIDs(values []store.Acknowledgement) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].CommandID
	}
	return result
}

func taskAcknowledgementIDs(values []store.TaskAcknowledgement) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].OperationID
	}
	return result
}

func durationAcknowledgementIDs(values []store.DurationAcknowledgement) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].OperationID
	}
	return result
}

func autoStartAcknowledgementIDs(values []store.AutoStartAcknowledgement) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].OperationID
	}
	return result
}

func selectedTaskAcknowledgementIDs(values []store.SelectedTaskAcknowledgement) []string {
	result := make([]string, len(values))
	for index := range values {
		result[index] = values[index].OperationID
	}
	return result
}

func TestLogicalProtocolClientsConvergeSelectedTaskPreference(t *testing.T) {
	fixture := newProtocolFixture(t)
	initiator := fixture.clients[0]
	taskTitle := "Protocol selected task"
	taskID := task.ID(taskTitle)
	selected := fixture.syncPayload(initiator)
	selected.TaskOperations = []syncTaskOperationJSON{validTaskOperationJSON(fixture.nextTime(), taskTitle)}
	selected.SelectedTaskOperations = []syncSelectedTaskOperationJSON{validSelectedTaskOperationJSON(t, fixture.nextTime(), &taskID)}
	result := fixture.sync(t, initiator, selected)
	if result.SelectedTaskID == nil || *result.SelectedTaskID != taskID || result.SelectedTaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("selected-task mutation = %#v", result)
	}
	states := fixture.converge(t, result.Revision)
	for index, state := range states {
		if state.SelectedTaskID == nil || *state.SelectedTaskID != taskID {
			t.Fatalf("client %d selected-task state = %#v", index, state.SelectedTaskID)
		}
	}

	clearer := fixture.clients[1]
	clear := fixture.syncPayload(clearer)
	clear.SelectedTaskOperations = []syncSelectedTaskOperationJSON{validSelectedTaskOperationJSON(t, fixture.nextTime(), nil)}
	clear.SelectedTaskOperations[0].ID = fixture.nextID("selected-task-operation")
	cleared := fixture.sync(t, clearer, clear)
	if cleared.SelectedTaskID != nil || cleared.SelectedTaskAcknowledgements[0].Outcome != "applied" {
		t.Fatalf("selected-task clear = %#v", cleared)
	}
	states = fixture.converge(t, cleared.Revision)
	for index, state := range states {
		if state.SelectedTaskID != nil {
			t.Fatalf("client %d selected-task clear = %#v", index, state.SelectedTaskID)
		}
	}
}

func (f *protocolFixture) converge(t *testing.T, revision int64) []store.SyncResult {
	t.Helper()
	results := make([]store.SyncResult, len(f.clients))
	for _, client := range f.clients {
		client.stream.waitAtLeast(t, revision)
	}
	for index, client := range f.clients {
		results[index] = f.pull(t, client)
	}
	want := comparableProtocolState(results[0])
	for index := 1; index < len(results); index++ {
		if got := comparableProtocolState(results[index]); got != want {
			t.Fatalf("logical client %s diverged:\nwant %s\ngot  %s", f.clients[index].name, want, got)
		}
	}
	return results
}

type protocolTransition struct {
	name        string
	from        string
	action      string
	wantStatus  string
	wantHistory string
	wantNil     bool
}

func TestLogicalProtocolClientsConvergeAcrossTimerTransitionTable(t *testing.T) {
	transitions := []protocolTransition{
		{name: "none-to-running", from: "none", action: "start", wantStatus: "running"},
		{name: "running-to-paused", from: "running", action: "pause", wantStatus: "paused"},
		{name: "running-to-completed", from: "running", action: "finish", wantStatus: "completed", wantHistory: "completed"},
		{name: "running-to-cancelled", from: "running", action: "cancel", wantStatus: "cancelled", wantHistory: "cancelled"},
		{name: "running-to-superseded", from: "running", action: "supersede", wantStatus: "running", wantHistory: "superseded"},
		{name: "paused-to-running", from: "paused", action: "resume", wantStatus: "running"},
		{name: "paused-to-completed", from: "paused", action: "finish", wantStatus: "completed", wantHistory: "completed"},
		{name: "paused-to-cancelled", from: "paused", action: "cancel", wantStatus: "cancelled", wantHistory: "cancelled"},
		{name: "terminal-to-cleared", from: "terminal", action: "clear", wantHistory: "completed", wantNil: true},
		{name: "terminal-to-new-running", from: "terminal", action: "new", wantStatus: "running", wantHistory: "completed"},
	}
	for clientIndex, name := range []string{"pwa", "ios", "linux", "android"} {
		for _, transition := range transitions {
			clientIndex, transition := clientIndex, transition
			t.Run(name+"-"+transition.name, func(t *testing.T) {
				fixture := newProtocolFixture(t)
				initiator := fixture.clients[clientIndex]
				timerID := fixture.nextID("timer")
				revision := int64(0)
				if transition.from != "none" {
					payload := fixture.syncPayload(initiator)
					payload.Commands = []syncCommandJSON{fixture.command(initiator, timerID, "start", "focus", 1_500_000, 0, "", fixture.nextTime())}
					revision = fixture.sync(t, initiator, payload).Revision
					fixture.converge(t, revision)
				}
				if transition.from == "paused" {
					payload := fixture.syncPayload(initiator)
					payload.Commands = []syncCommandJSON{fixture.command(initiator, timerID, "pause", "focus", 1_500_000, 30_000, "", fixture.nextTime())}
					revision = fixture.sync(t, initiator, payload).Revision
					fixture.converge(t, revision)
				}
				if transition.from == "terminal" {
					payload := fixture.syncPayload(initiator)
					payload.Commands = []syncCommandJSON{fixture.command(initiator, timerID, "finish", "focus", 1_500_000, 1_500_000, "", fixture.nextTime())}
					revision = fixture.sync(t, initiator, payload).Revision
					fixture.converge(t, revision)
				}

				payload := fixture.syncPayload(initiator)
				actionTimerID := timerID
				action := transition.action
				if transition.action == "start" || transition.action == "new" || transition.action == "supersede" {
					action = "start"
				}
				if transition.action == "new" || transition.action == "supersede" {
					actionTimerID = fixture.nextID("timer")
				}
				payload.Commands = []syncCommandJSON{fixture.command(initiator, actionTimerID, action, "focus", 1_500_000, 45_000, "", fixture.nextTime())}
				revision = fixture.sync(t, initiator, payload).Revision
				results := fixture.converge(t, revision)
				state := results[0]
				if transition.wantNil {
					if state.CanonicalTimer != nil {
						t.Fatalf("canonical timer = %#v, want nil", state.CanonicalTimer)
					}
				} else if state.CanonicalTimer == nil || state.CanonicalTimer.Status != transition.wantStatus || state.CanonicalTimer.ID != actionTimerID {
					t.Fatalf("canonical timer = %#v, want %s/%s", state.CanonicalTimer, actionTimerID, transition.wantStatus)
				}
				if transition.wantHistory == "" && len(state.History) != 0 {
					t.Fatalf("unexpected history = %#v", state.History)
				}
				if transition.wantHistory != "" && (len(state.History) != 1 || state.History[0].Status != transition.wantHistory) {
					t.Fatalf("history = %#v, want one %s", state.History, transition.wantHistory)
				}
			})
		}
	}
}

func TestLogicalProtocolClientsConvergeTasksDurationsAndAutoStart(t *testing.T) {
	fixture := newProtocolFixture(t)
	clients := fixture.clients
	title := "Protocol integration task"
	taskID := task.ID(title)
	at := fixture.nextTime()
	payload := fixture.syncPayload(clients[0])
	payload.TaskOperations = []syncTaskOperationJSON{{
		ID: fixture.nextID("task-operation"), TaskID: taskID, Type: "upsert", Title: title,
		OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0),
	}}
	result := fixture.sync(t, clients[0], payload)
	states := fixture.converge(t, result.Revision)
	if len(states[0].Tasks) != 1 || states[0].Tasks[0].ID != taskID {
		t.Fatalf("task upsert state = %#v", states[0])
	}

	timerID := fixture.nextID("timer")
	payload = fixture.syncPayload(clients[1])
	payload.Commands = []syncCommandJSON{fixture.command(clients[1], timerID, "start", "focus", 1_500_000, 0, taskID, fixture.nextTime())}
	result = fixture.sync(t, clients[1], payload)
	states = fixture.converge(t, result.Revision)
	if states[0].CanonicalTimer == nil || states[0].CanonicalTimer.TaskID != taskID {
		t.Fatalf("focus task association = %#v", states[0].CanonicalTimer)
	}

	at = fixture.nextTime()
	payload = fixture.syncPayload(clients[2])
	payload.TaskOperations = []syncTaskOperationJSON{{
		ID: fixture.nextID("task-operation"), TaskID: taskID, Type: "delete", OccurredAt: at.Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0),
	}}
	result = fixture.sync(t, clients[2], payload)
	states = fixture.converge(t, result.Revision)
	if len(states[0].Tasks) != 0 || states[0].CanonicalTimer == nil || states[0].CanonicalTimer.TaskID != taskID {
		t.Fatalf("task delete/current association state = %#v", states[0])
	}

	at = fixture.nextTime()
	payload = fixture.syncPayload(clients[3])
	payload.DurationOperations = []syncDurationOperationJSON{
		{ID: fixture.nextID("duration-operation"), Phase: "focus", DurationMs: int64Pointer(1_200_000), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
		{ID: fixture.nextID("duration-operation"), Phase: "short_break", DurationMs: int64Pointer(420_000), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
		{ID: fixture.nextID("duration-operation"), Phase: "long_break", DurationMs: int64Pointer(1_200_000), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
	}
	result = fixture.sync(t, clients[3], payload)
	states = fixture.converge(t, result.Revision)
	if states[0].DurationsMs != (store.DurationsMs{Focus: 1_200_000, ShortBreak: 420_000, LongBreak: 1_200_000}) {
		t.Fatalf("duration propagation = %#v", states[0].DurationsMs)
	}

	at = fixture.nextTime()
	payload = fixture.syncPayload(clients[0])
	payload.DurationOperations = []syncDurationOperationJSON{
		{ID: "duration-conflict-a", Phase: "focus", DurationMs: int64Pointer(1_500_000), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
		{ID: "duration-conflict-z", Phase: "focus", DurationMs: int64Pointer(1_800_000), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
	}
	result = fixture.sync(t, clients[0], payload)
	states = fixture.converge(t, result.Revision)
	if states[0].DurationsMs.Focus != 1_800_000 || result.DurationAcknowledgements[0].Outcome != "ignored" || result.DurationAcknowledgements[1].Outcome != "applied" {
		t.Fatalf("duration LWW conflict result=%#v state=%#v", result.DurationAcknowledgements, states[0].DurationsMs)
	}

	at = fixture.nextTime()
	payload = fixture.syncPayload(clients[1])
	payload.AutoStartOperations = []syncAutoStartOperationJSON{{
		ID: fixture.nextID("auto-start-operation"), Enabled: boolPointer(true), OccurredAt: at.Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0),
	}}
	result = fixture.sync(t, clients[1], payload)
	states = fixture.converge(t, result.Revision)
	if !states[0].AutoStartBreaks {
		t.Fatal("autoStartBreaks true did not propagate")
	}

	at = fixture.nextTime()
	payload = fixture.syncPayload(clients[2])
	payload.AutoStartOperations = []syncAutoStartOperationJSON{{
		ID: fixture.nextID("auto-start-operation"), Enabled: boolPointer(false), OccurredAt: at.Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0),
	}}
	result = fixture.sync(t, clients[2], payload)
	states = fixture.converge(t, result.Revision)
	if states[0].AutoStartBreaks {
		t.Fatal("autoStartBreaks false did not propagate")
	}

	at = fixture.nextTime()
	payload = fixture.syncPayload(clients[3])
	payload.AutoStartOperations = []syncAutoStartOperationJSON{
		{ID: "auto-start-conflict-a", Enabled: boolPointer(false), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
		{ID: "auto-start-conflict-z", Enabled: boolPointer(true), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
	}
	result = fixture.sync(t, clients[3], payload)
	states = fixture.converge(t, result.Revision)
	if !states[0].AutoStartBreaks || result.AutoStartAcknowledgements[0].Outcome != "ignored" || result.AutoStartAcknowledgements[1].Outcome != "applied" {
		t.Fatalf("auto-start LWW conflict result=%#v state=%v", result.AutoStartAcknowledgements, states[0].AutoStartBreaks)
	}
}

func TestIndependentNativeStoresConvergeAcrossBothDeliveryOrders(t *testing.T) {
	at := time.Now().UTC().Truncate(time.Millisecond)
	taskID := task.ID("Shared conflict")
	var snapshots [2]string
	orders := [][2]int{{0, 1}, {1, 0}}

	for orderIndex, order := range orders {
		orderIndex, order := orderIndex, order
		t.Run(fmt.Sprintf("order-%d-%d", order[0], order[1]), func(t *testing.T) {
			fixture := newProtocolFixture(t)
			ios, linux := fixture.clients[1], fixture.clients[2]
			counter := int64(0)
			stores := []*protocolNativeStore{
				{
					client: ios,
					commands: []syncCommandJSON{{
						ID: "independent-command-ios", DeviceSequence: int64Pointer(1),
						TimerID: "independent-timer-ios", Type: "start", Phase: "focus",
						PlannedDurationMs: int64Pointer(1_500_000), OccurredAt: at.Format(time.RFC3339Nano),
						HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: &counter, ObservedElapsedMs: int64Pointer(0),
					}},
					taskOperations: []syncTaskOperationJSON{{
						ID: "independent-task-ios", TaskID: taskID, Type: "upsert", Title: "Shared conflict",
						OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: &counter,
					}},
					durationOperations: []syncDurationOperationJSON{{
						ID: "independent-duration-ios", Phase: "focus", DurationMs: int64Pointer(1_200_000),
						OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: &counter,
					}},
					autoStartOperations: []syncAutoStartOperationJSON{{
						ID: "independent-auto-start-ios", Enabled: boolPointer(false),
						OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: &counter,
					}},
				},
				{
					client: linux,
					commands: []syncCommandJSON{{
						ID: "independent-command-linux", DeviceSequence: int64Pointer(1),
						TimerID: "independent-timer-linux", Type: "start", Phase: "short_break",
						PlannedDurationMs: int64Pointer(300_000), OccurredAt: at.Format(time.RFC3339Nano),
						HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: &counter, ObservedElapsedMs: int64Pointer(0),
					}},
					taskOperations: []syncTaskOperationJSON{{
						ID: "independent-task-linux", TaskID: taskID, Type: "delete",
						OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: &counter,
					}},
					durationOperations: []syncDurationOperationJSON{{
						ID: "independent-duration-linux", Phase: "focus", DurationMs: int64Pointer(1_800_000),
						OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: &counter,
					}},
					autoStartOperations: []syncAutoStartOperationJSON{{
						ID: "independent-auto-start-linux", Enabled: boolPointer(true),
						OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: &counter,
					}},
				},
			}
			captured := [2]syncRequestJSON{stores[0].payload(), stores[1].payload()}
			for _, storeIndex := range order {
				result := fixture.sync(t, stores[storeIndex].client, captured[storeIndex])
				stores[storeIndex].apply(t, result)
			}
			for _, local := range stores {
				if local.pendingCount() != 0 {
					t.Fatalf("%s retained %d queued operations", local.client.name, local.pendingCount())
				}
			}
			states := fixture.converge(t, 2)
			state := states[0]
			if state.CanonicalTimer == nil || state.CanonicalTimer.ID != "independent-timer-linux" ||
				len(state.History) != 1 || state.History[0].TimerID != "independent-timer-ios" ||
				len(state.Tasks) != 0 || state.DurationsMs.Focus != 1_800_000 || !state.AutoStartBreaks {
				t.Fatalf("final independent-store state = %#v", state)
			}
			snapshots[orderIndex] = comparableProtocolState(state)
		})
	}
	if snapshots[0] != snapshots[1] {
		t.Fatalf("delivery orders diverged:\nfirst  %s\nsecond %s", snapshots[0], snapshots[1])
	}
}

func TestLogicalProtocolClientsDeduplicateCompletedHistoryAfterLostResponseRetry(t *testing.T) {
	fixture := newProtocolFixture(t)
	client := fixture.clients[0]
	timerID := fixture.nextID("timer")
	payload := fixture.syncPayload(client)
	payload.Commands = []syncCommandJSON{fixture.command(client, timerID, "start", "focus", 1_500_000, 0, "", fixture.nextTime())}
	started := fixture.sync(t, client, payload)
	fixture.converge(t, started.Revision)

	finishPayload := fixture.syncPayload(client)
	finishPayload.Commands = []syncCommandJSON{fixture.command(client, timerID, "finish", "focus", 1_500_000, 1_500_000, "", fixture.nextTime())}
	first, _, err := fixture.doSync(client, finishPayload)
	if err != nil {
		t.Fatal(err)
	}
	retry, _, err := fixture.doSync(client, finishPayload)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != retry.Revision || first.Acknowledgements[0] != retry.Acknowledgements[0] || retry.Acknowledgements[0].Outcome != "applied" {
		t.Fatalf("lost-response retry first=%#v retry=%#v", first, retry)
	}
	states := fixture.converge(t, retry.Revision)
	if len(states[0].History) != 1 || states[0].History[0].TimerID != timerID || states[0].History[0].Status != "completed" {
		t.Fatalf("deduplicated history = %#v", states[0].History)
	}
}

func TestLogicalProtocolClientsCompleteFocusBreakCycle(t *testing.T) {
	fixture := newProtocolFixture(t)
	clients := fixture.clients
	title := "Cycle task"
	taskID := task.ID(title)
	at := fixture.nextTime()
	setup := fixture.syncPayload(clients[0])
	setup.TaskOperations = []syncTaskOperationJSON{{
		ID: fixture.nextID("task-operation"), TaskID: taskID, Type: "upsert", Title: title,
		OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0),
	}}
	setup.DurationOperations = []syncDurationOperationJSON{
		{ID: fixture.nextID("duration-operation"), Phase: "focus", DurationMs: int64Pointer(120_000), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
		{ID: fixture.nextID("duration-operation"), Phase: "short_break", DurationMs: int64Pointer(180_000), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
		{ID: fixture.nextID("duration-operation"), Phase: "long_break", DurationMs: int64Pointer(240_000), OccurredAt: at.Format(time.RFC3339Nano), HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0)},
	}
	setup.AutoStartOperations = []syncAutoStartOperationJSON{{
		ID: fixture.nextID("auto-start-operation"), Enabled: boolPointer(true), OccurredAt: at.Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0),
	}}
	result := fixture.sync(t, clients[0], setup)
	states := fixture.converge(t, result.Revision)
	if !states[0].AutoStartBreaks {
		t.Fatal("cycle setup did not enable canonical autoStartBreaks")
	}

	for focusNumber := 1; focusNumber <= 4; focusNumber++ {
		focusClient := clients[(focusNumber-1)%len(clients)]
		focusTimerID := fixture.nextID("timer")
		startFocus := fixture.syncPayload(focusClient)
		startFocus.Commands = []syncCommandJSON{fixture.command(focusClient, focusTimerID, "start", "focus", 120_000, 0, taskID, fixture.nextTime())}
		result = fixture.sync(t, focusClient, startFocus)
		states = fixture.converge(t, result.Revision)
		if states[0].CanonicalTimer == nil || states[0].CanonicalTimer.ID != focusTimerID || states[0].CanonicalTimer.Phase != "focus" || states[0].CanonicalTimer.Status != "running" {
			t.Fatalf("explicit focus %d start = %#v", focusNumber, states[0].CanonicalTimer)
		}

		finishFocus := fixture.syncPayload(focusClient)
		finishFocus.Commands = []syncCommandJSON{fixture.command(focusClient, focusTimerID, "finish", "focus", 120_000, 120_000, "", fixture.nextTime())}
		result = fixture.sync(t, focusClient, finishFocus)
		states = fixture.converge(t, result.Revision)
		breakPhase, breakDurationMs, completedFocuses, autoStart := logicalAutoStartedBreak(states[0])
		if !autoStart || completedFocuses != focusNumber {
			t.Fatalf("focus %d auto-start decision = %s/%d/%d/%v", focusNumber, breakPhase, breakDurationMs, completedFocuses, autoStart)
		}
		wantBreakPhase := "short_break"
		if focusNumber == 4 {
			wantBreakPhase = "long_break"
		}
		if breakPhase != wantBreakPhase {
			t.Fatalf("focus %d selected break %q, want %q", focusNumber, breakPhase, wantBreakPhase)
		}
		if focusNumber == 1 {
			disabled := states[0]
			disabled.AutoStartBreaks = false
			if _, _, _, autoStart := logicalAutoStartedBreak(disabled); autoStart {
				t.Fatal("logical client auto-started break while canonical preference was false")
			}
		}

		breakClient := clients[focusNumber%len(clients)]
		breakTimerID := fixture.nextID("timer")
		startBreak := fixture.syncPayload(breakClient)
		startBreak.Commands = []syncCommandJSON{fixture.command(breakClient, breakTimerID, "start", breakPhase, breakDurationMs, 0, "", fixture.nextTime())}
		result = fixture.sync(t, breakClient, startBreak)
		states = fixture.converge(t, result.Revision)
		if states[0].CanonicalTimer == nil || states[0].CanonicalTimer.ID != breakTimerID || states[0].CanonicalTimer.Phase != breakPhase || states[0].CanonicalTimer.Status != "running" {
			t.Fatalf("auto-started break after focus %d = %#v", focusNumber, states[0].CanonicalTimer)
		}

		finishBreak := fixture.syncPayload(breakClient)
		finishBreak.Commands = []syncCommandJSON{fixture.command(breakClient, breakTimerID, "finish", breakPhase, breakDurationMs, breakDurationMs, "", fixture.nextTime())}
		result = fixture.sync(t, breakClient, finishBreak)
		states = fixture.converge(t, result.Revision)
		if states[0].CanonicalTimer == nil || states[0].CanonicalTimer.ID != breakTimerID || states[0].CanonicalTimer.Status != "completed" {
			t.Fatalf("break completion after focus %d = %#v", focusNumber, states[0].CanonicalTimer)
		}
	}

	final := fixture.pull(t, clients[0])
	focuses := 0
	for _, item := range final.History {
		if item.Status != "completed" {
			t.Fatalf("cycle history item = %#v", item)
		}
		if item.Phase == "focus" {
			focuses++
			if item.TaskID != taskID {
				t.Fatalf("focus history lost task association: %#v", item)
			}
		}
	}
	if len(final.History) != 8 || focuses != 4 || final.CanonicalTimer == nil || final.CanonicalTimer.Phase != "long_break" || final.CanonicalTimer.Status != "completed" || !final.AutoStartBreaks {
		t.Fatalf("final cycle state = %#v", final)
	}
}

func logicalAutoStartedBreak(state store.SyncResult) (string, int64, int, bool) {
	if !state.AutoStartBreaks || state.CanonicalTimer == nil || state.CanonicalTimer.Phase != "focus" || state.CanonicalTimer.Status != "completed" {
		return "", 0, 0, false
	}
	completedFocuses := 0
	for _, item := range state.History {
		if item.Phase == "focus" && item.Status == "completed" {
			completedFocuses++
		}
	}
	if completedFocuses%4 == 0 {
		return "long_break", state.DurationsMs.LongBreak, completedFocuses, true
	}
	return "short_break", state.DurationsMs.ShortBreak, completedFocuses, true
}

func TestLogicalProtocolConcurrentStartsAndFinishCancelConvergeDeterministically(t *testing.T) {
	fixture := newProtocolFixture(t)
	ios, linux := fixture.clients[1], fixture.clients[2]
	at := fixture.nextTime()
	iosTimer, linuxTimer := fixture.nextID("timer"), fixture.nextID("timer")
	iosPayload, linuxPayload := fixture.syncPayload(ios), fixture.syncPayload(linux)
	iosPayload.Commands = []syncCommandJSON{fixture.command(ios, iosTimer, "start", "focus", 1_500_000, 0, "", at)}
	linuxPayload.Commands = []syncCommandJSON{fixture.command(linux, linuxTimer, "start", "focus", 1_500_000, 0, "", at)}
	var startResults [2]store.SyncResult
	var startErrors [2]error
	start := make(chan struct{})
	var wait sync.WaitGroup
	for index, input := range []struct {
		client  *protocolClient
		payload syncRequestJSON
	}{{client: ios, payload: iosPayload}, {client: linux, payload: linuxPayload}} {
		index, input := index, input
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			startResults[index], _, startErrors[index] = fixture.doSync(input.client, input.payload)
		}()
	}
	close(start)
	wait.Wait()
	for _, err := range startErrors {
		if err != nil {
			t.Fatal(err)
		}
	}
	states := fixture.converge(t, 2)
	if states[0].CanonicalTimer == nil || states[0].CanonicalTimer.ID != linuxTimer || len(states[0].History) != 1 || states[0].History[0].TimerID != iosTimer || states[0].History[0].Status != "superseded" {
		t.Fatalf("concurrent starts state = %#v", states[0])
	}

	finishAt := fixture.nextTime()
	finishPayload, cancelPayload := fixture.syncPayload(ios), fixture.syncPayload(linux)
	finishPayload.Commands = []syncCommandJSON{fixture.command(ios, linuxTimer, "finish", "focus", 1_500_000, 1_500_000, "", finishAt)}
	cancelPayload.Commands = []syncCommandJSON{fixture.command(linux, linuxTimer, "cancel", "focus", 1_500_000, 90_000, "", finishAt)}
	var terminalErrors [2]error
	start = make(chan struct{})
	for index, input := range []struct {
		client  *protocolClient
		payload syncRequestJSON
	}{{client: ios, payload: finishPayload}, {client: linux, payload: cancelPayload}} {
		index, input := index, input
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, _, terminalErrors[index] = fixture.doSync(input.client, input.payload)
		}()
	}
	close(start)
	wait.Wait()
	for _, err := range terminalErrors {
		if err != nil {
			t.Fatal(err)
		}
	}
	states = fixture.converge(t, 4)
	if states[0].CanonicalTimer == nil || states[0].CanonicalTimer.Status != "completed" || states[0].History[0].TimerID != linuxTimer || states[0].History[0].Status != "completed" {
		t.Fatalf("finish-vs-cancel state = %#v", states[0])
	}
}

func TestLogicalProtocolSSECoalescingOfflineReconnectAndDuplicateHints(t *testing.T) {
	fixture := newProtocolFixture(t)
	mutator, offline := fixture.clients[0], fixture.clients[3]
	offline.stream.close()
	offline.stream = nil
	for index := range 3 {
		at := fixture.nextTime()
		payload := fixture.syncPayload(mutator)
		payload.AutoStartOperations = []syncAutoStartOperationJSON{{
			ID: fmt.Sprintf("auto-start-offline-%02d", index), Enabled: boolPointer(index%2 == 0), OccurredAt: at.Format(time.RFC3339Nano),
			HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0),
		}}
		fixture.sync(t, mutator, payload)
	}
	for _, client := range fixture.clients[:3] {
		client.stream.waitAtLeast(t, 3)
	}
	want := comparableProtocolState(fixture.pull(t, fixture.clients[1]))
	if offline.revision != 0 {
		t.Fatalf("offline observer revision = %d, want 0", offline.revision)
	}
	offline.stream = fixture.openRevisionStream(t, offline)
	offline.stream.waitAtLeast(t, 3)
	if got := comparableProtocolState(fixture.pull(t, offline)); got != want {
		t.Fatalf("offline reconnect state:\nwant %s\ngot  %s", want, got)
	}

	offline.stream.close()
	offline.stream = fixture.openRevisionStream(t, offline)
	at := fixture.nextTime()
	payload := fixture.syncPayload(mutator)
	payload.AutoStartOperations = []syncAutoStartOperationJSON{{
		ID: "auto-start-after-reconnect", Enabled: boolPointer(false), OccurredAt: at.Format(time.RFC3339Nano),
		HLCWallMs: int64Pointer(at.UnixMilli()), HLCCounter: int64Pointer(0),
	}}
	result := fixture.sync(t, mutator, payload)
	offline.stream.waitAtLeast(t, result.Revision)
	refreshed := fixture.pull(t, offline)
	if refreshed.Revision != 4 || refreshed.AutoStartBreaks {
		t.Fatalf("duplicate/coalesced SSE reconciliation = %#v", refreshed)
	}
}

func TestLogicalProtocolRejectsMalformedBatchDeviceMismatchAndRevokedToken(t *testing.T) {
	fixture := newProtocolFixture(t)
	pwa, android := fixture.clients[0], fixture.clients[3]
	timerID := fixture.nextID("timer")
	payload := fixture.syncPayload(pwa)
	payload.Commands = []syncCommandJSON{fixture.command(pwa, timerID, "start", "focus", 1_500_000, 0, "", fixture.nextTime())}
	invalid := validAutoStartOperationJSON(fixture.nextTime(), true)
	invalid.ID = fixture.nextID("auto-start-operation")
	invalid.Enabled = nil
	payload.AutoStartOperations = []syncAutoStartOperationJSON{invalid}
	status, body, err := fixture.doJSON(pwa, "/api/v1/sync", payload)
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusBadRequest {
		t.Fatalf("malformed mixed batch status=%d body=%s", status, body)
	}
	state := fixture.pull(t, pwa)
	if state.Revision != 0 || state.CanonicalTimer != nil || len(state.History) != 0 {
		t.Fatalf("malformed mixed batch mutated state = %#v", state)
	}

	mismatch := fixture.syncPayload(pwa)
	mismatch.DeviceID = android.deviceID
	status, body, err = fixture.doJSON(pwa, "/api/v1/sync", mismatch)
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusForbidden || !bytes.Contains(body, []byte("device mismatch")) {
		t.Fatalf("device mismatch status=%d body=%s", status, body)
	}

	status, body, err = fixture.doJSON(pwa, "/api/v1/auth/revoke-device", map[string]string{"deviceId": android.deviceID})
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusNoContent {
		t.Fatalf("revoke device status=%d body=%s", status, body)
	}
	status, body, err = fixture.doJSON(android, "/api/v1/sync", fixture.syncPayload(android))
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusUnauthorized {
		t.Fatalf("revoked token status=%d body=%s", status, body)
	}
}
