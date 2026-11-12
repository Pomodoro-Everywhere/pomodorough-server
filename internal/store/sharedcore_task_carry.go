package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"pomodorough/internal/timer"
)

// returnedTimer is the timer projection the server returns: the Core
// reduction with finished history carried along task renames
// (task.carryHistory.v1). Persistence and change detection keep using the
// uncarried reduction, because carrying is not idempotent and timer_sessions
// stay raw.
type returnedTimer struct {
	Canonical *timer.CanonicalTimer
	History   []timer.HistoryItem
}

type coreCarryHistoryInput struct {
	CanonicalTimer *timer.CanonicalTimer `json:"canonicalTimer"`
	History        []timer.HistoryItem   `json:"history"`
	Sessions       []coreTimerSession    `json:"sessions"`
	TaskOperations []coreTaskOperation   `json:"taskOperations"`
}

type coreCarryHistoryOutput struct {
	Canonical coreNullable[timer.CanonicalTimer] `json:"canonicalTimer"`
	History   []timer.HistoryItem                `json:"history"`
}

// carryReturnedHistory always asks Core to carry, even when the log has no
// rename: Core alone decides which rows move. The input is the uncarried
// reduction and the full task operation log.
func carryReturnedHistory(ctx context.Context, call coreJSONCall, reduction *accountReduction) error {
	input := coreCarryHistoryInput{
		CanonicalTimer: reduction.timer.Canonical,
		History:        nonNilHistory(reduction.timer.History),
		Sessions:       coreTimerSessions(reduction.timer.Sessions),
		TaskOperations: coreTaskOperations(reduction.taskOperations),
	}
	var output coreCarryHistoryOutput
	if err := call(ctx, "task.carryHistory.v1", input, &output); err != nil {
		return fmt.Errorf("carry history with shared core: %w", err)
	}
	if err := validateCarriedHistory(reduction.timer, output); err != nil {
		return fmt.Errorf("validate shared history carry output: %w", err)
	}
	reduction.returned = returnedTimer{Canonical: output.Canonical.value, History: output.History}
	return nil
}

// validateCarriedHistory accepts only a carry that kept every row in place and
// changed nothing but a present taskId. A canonical timer is null exactly when
// the reduced one is.
func validateCarriedHistory(reduced timer.Result, output coreCarryHistoryOutput) error {
	if !output.Canonical.present {
		return errors.New("canonicalTimer is missing")
	}
	if (reduced.Canonical == nil) != (output.Canonical.value == nil) {
		return errors.New("canonicalTimer presence changed")
	}
	if reduced.Canonical != nil {
		before, after := *reduced.Canonical, *output.Canonical.value
		if !carriedTaskID(before.TaskID, after.TaskID) {
			return errors.New("canonicalTimer taskId moved from or to no task")
		}
		before.TaskID, after.TaskID = "", ""
		if !reflect.DeepEqual(before, after) {
			return errors.New("canonicalTimer changed beyond its taskId")
		}
	}
	if output.History == nil || len(output.History) != len(reduced.History) {
		return fmt.Errorf("history has %d rows; want %d", len(output.History), len(reduced.History))
	}
	for index, before := range reduced.History {
		after := output.History[index]
		if !carriedTaskID(before.TaskID, after.TaskID) {
			return fmt.Errorf("history row %d taskId moved from or to no task", index)
		}
		before.TaskID, after.TaskID = "", ""
		if !reflect.DeepEqual(before, after) {
			return fmt.Errorf("history row %d changed beyond its taskId", index)
		}
	}
	return nil
}

// carriedTaskID reports whether a carry may turn before into after: a row
// without a task keeps none, and a row with a task keeps one.
func carriedTaskID(before, after string) bool {
	return (before == "") == (after == "")
}

// coreTimerSessions encodes decoded reducer sessions back into the Core wire
// form. Times were parsed from Core output, so RFC3339Nano in UTC names the
// same instants.
func coreTimerSessions(sessions []timer.Session) []coreTimerSession {
	wire := make([]coreTimerSession, 0, len(sessions))
	for _, session := range sessions {
		endedAt := ""
		if !session.EndedAt.IsZero() {
			endedAt = session.EndedAt.UTC().Format(time.RFC3339Nano)
		}
		wire = append(wire, coreTimerSession{
			TimerID: session.TimerID, TaskID: session.TaskID, Phase: session.Phase, Status: session.Status,
			PlannedDurationMs: session.PlannedDurationMs, ElapsedAtAnchorMs: session.ElapsedAtAnchorMs,
			AnchorAt:          session.AnchorAt.UTC().Format(time.RFC3339Nano),
			StartedAt:         session.StartedAt.UTC().Format(time.RFC3339Nano),
			StartedByDeviceID: session.StartedByDeviceID, EndedAt: endedAt,
			LastCommandID: session.LastCommandID, TerminalCommandID: session.TerminalCommandID,
			SupersededByTimerID: session.SupersededByTimerID, LastIntent: session.LastIntent,
		})
	}
	return wire
}
