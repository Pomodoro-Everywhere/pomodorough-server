package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pomodorough/internal/timer"
)

type SyncRequest struct {
	DeviceID     string
	LastRevision int64
	Commands     []timer.Command
}

type Acknowledgement struct {
	CommandID string `json:"commandId"`
	Outcome   string `json:"outcome"`
	Reason    string `json:"reason"`
}

type SyncResult struct {
	Acknowledgements []Acknowledgement     `json:"acknowledgements"`
	Revision         int64                 `json:"revision"`
	CanonicalTimer   *timer.CanonicalTimer `json:"canonicalTimer"`
	History          []timer.HistoryItem   `json:"history"`
	ServerTime       string                `json:"serverTime"`
	ServerHLCWallMs  int64                 `json:"serverHlcWallMs"`
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
			id, device_id, device_sequence, timer_id, command_type, phase, planned_duration_ms,
			occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter, observed_elapsed_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			command.ID, request.DeviceID, command.DeviceSequence, command.TimerID, command.Type, command.Phase,
			command.PlannedDurationMs, command.OccurredAt.UTC().Format(time.RFC3339Nano), command.OccurredAt.UnixMilli(),
			command.HLCWallMs, command.HLCCounter, command.ObservedElapsedMs,
		)
		if err != nil {
			return SyncResult{}, fmt.Errorf("insert timer command: %w", err)
		}
		newCommands = true
	}

	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		return SyncResult{}, fmt.Errorf("read account revision: %w", err)
	}
	if newCommands {
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
			timer_id, phase, status, planned_duration_ms, elapsed_at_anchor_ms, anchor_at_ms, started_at_ms,
			ended_at_ms, last_command_id, terminal_command_id, superseded_by_timer_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			session.TimerID, session.Phase, session.Status, session.PlannedDurationMs, session.ElapsedAtAnchorMs,
			session.AnchorAt.UnixMilli(), session.StartedAt.UnixMilli(), unixMilli(session.EndedAt), session.LastCommandID,
			nullString(session.TerminalCommandID), nullString(session.SupersededByTimerID),
		); err != nil {
			return SyncResult{}, fmt.Errorf("save timer projection: %w", err)
		}
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
	return SyncResult{
		Acknowledgements: acknowledgements,
		Revision:         revision,
		CanonicalTimer:   reduced.Canonical,
		History:          nonNilHistory(reduced.History),
		ServerTime:       now.UTC().Format(time.RFC3339Nano),
		ServerHLCWallMs:  now.UnixMilli(),
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
	rows, err := source.QueryContext(ctx, `SELECT id, device_id, device_sequence, timer_id, command_type, phase,
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
		if err := rows.Scan(&command.ID, &command.DeviceID, &command.DeviceSequence, &command.TimerID, &command.Type,
			&command.Phase, &command.PlannedDurationMs, &occurredAt, &command.HLCWallMs, &command.HLCCounter,
			&command.ObservedElapsedMs); err != nil {
			return nil, fmt.Errorf("scan timer command: %w", err)
		}
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
