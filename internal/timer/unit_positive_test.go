package timer

import (
	"reflect"
	"testing"
	"time"
)

func TestReduceDeterministicAcrossEveryArrivalPermutation(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		commands []Command
	}{
		{
			name: "pause supersede resume finish",
			commands: []Command{
				command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0),
				command("command-b", "device-a", "timer-a", "pause", 2, 200, base.Add(time.Minute), 60_000),
				command("command-c", "device-b", "timer-b", "start", 1, 300, base.Add(2*time.Minute), 0),
				command("command-d", "device-a", "timer-a", "resume", 3, 400, base.Add(3*time.Minute), 60_000),
				command("command-e", "device-a", "timer-a", "finish", 4, 500, base.Add(4*time.Minute), 240_000),
			},
		},
		{
			name: "duplicate start and clear",
			commands: []Command{
				command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0),
				command("command-b", "device-b", "timer-a", "start", 1, 200, base.Add(time.Second), 0),
				command("command-c", "device-a", "timer-a", "cancel", 2, 300, base.Add(2*time.Second), 2_000),
				command("command-d", "device-a", "timer-a", "clear", 3, 400, base.Add(3*time.Second), 2_000),
			},
		},
		{
			name: "equal clock tie breakers",
			commands: []Command{
				withCounter(command("command-z", "device-a", "timer-a", "pause", 2, 100, base.Add(time.Second), 1_000), 1),
				command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0),
				command("command-b", "device-b", "timer-b", "start", 1, 100, base, 0),
				withCounter(command("command-y", "device-b", "timer-b", "cancel", 2, 100, base.Add(2*time.Second), 2_000), 1),
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			want := Reduce(test.commands, base.Add(5*time.Minute))
			permutations := 0
			forEachCommandPermutation(test.commands, func(permutation []Command) {
				permutations++
				got := Reduce(permutation, base.Add(5*time.Minute))
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("permutation %d changed result\ngot:  %#v\nwant: %#v", permutations, got, want)
				}
			})
			if permutations != factorial(len(test.commands)) {
				t.Fatalf("tested %d permutations, want %d", permutations, factorial(len(test.commands)))
			}
		})
	}
}

func forEachCommandPermutation(commands []Command, visit func([]Command)) {
	working := append([]Command(nil), commands...)
	var permute func(int)
	permute = func(index int) {
		if index == len(working) {
			visit(append([]Command(nil), working...))
			return
		}
		for candidate := index; candidate < len(working); candidate++ {
			working[index], working[candidate] = working[candidate], working[index]
			permute(index + 1)
			working[index], working[candidate] = working[candidate], working[index]
		}
	}
	permute(0)
}

func factorial(value int) int {
	result := 1
	for factor := 2; factor <= value; factor++ {
		result *= factor
	}
	return result
}

func TestReduceUsesCompleteHybridClockOrdering(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		commands []Command
		winner   string
	}{
		{
			name: "wall",
			commands: []Command{
				command("wall-high", "device-a", "shared-timer", "start", 1, 101, base, 0),
				command("wall-low", "device-z", "shared-timer", "start", 1, 100, base.Add(time.Second), 0),
			},
			winner: "wall-low",
		},
		{
			name: "counter",
			commands: []Command{
				withCounter(command("counter-high", "device-a", "shared-timer", "start", 1, 100, base, 0), 1),
				withCounter(command("counter-low", "device-a", "shared-timer", "start", 2, 100, base, 0), 0),
			},
			winner: "counter-low",
		},
		{
			name: "device ID",
			commands: []Command{
				command("command-a", "device-b", "shared-timer", "start", 1, 100, base, 0),
				command("command-z", "device-a", "shared-timer", "start", 1, 100, base, 0),
			},
			winner: "command-z",
		},
		{
			name: "command ID",
			commands: []Command{
				command("command-b", "device-a", "shared-timer", "start", 1, 100, base, 0),
				command("command-a", "device-a", "shared-timer", "start", 2, 100, base, 0),
			},
			winner: "command-a",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := Reduce(test.commands, base)
			for _, input := range test.commands {
				want := "ignored"
				if input.ID == test.winner {
					want = "applied"
				}
				if got := result.Outcomes[input.ID].Outcome; got != want {
					t.Fatalf("outcome for %q = %q, want %q", input.ID, got, want)
				}
			}
			if result.Canonical == nil || result.Canonical.LastIntent == nil || result.Canonical.LastIntent.CommandID != test.winner {
				t.Fatalf("ordering winner = %#v, want command %q", result.Canonical, test.winner)
			}
		})
	}
}

