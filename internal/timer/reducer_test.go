package timer

import (
	"math/rand"
	"reflect"
	"testing"
	"time"
)

func TestReduceDeterministicAcrossShuffledArrival(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	commands := []Command{
		command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0),
		command("command-b", "device-a", "timer-a", "pause", 2, 200, base.Add(time.Minute), 60_000),
		command("command-c", "device-b", "timer-b", "start", 1, 300, base.Add(2*time.Minute), 0),
		command("command-d", "device-a", "timer-a", "resume", 3, 400, base.Add(3*time.Minute), 60_000),
		command("command-e", "device-a", "timer-a", "finish", 4, 500, base.Add(4*time.Minute), 240_000),
	}
	want := Reduce(commands, base.Add(5*time.Minute))
	random := rand.New(rand.NewSource(42))
	for iteration := 0; iteration < 100; iteration++ {
		shuffled := append([]Command(nil), commands...)
		random.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		got := Reduce(shuffled, base.Add(5*time.Minute))
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("shuffle %d changed result\ngot:  %#v\nwant: %#v", iteration, got, want)
		}
	}
}

func TestReduceTransitionsClampAndAutoComplete(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	commands := []Command{
		command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0),
		command("command-b", "device-a", "timer-a", "pause", 2, 200, base.Add(30*time.Second), 999_999),
	}
	result := Reduce(commands, base.Add(time.Hour))
	if result.Canonical == nil || result.Canonical.Status != "paused" || result.Canonical.ElapsedAtAnchorMs != 5*60_000 {
		t.Fatalf("paused projection not clamped: %#v", result.Canonical)
	}

	auto := Reduce([]Command{command("command-c", "device-a", "timer-c", "start", 3, 300, base, 0)}, base.Add(6*time.Minute))
	if auto.Canonical == nil || auto.Canonical.Status != "completed" || auto.Canonical.ElapsedAtAnchorMs != 5*60_000 {
		t.Fatalf("running timer did not auto-complete: %#v", auto.Canonical)
	}
	if len(auto.History) != 1 || auto.History[0].Status != "completed" {
		t.Fatalf("auto-completed timer missing from history: %#v", auto.History)
	}
}

func TestFinishAtDeadlineClaimsAutoCompletion(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	start := command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0)
	finish := command("command-b", "device-a", "timer-a", "finish", 2, 200, base.Add(5*time.Minute), 5*60_000)
	result := Reduce([]Command{start, finish}, base.Add(5*time.Minute))
	if result.Outcomes[finish.ID].Outcome != "applied" {
		t.Fatalf("finish outcome = %#v, want applied", result.Outcomes[finish.ID])
	}
	if len(result.History) != 1 || result.History[0].CommandID != finish.ID {
		t.Fatalf("finish did not claim completed history: %#v", result.History)
	}
}

func TestLatestStartAndResumeSupersedeActiveTimer(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	commands := []Command{
		command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0),
		command("command-b", "device-a", "timer-a", "pause", 2, 200, base.Add(time.Minute), 60_000),
		command("command-c", "device-b", "timer-b", "start", 1, 300, base.Add(2*time.Minute), 0),
		command("command-d", "device-a", "timer-a", "resume", 3, 400, base.Add(3*time.Minute), 90_000),
	}
	result := Reduce(commands, base.Add(3*time.Minute))
	if result.Canonical == nil || result.Canonical.ID != "timer-a" || result.Canonical.Status != "running" {
		t.Fatalf("resume did not win: %#v", result.Canonical)
	}
	var timerB Session
	for _, session := range result.Sessions {
		if session.TimerID == "timer-b" {
			timerB = session
		}
	}
	if timerB.Status != "superseded" || timerB.SupersededByTimerID != "timer-a" {
		t.Fatalf("timer-b was not superseded: %#v", timerB)
	}
}

func TestRunningCanonicalKeepsAnchorElapsed(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	result := Reduce([]Command{command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0)}, base.Add(2*time.Minute))
	if result.Canonical == nil {
		t.Fatal("running timer missing")
	}
	if result.Canonical.ElapsedAtAnchorMs != 0 || result.Canonical.AnchorAt != base.Format(time.RFC3339Nano) {
		t.Fatalf("canonical anchor changed: %#v", result.Canonical)
	}
}

func TestClearRemovesCanonicalButPreservesHistory(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	commands := []Command{
		command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0),
		command("command-b", "device-a", "timer-a", "finish", 2, 200, base.Add(time.Minute), 60_000),
		command("command-c", "device-a", "timer-a", "clear", 3, 300, base.Add(2*time.Minute), 60_000),
	}
	result := Reduce(commands, base.Add(2*time.Minute))
	if result.Canonical != nil {
		t.Fatalf("canonical timer = %#v, want nil", result.Canonical)
	}
	if len(result.History) != 1 || result.History[0].TimerID != "timer-a" {
		t.Fatalf("history not preserved: %#v", result.History)
	}
	if result.Outcomes["command-c"].Outcome != "applied" {
		t.Fatalf("clear outcome = %#v", result.Outcomes["command-c"])
	}
}

func command(id, deviceID, timerID, commandType string, sequence, wall int64, occurredAt time.Time, observed int64) Command {
	return Command{
		ID: id, DeviceID: deviceID, DeviceSequence: sequence, TimerID: timerID, Type: commandType,
		Phase: "focus", PlannedDurationMs: 5 * 60_000, OccurredAt: occurredAt,
		HLCWallMs: wall, HLCCounter: 0, ObservedElapsedMs: observed,
	}
}
