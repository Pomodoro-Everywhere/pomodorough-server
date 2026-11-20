package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"
)

// R55-S09: the canonical HLC head covers the operations the server ordered and
// never the server's physical clock. It is persisted, so it stays put at an
// unchanged revision and never moves backwards, also across replace_remote.

func canonicalTestOperation(id string, wallMs, counter int64, at time.Time) SelectedTaskOperation {
	return SelectedTaskOperation{ID: id, OccurredAt: at, HLCWallMs: wallMs, HLCCounter: counter}
}

func canonicalPair(result SyncResult) coreHLC {
	return coreHLC{WallMs: result.CanonicalHLCWallMs, Counter: result.CanonicalHLCCounter}
}

func serverPair(result SyncResult) coreHLC {
	return coreHLC{WallMs: result.ServerHLCWallMs, Counter: result.ServerHLCCounter}
}

func TestCanonicalHeadExcludesServerClockOnEveryResponsePath(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "canonical-head-paths-subject")
	defer db.Close()
	empty, err := userStore.Bootstrap(ctx, db, userID, now)
	if err != nil {
		t.Fatal(err)
	}
	if canonicalPair(empty) != (coreHLC{}) || serverPair(empty) != (coreHLC{WallMs: now.UnixMilli()}) {
		t.Fatalf("empty workspace heads canonical=%#v server=%#v", canonicalPair(empty), serverPair(empty))
	}
	operation := canonicalTestOperation("canonical-operation-01", now.Add(-5*time.Second).UnixMilli(), 3, now)
	want := coreHLC{WallMs: operation.HLCWallMs, Counter: 3}
	synced, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0001", SelectedTaskOperations: []SelectedTaskOperation{operation},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if canonicalPair(synced) != want || serverPair(synced) != (coreHLC{WallMs: now.UnixMilli()}) {
		t.Fatalf("sync heads canonical=%#v server=%#v", canonicalPair(synced), serverPair(synced))
	}
	later := now.Add(time.Minute)
	materialized, err := userStore.Bootstrap(ctx, db, userID, later)
	if err != nil {
		t.Fatal(err)
	}
	request := BootstrapResolutionRequest{RequestID: "canonical-resolution-01", DeviceID: "device-0001",
		ExpectedRevision: synced.Revision, Strategy: BootstrapKeepRemote}
	resolved, err := userStore.ResolveBootstrap(ctx, db, userID, request, later)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := userStore.ResolveBootstrap(ctx, db, userID, request, later.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for name, result := range map[string]SyncResult{"bootstrap": materialized, "resolve": resolved, "replay": replayed} {
		if canonicalPair(result) != want || serverPair(result) != (coreHLC{WallMs: later.UnixMilli()}) {
			t.Fatalf("%s heads canonical=%#v server=%#v", name, canonicalPair(result), serverPair(result))
		}
	}
}

