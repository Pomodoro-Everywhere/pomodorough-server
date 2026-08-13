package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

type SyncRequest struct {
	DeviceID               string
	LastRevision           int64
	Commands               []timer.Command
	TaskOperations         []task.Operation
	DurationOperations     []DurationOperation
	AutoStartOperations    []AutoStartOperation
	SelectedTaskOperations []SelectedTaskOperation
}

type Acknowledgement struct {
	CommandID string `json:"commandId"`
	Outcome   string `json:"outcome"`
	Reason    string `json:"reason"`
}

type TaskAcknowledgement struct {
	OperationID string `json:"operationId"`
	Outcome     string `json:"outcome"`
	Reason      string `json:"reason"`
}

type DurationOperation struct {
	ID         string
	DeviceID   string
	Phase      string
	DurationMs int64
	OccurredAt time.Time
	HLCWallMs  int64
	HLCCounter int64
}

type DurationAcknowledgement struct {
	OperationID string `json:"operationId"`
	Outcome     string `json:"outcome"`
	Reason      string `json:"reason"`
}

type AutoStartOperation struct {
	ID         string
	DeviceID   string
	Enabled    bool
	OccurredAt time.Time
	HLCWallMs  int64
	HLCCounter int64
}

type AutoStartAcknowledgement struct {
	OperationID string `json:"operationId"`
	Outcome     string `json:"outcome"`
	Reason      string `json:"reason"`
}

type SelectedTaskOperation struct {
	ID         string
	DeviceID   string
	TaskID     *string
	OccurredAt time.Time
	HLCWallMs  int64
	HLCCounter int64
}

type SelectedTaskAcknowledgement struct {
	OperationID string `json:"operationId"`
	Outcome     string `json:"outcome"`
	Reason      string `json:"reason"`
}

type DurationsMs struct {
	Focus      int64 `json:"focus"`
	ShortBreak int64 `json:"short_break"`
	LongBreak  int64 `json:"long_break"`
}

type SyncResult struct {
	Acknowledgements             []Acknowledgement             `json:"acknowledgements"`
	TaskAcknowledgements         []TaskAcknowledgement         `json:"taskAcknowledgements"`
	DurationAcknowledgements     []DurationAcknowledgement     `json:"durationAcknowledgements"`
	AutoStartAcknowledgements    []AutoStartAcknowledgement    `json:"autoStartAcknowledgements"`
	SelectedTaskAcknowledgements []SelectedTaskAcknowledgement `json:"selectedTaskAcknowledgements"`
	Revision                     int64                         `json:"revision"`
	CanonicalTimer               *timer.CanonicalTimer         `json:"canonicalTimer"`
	History                      []timer.HistoryItem           `json:"history"`
	Tasks                        []task.Task                   `json:"tasks"`
	DurationsMs                  DurationsMs                   `json:"durationsMs"`
	AutoStartBreaks              bool                          `json:"autoStartBreaks"`
	SelectedTaskID               *string                       `json:"selectedTaskId"`
	ServerTime                   string                        `json:"serverTime"`
	ServerHLCWallMs              int64                         `json:"serverHlcWallMs"`
	ServerHLCCounter             int64                         `json:"serverHlcCounter"`
	Changed                      bool                          `json:"-"`
}

func normalizeSyncResult(result SyncResult) SyncResult {
	if result.Acknowledgements == nil {
		result.Acknowledgements = []Acknowledgement{}
	}
	if result.TaskAcknowledgements == nil {
		result.TaskAcknowledgements = []TaskAcknowledgement{}
	}
	if result.DurationAcknowledgements == nil {
		result.DurationAcknowledgements = []DurationAcknowledgement{}
	}
	if result.AutoStartAcknowledgements == nil {
		result.AutoStartAcknowledgements = []AutoStartAcknowledgement{}
	}
	if result.SelectedTaskAcknowledgements == nil {
		result.SelectedTaskAcknowledgements = []SelectedTaskAcknowledgement{}
	}
	if result.History == nil {
		result.History = []timer.HistoryItem{}
	}
	if result.Tasks == nil {
		result.Tasks = []task.Task{}
	}
	return result
}

func normalizeStoredSyncResult(result SyncResult) (SyncResult, error) {
	result = normalizeSyncResult(result)
	if result.ServerHLCWallMs != 0 {
		return result, nil
	}
	serverTime, err := time.Parse(time.RFC3339Nano, result.ServerTime)
	if err != nil {
		return SyncResult{}, fmt.Errorf("decode stored bootstrap server time: %w", err)
	}
	serverWallMs := serverTime.UnixMilli()
	if serverWallMs < 1 || serverWallMs > MaxSafeRevision {
		return SyncResult{}, errors.New("stored bootstrap server time is outside supported range")
	}
	result.ServerHLCWallMs = serverWallMs
	result.ServerHLCCounter = 0
	return result, nil
}

