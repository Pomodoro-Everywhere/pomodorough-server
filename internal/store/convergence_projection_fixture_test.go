package store

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"

	"pomodorough/internal/task"
)

type projectionConvergenceFixture struct {
	Version         int                         `json:"version"`
	Epoch           string                      `json:"epoch"`
	ProjectionCases []projectionConvergenceCase `json:"projectionCases"`
}

type projectionConvergenceCase struct {
	Name                string                         `json:"name"`
	TaskOperations      []projectionTaskOperation      `json:"taskOperations"`
	DurationOperations  []projectionDurationOperation  `json:"durationOperations"`
	AutoStartOperations []projectionAutoStartOperation `json:"autoStartOperations"`
	Expected            projectionConvergenceExpected  `json:"expected"`
}

type projectionOperationClock struct {
	ID       string `json:"id"`
	DeviceID string `json:"deviceId"`
	AtMs     int64  `json:"atMs"`
	WallMs   int64  `json:"wallMs"`
	Counter  int64  `json:"counter"`
}

type projectionTaskOperation struct {
	projectionOperationClock
	TaskID string `json:"taskId"`
	Type   string `json:"type"`
	Title  string `json:"title"`
}

type projectionDurationOperation struct {
	projectionOperationClock
	Phase      string `json:"phase"`
	DurationMs int64  `json:"durationMs"`
}

type projectionAutoStartOperation struct {
	projectionOperationClock
	Enabled bool `json:"enabled"`
}

type projectionConvergenceExpected struct {
	Tasks           []task.Task `json:"tasks"`
	DurationsMs     DurationsMs `json:"durationsMs"`
	AutoStartBreaks bool        `json:"autoStartBreaks"`
}

func TestOperationProjectionConvergenceFixture(t *testing.T) {
	data, err := os.ReadFile("../timer/testdata/convergence-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture projectionConvergenceFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Version != 2 {
		t.Fatalf("fixture version = %d, want 2", fixture.Version)
	}
	epoch, err := time.Parse(time.RFC3339Nano, fixture.Epoch)
	if err != nil {
		t.Fatal(err)
	}

	for _, testCase := range fixture.ProjectionCases {
		t.Run(testCase.Name, func(t *testing.T) {
			for index, order := range indexPermutations(len(testCase.TaskOperations)) {
				operations := make([]task.Operation, 0, len(order))
				for _, position := range order {
					item := testCase.TaskOperations[position]
					operations = append(operations, task.Operation{
						ID: item.ID, DeviceID: item.DeviceID, TaskID: item.TaskID,
						Type: item.Type, Title: item.Title,
						OccurredAt: epoch.Add(time.Duration(item.AtMs) * time.Millisecond),
						HLCWallMs:  item.WallMs, HLCCounter: item.Counter,
					})
				}
				sort.Slice(operations, func(i, j int) bool {
					return operationOrder(
						operations[i].HLCWallMs, operations[i].HLCCounter, operations[i].DeviceID, operations[i].ID,
						operations[j].HLCWallMs, operations[j].HLCCounter, operations[j].DeviceID, operations[j].ID,
					)
				})
				tasks, _ := reduceTasks(operations)
				if !reflect.DeepEqual(tasks, testCase.Expected.Tasks) {
					t.Fatalf("task arrival order %d result = %#v, want %#v", index, tasks, testCase.Expected.Tasks)
				}
			}

			for index, order := range indexPermutations(len(testCase.DurationOperations)) {
				operations := make([]DurationOperation, 0, len(order))
				for _, position := range order {
					item := testCase.DurationOperations[position]
					operations = append(operations, DurationOperation{
						ID: item.ID, DeviceID: item.DeviceID, Phase: item.Phase, DurationMs: item.DurationMs,
						OccurredAt: epoch.Add(time.Duration(item.AtMs) * time.Millisecond),
						HLCWallMs:  item.WallMs, HLCCounter: item.Counter,
					})
				}
				sort.Slice(operations, func(i, j int) bool {
					return operationOrder(
						operations[i].HLCWallMs, operations[i].HLCCounter, operations[i].DeviceID, operations[i].ID,
						operations[j].HLCWallMs, operations[j].HLCCounter, operations[j].DeviceID, operations[j].ID,
					)
				})
				durations, _ := reduceDurations(operations)
				if durations != testCase.Expected.DurationsMs {
					t.Fatalf("duration arrival order %d result = %#v, want %#v", index, durations, testCase.Expected.DurationsMs)
				}
			}

			for index, order := range indexPermutations(len(testCase.AutoStartOperations)) {
				operations := make([]AutoStartOperation, 0, len(order))
				for _, position := range order {
					item := testCase.AutoStartOperations[position]
					operations = append(operations, AutoStartOperation{
						ID: item.ID, DeviceID: item.DeviceID, Enabled: item.Enabled,
						OccurredAt: epoch.Add(time.Duration(item.AtMs) * time.Millisecond),
						HLCWallMs:  item.WallMs, HLCCounter: item.Counter,
					})
				}
				sort.Slice(operations, func(i, j int) bool {
					return operationOrder(
						operations[i].HLCWallMs, operations[i].HLCCounter, operations[i].DeviceID, operations[i].ID,
						operations[j].HLCWallMs, operations[j].HLCCounter, operations[j].DeviceID, operations[j].ID,
					)
				})
				enabled, _ := reduceAutoStart(operations)
				if enabled != testCase.Expected.AutoStartBreaks {
					t.Fatalf("auto-start arrival order %d result = %t, want %t", index, enabled, testCase.Expected.AutoStartBreaks)
				}
			}
		})
	}
}

func operationOrder(
	leftWall, leftCounter int64,
	leftDevice, leftID string,
	rightWall, rightCounter int64,
	rightDevice, rightID string,
) bool {
	if leftWall != rightWall {
		return leftWall < rightWall
	}
	if leftCounter != rightCounter {
		return leftCounter < rightCounter
	}
	if leftDevice != rightDevice {
		return leftDevice < rightDevice
	}
	return leftID < rightID
}
