package store

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func TestServerHLCDelegatesAllObservationsToSharedCore(t *testing.T) {
	now := time.UnixMilli(100).UTC()
	reduction, request := completeHLCInputs()
	call := func(_ context.Context, operation string, input, output any) error {
		if operation != "hlc.head.v1" {
			t.Fatalf("operation = %q", operation)
		}
		got := input.(coreHLCHeadInput)
		want := coreHLCHeadInput{PhysicalNowMs: 100, Observed: expectedHLCObservations()}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("input = %#v, want %#v", got, want)
		}
		return decodeCoreEnvelope(operation, []byte(`{"ok":true,"value":{"wallMs":110,"counter":9}}`), output)
	}

	result, err := resultFromReductionWithCore(context.Background(), call, reduction, 7, now, &request)
	if err != nil {
		t.Fatal(err)
	}
	if result.ServerHLCWallMs != 110 || result.ServerHLCCounter != 9 {
		t.Fatalf("server HLC = (%d,%d)", result.ServerHLCWallMs, result.ServerHLCCounter)
	}
}

func TestServerHLCAcceptsReferentialSharedCorePolicyDrift(t *testing.T) {
	now := time.UnixMilli(50).UTC()
	reduction := accountReduction{commands: []timer.Command{
		{HLCWallMs: 200, HLCCounter: 1},
		{HLCWallMs: 100, HLCCounter: 2},
	}}
	call := coreHeadResponse(`{"ok":true,"value":{"wallMs":100,"counter":2}}`)

	result, err := resultFromReductionWithCore(context.Background(), call, reduction, 1, now, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.ServerHLCWallMs != 100 || result.ServerHLCCounter != 2 {
		t.Fatalf("SharedCore policy drift was rewritten: (%d,%d)", result.ServerHLCWallMs, result.ServerHLCCounter)
	}
}

func TestMalformedSharedCoreHLCFailsBeforeResultConstruction(t *testing.T) {
	now := time.UnixMilli(100).UTC()
	reduction := accountReduction{commands: []timer.Command{{HLCWallMs: 101, HLCCounter: 2}}}
	cases := []string{
		`{"ok":true,"value":{"wallMs":101}}`,
		`{"ok":true,"value":{"wallMs":9007199254740992,"counter":0}}`,
		`{"ok":true,"value":{"wallMs":100,"counter":1}}`,
		`{"ok":true,"value":{"wallMs":101,"counter":2,"extra":0}}`,
	}
	for _, encoded := range cases {
		result, err := resultFromReductionWithCore(context.Background(), coreHeadResponse(encoded), reduction, 9, now, nil)
		if err == nil {
			t.Fatalf("accepted malformed output %s", encoded)
		}
		if !reflect.DeepEqual(result, SyncResult{}) {
			t.Fatalf("constructed result after malformed output: %#v", result)
		}
	}
}

func coreHeadResponse(encoded string) coreJSONCall {
	return func(_ context.Context, operation string, _ any, output any) error {
		return decodeCoreEnvelope(operation, []byte(encoded), output)
	}
}

func completeHLCInputs() (accountReduction, SyncRequest) {
	reduction := accountReduction{
		commands:               []timer.Command{{HLCWallMs: 101, HLCCounter: 1}},
		taskOperations:         []task.Operation{{HLCWallMs: 102, HLCCounter: 2}},
		durationOperations:     []DurationOperation{{HLCWallMs: 103, HLCCounter: 3}},
		autoStartOperations:    []AutoStartOperation{{HLCWallMs: 104, HLCCounter: 4}},
		selectedTaskOperations: []SelectedTaskOperation{{HLCWallMs: 105, HLCCounter: 5}},
	}
	request := SyncRequest{
		Commands:               []timer.Command{{HLCWallMs: 106, HLCCounter: 6}},
		TaskOperations:         []task.Operation{{HLCWallMs: 107, HLCCounter: 7}},
		DurationOperations:     []DurationOperation{{HLCWallMs: 108, HLCCounter: 8}},
		AutoStartOperations:    []AutoStartOperation{{HLCWallMs: 109, HLCCounter: 9}},
		SelectedTaskOperations: []SelectedTaskOperation{{HLCWallMs: 110, HLCCounter: 9}},
	}
	return reduction, request
}

func expectedHLCObservations() []coreHLC {
	return []coreHLC{
		{WallMs: 101, Counter: 1}, {WallMs: 102, Counter: 2},
		{WallMs: 103, Counter: 3}, {WallMs: 104, Counter: 4},
		{WallMs: 105, Counter: 5}, {WallMs: 106, Counter: 6},
		{WallMs: 107, Counter: 7}, {WallMs: 108, Counter: 8},
		{WallMs: 109, Counter: 9}, {WallMs: 110, Counter: 9},
	}
}

func TestHLCHeadWireInputJSON(t *testing.T) {
	encoded, err := json.Marshal(coreHLCHeadInput{PhysicalNowMs: 1, Observed: []coreHLC{}})
	if err != nil || string(encoded) != `{"physicalNowMs":1,"observed":[]}` {
		t.Fatalf("wire input = %s, %v", encoded, err)
	}
}
