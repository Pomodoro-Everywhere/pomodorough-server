package server

import (
	"encoding/json"
	"regexp"
	"time"

	"pomodorough/internal/store"
)

const (
	maxSyncBody      = 1 << 20
	maxBootstrapBody = 32 << 20
	maxSafeInteger   = int64(9_007_199_254_740_991)
	maxClockSkew     = 5 * time.Minute
)

var (
	idPattern                = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	platformPattern          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$`)
	validTypes               = map[string]struct{}{"start": {}, "pause": {}, "resume": {}, "finish": {}, "cancel": {}, "clear": {}}
	validPhases              = map[string]struct{}{"focus": {}, "short_break": {}, "long_break": {}}
	validTaskOperationTypes  = map[string]struct{}{"upsert": {}, "delete": {}}
	validBootstrapStrategies = map[string]struct{}{
		store.BootstrapKeepRemote: {}, store.BootstrapReplaceRemote: {}, store.BootstrapMerge: {},
	}
)

type syncRequestJSON struct {
	DeviceID               string                          `json:"deviceId"`
	LastRevision           *int64                          `json:"lastRevision"`
	Commands               []syncCommandJSON               `json:"commands"`
	TaskOperations         []syncTaskOperationJSON         `json:"taskOperations,omitempty"`
	DurationOperations     []syncDurationOperationJSON     `json:"durationOperations,omitempty"`
	AutoStartOperations    []syncAutoStartOperationJSON    `json:"autoStartOperations,omitempty"`
	SelectedTaskOperations []syncSelectedTaskOperationJSON `json:"selectedTaskOperations,omitempty"`
}

type syncCommandJSON struct {
	ID                string `json:"id"`
	DeviceSequence    *int64 `json:"deviceSequence"`
	TimerID           string `json:"timerId"`
	TaskID            string `json:"taskId,omitempty"`
	Type              string `json:"type"`
	Phase             string `json:"phase"`
	PlannedDurationMs *int64 `json:"plannedDurationMs"`
	OccurredAt        string `json:"occurredAt"`
	HLCWallMs         *int64 `json:"hlcWallMs"`
	HLCCounter        *int64 `json:"hlcCounter"`
	ObservedElapsedMs *int64 `json:"observedElapsedMs"`
}

type syncTaskOperationJSON struct {
	ID         string `json:"id"`
	TaskID     string `json:"taskId"`
	Type       string `json:"type"`
	Title      string `json:"title,omitempty"`
	OccurredAt string `json:"occurredAt"`
	HLCWallMs  *int64 `json:"hlcWallMs"`
	HLCCounter *int64 `json:"hlcCounter"`
}

type syncDurationOperationJSON struct {
	ID         string `json:"id"`
	Phase      string `json:"phase"`
	DurationMs *int64 `json:"durationMs"`
	OccurredAt string `json:"occurredAt"`
	HLCWallMs  *int64 `json:"hlcWallMs"`
	HLCCounter *int64 `json:"hlcCounter"`
}

type syncAutoStartOperationJSON struct {
	ID         string `json:"id"`
	Enabled    *bool  `json:"enabled"`
	OccurredAt string `json:"occurredAt"`
	HLCWallMs  *int64 `json:"hlcWallMs"`
	HLCCounter *int64 `json:"hlcCounter"`
}

type syncSelectedTaskOperationJSON struct {
	ID         string          `json:"id"`
	TaskID     json.RawMessage `json:"taskId,omitempty"`
	OccurredAt string          `json:"occurredAt"`
	HLCWallMs  *int64          `json:"hlcWallMs"`
	HLCCounter *int64          `json:"hlcCounter"`
}

type bootstrapResolutionRequestJSON struct {
	RequestID              string                      `json:"requestId"`
	DeviceID               string                      `json:"deviceId"`
	ExpectedRevision       *int64                      `json:"expectedRevision"`
	Strategy               string                      `json:"strategy"`
	Commands               []syncCommandJSON           `json:"commands"`
	TaskOperations         []syncTaskOperationJSON     `json:"taskOperations"`
	DurationOperations     []syncDurationOperationJSON `json:"durationOperations"`
	AutoStartOperations    json.RawMessage             `json:"autoStartOperations,omitempty"`
	SelectedTaskOperations json.RawMessage             `json:"selectedTaskOperations,omitempty"`
}
