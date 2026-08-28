package store

import (
	"strings"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func TestSharedCoreTimerOutputRejectsMalformedSecurityBoundaries(t *testing.T) {
	cases := []struct {
		name string
		edit func(*coreTimerResult, *[]timer.Command)
		want string
	}{
		{"missing required output", func(out *coreTimerResult, _ *[]timer.Command) { out.History = nil }, "missing required"},
		{"empty command id", func(_ *coreTimerResult, commands *[]timer.Command) { (*commands)[0].ID = "" }, "empty identifier"},
		{"empty timer id", func(_ *coreTimerResult, commands *[]timer.Command) { (*commands)[0].TimerID = "" }, "empty identifier"},
		{"duplicate command", func(_ *coreTimerResult, commands *[]timer.Command) { *commands = append(*commands, (*commands)[0]) }, "duplicate timer command"},
		{"missing outcome", func(out *coreTimerResult, _ *[]timer.Command) { out.Outcomes = map[string]coreTimerOutcome{} }, "do not cover"},
		{"unknown outcome", func(out *coreTimerResult, _ *[]timer.Command) {
			out.Outcomes = map[string]coreTimerOutcome{"unknown": authorityTimerOutcome("applied", "")}
		}, "unknown command"},
		{"applied reason", func(out *coreTimerResult, commands *[]timer.Command) {
			out.Outcomes[(*commands)[0].ID] = authorityTimerOutcome("applied", "reason")
		}, "has reason"},
		{"ignored without reason", func(out *coreTimerResult, commands *[]timer.Command) {
			out.Outcomes[(*commands)[0].ID] = authorityTimerOutcome("ignored", "")
		}, "missing reason"},
		{"invalid outcome", func(out *coreTimerResult, commands *[]timer.Command) {
			out.Outcomes[(*commands)[0].ID] = authorityTimerOutcome("maybe", "")
		}, "invalid type"},
		{"unknown timer session", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].TimerID = "unknown" }, "unknown timer"},
		{"invalid session phase", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].Phase = "rest" }, "invalid phase or status"},
		{"short session duration", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].PlannedDurationMs = 1 }, "invalid duration"},
		{"elapsed beyond duration", func(out *coreTimerResult, _ *[]timer.Command) {
			out.Sessions[0].ElapsedAtAnchorMs = out.Sessions[0].PlannedDurationMs + 1
		}, "invalid duration"},
		{"empty session anchor", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].AnchorAt = "" }, "anchor timestamp is empty"},
		{"malformed session start", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].StartedAt = "yesterday" }, "parse shared timer start"},
		{"running session has end", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].EndedAt = out.Sessions[0].StartedAt }, "inconsistent end timestamp"},
		{"unknown last command", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].LastCommandID = "unknown" }, "last timer command"},
		{"empty intent type", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].LastIntent.Type = "" }, "intent type is empty"},
		{"unknown intent command", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].LastIntent.CommandID = "unknown" }, "intent command"},
		{"invalid intent time", func(out *coreTimerResult, _ *[]timer.Command) { out.Sessions[0].LastIntent.OccurredAt = "bad" }, "parse shared timer intent"},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			command := authorityTimerCommand()
			commands := []timer.Command{command}
			output := validAuthorityTimerOutput(command)
			scenario.edit(&output, &commands)
			if _, err := timerResultFromCore(output, commands); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("timerResultFromCore error = %v, want %q", err, scenario.want)
			}
		})
	}
}

func TestSharedCoreSessionRelationshipsRejectMalformedGraphs(t *testing.T) {
	cases := []struct {
		name string
		edit func(*coreTimerResult, timer.Command)
		want string
	}{
		{"duplicate session", func(out *coreTimerResult, _ timer.Command) { out.Sessions = append(out.Sessions, out.Sessions[0]) }, "duplicate timer session"},
		{"unordered sessions", func(out *coreTimerResult, _ timer.Command) {
			second := out.Sessions[0]
			second.TimerID = "timer-0"
			out.Sessions = append(out.Sessions, second)
		}, "strictly ordered"},
		{"missing superseding session", func(out *coreTimerResult, command timer.Command) {
			out.Sessions[0].Status = "superseded"
			out.Sessions[0].EndedAt = out.Sessions[0].StartedAt
			out.Sessions[0].TerminalCommandID = command.ID
			out.Sessions[0].SupersededByTimerID = "missing"
		}, "missing superseding timer"},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			command := authorityTimerCommand()
			output := validAuthorityTimerOutput(command)
			scenario.edit(&output, command)
			commands := map[string]timer.Command{command.ID: command}
			timerIDs := map[string]struct{}{command.TimerID: {}, "timer-0": {}}
			if _, err := validateCoreTimerSessions(output.Sessions, commands, timerIDs); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("validateCoreTimerSessions error = %v, want %q", err, scenario.want)
			}
		})
	}
}

func TestSharedCoreTerminalSessionFieldsFailClosed(t *testing.T) {
	at := time.Now().UTC().Format(time.RFC3339Nano)
	cases := []struct {
		name, status, ended, supersededBy, terminalID, want string
	}{
		{"completed without end", "completed", "", "", "", "inconsistent end"},
		{"malformed end", "completed", "bad", "", "", "parse shared timer end"},
		{"superseded without replacement", "superseded", at, "", "terminal", "invalid superseding"},
		{"self superseded", "superseded", at, "timer", "terminal", "invalid superseding"},
		{"running names replacement", "running", "", "other", "", "unexpectedly names"},
		{"cancelled without command", "cancelled", at, "", "", "missing terminal command"},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			session := coreTimerSession{TimerID: "timer", Status: scenario.status, EndedAt: scenario.ended,
				SupersededByTimerID: scenario.supersededBy, TerminalCommandID: scenario.terminalID}
			if err := validateSessionTerminalFields(session); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("validateSessionTerminalFields error = %v, want %q", err, scenario.want)
			}
		})
	}
}

