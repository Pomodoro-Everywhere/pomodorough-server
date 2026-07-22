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
	DeviceID           string
	LastRevision       int64
	Commands           []timer.Command
	TaskOperations     []task.Operation
	DurationOperations []DurationOperation
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

type DurationsMs struct {
	Focus      int64 `json:"focus"`
	ShortBreak int64 `json:"short_break"`
	LongBreak  int64 `json:"long_break"`
}

type SyncResult struct {
	Acknowledgements         []Acknowledgement         `json:"acknowledgements"`
	TaskAcknowledgements     []TaskAcknowledgement     `json:"taskAcknowledgements"`
	DurationAcknowledgements []DurationAcknowledgement `json:"durationAcknowledgements"`
	Revision                 int64                     `json:"revision"`
	CanonicalTimer           *timer.CanonicalTimer     `json:"canonicalTimer"`
	History                  []timer.HistoryItem       `json:"history"`
	Tasks                    []task.Task               `json:"tasks"`
	DurationsMs              DurationsMs               `json:"durationsMs"`
	ServerTime               string                    `json:"serverTime"`
	ServerHLCWallMs          int64                     `json:"serverHlcWallMs"`
	ServerHLCCounter         int64                     `json:"serverHlcCounter"`
	Changed                  bool                      `json:"-"`
}

