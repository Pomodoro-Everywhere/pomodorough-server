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
	RequestID                     string
	DeviceID                      string
	ExpectedRevision              int64
	Strategy                      string
	Commands                      []timer.Command
	TaskOperations                []task.Operation
	DurationOperations            []DurationOperation
	AutoStartOperations           []AutoStartOperation
	AutoStartOperationsPresent    bool
	SelectedTaskOperations        []SelectedTaskOperation
	SelectedTaskOperationsPresent bool
}

func (s *Store) Bootstrap(ctx context.Context, db *sql.DB, userID string, now time.Time) (SyncResult, error) {
	return s.materializeProjection(ctx, db, userID, now)
}

func (s *Store) BootstrapForGeneration(ctx context.Context, userID string, generation int64, now time.Time) (SyncResult, error) {
	return s.materializeProjectionForGeneration(ctx, userID, generation, now)
}

func (s *Store) ResolveBootstrap(ctx context.Context, db *sql.DB, userID string, request BootstrapResolutionRequest, now time.Time) (SyncResult, error) {
	unlock := s.LockUser(userID)
	defer unlock()
	return s.resolveBootstrapLocked(ctx, db, request, now)
}

func (s *Store) ResolveBootstrapForGeneration(ctx context.Context, userID string, generation int64, request BootstrapResolutionRequest, now time.Time) (SyncResult, error) {
	return withAccountGeneration(s, ctx, userID, generation, func(db *sql.DB) (SyncResult, error) {
		return s.resolveBootstrapLocked(ctx, db, request, now)
	})
}

func (s *Store) resolveBootstrapLocked(ctx context.Context, db *sql.DB, request BootstrapResolutionRequest, now time.Time) (SyncResult, error) {
	syncRequest, payloadHash, err := validateBootstrapResolutionRequest(request)
	if err != nil {
		return SyncResult{}, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return SyncResult{}, fmt.Errorf("begin bootstrap resolution: %w", err)
	}
	defer tx.Rollback()

	stored, found, err := lookupStoredBootstrapResponse(ctx, tx, request, payloadHash)
	if err != nil {
		return SyncResult{}, err
	}
	if found {
		return stored, nil
	}
	revision, err := bootstrapRevisionForRequest(ctx, tx, request.ExpectedRevision)
	if err != nil {
		return SyncResult{}, err
	}
	application, err := applyBootstrapStrategy(ctx, tx, request, syncRequest, now)
	if err != nil {
		return SyncResult{}, err
	}
	revision, changed, err := persistBootstrapApplication(ctx, tx, request.Strategy, application, revision)
	if err != nil {
		return SyncResult{}, err
	}
	return recordBootstrapResponse(ctx, tx, request, syncRequest, application, revision, changed, payloadHash, now)
}

func validateBootstrapResolutionRequest(request BootstrapResolutionRequest) (SyncRequest, [sha256.Size]byte, error) {
	syncRequest := SyncRequest{
		DeviceID:               request.DeviceID,
		Commands:               request.Commands,
		TaskOperations:         request.TaskOperations,
		DurationOperations:     request.DurationOperations,
		AutoStartOperations:    request.AutoStartOperations,
		SelectedTaskOperations: request.SelectedTaskOperations,
	}
	if err := validateUniqueOperationIDs(syncRequest); err != nil {
		return SyncRequest{}, [sha256.Size]byte{}, err
	}
	if request.Strategy != BootstrapKeepRemote && request.Strategy != BootstrapReplaceRemote && request.Strategy != BootstrapMerge {
		return SyncRequest{}, [sha256.Size]byte{}, fmt.Errorf("invalid bootstrap strategy %q", request.Strategy)
	}
	if request.Strategy == BootstrapKeepRemote && (len(request.Commands) != 0 || len(request.TaskOperations) != 0 || len(request.DurationOperations) != 0 || len(request.AutoStartOperations) != 0 || len(request.SelectedTaskOperations) != 0) {
		return SyncRequest{}, [sha256.Size]byte{}, errors.New("keep_remote requires empty operation arrays")
	}
	payloadHash, err := bootstrapPayloadHash(request)
	if err != nil {
		return SyncRequest{}, [sha256.Size]byte{}, err
	}
	return syncRequest, payloadHash, nil
}

func lookupStoredBootstrapResponse(ctx context.Context, tx *sql.Tx, request BootstrapResolutionRequest, payloadHash [sha256.Size]byte) (SyncResult, bool, error) {
	var storedHash []byte
	var storedResponse string
	err := tx.QueryRowContext(ctx, `SELECT payload_hash, response_json FROM bootstrap_resolutions WHERE request_id = ?`, request.RequestID).Scan(&storedHash, &storedResponse)
	if errors.Is(err, sql.ErrNoRows) {
		return SyncResult{}, false, nil
	}
	if err != nil {
		return SyncResult{}, false, fmt.Errorf("read bootstrap resolution: %w", err)
	}
	hashMatches, err := storedBootstrapPayloadMatches(storedHash, payloadHash, request)
	if err != nil {
		return SyncResult{}, false, err
	}
	if !hashMatches {
		return SyncResult{}, false, ErrRequestIDConflict
	}
	var result SyncResult
	if err := json.Unmarshal([]byte(storedResponse), &result); err != nil {
		return SyncResult{}, false, fmt.Errorf("decode stored bootstrap response: %w", err)
	}
	if err := validateCanonicalRevision(result.Revision); err != nil {
		return SyncResult{}, false, err
	}
	result, err = normalizeStoredSyncResult(result)
	return result, true, err
}