func TestSharedCoreCanonicalTimerRejectsMalformedProjection(t *testing.T) {
	cases := []struct {
		name string
		edit func(*timer.CanonicalTimer)
		want string
	}{
		{"unknown canonical", func(value *timer.CanonicalTimer) { value.ID = "unknown" }, "unknown session"},
		{"invalid status", func(value *timer.CanonicalTimer) { value.Status = "stopped" }, "invalid phase or status"},
		{"invalid duration", func(value *timer.CanonicalTimer) { value.PlannedDurationMs = 1 }, "invalid duration"},
		{"invalid anchor", func(value *timer.CanonicalTimer) { value.AnchorAt = "bad" }, "parse shared canonical timer anchor"},
		{"unknown intent", func(value *timer.CanonicalTimer) { value.LastIntent.CommandID = "unknown" }, "timer intent command"},
		{"session mismatch", func(value *timer.CanonicalTimer) { value.TaskID = "different" }, "inconsistent with its session"},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			command := authorityTimerCommand()
			output := validAuthorityTimerOutput(command)
			scenario.edit(output.Canonical.value)
			if _, err := timerResultFromCore(output, []timer.Command{command}); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("timerResultFromCore error = %v, want %q", err, scenario.want)
			}
		})
	}
}

func TestSharedCoreTaskAndDurationOutputsRejectInvalidAuthorityData(t *testing.T) {
	taskOperations := []task.Operation{{ID: "op-a", TaskID: "task-a", Title: "Alpha"}, {ID: "op-b", TaskID: "task-b", Title: "Beta"}}
	taskCases := []struct {
		name   string
		output coreTaskResult
		want   string
	}{
		{"inconsistent winner", coreTaskResult{Tasks: []task.Task{}, WinningOperationIDs: map[string]string{"task-a": "op-b"}}, "inconsistent operation"},
		{"empty task", coreTaskResult{Tasks: []task.Task{{}}, WinningOperationIDs: map[string]string{"task-a": "op-a"}}, "invalid task"},
		{"duplicate task", coreTaskResult{Tasks: []task.Task{{ID: "task-a", Title: "Alpha"}, {ID: "task-a", Title: "Alpha"}}, WinningOperationIDs: map[string]string{"task-a": "op-a"}}, "duplicates task"},
		{"task without winner", coreTaskResult{Tasks: []task.Task{{ID: "task-b", Title: "Beta"}}, WinningOperationIDs: map[string]string{"task-a": "op-a"}}, "has no winning operation"},
		{"unordered tasks", coreTaskResult{Tasks: []task.Task{{ID: "task-b", Title: "Beta"}, {ID: "task-a", Title: "Alpha"}}, WinningOperationIDs: map[string]string{"task-a": "op-a", "task-b": "op-b"}}, "not strictly ordered"},
	}
	for _, scenario := range taskCases {
		t.Run(scenario.name, func(t *testing.T) {
			if _, _, err := taskResultFromCore(scenario.output, taskOperations); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("taskResultFromCore error = %v, want %q", err, scenario.want)
			}
		})
	}

	durationOperations := []DurationOperation{{ID: "focus-op", Phase: "focus"}}
	validDurations := map[string]int64{"focus": 1_500_000, "short_break": 300_000, "long_break": 900_000}
	for _, scenario := range []struct {
		name   string
		output coreDurationResult
		want   string
	}{
		{"missing phases", coreDurationResult{DurationsMs: map[string]int64{}, WinningOperationIDs: map[string]string{}}, "missing required phases"},
		{"non-minute duration", coreDurationResult{DurationsMs: map[string]int64{"focus": 61_000, "short_break": 300_000, "long_break": 900_000}, WinningOperationIDs: map[string]string{}}, "duration for"},
		{"unknown winner", coreDurationResult{DurationsMs: validDurations, WinningOperationIDs: map[string]string{"focus": "unknown"}}, "inconsistent operation"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			if _, _, err := durationResultFromCore(scenario.output, durationOperations); err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("durationResultFromCore error = %v, want %q", err, scenario.want)
			}
		})
	}
}

func TestStoredSyncNormalizationRejectsUntrustedLegacyClock(t *testing.T) {
	result := normalizeSyncResult(SyncResult{})
	if result.Acknowledgements == nil || result.TaskAcknowledgements == nil || result.DurationAcknowledgements == nil ||
		result.AutoStartAcknowledgements == nil || result.SelectedTaskAcknowledgements == nil || result.History == nil || result.Tasks == nil {
		t.Fatal("normalizeSyncResult left a nil collection")
	}
	for _, serverTime := range []string{"not-a-time", "1970-01-01T00:00:00Z"} {
		if _, err := normalizeStoredSyncResult(SyncResult{ServerTime: serverTime}); err == nil {
			t.Fatalf("normalizeStoredSyncResult accepted %q", serverTime)
		}
	}
}
