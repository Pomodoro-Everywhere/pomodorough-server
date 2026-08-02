package timer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

const convergenceFixtureSHA256 = "a293a679179f7f441a89b04f0260ee77fc0d810abc61e99501f9260a6ea9012e"

type convergenceFixture struct {
	Version int               `json:"version"`
	Epoch   string            `json:"epoch"`
	Cases   []convergenceCase `json:"cases"`
}

type convergenceCase struct {
	Name     string               `json:"name"`
	NowMs    int64                `json:"nowMs"`
	Commands []convergenceCommand `json:"commands"`
	Expected convergenceExpected  `json:"expected"`
}

type convergenceCommand struct {
	ID         string `json:"id"`
	Sequence   int64  `json:"sequence"`
	DeviceID   string `json:"deviceId"`
	TimerID    string `json:"timerId"`
	Type       string `json:"type"`
	Phase      string `json:"phase"`
	DurationMs int64  `json:"durationMs"`
	AtMs       int64  `json:"atMs"`
	WallMs     int64  `json:"wallMs"`
	Counter    int64  `json:"counter"`
	ElapsedMs  int64  `json:"elapsedMs"`
	TaskID     string `json:"taskId"`
}

type convergenceExpected struct {
	Timer   *convergenceTimer    `json:"timer"`
	History []convergenceHistory `json:"history"`
}

type convergenceTimer struct {
	ID            string `json:"id"`
	Status        string `json:"status"`
	Phase         string `json:"phase"`
	DurationMs    int64  `json:"durationMs"`
	ElapsedMs     int64  `json:"elapsedMs"`
	AnchorMs      int64  `json:"anchorMs"`
	LastCommandID string `json:"lastCommandId"`
	TaskID        string `json:"taskId"`
}

type convergenceHistory struct {
	TimerID    string `json:"timerId"`
	Status     string `json:"status"`
	Phase      string `json:"phase"`
	DurationMs int64  `json:"durationMs"`
	CommandID  string `json:"commandId"`
	EndedMs    int64  `json:"endedMs"`
	TaskID     string `json:"taskId"`
}

func TestCanonicalConvergenceFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/convergence-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	if got := hex.EncodeToString(digest[:]); got != convergenceFixtureSHA256 {
		t.Fatalf("fixture SHA-256 = %s, want %s", got, convergenceFixtureSHA256)
	}

	var fixture convergenceFixture
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

	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			commands := convergenceCommands(testCase.Commands, epoch)
			arrivalOrders := commandPermutations(commands)
			for index, arrivalOrder := range arrivalOrders {
				result := Reduce(arrivalOrder, epoch.Add(time.Duration(testCase.NowMs)*time.Millisecond))
				got := normalizeConvergenceResult(result, epoch)
				if !reflect.DeepEqual(got, testCase.Expected) {
					t.Fatalf("arrival order %d result = %#v, want %#v", index, got, testCase.Expected)
				}
			}
		})
	}
}

func convergenceCommands(commands []convergenceCommand, epoch time.Time) []Command {
	result := make([]Command, 0, len(commands))
	for _, command := range commands {
		result = append(result, Command{
			ID: command.ID, DeviceID: command.DeviceID, DeviceSequence: command.Sequence,
			TimerID: command.TimerID, TaskID: command.TaskID, Type: command.Type,
			Phase: command.Phase, PlannedDurationMs: command.DurationMs,
			OccurredAt: epoch.Add(time.Duration(command.AtMs) * time.Millisecond),
			HLCWallMs:  command.WallMs, HLCCounter: command.Counter,
			ObservedElapsedMs: command.ElapsedMs,
		})
	}
	return result
}

func commandPermutations(commands []Command) [][]Command {
	if len(commands) == 0 {
		return [][]Command{{}}
	}
	var result [][]Command
	for index, command := range commands {
		rest := append([]Command(nil), commands[:index]...)
		rest = append(rest, commands[index+1:]...)
		for _, permutation := range commandPermutations(rest) {
			result = append(result, append([]Command{command}, permutation...))
		}
	}
	return result
}

func normalizeConvergenceResult(result Result, epoch time.Time) convergenceExpected {
	normalized := convergenceExpected{History: make([]convergenceHistory, 0, len(result.History))}
	if result.Canonical != nil {
		lastCommandID := ""
		if result.Canonical.LastIntent != nil {
			lastCommandID = result.Canonical.LastIntent.CommandID
		}
		normalized.Timer = &convergenceTimer{
			ID: result.Canonical.ID, Status: result.Canonical.Status, Phase: result.Canonical.Phase,
			DurationMs: result.Canonical.PlannedDurationMs, ElapsedMs: result.Canonical.ElapsedAtAnchorMs,
			AnchorMs: timeOffsetMs(timed(result.Canonical.AnchorAt), epoch), LastCommandID: lastCommandID,
			TaskID: result.Canonical.TaskID,
		}
	}
	for _, item := range result.History {
		normalized.History = append(normalized.History, convergenceHistory{
			TimerID: item.TimerID, Status: item.Status, Phase: item.Phase,
			DurationMs: item.PlannedDurationMs, CommandID: item.CommandID,
			EndedMs: timeOffsetMs(timed(item.EndedAt), epoch), TaskID: item.TaskID,
		})
	}
	return normalized
}

func timed(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		panic(err)
	}
	return parsed
}

func timeOffsetMs(value, epoch time.Time) int64 {
	return value.Sub(epoch).Milliseconds()
}
