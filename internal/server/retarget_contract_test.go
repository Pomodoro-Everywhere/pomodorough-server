package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func retargetTestClock(now time.Time) (string, *int64, *int64) {
	return now.Format(time.RFC3339Nano), int64Pointer(now.UnixMilli()), int64Pointer(0)
}

// S59: retarget lifecycle fields are echo-only with deterministic defaults.
func TestS59RetargetAcceptsOmittedLifecycleWithDefaults(t *testing.T) {
	now := time.Now().UTC()
	occurredAt, wallMs, counter := retargetTestClock(now)
	command, err := parseCommand("device-a", syncCommandJSON{
		ID: "command-0001", DeviceSequence: int64Pointer(1), TimerID: "timer-000001",
		TaskID: "task-abc12345", Type: "retarget", Phase: "focus",
		OccurredAt: occurredAt, HLCWallMs: wallMs, HLCCounter: counter,
	}, now)
	if err != nil {
		t.Fatalf("retarget with omitted lifecycle: %v", err)
	}
	if command.PlannedDurationMs != defaultRetargetPlannedDurationMs || command.ObservedElapsedMs != 0 {
		t.Fatalf("retarget defaults = %d/%d, want %d/0",
			command.PlannedDurationMs, command.ObservedElapsedMs, defaultRetargetPlannedDurationMs)
	}
}

func TestS59RetargetNullUnassignAcceptsOmittedLifecycle(t *testing.T) {
	now := time.Now().UTC()
	occurredAt, wallMs, counter := retargetTestClock(now)
	command, err := parseCommand("device-a", syncCommandJSON{
		ID: "command-0002", DeviceSequence: int64Pointer(2), TimerID: "timer-000001",
		Type: "retarget", Phase: "focus", TaskIDExplicitNull: true,
		OccurredAt: occurredAt, HLCWallMs: wallMs, HLCCounter: counter,
	}, now)
	if err != nil {
		t.Fatalf("retarget null with omitted lifecycle: %v", err)
	}
	if command.TaskID != "" {
		t.Fatalf("retarget null TaskID = %q, want empty", command.TaskID)
	}
}

func TestS59NonRetargetStillRequiresLifecycle(t *testing.T) {
	now := time.Now().UTC()
	occurredAt, wallMs, counter := retargetTestClock(now)
	if _, err := parseCommand("device-a", syncCommandJSON{
		ID: "command-0003", DeviceSequence: int64Pointer(3), TimerID: "timer-000001",
		Type: "start", Phase: "focus",
		OccurredAt: occurredAt, HLCWallMs: wallMs, HLCCounter: counter,
		ObservedElapsedMs: int64Pointer(0),
	}, now); err == nil {
		t.Fatal("start with omitted duration succeeded; want invalid timer duration")
	}
}

// S61: explicit null taskId is significant only for retarget unassign.
func TestS61NonRetargetExplicitNullRejected(t *testing.T) {
	now := time.Now().UTC()
	for _, commandType := range []struct{ commandType, phase string }{
		{"pause", "focus"}, {"clear", "focus"}, {"start", "short_break"},
	} {
		occurredAt, wallMs, counter := retargetTestClock(now)
		_, err := parseCommand("device-a", syncCommandJSON{
			ID: "command-s61", DeviceSequence: int64Pointer(1), TimerID: "timer-000001",
			Type: commandType.commandType, Phase: commandType.phase, TaskIDExplicitNull: true,
			PlannedDurationMs: int64Pointer(1_500_000),
			OccurredAt:        occurredAt, HLCWallMs: wallMs, HLCCounter: counter,
			ObservedElapsedMs: int64Pointer(0),
		}, now)
		if err == nil || !strings.Contains(err.Error(), "invalid task association") {
			t.Fatalf("%s/%s with null taskId err = %v, want invalid task association",
				commandType.commandType, commandType.phase, err)
		}
	}
}