func storedBootstrapPayloadMatches(storedHash []byte, payloadHash [sha256.Size]byte, request BootstrapResolutionRequest) (bool, error) {
	if subtle.ConstantTimeCompare(storedHash, payloadHash[:]) == 1 {
		return true, nil
	}
	if !request.SelectedTaskOperationsPresent {
		previousHash, err := previousBootstrapPayloadHash(request)
		if err != nil {
			return false, err
		}
		if subtle.ConstantTimeCompare(storedHash, previousHash[:]) == 1 {
			return true, nil
		}
	}
	if !request.AutoStartOperationsPresent && !request.SelectedTaskOperationsPresent {
		legacyHash, err := legacyBootstrapPayloadHash(request)
		if err != nil {
			return false, err
		}
		return subtle.ConstantTimeCompare(storedHash, legacyHash[:]) == 1, nil
	}
	return false, nil
}

func bootstrapRevisionForRequest(ctx context.Context, tx *sql.Tx, expectedRevision int64) (int64, error) {
	var revision int64
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil {
		return 0, fmt.Errorf("read account revision: %w", err)
	}
	if err := validateCanonicalRevision(revision); err != nil {
		return 0, err
	}
	if revision != expectedRevision {
		return 0, ErrRevisionConflict
	}
	return revision, nil
}

type bootstrapStrategyApplication struct {
	operations operationApplication
	before     accountReduction
	reduction  accountReduction
}

func applyBootstrapStrategy(ctx context.Context, tx *sql.Tx, request BootstrapResolutionRequest, syncRequest SyncRequest, now time.Time) (bootstrapStrategyApplication, error) {
	var before accountReduction
	var err error
	if request.Strategy == BootstrapKeepRemote || request.Strategy == BootstrapReplaceRemote {
		before, err = reduceAccount(ctx, tx, now)
		if err != nil {
			return bootstrapStrategyApplication{}, err
		}
	}
	application := operationApplication{}
	if request.Strategy == BootstrapReplaceRemote {
		if err := clearForBootstrapReplacement(ctx, tx, request.AutoStartOperationsPresent, request.SelectedTaskOperationsPresent); err != nil {
			return bootstrapStrategyApplication{}, err
		}
	}
	if request.Strategy != BootstrapKeepRemote {
		application, err = applyOperations(ctx, tx, syncRequest)
		if err != nil {
			return bootstrapStrategyApplication{}, err
		}
	}
	reduction := before
	if request.Strategy != BootstrapKeepRemote {
		reduction, err = reduceAccount(ctx, tx, now)
		if err != nil {
			return bootstrapStrategyApplication{}, err
		}
	}
	return bootstrapStrategyApplication{operations: application, before: before, reduction: reduction}, nil
}

func persistBootstrapApplication(ctx context.Context, tx *sql.Tx, strategy string, application bootstrapStrategyApplication, revision int64) (int64, bool, error) {
	projectionChanged, err := timerProjectionChanged(ctx, tx, application.reduction.timer)
	if err != nil {
		return 0, false, err
	}
	changed := application.operations.changed
	if strategy == BootstrapReplaceRemote {
		changed = !slices.Equal(application.before.commands, application.reduction.commands) ||
			!slices.Equal(application.before.taskOperations, application.reduction.taskOperations) ||
			!slices.Equal(application.before.durationOperations, application.reduction.durationOperations) ||
			!slices.Equal(application.before.autoStartOperations, application.reduction.autoStartOperations) ||
			!equalSelectedTaskOperations(application.before.selectedTaskOperations, application.reduction.selectedTaskOperations)
	}
	changed = changed || projectionChanged
	if changed {
		revision, err = safeRevisionIncrement(revision)
		if err != nil {
			return 0, false, err
		}
	}
	if changed {
		if err := persistReduction(ctx, tx, application.reduction, revision); err != nil {
			return 0, false, err
		}
	}
	return revision, changed, nil
}