func (s *Store) Sync(ctx context.Context, db *sql.DB, userID string, request SyncRequest, now time.Time) (SyncResult, error) {
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

	rejections := make(map[string]timer.Outcome)
	newCommands := false
	for _, command := range request.Commands {
		var existingID string
		err := tx.QueryRowContext(ctx, `SELECT id FROM timer_commands WHERE id = ?`, command.ID).Scan(&existingID)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return SyncResult{}, fmt.Errorf("check command id: %w", err)
		}
		err = tx.QueryRowContext(ctx, `SELECT id FROM timer_commands WHERE device_id = ? AND device_sequence = ?`, request.DeviceID, command.DeviceSequence).Scan(&existingID)
		if err == nil {
			rejections[command.ID] = timer.Outcome{Outcome: "rejected", Reason: "device sequence already used"}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return SyncResult{}, fmt.Errorf("check device sequence: %w", err)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO timer_commands(
			id, device_id, device_sequence, timer_id, task_id, command_type, phase, planned_duration_ms,
			occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter, observed_elapsed_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			command.ID, request.DeviceID, command.DeviceSequence, command.TimerID, nullString(command.TaskID), command.Type, command.Phase,
			command.PlannedDurationMs, command.OccurredAt.UTC().Format(time.RFC3339Nano), command.OccurredAt.UnixMilli(),
			command.HLCWallMs, command.HLCCounter, command.ObservedElapsedMs,
		)
		if err != nil {
			return SyncResult{}, fmt.Errorf("insert timer command: %w", err)
		}
		newCommands = true
	}
	newTaskOperations := false
	for _, operation := range request.TaskOperations {
		var existingID string
		err := tx.QueryRowContext(ctx, `SELECT id FROM task_operations WHERE id = ?`, operation.ID).Scan(&existingID)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return SyncResult{}, fmt.Errorf("check task operation id: %w", err)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO task_operations(
			id, device_id, task_id, operation_type, title, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, operation.ID, request.DeviceID, operation.TaskID, operation.Type,
			operation.Title, operation.OccurredAt.UTC().Format(time.RFC3339Nano), operation.OccurredAt.UnixMilli(), operation.HLCWallMs, operation.HLCCounter)
		if err != nil {
			return SyncResult{}, fmt.Errorf("insert task operation: %w", err)
		}
		newTaskOperations = true
	}
	newDurationOperations := false
	durationRejections := make(map[string]DurationAcknowledgement)
	seenDurationOperationIDs := make(map[string]struct{}, len(request.DurationOperations))
	for _, operation := range request.DurationOperations {
		if _, duplicate := seenDurationOperationIDs[operation.ID]; duplicate {
			return SyncResult{}, fmt.Errorf("duplicate duration operation id %q", operation.ID)
		}
		seenDurationOperationIDs[operation.ID] = struct{}{}

		var existing DurationOperation
		var occurredAt string
		err := tx.QueryRowContext(ctx, `SELECT id, device_id, phase, duration_ms, occurred_at, hlc_wall_ms, hlc_counter
			FROM duration_operations WHERE id = ?`, operation.ID).Scan(
			&existing.ID, &existing.DeviceID, &existing.Phase, &existing.DurationMs, &occurredAt, &existing.HLCWallMs, &existing.HLCCounter,
		)
		if err == nil {
			existing.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredAt)
			if err != nil {
				return SyncResult{}, fmt.Errorf("parse stored duration operation timestamp: %w", err)
			}
			if existing.DeviceID != request.DeviceID || existing.Phase != operation.Phase || existing.DurationMs != operation.DurationMs ||
				!existing.OccurredAt.Equal(operation.OccurredAt) || existing.HLCWallMs != operation.HLCWallMs || existing.HLCCounter != operation.HLCCounter {
				durationRejections[operation.ID] = DurationAcknowledgement{
					OperationID: operation.ID,
					Outcome:     "rejected",
					Reason:      "operation ID already used with different payload",
				}
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return SyncResult{}, fmt.Errorf("check duration operation id: %w", err)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO duration_operations(
			id, device_id, phase, duration_ms, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, operation.ID, request.DeviceID, operation.Phase, operation.DurationMs,
			operation.OccurredAt.UTC().Format(time.RFC3339Nano), operation.OccurredAt.UnixMilli(), operation.HLCWallMs, operation.HLCCounter)
		if err != nil {
			return SyncResult{}, fmt.Errorf("insert duration operation: %w", err)
		}
		newDurationOperations = true
	}

	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		return SyncResult{}, fmt.Errorf("read account revision: %w", err)
	}
	if newCommands || newTaskOperations || newDurationOperations {
		revision++
	}
	commands, err := loadCommands(ctx, tx)
	if err != nil {
		return SyncResult{}, err
	}
	reduced := timer.Reduce(commands, now)
	for commandID, outcome := range reduced.Outcomes {
		if _, err := tx.ExecContext(ctx, `INSERT INTO command_outcomes(command_id, outcome, reason) VALUES (?, ?, ?)
			ON CONFLICT(command_id) DO UPDATE SET outcome = excluded.outcome, reason = excluded.reason`, commandID, outcome.Outcome, outcome.Reason); err != nil {
			return SyncResult{}, fmt.Errorf("save command outcome: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM timer_sessions`); err != nil {
		return SyncResult{}, fmt.Errorf("clear timer projection: %w", err)
	}
	for _, session := range reduced.Sessions {
		if _, err := tx.ExecContext(ctx, `INSERT INTO timer_sessions(
			timer_id, task_id, phase, status, planned_duration_ms, elapsed_at_anchor_ms, anchor_at_ms, started_at_ms,
			ended_at_ms, last_command_id, terminal_command_id, superseded_by_timer_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			session.TimerID, nullString(session.TaskID), session.Phase, session.Status, session.PlannedDurationMs, session.ElapsedAtAnchorMs,
			session.AnchorAt.UnixMilli(), session.StartedAt.UnixMilli(), unixMilli(session.EndedAt), session.LastCommandID,
			nullString(session.TerminalCommandID), nullString(session.SupersededByTimerID),
		); err != nil {
			return SyncResult{}, fmt.Errorf("save timer projection: %w", err)
		}
	}
	taskOperations, err := loadTaskOperations(ctx, tx)
	if err != nil {
		return SyncResult{}, err
	}
	tasks, winningTaskOperations := reduceTasks(taskOperations)
	durationOperations, err := loadDurationOperations(ctx, tx)
	if err != nil {
		return SyncResult{}, err
	}
	durations, winningDurationOperations := reduceDurations(durationOperations)
	serverHLCWallMs, serverHLCCounter := now.UnixMilli(), int64(0)
	observeHLC := func(wallMs, counter int64) {
		if wallMs > serverHLCWallMs || wallMs == serverHLCWallMs && counter > serverHLCCounter {
			serverHLCWallMs = wallMs
			serverHLCCounter = counter
		}
	}
	for _, command := range commands {
		observeHLC(command.HLCWallMs, command.HLCCounter)
	}
	for _, operation := range taskOperations {
		observeHLC(operation.HLCWallMs, operation.HLCCounter)
	}
	for _, operation := range durationOperations {
		observeHLC(operation.HLCWallMs, operation.HLCCounter)
	}
	for _, command := range request.Commands {
		observeHLC(command.HLCWallMs, command.HLCCounter)
	}
	for _, operation := range request.TaskOperations {
		observeHLC(operation.HLCWallMs, operation.HLCCounter)
	}
	for _, operation := range request.DurationOperations {
		observeHLC(operation.HLCWallMs, operation.HLCCounter)
	}
	var currentTimerID any
	if reduced.Canonical != nil {
		currentTimerID = reduced.Canonical.ID
	}
	if _, err := tx.ExecContext(ctx, `UPDATE account_state SET revision = ?, current_timer_id = ? WHERE singleton = 1`, revision, currentTimerID); err != nil {
		return SyncResult{}, fmt.Errorf("save account state: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return SyncResult{}, fmt.Errorf("commit sync: %w", err)
	}

	acknowledgements := make([]Acknowledgement, 0, len(request.Commands))
	for _, command := range request.Commands {
		outcome, rejected := rejections[command.ID]
		if !rejected {
			outcome = reduced.Outcomes[command.ID]
		}
		acknowledgements = append(acknowledgements, Acknowledgement{CommandID: command.ID, Outcome: outcome.Outcome, Reason: outcome.Reason})
	}
	taskAcknowledgements := make([]TaskAcknowledgement, 0, len(request.TaskOperations))
	for _, operation := range request.TaskOperations {
		acknowledgement := TaskAcknowledgement{OperationID: operation.ID, Outcome: "ignored", Reason: "superseded by newer task operation"}
		if winningTaskOperations[operation.TaskID] == operation.ID {
			acknowledgement.Outcome = "applied"
			acknowledgement.Reason = ""
		}
		taskAcknowledgements = append(taskAcknowledgements, acknowledgement)
	}
	durationAcknowledgements := make([]DurationAcknowledgement, 0, len(request.DurationOperations))
	for _, operation := range request.DurationOperations {
		if acknowledgement, rejected := durationRejections[operation.ID]; rejected {
			durationAcknowledgements = append(durationAcknowledgements, acknowledgement)
			continue
		}
		acknowledgement := DurationAcknowledgement{OperationID: operation.ID, Outcome: "ignored", Reason: "superseded by newer duration operation"}
		if _, winning := winningDurationOperations[operation.ID]; winning {
			acknowledgement.Outcome = "applied"
			acknowledgement.Reason = ""
		}
		durationAcknowledgements = append(durationAcknowledgements, acknowledgement)
	}
	return SyncResult{
		Acknowledgements:         acknowledgements,
		TaskAcknowledgements:     taskAcknowledgements,
		DurationAcknowledgements: durationAcknowledgements,
		Revision:                 revision,
		CanonicalTimer:           reduced.Canonical,
		History:                  nonNilHistory(reduced.History),
		Tasks:                    tasks,
		DurationsMs:              durations,
		ServerTime:               now.UTC().Format(time.RFC3339Nano),
		ServerHLCWallMs:          serverHLCWallMs,
		ServerHLCCounter:         serverHLCCounter,
		Changed:                  newCommands || newTaskOperations || newDurationOperations,
	}, nil
}

func History(ctx context.Context, db *sql.DB, now time.Time) ([]timer.HistoryItem, int64, error) {
	commands, err := loadCommands(ctx, db)
	if err != nil {
		return nil, 0, err
	}
	var revision int64
	if err := db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		return nil, 0, fmt.Errorf("read account revision: %w", err)
	}
	return nonNilHistory(timer.Reduce(commands, now).History), revision, nil
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
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

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nonNilHistory(history []timer.HistoryItem) []timer.HistoryItem {
	if history == nil {
		return []timer.HistoryItem{}
	}
	return history
}
