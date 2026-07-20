package timer

import (
	"testing"
	"time"
)

func TestReduceRejectsInvalidTransitions(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	start := command("start", "device-a", "timer-a", "start", 1, 100, base, 0)
	tests := []struct {
		name     string
		commands []Command
		target   string
		outcome  Outcome
	}{
		{
			name: "duplicate start", commands: []Command{start, command("duplicate", "device-a", "timer-a", "start", 2, 200, base.Add(time.Second), 0)},
			target: "duplicate", outcome: Outcome{Outcome: "ignored", Reason: "timer already exists"},
		},
		{
			name: "pause missing timer", commands: []Command{command("pause", "device-a", "timer-a", "pause", 1, 100, base, 0)},
			target: "pause", outcome: Outcome{Outcome: "ignored", Reason: "timer is not the active running timer"},
		},
		{
			name: "resume running timer", commands: []Command{start, command("resume", "device-a", "timer-a", "resume", 2, 200, base.Add(time.Second), 0)},
			target: "resume", outcome: Outcome{Outcome: "ignored", Reason: "timer cannot be resumed"},
		},
		{
			name: "finish missing timer", commands: []Command{command("finish", "device-a", "timer-a", "finish", 1, 100, base, 0)},
			target: "finish", outcome: Outcome{Outcome: "ignored", Reason: "timer is not active"},
		},
		{
			name: "clear active timer", commands: []Command{start, command("clear", "device-a", "timer-a", "clear", 2, 200, base.Add(time.Second), 0)},
			target: "clear", outcome: Outcome{Outcome: "ignored", Reason: "timer cannot be cleared"},
		},
		{
			name: "unsupported command", commands: []Command{command("unsupported", "device-a", "timer-a", "skip", 1, 100, base, 0)},
			target: "unsupported", outcome: Outcome{Outcome: "rejected", Reason: "unsupported command type"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := Reduce(test.commands, base.Add(2*time.Second))
			if got := result.Outcomes[test.target]; got != test.outcome {
				t.Fatalf("outcome = %#v, want %#v", got, test.outcome)
			}
		})
	}
}

func TestCancelClampsInvalidObservedElapsedTime(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	for name, test := range map[string]struct {
		observed int64
		want     int64
	}{
		"negative":      {observed: -1, want: 0},
		"over duration": {observed: 999_999, want: 5 * 60_000},
	} {
		t.Run(name, func(t *testing.T) {
			result := Reduce([]Command{
				command("start", "device-a", "timer-a", "start", 1, 100, base, 0),
				command("cancel", "device-a", "timer-a", "cancel", 2, 200, base.Add(time.Second), test.observed),
			}, base.Add(time.Second))
			if result.Canonical == nil || result.Canonical.Status != "cancelled" || result.Canonical.ElapsedAtAnchorMs != test.want {
				t.Fatalf("cancelled projection = %#v, want elapsed %d", result.Canonical, test.want)
			}
		})
	}
}
