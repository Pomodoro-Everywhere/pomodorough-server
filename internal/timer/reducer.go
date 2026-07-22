package timer

import (
	"sort"
	"time"
)

type Command struct {
	ID                string
	DeviceID          string
	DeviceSequence    int64
	TimerID           string
	TaskID            string
	Type              string
	Phase             string
	PlannedDurationMs int64
	OccurredAt        time.Time
	HLCWallMs         int64
	HLCCounter        int64
	ObservedElapsedMs int64
}

type Intent struct {
	Type       string `json:"type"`
	CommandID  string `json:"commandId"`
	OccurredAt string `json:"occurredAt"`
}

type CanonicalTimer struct {
	ID                string  `json:"id"`
	TaskID            string  `json:"taskId,omitempty"`
	Phase             string  `json:"phase"`
	Status            string  `json:"status"`
	PlannedDurationMs int64   `json:"plannedDurationMs"`
	ElapsedAtAnchorMs int64   `json:"elapsedAtAnchorMs"`
	AnchorAt          string  `json:"anchorAt"`
	LastIntent        *Intent `json:"lastIntent,omitempty"`
}

type HistoryItem struct {
	ID                string `json:"id"`
	TimerID           string `json:"timerId"`
	TaskID            string `json:"taskId,omitempty"`
	CommandID         string `json:"commandId,omitempty"`
	Phase             string `json:"phase"`
	Status            string `json:"status"`
	PlannedDurationMs int64  `json:"plannedDurationMs"`
	CompletedAt       string `json:"completedAt,omitempty"`
	EndedAt           string `json:"endedAt,omitempty"`
}

type Outcome struct {
	Outcome string
	Reason  string
}

type Session struct {
	TimerID             string
	TaskID              string
	Phase               string
	Status              string
	PlannedDurationMs   int64
	ElapsedAtAnchorMs   int64
	AnchorAt            time.Time
	StartedAt           time.Time
	EndedAt             time.Time
	LastCommandID       string
	TerminalCommandID   string
	SupersededByTimerID string
	LastIntent          *Intent
}

type Result struct {
	Canonical *CanonicalTimer
	History   []HistoryItem
	Sessions  []Session
	Outcomes  map[string]Outcome
}

func Reduce(input []Command, now time.Time) Result {
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

	sessions := make(map[string]*Session)
	outcomes := make(map[string]Outcome, len(commands))
	var currentID string

	for _, command := range commands {
		if current := sessions[currentID]; current != nil {
			autoComplete(current, command.OccurredAt)
		}
		intent := &Intent{Type: command.Type, CommandID: command.ID, OccurredAt: formatTime(command.OccurredAt)}
		switch command.Type {
		case "start":
			if _, exists := sessions[command.TimerID]; exists {
				outcomes[command.ID] = Outcome{Outcome: "ignored", Reason: "timer already exists"}
				continue
			}
			if current := sessions[currentID]; isActive(current) {
				supersede(current, command.OccurredAt, command.TimerID, command.ID)
			}
			sessions[command.TimerID] = &Session{
				TimerID:           command.TimerID,
				TaskID:            command.TaskID,
				Phase:             command.Phase,
				Status:            "running",
				PlannedDurationMs: command.PlannedDurationMs,
				ElapsedAtAnchorMs: 0,
				AnchorAt:          command.OccurredAt,
				StartedAt:         command.OccurredAt,
				LastCommandID:     command.ID,
				LastIntent:        intent,
			}
			currentID = command.TimerID
			outcomes[command.ID] = Outcome{Outcome: "applied"}

		case "pause":
			target := sessions[command.TimerID]
			if target == nil || currentID != command.TimerID || target.Status != "running" {
				outcomes[command.ID] = Outcome{Outcome: "ignored", Reason: "timer is not the active running timer"}
				continue
			}
			target.Status = "paused"
			target.ElapsedAtAnchorMs = clamp(command.ObservedElapsedMs, 0, target.PlannedDurationMs)
			target.AnchorAt = command.OccurredAt
			target.LastCommandID = command.ID
			target.LastIntent = intent
			outcomes[command.ID] = Outcome{Outcome: "applied"}

		case "resume":
			target := sessions[command.TimerID]
			if target == nil || (target.Status != "paused" && target.Status != "superseded") {
				outcomes[command.ID] = Outcome{Outcome: "ignored", Reason: "timer cannot be resumed"}
				continue
			}
			if current := sessions[currentID]; current != nil && current.TimerID != target.TimerID && isActive(current) {
				supersede(current, command.OccurredAt, target.TimerID, command.ID)
			}
			target.Status = "running"
			target.ElapsedAtAnchorMs = clamp(command.ObservedElapsedMs, 0, target.PlannedDurationMs)
			target.AnchorAt = command.OccurredAt
			target.EndedAt = time.Time{}
			target.TerminalCommandID = ""
			target.SupersededByTimerID = ""
			target.LastCommandID = command.ID
			target.LastIntent = intent
			currentID = target.TimerID
			outcomes[command.ID] = Outcome{Outcome: "applied"}

		case "finish", "cancel":
			target := sessions[command.TimerID]
			if command.Type == "finish" && target != nil && currentID == command.TimerID && target.Status == "completed" && target.TerminalCommandID == "" {
				target.LastCommandID = command.ID
				target.TerminalCommandID = command.ID
				target.LastIntent = intent
				outcomes[command.ID] = Outcome{Outcome: "applied"}
				continue
			}
			if target == nil || currentID != command.TimerID || !isActive(target) {
				outcomes[command.ID] = Outcome{Outcome: "ignored", Reason: "timer is not active"}
				continue
			}
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
			target.LastIntent = intent
			outcomes[command.ID] = Outcome{Outcome: "applied"}

		case "clear":
			target := sessions[command.TimerID]
			if target == nil || currentID != command.TimerID || isActive(target) {
				outcomes[command.ID] = Outcome{Outcome: "ignored", Reason: "timer cannot be cleared"}
				continue
			}
			target.LastCommandID = command.ID
			target.LastIntent = intent
			currentID = ""
			outcomes[command.ID] = Outcome{Outcome: "applied"}

		default:
			outcomes[command.ID] = Outcome{Outcome: "rejected", Reason: "unsupported command type"}
		}
	}

	storedSessions := sessionSlice(sessions)
	viewSessions := cloneSessions(storedSessions)
	viewByID := make(map[string]*Session, len(viewSessions))
	for index := range viewSessions {
		viewByID[viewSessions[index].TimerID] = &viewSessions[index]
	}
	if current := viewByID[currentID]; current != nil {
		autoComplete(current, now)
	}

	result := Result{Sessions: viewSessions, Outcomes: outcomes}
	if current := viewByID[currentID]; current != nil {
		result.Canonical = canonical(current, now)
	}
	terminalSessions := make([]Session, 0, len(viewSessions))
	for _, session := range viewSessions {
		if session.Status != "completed" && session.Status != "cancelled" && session.Status != "superseded" {
			continue
		}
		terminalSessions = append(terminalSessions, session)
	}
	sort.Slice(terminalSessions, func(i, j int) bool {
		if !terminalSessions[i].EndedAt.Equal(terminalSessions[j].EndedAt) {
			return terminalSessions[i].EndedAt.After(terminalSessions[j].EndedAt)
		}
		return terminalSessions[i].TimerID < terminalSessions[j].TimerID
	})
	for _, session := range terminalSessions {
		item := HistoryItem{
			ID:                session.TimerID,
			TimerID:           session.TimerID,
			TaskID:            session.TaskID,
			CommandID:         session.TerminalCommandID,
			Phase:             session.Phase,
			Status:            session.Status,
			PlannedDurationMs: session.PlannedDurationMs,
			EndedAt:           formatTime(session.EndedAt),
		}
		if session.Status == "completed" {
			item.CompletedAt = formatTime(session.EndedAt)
		}
		result.History = append(result.History, item)
	}
	return result
}