func recordBootstrapResponse(ctx context.Context, tx *sql.Tx, request BootstrapResolutionRequest, syncRequest SyncRequest, application bootstrapStrategyApplication, revision int64, changed bool, payloadHash [sha256.Size]byte, now time.Time) (SyncResult, error) {
	result, err := resultFromReduction(ctx, application.reduction, revision, now, &syncRequest)
	if err != nil {
		return SyncResult{}, err
	}
	if request.Strategy != BootstrapKeepRemote {
		addAcknowledgements(&result, syncRequest, application.operations, application.reduction)
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

func clearForBootstrapReplacement(ctx context.Context, tx *sql.Tx, clearAutoStart, clearSelectedTask bool) error {
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
	if clearAutoStart {
		if _, err := tx.ExecContext(ctx, `DELETE FROM auto_start_operations`); err != nil {
			return fmt.Errorf("clear auto-start operations for bootstrap replacement: %w", err)
		}
	}
	if clearSelectedTask {
		if _, err := tx.ExecContext(ctx, `DELETE FROM selected_task_operations`); err != nil {
			return fmt.Errorf("clear selected-task operations for bootstrap replacement: %w", err)
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
	commands, taskOperations, durationOperations := normalizedBootstrapCore(request)
	autoStartOperations := make([]AutoStartOperation, len(request.AutoStartOperations))
	copy(autoStartOperations, request.AutoStartOperations)
	for index := range autoStartOperations {
		autoStartOperations[index].DeviceID = request.DeviceID
		autoStartOperations[index].OccurredAt = autoStartOperations[index].OccurredAt.UTC()
	}
	selectedTaskOperations := make([]SelectedTaskOperation, len(request.SelectedTaskOperations))
	copy(selectedTaskOperations, request.SelectedTaskOperations)
	for index := range selectedTaskOperations {
		selectedTaskOperations[index].DeviceID = request.DeviceID
		selectedTaskOperations[index].OccurredAt = selectedTaskOperations[index].OccurredAt.UTC()
	}
	normalized := struct {
		DeviceID                      string
		ExpectedRevision              int64
		Strategy                      string
		Commands                      []timer.Command
		TaskOperations                []task.Operation
		DurationOperations            []DurationOperation
		AutoStartOperations           []AutoStartOperation
		AutoStartOperationsPresent    bool
		SelectedTaskOperations        []SelectedTaskOperation
		SelectedTaskOperationsPresent bool
	}{
		DeviceID: request.DeviceID, ExpectedRevision: request.ExpectedRevision, Strategy: request.Strategy,
		Commands: commands, TaskOperations: taskOperations, DurationOperations: durationOperations,
		AutoStartOperations: autoStartOperations, AutoStartOperationsPresent: request.AutoStartOperationsPresent,
		SelectedTaskOperations: selectedTaskOperations, SelectedTaskOperationsPresent: request.SelectedTaskOperationsPresent,
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("encode normalized bootstrap request: %w", err)
	}
	return sha256.Sum256(encoded), nil
}

func previousBootstrapPayloadHash(request BootstrapResolutionRequest) ([sha256.Size]byte, error) {
	commands, taskOperations, durationOperations := normalizedBootstrapCore(request)
	autoStartOperations := make([]AutoStartOperation, len(request.AutoStartOperations))
	copy(autoStartOperations, request.AutoStartOperations)
	for index := range autoStartOperations {
		autoStartOperations[index].DeviceID = request.DeviceID
		autoStartOperations[index].OccurredAt = autoStartOperations[index].OccurredAt.UTC()
	}
	normalized := struct {
		DeviceID                   string
		ExpectedRevision           int64
		Strategy                   string
		Commands                   []timer.Command
		TaskOperations             []task.Operation
		DurationOperations         []DurationOperation
		AutoStartOperations        []AutoStartOperation
		AutoStartOperationsPresent bool
	}{
		DeviceID: request.DeviceID, ExpectedRevision: request.ExpectedRevision, Strategy: request.Strategy,
		Commands: commands, TaskOperations: taskOperations, DurationOperations: durationOperations,
		AutoStartOperations: autoStartOperations, AutoStartOperationsPresent: request.AutoStartOperationsPresent,
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("encode previous normalized bootstrap request: %w", err)
	}
	return sha256.Sum256(encoded), nil
}

func normalizedBootstrapCore(request BootstrapResolutionRequest) ([]timer.Command, []task.Operation, []DurationOperation) {
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
	return commands, taskOperations, durationOperations
}

func equalSelectedTaskOperations(left, right []SelectedTaskOperation) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index].ID != right[index].ID || left[index].DeviceID != right[index].DeviceID ||
			!equalStringPointers(left[index].TaskID, right[index].TaskID) || !left[index].OccurredAt.Equal(right[index].OccurredAt) ||
			left[index].HLCWallMs != right[index].HLCWallMs || left[index].HLCCounter != right[index].HLCCounter {
			return false
		}
	}
	return true
}

func legacyBootstrapPayloadHash(request BootstrapResolutionRequest) ([sha256.Size]byte, error) {
	commands, taskOperations, durationOperations := normalizedBootstrapCore(request)
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
		return [sha256.Size]byte{}, fmt.Errorf("encode legacy normalized bootstrap request: %w", err)
	}
	return sha256.Sum256(encoded), nil
}