func (s *Store) Sync(ctx context.Context, db *sql.DB, userID string, request SyncRequest, now time.Time) (SyncResult, error) {
	if err := validateUniqueOperationIDs(request); err != nil {
		return SyncResult{}, err
	}
	unlock := s.LockUser(userID)
	defer unlock()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return SyncResult{}, fmt.Errorf("begin sync: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `INSERT INTO devices(id, platform, created_at_ms, last_seen_at_ms, revoked_at_ms)
		VALUES (?, 'web', ?, ?, NULL)
		ON CONFLICT(id) DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms`, request.DeviceID, now.UnixMilli(), now.UnixMilli()); err != nil {
		return SyncResult{}, fmt.Errorf("record sync device: %w", err)
	}

	applied, err := applyOperations(ctx, tx, request)
	if err != nil {
		return SyncResult{}, err
	}
	reduction, err := reduceAccount(ctx, tx, now)
	if err != nil {
		return SyncResult{}, err
	}
	projectionChanged, err := timerProjectionChanged(ctx, tx, reduction.timer)
	if err != nil {
		return SyncResult{}, err
	}
	revision := reduction.revision
	if applied.changed || projectionChanged {
		revision, err = safeRevisionIncrement(revision)
		if err != nil {
			return SyncResult{}, err
		}
	}
	if err := persistReduction(ctx, tx, reduction, revision); err != nil {
		return SyncResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return SyncResult{}, fmt.Errorf("commit sync: %w", err)
	}

	result := resultFromReduction(reduction, revision, now, &request)
	addAcknowledgements(&result, request, applied, reduction)
	result.Changed = applied.changed || projectionChanged
	return result, nil
}

func (s *Store) materializeProjection(ctx context.Context, db *sql.DB, userID string, now time.Time) (SyncResult, error) {
	unlock := s.LockUser(userID)
	defer unlock()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return SyncResult{}, fmt.Errorf("begin projection materialization: %w", err)
	}
	defer tx.Rollback()
	reduction, err := reduceAccount(ctx, tx, now)
	if err != nil {
		return SyncResult{}, err
	}
	changed, err := timerProjectionChanged(ctx, tx, reduction.timer)
	if err != nil {
		return SyncResult{}, err
	}
	revision := reduction.revision
	if changed {
		revision, err = safeRevisionIncrement(revision)
		if err != nil {
			return SyncResult{}, err
		}
		if err := persistReduction(ctx, tx, reduction, revision); err != nil {
			return SyncResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return SyncResult{}, fmt.Errorf("commit projection materialization: %w", err)
	}
	result := resultFromReduction(reduction, revision, now, nil)
	result.Changed = changed
	return result, nil
}

type operationApplication struct {
	commandRejections      map[string]timer.Outcome
	taskRejections         map[string]TaskAcknowledgement
	durationRejections     map[string]DurationAcknowledgement
	autoStartRejections    map[string]AutoStartAcknowledgement
	selectedTaskRejections map[string]SelectedTaskAcknowledgement
	changed                bool
}

type accountReduction struct {
	revision                     int64
	commands                     []timer.Command
	timer                        timer.Result
	taskOperations               []task.Operation
	tasks                        []task.Task
	winningTaskOperations        map[string]string
	durationOperations           []DurationOperation
	durations                    DurationsMs
	winningDurationOperations    map[string]struct{}
	autoStartOperations          []AutoStartOperation
	autoStartBreaks              bool
	winningAutoStartOperation    string
	selectedTaskOperations       []SelectedTaskOperation
	selectedTaskID               *string
	winningSelectedTaskOperation string
}

func validateUniqueOperationIDs(request SyncRequest) error {
	commandIDs := make(map[string]struct{}, len(request.Commands))
	for _, command := range request.Commands {
		if _, duplicate := commandIDs[command.ID]; duplicate {
			return fmt.Errorf("duplicate timer command id %q", command.ID)
		}
		commandIDs[command.ID] = struct{}{}
	}
	taskOperationIDs := make(map[string]struct{}, len(request.TaskOperations))
	for _, operation := range request.TaskOperations {
		if _, duplicate := taskOperationIDs[operation.ID]; duplicate {
			return fmt.Errorf("duplicate task operation id %q", operation.ID)
		}
		taskOperationIDs[operation.ID] = struct{}{}
	}
	durationOperationIDs := make(map[string]struct{}, len(request.DurationOperations))
	for _, operation := range request.DurationOperations {
		if _, duplicate := durationOperationIDs[operation.ID]; duplicate {
			return fmt.Errorf("duplicate duration operation id %q", operation.ID)
		}
		durationOperationIDs[operation.ID] = struct{}{}
	}
	autoStartOperationIDs := make(map[string]struct{}, len(request.AutoStartOperations))
	for _, operation := range request.AutoStartOperations {
		if _, duplicate := autoStartOperationIDs[operation.ID]; duplicate {
			return fmt.Errorf("duplicate auto-start operation id %q", operation.ID)
		}
		autoStartOperationIDs[operation.ID] = struct{}{}
	}
	selectedTaskOperationIDs := make(map[string]struct{}, len(request.SelectedTaskOperations))
	for _, operation := range request.SelectedTaskOperations {
		if _, duplicate := selectedTaskOperationIDs[operation.ID]; duplicate {
			return fmt.Errorf("duplicate selected-task operation id %q", operation.ID)
		}
		selectedTaskOperationIDs[operation.ID] = struct{}{}
	}
	return nil
}

func applyOperations(ctx context.Context, tx *sql.Tx, request SyncRequest) (operationApplication, error) {
	application := operationApplication{
		commandRejections:      make(map[string]timer.Outcome),
		taskRejections:         make(map[string]TaskAcknowledgement),
		durationRejections:     make(map[string]DurationAcknowledgement),
		autoStartRejections:    make(map[string]AutoStartAcknowledgement),
		selectedTaskRejections: make(map[string]SelectedTaskAcknowledgement),
	}
	for _, command := range request.Commands {
		existing, err := loadCommand(ctx, tx, command.ID)
		if err == nil {
			if !sameCommand(existing, command, request.DeviceID) {
				application.commandRejections[command.ID] = timer.Outcome{Outcome: "rejected", Reason: "command ID already used with different payload"}
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return operationApplication{}, fmt.Errorf("check command id: %w", err)
		}
		var existingID string
		err = tx.QueryRowContext(ctx, `SELECT id FROM timer_commands WHERE device_id = ? AND device_sequence = ?`, request.DeviceID, command.DeviceSequence).Scan(&existingID)
		if err == nil {
			application.commandRejections[command.ID] = timer.Outcome{Outcome: "rejected", Reason: "device sequence already used"}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return operationApplication{}, fmt.Errorf("check device sequence: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO timer_commands(
			id, device_id, device_sequence, timer_id, task_id, command_type, phase, planned_duration_ms,
			occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter, observed_elapsed_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			command.ID, request.DeviceID, command.DeviceSequence, command.TimerID, nullString(command.TaskID), command.Type, command.Phase,
			command.PlannedDurationMs, command.OccurredAt.UTC().Format(time.RFC3339Nano), command.OccurredAt.UnixMilli(),
			command.HLCWallMs, command.HLCCounter, command.ObservedElapsedMs,
		); err != nil {
			return operationApplication{}, fmt.Errorf("insert timer command: %w", err)
		}
		application.changed = true
	}
	for _, operation := range request.TaskOperations {
		existing, err := loadTaskOperation(ctx, tx, operation.ID)
		if err == nil {
			if !sameTaskOperation(existing, operation, request.DeviceID) {
				application.taskRejections[operation.ID] = TaskAcknowledgement{
					OperationID: operation.ID, Outcome: "rejected", Reason: "operation ID already used with different payload",
				}
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return operationApplication{}, fmt.Errorf("check task operation id: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO task_operations(
			id, device_id, task_id, operation_type, title, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, operation.ID, request.DeviceID, operation.TaskID, operation.Type,
			operation.Title, operation.OccurredAt.UTC().Format(time.RFC3339Nano), operation.OccurredAt.UnixMilli(), operation.HLCWallMs, operation.HLCCounter); err != nil {
			return operationApplication{}, fmt.Errorf("insert task operation: %w", err)
		}
		application.changed = true
	}
	for _, operation := range request.DurationOperations {
		existing, err := loadDurationOperation(ctx, tx, operation.ID)
		if err == nil {
			if !sameDurationOperation(existing, operation, request.DeviceID) {
				application.durationRejections[operation.ID] = DurationAcknowledgement{
					OperationID: operation.ID, Outcome: "rejected", Reason: "operation ID already used with different payload",
				}
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return operationApplication{}, fmt.Errorf("check duration operation id: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO duration_operations(
			id, device_id, phase, duration_ms, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, operation.ID, request.DeviceID, operation.Phase, operation.DurationMs,
			operation.OccurredAt.UTC().Format(time.RFC3339Nano), operation.OccurredAt.UnixMilli(), operation.HLCWallMs, operation.HLCCounter); err != nil {
			return operationApplication{}, fmt.Errorf("insert duration operation: %w", err)
		}
		application.changed = true
	}
	for _, operation := range request.AutoStartOperations {
		existing, err := loadAutoStartOperation(ctx, tx, operation.ID)
		if err == nil {
			if !sameAutoStartOperation(existing, operation, request.DeviceID) {
				application.autoStartRejections[operation.ID] = AutoStartAcknowledgement{
					OperationID: operation.ID, Outcome: "rejected", Reason: "operation ID already used with different payload",
				}
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return operationApplication{}, fmt.Errorf("check auto-start operation id: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO auto_start_operations(
			id, device_id, enabled, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
		) VALUES (?, ?, ?, ?, ?, ?, ?)`, operation.ID, request.DeviceID, operation.Enabled,
			operation.OccurredAt.UTC().Format(time.RFC3339Nano), operation.OccurredAt.UnixMilli(), operation.HLCWallMs, operation.HLCCounter); err != nil {
			return operationApplication{}, fmt.Errorf("insert auto-start operation: %w", err)
		}
		application.changed = true
	}
	for _, operation := range request.SelectedTaskOperations {
		existing, err := loadSelectedTaskOperation(ctx, tx, operation.ID)
		if err == nil {
			if !sameSelectedTaskOperation(existing, operation, request.DeviceID) {
				application.selectedTaskRejections[operation.ID] = SelectedTaskAcknowledgement{
					OperationID: operation.ID, Outcome: "rejected", Reason: "operation ID already used with different payload",
				}
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return operationApplication{}, fmt.Errorf("check selected-task operation id: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO selected_task_operations(
			id, device_id, task_id, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
		) VALUES (?, ?, ?, ?, ?, ?, ?)`, operation.ID, request.DeviceID, nullableString(operation.TaskID),
			operation.OccurredAt.UTC().Format(time.RFC3339Nano), operation.OccurredAt.UnixMilli(), operation.HLCWallMs, operation.HLCCounter); err != nil {
			return operationApplication{}, fmt.Errorf("insert selected-task operation: %w", err)
		}
		application.changed = true
	}
	return application, nil
}

func reduceAccount(ctx context.Context, source databaseQueryer, now time.Time) (accountReduction, error) {
	var reduction accountReduction
	if err := source.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&reduction.revision); err != nil {
		return accountReduction{}, fmt.Errorf("read account revision: %w", err)
	}
	if err := validateCanonicalRevision(reduction.revision); err != nil {
		return accountReduction{}, err
	}
	var err error
	reduction.commands, err = loadCommands(ctx, source)
	if err != nil {
		return accountReduction{}, err
	}
	reduction.timer = timer.Reduce(reduction.commands, now)
	reduction.taskOperations, err = loadTaskOperations(ctx, source)
	if err != nil {
		return accountReduction{}, err
	}
	reduction.tasks, reduction.winningTaskOperations = reduceTasks(reduction.taskOperations)
	reduction.durationOperations, err = loadDurationOperations(ctx, source)
	if err != nil {
		return accountReduction{}, err
	}
	reduction.durations, reduction.winningDurationOperations = reduceDurations(reduction.durationOperations)
	reduction.autoStartOperations, err = loadAutoStartOperations(ctx, source)
	if err != nil {
		return accountReduction{}, err
	}
	reduction.autoStartBreaks, reduction.winningAutoStartOperation = reduceAutoStart(reduction.autoStartOperations)
	reduction.selectedTaskOperations, err = loadSelectedTaskOperations(ctx, source)
	if err != nil {
		return accountReduction{}, err
	}
	reduction.selectedTaskID, reduction.winningSelectedTaskOperation = reduceSelectedTask(reduction.selectedTaskOperations, reduction.tasks)
	return reduction, nil
}

func persistReduction(ctx context.Context, tx *sql.Tx, reduction accountReduction, revision int64) error {
	if err := validateCanonicalRevision(revision); err != nil {
		return err
	}
	for commandID, outcome := range reduction.timer.Outcomes {
		if _, err := tx.ExecContext(ctx, `INSERT INTO command_outcomes(command_id, outcome, reason) VALUES (?, ?, ?)
			ON CONFLICT(command_id) DO UPDATE SET outcome = excluded.outcome, reason = excluded.reason`, commandID, outcome.Outcome, outcome.Reason); err != nil {
			return fmt.Errorf("save command outcome: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM timer_sessions`); err != nil {
		return fmt.Errorf("clear timer projection: %w", err)
	}
	for _, session := range reduction.timer.Sessions {
		if _, err := tx.ExecContext(ctx, `INSERT INTO timer_sessions(
			timer_id, task_id, phase, status, planned_duration_ms, elapsed_at_anchor_ms, anchor_at_ms, started_at_ms,
			ended_at_ms, last_command_id, terminal_command_id, superseded_by_timer_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			session.TimerID, nullString(session.TaskID), session.Phase, session.Status, session.PlannedDurationMs, session.ElapsedAtAnchorMs,
			session.AnchorAt.UnixMilli(), session.StartedAt.UnixMilli(), unixMilli(session.EndedAt), session.LastCommandID,
			nullString(session.TerminalCommandID), nullString(session.SupersededByTimerID),
		); err != nil {
			return fmt.Errorf("save timer projection: %w", err)
		}
	}
	var currentTimerID any
	if reduction.timer.Canonical != nil {
		currentTimerID = reduction.timer.Canonical.ID
	}
	if _, err := tx.ExecContext(ctx, `UPDATE account_state SET revision = ?, current_timer_id = ? WHERE singleton = 1`, revision, currentTimerID); err != nil {
		return fmt.Errorf("save account state: %w", err)
	}
	return nil
}

func timerProjectionChanged(ctx context.Context, source databaseQueryer, result timer.Result) (bool, error) {
	var persistedCurrentID sql.NullString
	if err := source.QueryRowContext(ctx, `SELECT current_timer_id FROM account_state WHERE singleton = 1`).Scan(&persistedCurrentID); err != nil {
		return false, fmt.Errorf("read current timer projection: %w", err)
	}
	currentID := ""
	if result.Canonical != nil {
		currentID = result.Canonical.ID
	}
	if persistedCurrentID.String != currentID {
		return true, nil
	}

	rows, err := source.QueryContext(ctx, `SELECT timer_id, task_id, phase, status, planned_duration_ms, elapsed_at_anchor_ms,
		anchor_at_ms, started_at_ms, ended_at_ms, last_command_id, terminal_command_id, superseded_by_timer_id
	FROM timer_sessions ORDER BY timer_id`)
	if err != nil {
		return false, fmt.Errorf("read timer projection: %w", err)
	}
	defer rows.Close()
	persisted := make([]timer.Session, 0, len(result.Sessions))
	for rows.Next() {
		var session timer.Session
		var taskID, terminalCommandID, supersededByTimerID sql.NullString
		var anchorAtMs, startedAtMs int64
		var endedAtMs sql.NullInt64
		if err := rows.Scan(&session.TimerID, &taskID, &session.Phase, &session.Status, &session.PlannedDurationMs,
			&session.ElapsedAtAnchorMs, &anchorAtMs, &startedAtMs, &endedAtMs, &session.LastCommandID,
			&terminalCommandID, &supersededByTimerID); err != nil {
			return false, fmt.Errorf("scan timer projection: %w", err)
		}
		session.TaskID = taskID.String
		session.AnchorAt = time.UnixMilli(anchorAtMs).UTC()
		session.StartedAt = time.UnixMilli(startedAtMs).UTC()
		if endedAtMs.Valid {
			session.EndedAt = time.UnixMilli(endedAtMs.Int64).UTC()
		}
		session.TerminalCommandID = terminalCommandID.String
		session.SupersededByTimerID = supersededByTimerID.String
		persisted = append(persisted, session)
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate timer projection: %w", err)
	}
	if len(persisted) != len(result.Sessions) {
		return true, nil
	}
	for index, session := range result.Sessions {
		stored := persisted[index]
		if stored.TimerID != session.TimerID || stored.TaskID != session.TaskID || stored.Phase != session.Phase ||
			stored.Status != session.Status || stored.PlannedDurationMs != session.PlannedDurationMs ||
			stored.ElapsedAtAnchorMs != session.ElapsedAtAnchorMs || !sameProjectedTime(stored.AnchorAt, session.AnchorAt) ||
			!sameProjectedTime(stored.StartedAt, session.StartedAt) || !sameProjectedTime(stored.EndedAt, session.EndedAt) ||
			stored.LastCommandID != session.LastCommandID || stored.TerminalCommandID != session.TerminalCommandID ||
			stored.SupersededByTimerID != session.SupersededByTimerID {
			return true, nil
		}
	}
	return false, nil
}

func sameProjectedTime(left, right time.Time) bool {
	if left.IsZero() || right.IsZero() {
		return left.IsZero() && right.IsZero()
	}
	return left.UnixMilli() == right.UnixMilli()
}

func resultFromReduction(reduction accountReduction, revision int64, now time.Time, request *SyncRequest) SyncResult {
	serverHLCWallMs, serverHLCCounter := now.UnixMilli(), int64(0)
	observeHLC := func(wallMs, counter int64) {
		if wallMs > serverHLCWallMs || wallMs == serverHLCWallMs && counter > serverHLCCounter {
			serverHLCWallMs = wallMs
			serverHLCCounter = counter
		}
	}
	for _, command := range reduction.commands {
		observeHLC(command.HLCWallMs, command.HLCCounter)
	}
	for _, operation := range reduction.taskOperations {
		observeHLC(operation.HLCWallMs, operation.HLCCounter)
	}
	for _, operation := range reduction.durationOperations {
		observeHLC(operation.HLCWallMs, operation.HLCCounter)
	}
	for _, operation := range reduction.autoStartOperations {
		observeHLC(operation.HLCWallMs, operation.HLCCounter)
	}
	for _, operation := range reduction.selectedTaskOperations {
		observeHLC(operation.HLCWallMs, operation.HLCCounter)
	}
	if request != nil {
		for _, command := range request.Commands {
			observeHLC(command.HLCWallMs, command.HLCCounter)
		}
		for _, operation := range request.TaskOperations {
			observeHLC(operation.HLCWallMs, operation.HLCCounter)
		}
		for _, operation := range request.DurationOperations {
			observeHLC(operation.HLCWallMs, operation.HLCCounter)
		}
		for _, operation := range request.AutoStartOperations {
			observeHLC(operation.HLCWallMs, operation.HLCCounter)
		}
		for _, operation := range request.SelectedTaskOperations {
			observeHLC(operation.HLCWallMs, operation.HLCCounter)
		}
	}
	return normalizeSyncResult(SyncResult{
		Acknowledgements:             []Acknowledgement{},
		TaskAcknowledgements:         []TaskAcknowledgement{},
		DurationAcknowledgements:     []DurationAcknowledgement{},
		AutoStartAcknowledgements:    []AutoStartAcknowledgement{},
		SelectedTaskAcknowledgements: []SelectedTaskAcknowledgement{},
		Revision:                     revision,
		CanonicalTimer:               reduction.timer.Canonical,
		History:                      nonNilHistory(reduction.timer.History),
		Tasks:                        reduction.tasks,
		DurationsMs:                  reduction.durations,
		AutoStartBreaks:              reduction.autoStartBreaks,
		SelectedTaskID:               reduction.selectedTaskID,
		ServerTime:                   now.UTC().Format(time.RFC3339Nano),
		ServerHLCWallMs:              serverHLCWallMs,
		ServerHLCCounter:             serverHLCCounter,
	})
}

func addAcknowledgements(result *SyncResult, request SyncRequest, application operationApplication, reduction accountReduction) {
	result.Acknowledgements = make([]Acknowledgement, 0, len(request.Commands))
	for _, command := range request.Commands {
		outcome, rejected := application.commandRejections[command.ID]
		if !rejected {
			outcome = reduction.timer.Outcomes[command.ID]
		}
		result.Acknowledgements = append(result.Acknowledgements, Acknowledgement{CommandID: command.ID, Outcome: outcome.Outcome, Reason: outcome.Reason})
	}
	result.TaskAcknowledgements = make([]TaskAcknowledgement, 0, len(request.TaskOperations))
	for _, operation := range request.TaskOperations {
		if acknowledgement, rejected := application.taskRejections[operation.ID]; rejected {
			result.TaskAcknowledgements = append(result.TaskAcknowledgements, acknowledgement)
			continue
		}
		acknowledgement := TaskAcknowledgement{OperationID: operation.ID, Outcome: "ignored", Reason: "superseded by newer task operation"}
		if reduction.winningTaskOperations[operation.TaskID] == operation.ID {
			acknowledgement.Outcome = "applied"
			acknowledgement.Reason = ""
		}
		result.TaskAcknowledgements = append(result.TaskAcknowledgements, acknowledgement)
	}
	result.DurationAcknowledgements = make([]DurationAcknowledgement, 0, len(request.DurationOperations))
	for _, operation := range request.DurationOperations {
		if acknowledgement, rejected := application.durationRejections[operation.ID]; rejected {
			result.DurationAcknowledgements = append(result.DurationAcknowledgements, acknowledgement)
			continue
		}
		acknowledgement := DurationAcknowledgement{OperationID: operation.ID, Outcome: "ignored", Reason: "superseded by newer duration operation"}
		if _, winning := reduction.winningDurationOperations[operation.ID]; winning {
			acknowledgement.Outcome = "applied"
			acknowledgement.Reason = ""
		}
		result.DurationAcknowledgements = append(result.DurationAcknowledgements, acknowledgement)
	}
	result.AutoStartAcknowledgements = make([]AutoStartAcknowledgement, 0, len(request.AutoStartOperations))
	for _, operation := range request.AutoStartOperations {
		if acknowledgement, rejected := application.autoStartRejections[operation.ID]; rejected {
			result.AutoStartAcknowledgements = append(result.AutoStartAcknowledgements, acknowledgement)
			continue
		}
		acknowledgement := AutoStartAcknowledgement{OperationID: operation.ID, Outcome: "ignored", Reason: "superseded by newer auto-start operation"}
		if reduction.winningAutoStartOperation == operation.ID {
			acknowledgement.Outcome = "applied"
			acknowledgement.Reason = ""
		}
		result.AutoStartAcknowledgements = append(result.AutoStartAcknowledgements, acknowledgement)
	}
	result.SelectedTaskAcknowledgements = make([]SelectedTaskAcknowledgement, 0, len(request.SelectedTaskOperations))
	for _, operation := range request.SelectedTaskOperations {
		if acknowledgement, rejected := application.selectedTaskRejections[operation.ID]; rejected {
			result.SelectedTaskAcknowledgements = append(result.SelectedTaskAcknowledgements, acknowledgement)
			continue
		}
		acknowledgement := SelectedTaskAcknowledgement{OperationID: operation.ID, Outcome: "ignored", Reason: "superseded by newer selected-task operation"}
		if reduction.winningSelectedTaskOperation == operation.ID {
			acknowledgement.Outcome = "applied"
			acknowledgement.Reason = ""
		}
		result.SelectedTaskAcknowledgements = append(result.SelectedTaskAcknowledgements, acknowledgement)
	}
}

func loadCommand(ctx context.Context, source databaseQueryer, id string) (timer.Command, error) {
	var command timer.Command
	var occurredAt string
	var taskID sql.NullString
	err := source.QueryRowContext(ctx, `SELECT id, device_id, device_sequence, timer_id, task_id, command_type, phase,
		planned_duration_ms, occurred_at, hlc_wall_ms, hlc_counter, observed_elapsed_ms
		FROM timer_commands WHERE id = ?`, id).Scan(
		&command.ID, &command.DeviceID, &command.DeviceSequence, &command.TimerID, &taskID, &command.Type, &command.Phase,
		&command.PlannedDurationMs, &occurredAt, &command.HLCWallMs, &command.HLCCounter, &command.ObservedElapsedMs,
	)
	if err != nil {
		return timer.Command{}, err
	}
	command.TaskID = taskID.String
	command.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return timer.Command{}, fmt.Errorf("parse stored command timestamp: %w", err)
	}
	return command, nil
}

func loadTaskOperation(ctx context.Context, source databaseQueryer, id string) (task.Operation, error) {
	var operation task.Operation
	var occurredAt string
	err := source.QueryRowContext(ctx, `SELECT id, device_id, task_id, operation_type, title, occurred_at, hlc_wall_ms, hlc_counter
		FROM task_operations WHERE id = ?`, id).Scan(&operation.ID, &operation.DeviceID, &operation.TaskID, &operation.Type,
		&operation.Title, &occurredAt, &operation.HLCWallMs, &operation.HLCCounter)
	if err != nil {
		return task.Operation{}, err
	}
	operation.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return task.Operation{}, fmt.Errorf("parse stored task operation timestamp: %w", err)
	}
	return operation, nil
}

func loadDurationOperation(ctx context.Context, source databaseQueryer, id string) (DurationOperation, error) {
	var operation DurationOperation
	var occurredAt string
	err := source.QueryRowContext(ctx, `SELECT id, device_id, phase, duration_ms, occurred_at, hlc_wall_ms, hlc_counter
		FROM duration_operations WHERE id = ?`, id).Scan(&operation.ID, &operation.DeviceID, &operation.Phase, &operation.DurationMs,
		&occurredAt, &operation.HLCWallMs, &operation.HLCCounter)
	if err != nil {
		return DurationOperation{}, err
	}
	operation.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return DurationOperation{}, fmt.Errorf("parse stored duration operation timestamp: %w", err)
	}
	return operation, nil
}

func loadAutoStartOperation(ctx context.Context, source databaseQueryer, id string) (AutoStartOperation, error) {
	var operation AutoStartOperation
	var occurredAt string
	err := source.QueryRowContext(ctx, `SELECT id, device_id, enabled, occurred_at, hlc_wall_ms, hlc_counter
		FROM auto_start_operations WHERE id = ?`, id).Scan(&operation.ID, &operation.DeviceID, &operation.Enabled,
		&occurredAt, &operation.HLCWallMs, &operation.HLCCounter)
	if err != nil {
		return AutoStartOperation{}, err
	}
	operation.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return AutoStartOperation{}, fmt.Errorf("parse stored auto-start operation timestamp: %w", err)
	}
	return operation, nil
}

func loadSelectedTaskOperation(ctx context.Context, source databaseQueryer, id string) (SelectedTaskOperation, error) {
	var operation SelectedTaskOperation
	var occurredAt string
	var taskID sql.NullString
	err := source.QueryRowContext(ctx, `SELECT id, device_id, task_id, occurred_at, hlc_wall_ms, hlc_counter
		FROM selected_task_operations WHERE id = ?`, id).Scan(&operation.ID, &operation.DeviceID, &taskID,
		&occurredAt, &operation.HLCWallMs, &operation.HLCCounter)
	if err != nil {
		return SelectedTaskOperation{}, err
	}
	operation.TaskID = stringPointer(taskID)
	operation.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
	if err != nil {
		return SelectedTaskOperation{}, fmt.Errorf("parse stored selected-task operation timestamp: %w", err)
	}
	return operation, nil
}

func sameCommand(stored, submitted timer.Command, deviceID string) bool {
	return stored.DeviceID == deviceID && stored.DeviceSequence == submitted.DeviceSequence && stored.TimerID == submitted.TimerID &&
		stored.TaskID == submitted.TaskID && stored.Type == submitted.Type && stored.Phase == submitted.Phase &&
		stored.PlannedDurationMs == submitted.PlannedDurationMs && stored.OccurredAt.Equal(submitted.OccurredAt) &&
		stored.HLCWallMs == submitted.HLCWallMs && stored.HLCCounter == submitted.HLCCounter && stored.ObservedElapsedMs == submitted.ObservedElapsedMs
}

func sameTaskOperation(stored, submitted task.Operation, deviceID string) bool {
	return stored.DeviceID == deviceID && stored.TaskID == submitted.TaskID && stored.Type == submitted.Type && stored.Title == submitted.Title &&
		stored.OccurredAt.Equal(submitted.OccurredAt) && stored.HLCWallMs == submitted.HLCWallMs && stored.HLCCounter == submitted.HLCCounter
}

func sameDurationOperation(stored, submitted DurationOperation, deviceID string) bool {
	return stored.DeviceID == deviceID && stored.Phase == submitted.Phase && stored.DurationMs == submitted.DurationMs &&
		stored.OccurredAt.Equal(submitted.OccurredAt) && stored.HLCWallMs == submitted.HLCWallMs && stored.HLCCounter == submitted.HLCCounter
}

func sameAutoStartOperation(stored, submitted AutoStartOperation, deviceID string) bool {
	return stored.DeviceID == deviceID && stored.Enabled == submitted.Enabled && stored.OccurredAt.Equal(submitted.OccurredAt) &&
		stored.HLCWallMs == submitted.HLCWallMs && stored.HLCCounter == submitted.HLCCounter
}

func sameSelectedTaskOperation(stored, submitted SelectedTaskOperation, deviceID string) bool {
	return stored.DeviceID == deviceID && equalStringPointers(stored.TaskID, submitted.TaskID) && stored.OccurredAt.Equal(submitted.OccurredAt) &&
		stored.HLCWallMs == submitted.HLCWallMs && stored.HLCCounter == submitted.HLCCounter
}

func (s *Store) History(ctx context.Context, db *sql.DB, userID string, now time.Time) ([]timer.HistoryItem, int64, bool, error) {
	result, err := s.materializeProjection(ctx, db, userID, now)
	if err != nil {
		return nil, 0, false, err
	}
	return result.History, result.Revision, result.Changed, nil
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type databaseQueryer interface {
	queryer
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadCommands(ctx context.Context, source queryer) ([]timer.Command, error) {
	rows, err := source.QueryContext(ctx, `SELECT id, device_id, device_sequence, timer_id, task_id, command_type, phase,
		planned_duration_ms, occurred_at, hlc_wall_ms, hlc_counter, observed_elapsed_ms
	FROM timer_commands ORDER BY hlc_wall_ms, hlc_counter, device_id, id`)
	if err != nil {
		return nil, fmt.Errorf("read timer commands: %w", err)
	}
	defer rows.Close()
	var commands []timer.Command
	for rows.Next() {
		var command timer.Command
		var occurredAt string
		var taskID sql.NullString
		if err := rows.Scan(&command.ID, &command.DeviceID, &command.DeviceSequence, &command.TimerID, &taskID,
			&command.Type, &command.Phase, &command.PlannedDurationMs, &occurredAt, &command.HLCWallMs, &command.HLCCounter,
			&command.ObservedElapsedMs); err != nil {
			return nil, fmt.Errorf("scan timer command: %w", err)
		}
		command.TaskID = taskID.String
		command.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
		if err != nil {
			return nil, fmt.Errorf("parse stored command timestamp: %w", err)
		}
		commands = append(commands, command)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate timer commands: %w", err)
	}
	return commands, nil
}

func loadTaskOperations(ctx context.Context, source queryer) ([]task.Operation, error) {
	rows, err := source.QueryContext(ctx, `SELECT id, device_id, task_id, operation_type, title, occurred_at, hlc_wall_ms, hlc_counter
		FROM task_operations ORDER BY hlc_wall_ms, hlc_counter, device_id, id`)
	if err != nil {
		return nil, fmt.Errorf("read task operations: %w", err)
	}
	defer rows.Close()
	var operations []task.Operation
	for rows.Next() {
		var operation task.Operation
		var occurredAt string
		if err := rows.Scan(&operation.ID, &operation.DeviceID, &operation.TaskID, &operation.Type, &operation.Title,
			&occurredAt, &operation.HLCWallMs, &operation.HLCCounter); err != nil {
			return nil, fmt.Errorf("scan task operation: %w", err)
		}
		operation.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
		if err != nil {
			return nil, fmt.Errorf("parse stored task operation timestamp: %w", err)
		}
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate task operations: %w", err)
	}
	return operations, nil
}

func reduceTasks(operations []task.Operation) ([]task.Task, map[string]string) {
	winners := make(map[string]task.Operation)
	for _, operation := range operations {
		winners[operation.TaskID] = operation
	}
	tasks := make([]task.Task, 0, len(winners))
	winningIDs := make(map[string]string, len(winners))
	for taskID, operation := range winners {
		winningIDs[taskID] = operation.ID
		if operation.Type == "upsert" {
			tasks = append(tasks, task.Task{ID: taskID, Title: operation.Title})
		}
	}
	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].Title != tasks[j].Title {
			return tasks[i].Title < tasks[j].Title
		}
		return tasks[i].ID < tasks[j].ID
	})
	return tasks, winningIDs
}

func loadDurationOperations(ctx context.Context, source queryer) ([]DurationOperation, error) {
	rows, err := source.QueryContext(ctx, `SELECT id, device_id, phase, duration_ms, occurred_at, hlc_wall_ms, hlc_counter
		FROM duration_operations ORDER BY phase, hlc_wall_ms, hlc_counter, device_id, id`)
	if err != nil {
		return nil, fmt.Errorf("read duration operations: %w", err)
	}
	defer rows.Close()
	var operations []DurationOperation
	for rows.Next() {
		var operation DurationOperation
		var occurredAt string
		if err := rows.Scan(&operation.ID, &operation.DeviceID, &operation.Phase, &operation.DurationMs,
			&occurredAt, &operation.HLCWallMs, &operation.HLCCounter); err != nil {
			return nil, fmt.Errorf("scan duration operation: %w", err)
		}
		operation.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
		if err != nil {
			return nil, fmt.Errorf("parse stored duration operation timestamp: %w", err)
		}
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate duration operations: %w", err)
	}
	return operations, nil
}

func reduceDurations(operations []DurationOperation) (DurationsMs, map[string]struct{}) {
	durations := DurationsMs{Focus: 1_500_000, ShortBreak: 300_000, LongBreak: 900_000}
	winnersByPhase := make(map[string]string, 3)
	for _, operation := range operations {
		winnersByPhase[operation.Phase] = operation.ID
		switch operation.Phase {
		case "focus":
			durations.Focus = operation.DurationMs
		case "short_break":
			durations.ShortBreak = operation.DurationMs
		case "long_break":
			durations.LongBreak = operation.DurationMs
		}
	}
	winners := make(map[string]struct{}, len(winnersByPhase))
	for _, operationID := range winnersByPhase {
		winners[operationID] = struct{}{}
	}
	return durations, winners
}

func loadAutoStartOperations(ctx context.Context, source queryer) ([]AutoStartOperation, error) {
	rows, err := source.QueryContext(ctx, `SELECT id, device_id, enabled, occurred_at, hlc_wall_ms, hlc_counter
		FROM auto_start_operations ORDER BY hlc_wall_ms, hlc_counter, device_id, id`)
	if err != nil {
		return nil, fmt.Errorf("read auto-start operations: %w", err)
	}
	defer rows.Close()
	var operations []AutoStartOperation
	for rows.Next() {
		var operation AutoStartOperation
		var occurredAt string
		if err := rows.Scan(&operation.ID, &operation.DeviceID, &operation.Enabled, &occurredAt, &operation.HLCWallMs, &operation.HLCCounter); err != nil {
			return nil, fmt.Errorf("scan auto-start operation: %w", err)
		}
		operation.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
		if err != nil {
			return nil, fmt.Errorf("parse stored auto-start operation timestamp: %w", err)
		}
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate auto-start operations: %w", err)
	}
	return operations, nil
}

func reduceAutoStart(operations []AutoStartOperation) (bool, string) {
	if len(operations) == 0 {
		return false, ""
	}
	winner := operations[len(operations)-1]
	return winner.Enabled, winner.ID
}

func loadSelectedTaskOperations(ctx context.Context, source queryer) ([]SelectedTaskOperation, error) {
	rows, err := source.QueryContext(ctx, `SELECT id, device_id, task_id, occurred_at, hlc_wall_ms, hlc_counter
		FROM selected_task_operations ORDER BY hlc_wall_ms, hlc_counter, device_id, id`)
	if err != nil {
		return nil, fmt.Errorf("read selected-task operations: %w", err)
	}
	defer rows.Close()
	var operations []SelectedTaskOperation
	for rows.Next() {
		var operation SelectedTaskOperation
		var occurredAt string
		var taskID sql.NullString
		if err := rows.Scan(&operation.ID, &operation.DeviceID, &taskID, &occurredAt, &operation.HLCWallMs, &operation.HLCCounter); err != nil {
			return nil, fmt.Errorf("scan selected-task operation: %w", err)
		}
		operation.TaskID = stringPointer(taskID)
		operation.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
		if err != nil {
			return nil, fmt.Errorf("parse stored selected-task operation timestamp: %w", err)
		}
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate selected-task operations: %w", err)
	}
	return operations, nil
}

func reduceSelectedTask(operations []SelectedTaskOperation, tasks []task.Task) (*string, string) {
	if len(operations) == 0 {
		return nil, ""
	}
	winner := operations[len(operations)-1]
	if winner.TaskID == nil {
		return nil, winner.ID
	}
	for _, current := range tasks {
		if current.ID == *winner.TaskID {
			selectedTaskID := *winner.TaskID
			return &selectedTaskID, winner.ID
		}
	}
	return nil, winner.ID
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func stringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func equalStringPointers(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func nonNilHistory(history []timer.HistoryItem) []timer.HistoryItem {
	if history == nil {
		return []timer.HistoryItem{}
	}
	return history
}
