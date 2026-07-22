package store

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

const (
	BootstrapKeepRemote    = "keep_remote"
	BootstrapReplaceRemote = "replace_remote"
	BootstrapMerge         = "merge"
)

type BootstrapResolutionRequest struct {
	RequestID          string
	DeviceID           string
	ExpectedRevision   int64
	Strategy           string
	Commands           []timer.Command
	TaskOperations     []task.Operation
	DurationOperations []DurationOperation
}

func (s *Store) Bootstrap(ctx context.Context, db *sql.DB, userID string, now time.Time) (SyncResult, error) {
	unlock := s.LockUser(userID)
	defer unlock()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SyncResult{}, fmt.Errorf("begin bootstrap snapshot: %w", err)
	}
	defer tx.Rollback()
	reduction, err := reduceAccount(ctx, tx, now)
	if err != nil {
		return SyncResult{}, err
	}
	result := resultFromReduction(reduction, reduction.revision, now, nil)
	if err := tx.Commit(); err != nil {
		return SyncResult{}, fmt.Errorf("commit bootstrap snapshot: %w", err)
	}
	return result, nil
}

func (s *Store) ResolveBootstrap(ctx context.Context, db *sql.DB, userID string, request BootstrapResolutionRequest, now time.Time) (SyncResult, error) {
	syncRequest := SyncRequest{
		DeviceID:           request.DeviceID,
		Commands:           request.Commands,
		TaskOperations:     request.TaskOperations,
		DurationOperations: request.DurationOperations,
	}
	if err := validateUniqueOperationIDs(syncRequest); err != nil {
		return SyncResult{}, err
	}
	if request.Strategy != BootstrapKeepRemote && request.Strategy != BootstrapReplaceRemote && request.Strategy != BootstrapMerge {
		return SyncResult{}, fmt.Errorf("invalid bootstrap strategy %q", request.Strategy)
	}
	if request.Strategy == BootstrapKeepRemote && (len(request.Commands) != 0 || len(request.TaskOperations) != 0 || len(request.DurationOperations) != 0) {
		return SyncResult{}, errors.New("keep_remote requires empty operation arrays")
	}
	payloadHash, err := bootstrapPayloadHash(request)
	if err != nil {
		return SyncResult{}, err
	}

	unlock := s.LockUser(userID)
	defer unlock()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return SyncResult{}, fmt.Errorf("begin bootstrap resolution: %w", err)
	}
	defer tx.Rollback()

	var storedHash []byte
	var storedResponse string
	err = tx.QueryRowContext(ctx, `SELECT payload_hash, response_json FROM bootstrap_resolutions WHERE request_id = ?`, request.RequestID).Scan(&storedHash, &storedResponse)
	if err == nil {
		if subtle.ConstantTimeCompare(storedHash, payloadHash[:]) != 1 {
			return SyncResult{}, ErrRequestIDConflict
		}
		var result SyncResult
		if err := json.Unmarshal([]byte(storedResponse), &result); err != nil {
			return SyncResult{}, fmt.Errorf("decode stored bootstrap response: %w", err)
		}
		return result, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return SyncResult{}, fmt.Errorf("read bootstrap resolution: %w", err)
	}

	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		return SyncResult{}, fmt.Errorf("read account revision: %w", err)
	}
	if revision != request.ExpectedRevision {
		return SyncResult{}, ErrRevisionConflict
	}

	var before accountReduction
	if request.Strategy == BootstrapKeepRemote || request.Strategy == BootstrapReplaceRemote {
		before, err = reduceAccount(ctx, tx, now)
		if err != nil {
			return SyncResult{}, err
		}
	}
	application := operationApplication{}
	if request.Strategy == BootstrapReplaceRemote {
		if err := clearForBootstrapReplacement(ctx, tx); err != nil {
			return SyncResult{}, err
		}
	}
	if request.Strategy != BootstrapKeepRemote {
		application, err = applyOperations(ctx, tx, syncRequest)
		if err != nil {
			return SyncResult{}, err
		}
	}

	reduction := before
	if request.Strategy != BootstrapKeepRemote {
		reduction, err = reduceAccount(ctx, tx, now)
		if err != nil {
			return SyncResult{}, err
		}
	}
	changed := application.changed
	if request.Strategy == BootstrapReplaceRemote {
		changed = !slices.Equal(before.commands, reduction.commands) ||
			!slices.Equal(before.taskOperations, reduction.taskOperations) ||
			!slices.Equal(before.durationOperations, reduction.durationOperations)
	}
	if changed {
		revision++
	}
	if request.Strategy == BootstrapReplaceRemote || (request.Strategy == BootstrapMerge && changed) {
		if err := persistReduction(ctx, tx, reduction, revision); err != nil {
			return SyncResult{}, err
		}
	}

	result := resultFromReduction(reduction, revision, now, &syncRequest)
	if request.Strategy != BootstrapKeepRemote {
		addAcknowledgements(&result, syncRequest, application, reduction)
	}
	result.Changed = changed
	responseJSON, err := json.Marshal(result)
	if err != nil {
		return SyncResult{}, fmt.Errorf("encode bootstrap response: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO bootstrap_resolutions(request_id, payload_hash, response_json, created_at_ms)
		VALUES (?, ?, ?, ?)`, request.RequestID, payloadHash[:], string(responseJSON), now.UnixMilli()); err != nil {
		return SyncResult{}, fmt.Errorf("record bootstrap resolution: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return SyncResult{}, fmt.Errorf("commit bootstrap resolution: %w", err)
	}
	return result, nil
}

func clearForBootstrapReplacement(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO maintenance_flags(name) VALUES ('bootstrap_replace')`); err != nil {
		return fmt.Errorf("enable bootstrap replacement: %w", err)
	}
	for _, deletion := range []struct {
		query string
		name  string
	}{
		{query: `DELETE FROM command_outcomes`, name: "command outcomes"},
		{query: `DELETE FROM timer_sessions`, name: "timer projection"},
		{query: `DELETE FROM timer_commands`, name: "timer commands"},
		{query: `DELETE FROM task_operations`, name: "task operations"},
		{query: `DELETE FROM duration_operations`, name: "duration operations"},
	} {
		if _, err := tx.ExecContext(ctx, deletion.query); err != nil {
			return fmt.Errorf("clear %s for bootstrap replacement: %w", deletion.name, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE account_state SET current_timer_id = NULL WHERE singleton = 1`); err != nil {
		return fmt.Errorf("clear account timer projection for bootstrap replacement: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM maintenance_flags WHERE name = 'bootstrap_replace'`); err != nil {
		return fmt.Errorf("disable bootstrap replacement: %w", err)
	}
	return nil
}

func bootstrapPayloadHash(request BootstrapResolutionRequest) ([sha256.Size]byte, error) {
	commands := make([]timer.Command, len(request.Commands))
	copy(commands, request.Commands)
	for index := range commands {
		commands[index].DeviceID = request.DeviceID
		commands[index].OccurredAt = commands[index].OccurredAt.UTC()
	}
	taskOperations := make([]task.Operation, len(request.TaskOperations))
	copy(taskOperations, request.TaskOperations)
	for index := range taskOperations {
		taskOperations[index].DeviceID = request.DeviceID
		taskOperations[index].OccurredAt = taskOperations[index].OccurredAt.UTC()
	}
	durationOperations := make([]DurationOperation, len(request.DurationOperations))
	copy(durationOperations, request.DurationOperations)
	for index := range durationOperations {
		durationOperations[index].DeviceID = request.DeviceID
		durationOperations[index].OccurredAt = durationOperations[index].OccurredAt.UTC()
	}
	normalized := struct {
		DeviceID           string
		ExpectedRevision   int64
		Strategy           string
		Commands           []timer.Command
		TaskOperations     []task.Operation
		DurationOperations []DurationOperation
	}{
		DeviceID: request.DeviceID, ExpectedRevision: request.ExpectedRevision, Strategy: request.Strategy,
		Commands: commands, TaskOperations: taskOperations, DurationOperations: durationOperations,
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("encode normalized bootstrap request: %w", err)
	}
	return sha256.Sum256(encoded), nil
}
