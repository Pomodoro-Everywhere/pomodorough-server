package timer

import (
	"sort"
	"time"
)

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
