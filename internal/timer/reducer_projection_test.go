package timer

import (
	"sort"
	"time"
)

func (state *reductionState) result(now time.Time) Result {
	sessions := cloneSessions(sessionSlice(state.sessions))
	byID := indexSessions(sessions)
	if current := byID[state.currentID]; current != nil {
		autoComplete(current, now)
	}
	result := Result{Sessions: sessions, Outcomes: state.outcomes}
	if current := byID[state.currentID]; current != nil {
		result.Canonical = canonical(current)
	}
	for _, session := range terminalSessions(sessions) {
		result.History = append(result.History, historyItem(session))
	}
	return result
}

func indexSessions(sessions []Session) map[string]*Session {
	byID := make(map[string]*Session, len(sessions))
	for index := range sessions {
		byID[sessions[index].TimerID] = &sessions[index]
	}
	return byID
}

func canonical(session *Session) *CanonicalTimer {
	return &CanonicalTimer{
		ID:                session.TimerID,
		TaskID:            session.TaskID,
		Phase:             session.Phase,
		Status:            session.Status,
		PlannedDurationMs: session.PlannedDurationMs,
		ElapsedAtAnchorMs: clamp(session.ElapsedAtAnchorMs, 0, session.PlannedDurationMs),
		AnchorAt:          formatTime(session.AnchorAt),
		StartedByDeviceID: session.StartedByDeviceID,
		LastIntent:        session.LastIntent,
	}
}

func terminalSessions(sessions []Session) []Session {
	terminal := make([]Session, 0, len(sessions))
	for _, session := range sessions {
		if session.Status == "completed" || session.Status == "cancelled" || session.Status == "superseded" {
			terminal = append(terminal, session)
		}
	}
	sort.Slice(terminal, func(i, j int) bool {
		if !terminal[i].EndedAt.Equal(terminal[j].EndedAt) {
			return terminal[i].EndedAt.After(terminal[j].EndedAt)
		}
		return terminal[i].TimerID < terminal[j].TimerID
	})
	return terminal
}

func historyItem(session Session) HistoryItem {
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
	return item
}
