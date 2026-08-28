package timer

import (
	"sort"
	"time"
)

type reductionState struct {
	sessions  map[string]*Session
	outcomes  map[string]Outcome
	currentID string
}

func newReductionState(commandCount int) *reductionState {
	return &reductionState{
		sessions: make(map[string]*Session),
		outcomes: make(map[string]Outcome, commandCount),
	}
}

func sortedCommands(input []Command) []Command {
	commands := append([]Command(nil), input...)
	sort.Slice(commands, func(i, j int) bool {
		left, right := commands[i], commands[j]
		if left.HLCWallMs != right.HLCWallMs {
			return left.HLCWallMs < right.HLCWallMs
		}
		if left.HLCCounter != right.HLCCounter {
			return left.HLCCounter < right.HLCCounter
		}
		if left.DeviceID != right.DeviceID {
			return left.DeviceID < right.DeviceID
		}
		return left.ID < right.ID
	})
	return commands
}

func (state *reductionState) apply(command Command) {
	if current := state.sessions[state.currentID]; current != nil {
		autoComplete(current, command.OccurredAt)
	}
	switch command.Type {
	case "start":
		state.applyStart(command)
	case "pause":
		state.applyPause(command)
	case "resume":
		state.applyResume(command)
	case "finish", "cancel":
		state.applyTerminal(command)
	case "clear":
		state.applyClear(command)
	default:
		state.outcomes[command.ID] = Outcome{Outcome: "rejected", Reason: "unsupported command type"}
	}
}

func (state *reductionState) applyStart(command Command) {
	state.supersedeCurrent(command)
	state.sessions[command.TimerID] = &Session{
		TimerID:           command.TimerID,
		TaskID:            command.TaskID,
		Phase:             command.Phase,
		Status:            "running",
		PlannedDurationMs: command.PlannedDurationMs,
		AnchorAt:          command.OccurredAt,
		StartedAt:         command.OccurredAt,
		StartedByDeviceID: command.DeviceID,
		LastCommandID:     command.ID,
		LastIntent:        commandIntent(command),
	}
	state.accept(command, command.TimerID)
}

func (state *reductionState) applyPause(command Command) {
	target := state.sessions[command.TimerID]
	if target == nil {
		state.ignore(command, "timer is not the active running timer")
		return
	}
	state.supersedeCurrent(command)
	target.Status = "paused"
	state.reanchor(target, command)
	state.accept(command, target.TimerID)
}

func (state *reductionState) applyResume(command Command) {
	target := state.sessions[command.TimerID]
	if target == nil {
		state.ignore(command, "timer cannot be resumed")
		return
	}
	state.supersedeCurrent(command)
	target.Status = "running"
	state.reanchor(target, command)
	state.accept(command, target.TimerID)
}

func (state *reductionState) applyTerminal(command Command) {
	target := state.sessions[command.TimerID]
	if target == nil {
		state.ignore(command, "timer is not active")
		return
	}
	state.supersedeCurrent(command)
	if command.Type == "finish" {
		target.Status = "completed"
		target.ElapsedAtAnchorMs = target.PlannedDurationMs
	} else {
		target.Status = "cancelled"
		target.ElapsedAtAnchorMs = clamp(command.ObservedElapsedMs, 0, target.PlannedDurationMs)
	}
	target.AnchorAt = command.OccurredAt
	target.EndedAt = command.OccurredAt
	target.LastCommandID = command.ID
	target.TerminalCommandID = command.ID
	target.SupersededByTimerID = ""
	target.LastIntent = commandIntent(command)
	state.accept(command, target.TimerID)
}

func (state *reductionState) applyClear(command Command) {
	target := state.sessions[command.TimerID]
	if target == nil {
		state.ignore(command, "timer cannot be cleared")
		return
	}
	target.LastCommandID = command.ID
	target.LastIntent = commandIntent(command)
	if state.currentID == command.TimerID {
		state.currentID = ""
	}
	state.outcomes[command.ID] = Outcome{Outcome: "applied"}
}

func (state *reductionState) reanchor(target *Session, command Command) {
	target.ElapsedAtAnchorMs = clamp(command.ObservedElapsedMs, 0, target.PlannedDurationMs)
	target.AnchorAt = command.OccurredAt
	target.EndedAt = time.Time{}
	target.TerminalCommandID = ""
	target.SupersededByTimerID = ""
	target.LastCommandID = command.ID
	target.LastIntent = commandIntent(command)
}

func (state *reductionState) supersedeCurrent(command Command) {
	current := state.sessions[state.currentID]
	if current != nil && current.TimerID != command.TimerID && isActive(current) {
		supersede(current, command.OccurredAt, command.TimerID, command.ID)
	}
}

func (state *reductionState) accept(command Command, currentID string) {
	state.currentID = currentID
	state.outcomes[command.ID] = Outcome{Outcome: "applied"}
}

func (state *reductionState) ignore(command Command, reason string) {
	state.outcomes[command.ID] = Outcome{Outcome: "ignored", Reason: reason}
}

func commandIntent(command Command) *Intent {
	return &Intent{Type: command.Type, CommandID: command.ID, OccurredAt: formatTime(command.OccurredAt)}
}
