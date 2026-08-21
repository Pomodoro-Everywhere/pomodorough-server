package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"pomodorough/internal/store"
)

type crossClientProtocolFixture struct {
	FormatVersion          int                        `json:"formatVersion"`
	SyncRequest            json.RawMessage            `json:"syncRequest"`
	SyncResponse           json.RawMessage            `json:"syncResponse"`
	BootstrapRequest       json.RawMessage            `json:"bootstrapResolutionRequest"`
	NullableCases          map[string]json.RawMessage `json:"nullableCollectionWireCases"`
	IrohGenesisRecord      json.RawMessage            `json:"irohGenesisRecord"`
	IrohSelectedTaskRecord json.RawMessage            `json:"irohSelectedTaskRecord"`
	SelectedTaskWireCases  []json.RawMessage          `json:"selectedTaskWireCases"`
	TimeZoneCases          []struct {
		Name      string `json:"name"`
		Before    string `json:"before"`
		After     string `json:"after"`
		First     string `json:"first"`
		Second    string `json:"second"`
		ElapsedMs int64  `json:"elapsedMs"`
	} `json:"timeZoneCases"`
}

func TestCrossClientProtocolFixture(t *testing.T) {
	encoded, err := os.ReadFile("../../docs/protocol-fixtures-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture crossClientProtocolFixture
	if err := json.Unmarshal(encoded, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.FormatVersion != 1 {
		t.Fatalf("format version = %d", fixture.FormatVersion)
	}

	now := time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/sync", bytes.NewReader(fixture.SyncRequest))
	request.Header.Set("Content-Type", "application/json")
	parsed, err := parseSyncRequest(httptest.NewRecorder(), request, now)
	if err != nil {
		t.Fatalf("parse sync fixture: %v", err)
	}
	if len(parsed.Commands) != 1 || len(parsed.TaskOperations) != 1 || len(parsed.DurationOperations) != 1 ||
		len(parsed.AutoStartOperations) != 1 || len(parsed.SelectedTaskOperations) != 1 {
		t.Fatalf("fixture domain counts = commands:%d tasks:%d durations:%d auto:%d selected:%d",
			len(parsed.Commands), len(parsed.TaskOperations), len(parsed.DurationOperations),
			len(parsed.AutoStartOperations), len(parsed.SelectedTaskOperations))
	}
	if parsed.SelectedTaskOperations[0].TaskID != nil {
		t.Fatalf("explicit null deselection decoded as %#v", parsed.SelectedTaskOperations[0].TaskID)
	}

	bootstrapHTTP := httptest.NewRequest(http.MethodPost, "/api/v1/bootstrap/resolve", bytes.NewReader(fixture.BootstrapRequest))
	bootstrapHTTP.Header.Set("Content-Type", "application/json")
	bootstrap, err := parseBootstrapResolutionRequest(httptest.NewRecorder(), bootstrapHTTP, now)
	if err != nil {
		t.Fatalf("parse bootstrap fixture: %v", err)
	}
	if len(bootstrap.Commands) != 1 || len(bootstrap.TaskOperations) != 1 ||
		len(bootstrap.DurationOperations) != 1 || len(bootstrap.AutoStartOperations) != 1 ||
		!bootstrap.SelectedTaskOperationsPresent || len(bootstrap.SelectedTaskOperations) != 1 {
		t.Fatalf("bootstrap fixture did not decode every operation domain: %#v", bootstrap)
	}
	for name, wantPresent := range map[string]bool{
		"selectedTaskOperationsOmitted":      false,
		"selectedTaskOperationsPresentEmpty": true,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/bootstrap/resolve", bytes.NewReader(fixture.NullableCases[name]))
		request.Header.Set("Content-Type", "application/json")
		parsedCase, caseErr := parseBootstrapResolutionRequest(httptest.NewRecorder(), request, now)
		if caseErr != nil {
			t.Fatalf("parse %s: %v", name, caseErr)
		}
		if parsedCase.SelectedTaskOperationsPresent != wantPresent {
			t.Fatalf("%s presence = %t, want %t", name, parsedCase.SelectedTaskOperationsPresent, wantPresent)
		}
	}
	for name, raw := range map[string]json.RawMessage{
		"genesis":       fixture.IrohGenesisRecord,
		"selected task": fixture.IrohSelectedTaskRecord,
	} {
		var record struct {
			Domain    string                     `json:"domain"`
			DeviceID  string                     `json:"deviceId"`
			Operation map[string]json.RawMessage `json:"operation"`
		}
		if err := json.Unmarshal(raw, &record); err != nil || record.Domain == "" || record.DeviceID == "" || len(record.Operation) == 0 {
			t.Fatalf("decode Iroh %s fixture: record=%#v err=%v", name, record, err)
		}
	}

	var response store.SyncResult
	decoder := json.NewDecoder(bytes.NewReader(fixture.SyncResponse))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		t.Fatalf("decode sync response fixture: %v", err)
	}
	if response.SelectedTaskID != nil || len(response.SelectedTaskAcknowledgements) != 1 {
		t.Fatalf("selected-task response = id:%#v acknowledgements:%#v", response.SelectedTaskID, response.SelectedTaskAcknowledgements)
	}
	if len(fixture.SelectedTaskWireCases) != 2 {
		t.Fatal("fixture must contain select and explicit deselect wire cases")
	}
	compactDeselect := bytes.ReplaceAll(fixture.SelectedTaskWireCases[1], []byte(" "), nil)
	if !bytes.Contains(compactDeselect, []byte(`"taskId":null`)) {
		t.Fatal("fixture must retain explicit nullable selected-task wire cases")
	}

	for _, testCase := range fixture.TimeZoneCases {
		left, right := testCase.Before, testCase.After
		if left == "" {
			left, right = testCase.First, testCase.Second
		}
		start, err := time.Parse(time.RFC3339, left)
		if err != nil {
			t.Fatalf("%s start: %v", testCase.Name, err)
		}
		end, err := time.Parse(time.RFC3339, right)
		if err != nil {
			t.Fatalf("%s end: %v", testCase.Name, err)
		}
		if elapsed := end.Sub(start).Milliseconds(); elapsed != testCase.ElapsedMs {
			t.Fatalf("%s elapsed = %d, want %d", testCase.Name, elapsed, testCase.ElapsedMs)
		}
	}
}
