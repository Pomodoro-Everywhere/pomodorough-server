package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"time"
)

// responseHLCHeads holds the two HLC pairs of a sync result. The canonical
// head covers only operations the server ordered into the workspace: the
// persisted floor and every retained operation, which includes every accepted
// operation of the current request. It never includes the server's physical
// clock. The server head adds the request operations and the physical clock,
// so canonical <= server always holds.
type responseHLCHeads struct {
	canonical coreHLC
	server    coreHLC
}

func responseHLCHeadsWithCore(ctx context.Context, call coreJSONCall, reduction accountReduction, now time.Time, request *SyncRequest) (responseHLCHeads, error) {
	canonical, err := hlcHeadSequenceWithCore(ctx, call, 0, canonicalHLCObservations(reduction))
	if err != nil {
		return responseHLCHeads{}, err
	}
	server, err := hlcHeadSequenceWithCore(ctx, call, now.UnixMilli(), serverHLCObservations(canonical, request))
	if err != nil {
		return responseHLCHeads{}, err
	}
	return responseHLCHeads{canonical: canonical, server: server}, nil
}

func canonicalHLCObservations(reduction accountReduction) iter.Seq[coreHLC] {
	return func(yield func(coreHLC) bool) {
		if !yield(reduction.canonicalFloor) {
			return
		}
		yieldReductionClocks(reduction, yield)
	}
}

func serverHLCObservations(canonical coreHLC, request *SyncRequest) iter.Seq[coreHLC] {
	return func(yield func(coreHLC) bool) {
		if !yield(canonical) || request == nil {
			return
		}
		yieldReductionClocks(accountReduction{commands: request.Commands, taskOperations: request.TaskOperations,
			durationOperations: request.DurationOperations, autoStartOperations: request.AutoStartOperations,
			selectedTaskOperations: request.SelectedTaskOperations}, yield)
	}
}

func hlcAfter(left, right coreHLC) bool {
	return left.WallMs > right.WallMs || left.WallMs == right.WallMs && left.Counter > right.Counter
}

// persistCanonicalHead stores the result's canonical head when it moved past
// the persisted floor. The guarded update refuses a head below the stored one,
// so the head never moves backwards even if the floor read and the write
// disagree.
func persistCanonicalHead(ctx context.Context, tx *sql.Tx, reduction accountReduction, result SyncResult) error {
	head := coreHLC{WallMs: result.CanonicalHLCWallMs, Counter: result.CanonicalHLCCounter}
	if head == reduction.canonicalFloor {
		return nil
	}
	if hlcAfter(reduction.canonicalFloor, head) {
		return errors.New("canonical HLC head would move backwards")
	}
	updated, err := tx.ExecContext(ctx, `UPDATE account_state SET canonical_hlc_wall_ms = ?, canonical_hlc_counter = ?
		WHERE singleton = 1 AND (canonical_hlc_wall_ms, canonical_hlc_counter) <= (?, ?)`,
		head.WallMs, head.Counter, head.WallMs, head.Counter)
	if err != nil {
		return fmt.Errorf("save canonical HLC head: %w", err)
	}
	rows, err := updated.RowsAffected()
	if err != nil {
		return fmt.Errorf("check canonical HLC head update: %w", err)
	}
	if rows != 1 {
		return errors.New("canonical HLC head would move backwards")
	}
	return nil
}

// normalizeStoredCanonicalHead fills the canonical pair of a stored bootstrap
// response. A response stored before the pair existed falls back to its server
// pair, which covers every operation it covered. A stored pair must be whole,
// in range and not above the server pair.
func normalizeStoredCanonicalHead(storedResponse []byte, result SyncResult) (SyncResult, error) {
	var presence struct {
		WallMs  *int64 `json:"canonicalHlcWallMs"`
		Counter *int64 `json:"canonicalHlcCounter"`
	}
	if err := json.Unmarshal(storedResponse, &presence); err != nil {
		return SyncResult{}, fmt.Errorf("decode stored bootstrap canonical head: %w", err)
	}
	if presence.WallMs == nil && presence.Counter == nil {
		result.CanonicalHLCWallMs, result.CanonicalHLCCounter = result.ServerHLCWallMs, result.ServerHLCCounter
		return result, nil
	}
	if presence.WallMs == nil || presence.Counter == nil {
		return SyncResult{}, errors.New("stored bootstrap response has a partial canonical HLC head")
	}
	canonical := coreHLC{WallMs: *presence.WallMs, Counter: *presence.Counter}
	server := coreHLC{WallMs: result.ServerHLCWallMs, Counter: result.ServerHLCCounter}
	if canonical.WallMs < 0 || canonical.WallMs > MaxSafeRevision || canonical.Counter < 0 || canonical.Counter > MaxSafeRevision {
		return SyncResult{}, errors.New("stored bootstrap canonical HLC head is outside supported range")
	}
	if hlcAfter(canonical, server) {
		return SyncResult{}, errors.New("stored bootstrap canonical HLC head is above its server HLC")
	}
	result.CanonicalHLCWallMs, result.CanonicalHLCCounter = canonical.WallMs, canonical.Counter
	return result, nil
}