func canonical(session *Session, now time.Time) *CanonicalTimer {
	elapsed := session.ElapsedAtAnchorMs
	return &CanonicalTimer{
		ID:                session.TimerID,
		TaskID:            session.TaskID,
		Phase:             session.Phase,
		Status:            session.Status,
		PlannedDurationMs: session.PlannedDurationMs,
		ElapsedAtAnchorMs: clamp(elapsed, 0, session.PlannedDurationMs),
		AnchorAt:          formatTime(session.AnchorAt),
		LastIntent:        session.LastIntent,
	}
}

func autoComplete(session *Session, at time.Time) {
	if session == nil || session.Status != "running" || elapsedAt(session, at) < session.PlannedDurationMs {
		return
	}
	remaining := session.PlannedDurationMs - session.ElapsedAtAnchorMs
	if remaining < 0 {
		remaining = 0
	}
	completedAt := session.AnchorAt.Add(time.Duration(remaining) * time.Millisecond)
	session.Status = "completed"
	session.ElapsedAtAnchorMs = session.PlannedDurationMs
	session.AnchorAt = completedAt
	session.EndedAt = completedAt
}

func supersede(session *Session, at time.Time, replacementID, commandID string) {
	if session.Status == "running" {
		session.ElapsedAtAnchorMs = elapsedAt(session, at)
	}
	session.Status = "superseded"
	session.AnchorAt = at
	session.EndedAt = at
	session.LastCommandID = commandID
	session.TerminalCommandID = commandID
	session.SupersededByTimerID = replacementID
}

func elapsedAt(session *Session, at time.Time) int64 {
	elapsed := session.ElapsedAtAnchorMs
	if at.After(session.AnchorAt) {
		elapsed += at.Sub(session.AnchorAt).Milliseconds()
	}
	return clamp(elapsed, 0, session.PlannedDurationMs)
}

func isActive(session *Session) bool {
	return session != nil && (session.Status == "running" || session.Status == "paused")
}

func sessionSlice(sessions map[string]*Session) []Session {
	result := make([]Session, 0, len(sessions))
	for _, session := range sessions {
		copy := *session
		if session.LastIntent != nil {
			intentCopy := *session.LastIntent
			copy.LastIntent = &intentCopy
		}
		result = append(result, copy)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].TimerID < result[j].TimerID })
	return result
}

func cloneSessions(sessions []Session) []Session {
	result := append([]Session(nil), sessions...)
	for index := range result {
		if result[index].LastIntent != nil {
			intentCopy := *result[index].LastIntent
			result[index].LastIntent = &intentCopy
		}
	}
	return result
}

func clamp(value, minimum, maximum int64) int64 {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
