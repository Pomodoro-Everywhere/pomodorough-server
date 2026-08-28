package timer

import (
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
	StartedByDeviceID string  `json:"startedByDeviceId,omitempty"`
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
	StartedByDeviceID   string
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
