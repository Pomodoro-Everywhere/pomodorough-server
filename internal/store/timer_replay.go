package store

import (
	"cmp"
	"context"
	"encoding/json"
	"slices"
	"time"

	"pomodorough/internal/timer"
)

const timerReplayPageSize = 256

type timerReplayPage struct {
	coreTimerResult
	CurrentTimerID *string         `json:"currentTimerId"`
	After          json.RawMessage `json:"after"`
}

func replayTimerPages(ctx context.Context, commands []timer.Command, now time.Time) (timer.Result, error) {
	ordered := slices.Clone(commands)
	slices.SortFunc(ordered, compareReplayCommands)
	sessions := make(map[string]coreTimerSession)
	history := make(map[string]timer.HistoryItem)
	output := coreTimerResult{Outcomes: make(map[string]coreTimerOutcome)}
	var current *string
	var after json.RawMessage
	for offset := 0; offset < len(ordered); offset += timerReplayPageSize {
		end := min(offset+timerReplayPageSize, len(ordered))
		batch := ordered[offset:end]
		input := map[string]any{
			"commands": coreTimerCommands(batch), "sessions": replaySeeds(sessions, current, batch),
			"currentTimerId": current, "after": after,
		}
		if end == len(ordered) {
			input["now"] = now.UTC().Format(time.RFC3339Nano)
		}
		var page timerReplayPage
		if err := callAccountSharedCore(ctx, "timer.replay.page.v1", input, &page); err != nil {
			return timer.Result{}, err
		}
		for _, session := range page.Sessions {
			sessions[session.TimerID] = session
			delete(history, session.TimerID)
		}
		for _, item := range page.History {
			history[item.TimerID] = item
		}
		for id, outcome := range page.Outcomes {
			output.Outcomes[id] = outcome
		}
		output.Canonical = page.Canonical
		current, after = page.CurrentTimerID, page.After
	}
	output.Sessions, output.History = orderedReplayProjection(sessions, history)
	return timerResultFromCore(output, commands)
}

func replaySeeds(sessions map[string]coreTimerSession, current *string, commands []timer.Command) []coreTimerSession {
	needed := make(map[string]struct{})
	if current != nil {
		needed[*current] = struct{}{}
	}
	for _, command := range commands {
		needed[command.TimerID] = struct{}{}
	}
	seeds := make([]coreTimerSession, 0, len(needed))
	for id := range needed {
		if session, exists := sessions[id]; exists {
			seeds = append(seeds, session)
		}
	}
	slices.SortFunc(seeds, func(a, b coreTimerSession) int { return cmp.Compare(a.TimerID, b.TimerID) })
	return seeds
}

// Ordering mirrors the Core log key; each page validates its continuation key.
func compareReplayCommands(a, b timer.Command) int {
	if order := cmp.Compare(a.HLCWallMs, b.HLCWallMs); order != 0 {
		return order
	}
	if order := cmp.Compare(a.HLCCounter, b.HLCCounter); order != 0 {
		return order
	}
	if order := cmp.Compare(a.DeviceID, b.DeviceID); order != 0 {
		return order
	}
	return cmp.Compare(a.ID, b.ID)
}

func orderedReplayProjection(sessions map[string]coreTimerSession, history map[string]timer.HistoryItem) ([]coreTimerSession, []timer.HistoryItem) {
	result := make([]coreTimerSession, 0, len(sessions))
	items := make([]timer.HistoryItem, 0, len(history))
	for _, session := range sessions {
		result = append(result, session)
	}
	for _, item := range history {
		items = append(items, item)
	}
	slices.SortFunc(result, func(a, b coreTimerSession) int { return cmp.Compare(a.TimerID, b.TimerID) })
	slices.SortFunc(items, func(a, b timer.HistoryItem) int {
		// Core emits normalized UTC timestamps. Compare instants, not strings
		// with optional fractional seconds; output validation checks parse errors.
		left, _ := time.Parse(time.RFC3339Nano, a.EndedAt)
		right, _ := time.Parse(time.RFC3339Nano, b.EndedAt)
		if order := right.Compare(left); order != 0 {
			return order
		}
		return cmp.Compare(a.TimerID, b.TimerID)
	})
	return result, items
}