// S58: null-vs-omitted wire distinction for retarget.
func TestS58RetargetWireDistinguishesNullFromOmission(t *testing.T) {
	var omitted syncCommandJSON
	if err := json.Unmarshal([]byte(`{"id":"command-0001","deviceSequence":1,"timerId":"timer-000001",`+
		`"type":"retarget","phase":"focus","plannedDurationMs":1500000,`+
		`"occurredAt":"2026-07-15T17:00:00.125Z","hlcWallMs":1784134800125,`+
		`"hlcCounter":0,"observedElapsedMs":0}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.TaskIDExplicitNull {
		t.Fatal("omitted taskId flagged as explicit null")
	}
	var explicitNull syncCommandJSON
	if err := json.Unmarshal([]byte(`{"id":"command-0001","deviceSequence":1,"timerId":"timer-000001",`+
		`"taskId":null,"type":"retarget","phase":"focus","plannedDurationMs":1500000,`+
		`"occurredAt":"2026-07-15T17:00:00.125Z","hlcWallMs":1784134800125,`+
		`"hlcCounter":0,"observedElapsedMs":0}`), &explicitNull); err != nil {
		t.Fatal(err)
	}
	if !explicitNull.TaskIDExplicitNull {
		t.Fatal("explicit null taskId not detected")
	}
	now := time.Now().UTC()
	occurredAt, wallMs, counter := retargetTestClock(now)
	omitted.OccurredAt, omitted.HLCWallMs, omitted.HLCCounter = occurredAt, wallMs, counter
	if _, err := parseCommand("device-a", omitted, now); err == nil {
		t.Fatal("retarget with omitted taskId succeeded; want explicit taskId-or-null error")
	}
	explicitNull.OccurredAt, explicitNull.HLCWallMs, explicitNull.HLCCounter = occurredAt, wallMs, counter
	if _, err := parseCommand("device-a", explicitNull, now); err != nil {
		t.Fatalf("retarget with null taskId: %v", err)
	}
}

func TestS58RetargetRequiresFocusPhase(t *testing.T) {
	now := time.Now().UTC()
	occurredAt, wallMs, counter := retargetTestClock(now)
	if _, err := parseCommand("device-a", syncCommandJSON{
		ID: "command-0004", DeviceSequence: int64Pointer(4), TimerID: "timer-000001",
		TaskID: "task-abc12345", Type: "retarget", Phase: "short_break",
		PlannedDurationMs: int64Pointer(1_500_000),
		OccurredAt:        occurredAt, HLCWallMs: wallMs, HLCCounter: counter,
		ObservedElapsedMs: int64Pointer(0),
	}, now); err == nil {
		t.Fatal("retarget with break phase succeeded; want focus-only error")
	}
}

// S58+S59: OpenAPI contract pins for retarget.
func TestS58S59OpenAPIRetargetContract(t *testing.T) {
	document := loadOpenAPIDocument(t)
	schemas := openAPIMap(t, openAPIMap(t, document, "components"), "schemas")
	commandType := openAPIMap(t, schemas, "CommandType")
	enum, ok := commandType["enum"].([]any)
	if !ok {
		t.Fatalf("CommandType enum = %#v", commandType["enum"])
	}
	found := false
	for _, value := range enum {
		if value == "retarget" {
			found = true
		}
	}
	if !found {
		t.Fatalf("CommandType enum = %v, missing retarget", enum)
	}
	timerCommand := openAPIMap(t, schemas, "TimerCommand")
	properties := openAPIMap(t, timerCommand, "properties")
	taskID, ok := properties["taskId"].(map[string]any)
	if !ok {
		t.Fatalf("TimerCommand taskId = %#v", properties["taskId"])
	}
	if taskID["nullable"] != true {
		t.Fatalf("TimerCommand taskId nullable = %#v, want true for explicit-null unassign", taskID["nullable"])
	}
	description, _ := taskID["description"].(string)
	for _, want := range []string{"null", "omitted", "omission", "focus", "retarget"} {
		if !strings.Contains(strings.ToLower(description), want) {
			t.Fatalf("TimerCommand taskId description missing %q: %q", want, description)
		}
	}
	for _, field := range []string{"plannedDurationMs", "observedElapsedMs"} {
		property, ok := properties[field].(map[string]any)
		if !ok {
			t.Fatalf("TimerCommand %s = %#v", field, properties[field])
		}
		fieldDescription, _ := property["description"].(string)
		for _, want := range []string{"retarget", "omit", "default"} {
			if !strings.Contains(strings.ToLower(fieldDescription), want) {
				t.Fatalf("TimerCommand %s description missing %q: %q", field, want, fieldDescription)
			}
		}
	}
}

// S64: TimerCommand.required omits lifecycle for all types by intent.
// Retarget accepts omission with deterministic server defaults; the parser
// still rejects other types without them. Pinned via
// x-required-except-retarget so spec/parser drift fails closed.
func TestS64OpenAPILifecycleRequiredExceptRetarget(t *testing.T) {
	document := loadOpenAPIDocument(t)
	schemas := openAPIMap(t, openAPIMap(t, document, "components"), "schemas")
	timerCommand := openAPIMap(t, schemas, "TimerCommand")
	for _, field := range []string{"plannedDurationMs", "observedElapsedMs"} {
		if openAPIRequired(timerCommand, field) {
			t.Fatalf("TimerCommand required pins %q; lifecycle stays out for retarget omission", field)
		}
	}
	conditional, ok := timerCommand["x-required-except-retarget"].([]any)
	if !ok || len(conditional) != 2 || conditional[0] != "plannedDurationMs" || conditional[1] != "observedElapsedMs" {
		t.Fatalf("x-required-except-retarget = %#v, want [plannedDurationMs observedElapsedMs]",
			timerCommand["x-required-except-retarget"])
	}
	description, _ := timerCommand["description"].(string)
	for _, want := range []string{"retarget", "reject", "required"} {
		if !strings.Contains(strings.ToLower(description), want) {
			t.Fatalf("TimerCommand description missing %q: %q", want, description)
		}
	}
	properties := openAPIMap(t, timerCommand, "properties")
	for _, field := range []string{"plannedDurationMs", "observedElapsedMs"} {
		property, ok := properties[field].(map[string]any)
		if !ok {
			t.Fatalf("TimerCommand %s = %#v", field, properties[field])
		}
		fieldDescription, _ := property["description"].(string)
		if !strings.Contains(strings.ToLower(fieldDescription), "retarget") {
			t.Fatalf("TimerCommand %s description missing retarget omission: %q", field, fieldDescription)
		}
	}
}