func TestCanonicalHeadIsUnchangedAtUnchangedRevision(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "canonical-head-unchanged-subject")
	defer db.Close()
	operation := canonicalTestOperation("canonical-operation-01", now.UnixMilli(), 1, now)
	first, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0001", SelectedTaskOperations: []SelectedTaskOperation{operation},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	reused := operation
	reused.HLCWallMs = now.Add(time.Hour).UnixMilli()
	for index, request := range []SyncRequest{
		{DeviceID: "device-0001", LastRevision: first.Revision},
		{DeviceID: "device-0001", LastRevision: first.Revision, SelectedTaskOperations: []SelectedTaskOperation{operation}},
		{DeviceID: "device-0001", LastRevision: first.Revision, SelectedTaskOperations: []SelectedTaskOperation{reused}},
	} {
		next, err := userStore.Sync(ctx, db, userID, request, now.Add(time.Duration(index+1)*time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		if next.Revision != first.Revision || canonicalPair(next) != canonicalPair(first) {
			t.Fatalf("request %d: revision %d head %#v, want revision %d head %#v",
				index, next.Revision, canonicalPair(next), first.Revision, canonicalPair(first))
		}
	}
}

func TestCanonicalHeadNeverMovesBackwardsAcrossReplaceRemote(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "canonical-head-replace-subject")
	defer db.Close()
	high := canonicalTestOperation("canonical-operation-01", now.Add(time.Hour).UnixMilli(), 4, now)
	synced, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0001", SelectedTaskOperations: []SelectedTaskOperation{high},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	low := canonicalTestOperation("canonical-operation-02", now.UnixMilli(), 0, now)
	replaced, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "canonical-resolution-01", DeviceID: "device-0002", ExpectedRevision: synced.Revision,
		Strategy: BootstrapReplaceRemote, SelectedTaskOperations: []SelectedTaskOperation{low}, SelectedTaskOperationsPresent: true,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	var retained int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM selected_task_operations WHERE id = ?`, high.ID).Scan(&retained); err != nil || retained != 0 {
		t.Fatalf("replace_remote kept the high operation: count=%d err=%v", retained, err)
	}
	materialized, err := userStore.Bootstrap(ctx, db, userID, now)
	if err != nil {
		t.Fatal(err)
	}
	for name, result := range map[string]SyncResult{"replace": replaced, "bootstrap": materialized} {
		if result.Revision <= synced.Revision || canonicalPair(result) != canonicalPair(synced) {
			t.Fatalf("%s revision %d head %#v, want head %#v after revision %d",
				name, result.Revision, canonicalPair(result), canonicalPair(synced), synced.Revision)
		}
		if hlcAfter(canonicalPair(result), serverPair(result)) {
			t.Fatalf("%s canonical %#v above server %#v", name, canonicalPair(result), serverPair(result))
		}
	}
	higher := canonicalTestOperation("canonical-operation-03", now.Add(2*time.Hour).UnixMilli(), 0, now)
	moved, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: "device-0002", SelectedTaskOperations: []SelectedTaskOperation{higher},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if canonicalPair(moved) != (coreHLC{WallMs: higher.HLCWallMs}) {
		t.Fatalf("head after newer operation = %#v", canonicalPair(moved))
	}
}

// The resolve path persists the head itself: a second replace_remote with no
// sync between them must keep the head the first replacement installed.
func TestCanonicalHeadSurvivesConsecutiveReplaceRemoteResolutions(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "canonical-head-double-replace-subject")
	defer db.Close()
	high := canonicalTestOperation("canonical-operation-01", now.Add(time.Hour).UnixMilli(), 4, now)
	first, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "canonical-resolution-01", DeviceID: "device-0001", ExpectedRevision: 0,
		Strategy: BootstrapReplaceRemote, SelectedTaskOperations: []SelectedTaskOperation{high}, SelectedTaskOperationsPresent: true,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	low := canonicalTestOperation("canonical-operation-02", now.UnixMilli(), 0, now)
	second, err := userStore.ResolveBootstrap(ctx, db, userID, BootstrapResolutionRequest{
		RequestID: "canonical-resolution-02", DeviceID: "device-0002", ExpectedRevision: first.Revision,
		Strategy: BootstrapReplaceRemote, SelectedTaskOperations: []SelectedTaskOperation{low}, SelectedTaskOperationsPresent: true,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if canonicalPair(second) != canonicalPair(first) {
		t.Fatalf("second replace_remote head %#v, want %#v", canonicalPair(second), canonicalPair(first))
	}
	again, err := userStore.Bootstrap(ctx, db, userID, now)
	if err != nil || canonicalPair(again) != canonicalPair(first) {
		t.Fatalf("bootstrap head %#v, want %#v, err %v", canonicalPair(again), canonicalPair(first), err)
	}
}

func TestPersistCanonicalHeadRefusesToMoveBackwards(t *testing.T) {
	ctx := context.Background()
	_, db, _, _ := openTestUser(t, "canonical-head-guard-subject")
	defer db.Close()
	if _, err := db.ExecContext(ctx, `UPDATE account_state SET canonical_hlc_wall_ms = 50, canonical_hlc_counter = 2`); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		floor coreHLC
		head  coreHLC
	}{
		{"head below floor", coreHLC{WallMs: 50, Counter: 2}, coreHLC{WallMs: 50, Counter: 1}},
		{"head below stored row", coreHLC{WallMs: 10}, coreHLC{WallMs: 49, Counter: 9}},
	}
	for _, test := range cases {
		err := withCanonicalTestTransaction(t, db, func(tx *sql.Tx) error {
			return persistCanonicalHead(ctx, tx, accountReduction{canonicalFloor: test.floor},
				SyncResult{CanonicalHLCWallMs: test.head.WallMs, CanonicalHLCCounter: test.head.Counter})
		})
		if err == nil || !strings.Contains(err.Error(), "move backwards") {
			t.Fatalf("%s: error = %v", test.name, err)
		}
	}
	if err := withCanonicalTestTransaction(t, db, func(tx *sql.Tx) error {
		return persistCanonicalHead(ctx, tx, accountReduction{canonicalFloor: coreHLC{WallMs: 50, Counter: 2}},
			SyncResult{CanonicalHLCWallMs: 50, CanonicalHLCCounter: 3})
	}); err != nil {
		t.Fatal(err)
	}
	var stored coreHLC
	if err := db.QueryRowContext(ctx, `SELECT canonical_hlc_wall_ms, canonical_hlc_counter FROM account_state`).Scan(&stored.WallMs, &stored.Counter); err != nil || stored != (coreHLC{WallMs: 50, Counter: 3}) {
		t.Fatalf("stored head = %#v, %v", stored, err)
	}
}

func withCanonicalTestTransaction(t *testing.T, db *sql.DB, body func(*sql.Tx) error) error {
	t.Helper()
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := body(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func TestStoredCanonicalHeadNormalization(t *testing.T) {
	stored := SyncResult{ServerHLCWallMs: 100, ServerHLCCounter: 5}
	cases := []struct {
		name    string
		raw     string
		want    coreHLC
		wantErr string
	}{
		{"legacy result uses server pair", `{}`, coreHLC{WallMs: 100, Counter: 5}, ""},
		{"stored pair kept", `{"canonicalHlcWallMs":90,"canonicalHlcCounter":7}`, coreHLC{WallMs: 90, Counter: 7}, ""},
		{"equal to server", `{"canonicalHlcWallMs":100,"canonicalHlcCounter":5}`, coreHLC{WallMs: 100, Counter: 5}, ""},
		{"empty workspace", `{"canonicalHlcWallMs":0,"canonicalHlcCounter":0}`, coreHLC{}, ""},
		{"wall only", `{"canonicalHlcWallMs":90}`, coreHLC{}, "partial"},
		{"counter only", `{"canonicalHlcCounter":0}`, coreHLC{}, "partial"},
		{"null counter", `{"canonicalHlcWallMs":90,"canonicalHlcCounter":null}`, coreHLC{}, "partial"},
		{"negative wall", `{"canonicalHlcWallMs":-1,"canonicalHlcCounter":0}`, coreHLC{}, "range"},
		{"negative counter", `{"canonicalHlcWallMs":1,"canonicalHlcCounter":-1}`, coreHLC{}, "range"},
		{"unsafe wall", `{"canonicalHlcWallMs":9007199254740992,"canonicalHlcCounter":0}`, coreHLC{}, "range"},
		{"fraction", `{"canonicalHlcWallMs":1.5,"canonicalHlcCounter":0}`, coreHLC{}, "decode"},
		{"string", `{"canonicalHlcWallMs":"1","canonicalHlcCounter":0}`, coreHLC{}, "decode"},
		{"counter above server", `{"canonicalHlcWallMs":100,"canonicalHlcCounter":6}`, coreHLC{}, "above"},
		{"wall above server", `{"canonicalHlcWallMs":101,"canonicalHlcCounter":0}`, coreHLC{}, "above"},
	}
	for _, test := range cases {
		result, err := normalizeStoredCanonicalHead([]byte(test.raw), stored)
		if test.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("%s: error = %v, want %q", test.name, err, test.wantErr)
			}
			continue
		}
		if err != nil || canonicalPair(result) != test.want || serverPair(result) != serverPair(stored) {
			t.Fatalf("%s: result = %#v, err = %v", test.name, result, err)
		}
	}
}

func TestStoredBootstrapReplayWithoutCanonicalHeadUsesServerPair(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "canonical-head-legacy-replay-subject")
	defer db.Close()
	request := BootstrapResolutionRequest{RequestID: "canonical-resolution-legacy", DeviceID: "device-0001", Strategy: BootstrapKeepRemote}
	first, err := userStore.ResolveBootstrap(ctx, db, userID, request, now)
	if err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := db.QueryRowContext(ctx, `SELECT response_json FROM bootstrap_resolutions WHERE request_id = ?`, request.RequestID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored, `"canonicalHlcWallMs":0,"canonicalHlcCounter":0`) {
		t.Fatalf("stored response lacks the canonical pair: %s", stored)
	}
	legacy := strings.Replace(stored, `,"canonicalHlcWallMs":0,"canonicalHlcCounter":0`, "", 1)
	if _, err := db.ExecContext(ctx, `UPDATE bootstrap_resolutions SET response_json = ? WHERE request_id = ?`, legacy, request.RequestID); err != nil {
		t.Fatal(err)
	}
	replayed, err := userStore.ResolveBootstrap(ctx, db, userID, request, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if canonicalPair(first) != (coreHLC{}) || canonicalPair(replayed) != serverPair(first) || serverPair(replayed) != serverPair(first) {
		t.Fatalf("legacy replay canonical=%#v server=%#v, first server=%#v",
			canonicalPair(replayed), serverPair(replayed), serverPair(first))
	}
}

func TestMigrationBackfillsCanonicalHeadFromRetainedOperations(t *testing.T) {
	ctx := context.Background()
	db := openVersionSevenDatabase(t)
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	var head coreHLC
	if err := db.QueryRowContext(ctx, `SELECT canonical_hlc_wall_ms, canonical_hlc_counter FROM account_state WHERE singleton = 1`).
		Scan(&head.WallMs, &head.Counter); err != nil {
		t.Fatal(err)
	}
	if head != (coreHLC{WallMs: 1784109720000, Counter: 1}) {
		t.Fatalf("backfilled head = %#v", head)
	}
	upgraded, fresh := accountStateSchema(t, db), freshAccountStateSchema(t)
	if upgraded == "" || upgraded != fresh {
		t.Fatalf("upgraded account_state %q; fresh %q", upgraded, fresh)
	}
}

func accountStateSchema(t *testing.T, db *sql.DB) string {
	t.Helper()
	var text string
	if err := db.QueryRowContext(context.Background(), `SELECT sql FROM sqlite_schema WHERE name = 'account_state'`).Scan(&text); err != nil {
		t.Fatal(err)
	}
	return text
}

func freshAccountStateSchema(t *testing.T) string {
	t.Helper()
	fresh, err := sql.Open("sqlite", "file:"+t.TempDir()+"/fresh.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if err := migrate(context.Background(), fresh); err != nil {
		t.Fatal(err)
	}
	return accountStateSchema(t, fresh)
}