func TestReduceDoesNotMutateInput(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	commands := []Command{
		command("command-b", "device-b", "timer-b", "start", 1, 200, base.Add(time.Second), 0),
		command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0),
	}
	want := append([]Command(nil), commands...)
	Reduce(commands, base.Add(time.Minute))
	if !reflect.DeepEqual(commands, want) {
		t.Fatalf("Reduce mutated input\ngot:  %#v\nwant: %#v", commands, want)
	}
}

func TestCanonicalTimerRetainsStartingDeviceAcrossLaterIntents(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	result := Reduce([]Command{
		command("start-owner", "device-owner", "timer-owner", "start", 1, 100, base, 0),
		command("pause-peer", "device-peer", "timer-owner", "pause", 1, 200, base.Add(time.Minute), 60_000),
	}, base.Add(2*time.Minute))
	if result.Canonical == nil {
		t.Fatal("canonical timer missing")
	}
	if result.Canonical.StartedByDeviceID != "device-owner" {
		t.Fatalf("starting device = %q, want device-owner", result.Canonical.StartedByDeviceID)
	}
	if result.Canonical.LastIntent == nil || result.Canonical.LastIntent.CommandID != "pause-peer" {
		t.Fatalf("last intent = %#v, want pause-peer", result.Canonical.LastIntent)
	}
}

func TestHistoryIsNewestFirstAtFractionalSecondPrecision(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	commands := []Command{
		command("start-a", "device-a", "timer-a", "start", 1, 100, base, 0),
		command("cancel-a", "device-a", "timer-a", "cancel", 2, 200, base.Add(time.Second), 1_000),
		command("start-b", "device-a", "timer-b", "start", 3, 300, base.Add(time.Second+50*time.Millisecond), 0),
		command("cancel-b", "device-a", "timer-b", "cancel", 4, 400, base.Add(time.Second+100*time.Millisecond), 50),
	}
	result := Reduce(commands, base.Add(2*time.Second))
	if len(result.History) != 2 || result.History[0].TimerID != "timer-b" || result.History[1].TimerID != "timer-a" {
		t.Fatalf("history order = %#v, want timer-b then timer-a", result.History)
	}
	latest := result.History[0]
	if latest.Status != "cancelled" || latest.CommandID != "cancel-b" || latest.CompletedAt != "" || latest.EndedAt != base.Add(time.Second+100*time.Millisecond).Format(time.RFC3339Nano) {
		t.Fatalf("latest terminal history item mismatch: %#v", latest)
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

func TestTaskAssociationFollowsTimerIntoCanonicalAndHistory(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	start := command("command-a", "device-a", "timer-a", "start", 1, 100, base, 0)
	start.TaskID = "task-0000001"
	finish := command("command-b", "device-a", "timer-a", "finish", 2, 200, base.Add(time.Minute), 60_000)
	finish.TaskID = "task-ignored"

	running := Reduce([]Command{start}, base)
	if running.Canonical == nil || running.Canonical.TaskID != start.TaskID {
		t.Fatalf("canonical task = %#v, want %q", running.Canonical, start.TaskID)
	}
	finished := Reduce([]Command{start, finish}, base.Add(time.Minute))
	if len(finished.History) != 1 || finished.History[0].TaskID != start.TaskID {
		t.Fatalf("history task = %#v, want original start task", finished.History)
	}
}

func command(id, deviceID, timerID, commandType string, sequence, wall int64, occurredAt time.Time, observed int64) Command {
	return Command{
		ID: id, DeviceID: deviceID, DeviceSequence: sequence, TimerID: timerID, Type: commandType,
		Phase: "focus", PlannedDurationMs: 5 * 60_000, OccurredAt: occurredAt,
		HLCWallMs: wall, HLCCounter: 0, ObservedElapsedMs: observed,
	}
}

func withCounter(command Command, counter int64) Command {
	command.HLCCounter = counter
	return command
}
