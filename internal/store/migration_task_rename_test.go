package store

import (
	"context"
	"database/sql"
	"reflect"
	"strings"
	"testing"
)

// Schema v8 rebuilds task_operations so its CHECK admits the Core 0.56.0
// `rename` operation. These tests start from a database built with the real
// v7 statements.

type storedTaskOperationRow struct {
	id, deviceID, taskID, operationType, title, occurredAt string
	occurredAtMs, hlcWallMs, hlcCounter                    int64
}

var versionSevenTaskOperationRows = []storedTaskOperationRow{
	{"task-operation-0001", "device-0001", "task-alpha-0001", "upsert", "Alpha", "2026-07-15T10:00:00Z", 1784109600000, 1784109600000, 0},
	{"task-operation-0002", "device-0002", "task-alpha-0001", "delete", "", "2026-07-15T10:01:00Z", 1784109660000, 1784109660000, 3},
	{"task-operation-0003", "device-0001", "task-beta-00001", "upsert", "  Beta  ", "2026-07-15T10:02:00Z", 1784109720000, 1784109720000, 1},
}

func openVersionSevenDatabase(t *testing.T) *sql.DB {
	t.Helper()
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/v7.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	statements := append([]string{}, initialSchemaStatements...)
	for _, migration := range incrementalMigrations {
		if migration.version <= 7 {
			statements = append(statements, migration.statements...)
		}
	}
	if err := executeMigrationStatements(ctx, conn, statements); err != nil {
		t.Fatal(err)
	}
	if err := replaceImmutableDeleteTriggers(ctx, conn); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA user_version = 7`); err != nil {
		t.Fatal(err)
	}
	for _, row := range versionSevenTaskOperationRows {
		insertTaskOperationRow(t, conn, row)
	}
	return db
}

type sqlExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insertTaskOperationRow(t *testing.T, db sqlExecer, row storedTaskOperationRow) {
	t.Helper()
	if err := tryInsertTaskOperationRow(db, row); err != nil {
		t.Fatalf("insert task operation %s: %v", row.id, err)
	}
}

func tryInsertTaskOperationRow(db sqlExecer, row storedTaskOperationRow) error {
	_, err := db.ExecContext(context.Background(), `INSERT INTO task_operations(
		id, device_id, task_id, operation_type, title, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.deviceID, row.taskID, row.operationType, row.title,
		row.occurredAt, row.occurredAtMs, row.hlcWallMs, row.hlcCounter)
	return err
}

func readTaskOperationRows(t *testing.T, db *sql.DB) []storedTaskOperationRow {
	t.Helper()
	rows, err := db.QueryContext(context.Background(), `SELECT id, device_id, task_id, operation_type, title,
		occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter FROM task_operations
		ORDER BY task_id, hlc_wall_ms, hlc_counter, device_id, id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []storedTaskOperationRow
	for rows.Next() {
		var row storedTaskOperationRow
		if err := rows.Scan(&row.id, &row.deviceID, &row.taskID, &row.operationType, &row.title,
			&row.occurredAt, &row.occurredAtMs, &row.hlcWallMs, &row.hlcCounter); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

// taskOperationSchema maps each sqlite_schema object of task_operations (the
// table, its index and its triggers) to its SQL text.
func taskOperationSchema(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	rows, err := db.QueryContext(context.Background(),
		`SELECT type || ':' || name, sql FROM sqlite_schema WHERE tbl_name LIKE 'task_operations%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	schema := map[string]string{}
	for rows.Next() {
		var name string
		var text sql.NullString
		if err := rows.Scan(&name, &text); err != nil {
			t.Fatal(err)
		}
		schema[name] = text.String
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return schema
}

func freshDatabaseSchema(t *testing.T) map[string]string {
	t.Helper()
	fresh, err := sql.Open("sqlite", "file:"+t.TempDir()+"/fresh.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if err := migrate(context.Background(), fresh); err != nil {
		t.Fatal(err)
	}
	return taskOperationSchema(t, fresh)
}

func TestMigrateVersionSevenWidensTaskOperationTypes(t *testing.T) {
	ctx := context.Background()
	db := openVersionSevenDatabase(t)
	before := readTaskOperationRows(t, db)
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if after := readTaskOperationRows(t, db); !reflect.DeepEqual(after, before) || len(after) != 3 {
		t.Fatalf("rows after migration = %#v; want %#v", after, before)
	}
	rename := storedTaskOperationRow{"task-operation-0004", "device-0001", "task-beta-00001", "rename", "Gamma",
		"2026-07-15T10:03:00Z", 1784109780000, 1784109780000, 0}
	insertTaskOperationRow(t, db, rename)
	merge := rename
	merge.id, merge.operationType = "task-operation-0005", "merge"
	if err := tryInsertTaskOperationRow(db, merge); err == nil || !strings.Contains(err.Error(), "CHECK constraint failed") {
		t.Fatalf("merge insert error = %v; want a CHECK constraint failure", err)
	}
	assertTaskOperationsImmutable(t, db)
	if got, want := taskOperationSchema(t, db), freshDatabaseSchema(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("upgraded schema = %#v; fresh schema = %#v", got, want)
	}
	var leftovers, version int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE '%_v8'`).Scan(&leftovers); err != nil || leftovers != 0 {
		t.Fatalf("v8 rebuild objects left = %d, %v", leftovers, err)
	}
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != 8 {
		t.Fatalf("schema version = %d, %v; want 8", version, err)
	}
}

// assertTaskOperationsImmutable checks that rows cannot be updated, cannot be
// deleted without the bootstrap replace flag, and can be deleted with it.
func assertTaskOperationsImmutable(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `UPDATE task_operations SET title = 'Changed'`); err == nil ||
		!strings.Contains(err.Error(), "task operations are immutable") {
		t.Fatalf("update error = %v", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM task_operations`); err == nil ||
		!strings.Contains(err.Error(), "task operations are immutable") {
		t.Fatalf("unflagged delete error = %v", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO maintenance_flags(name) VALUES ('bootstrap_replace')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM task_operations`); err != nil {
		t.Fatalf("flagged delete failed: %v", err)
	}
}

func TestFreshAndUpgradedTaskOperationsSchemaMatch(t *testing.T) {
	db := openVersionSevenDatabase(t)
	if err := migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	upgraded, fresh := taskOperationSchema(t, db), freshDatabaseSchema(t)
	for _, name := range []string{"table:task_operations", "index:task_operations_order_idx",
		"trigger:task_operations_no_update", "trigger:task_operations_no_delete"} {
		if fresh[name] == "" || upgraded[name] != fresh[name] {
			t.Fatalf("%s: upgraded %q, fresh %q", name, upgraded[name], fresh[name])
		}
	}
	if !strings.Contains(fresh["table:task_operations"], "('upsert', 'delete', 'rename')") {
		t.Fatalf("fresh task_operations does not admit rename: %q", fresh["table:task_operations"])
	}
	if len(upgraded) != len(fresh) {
		t.Fatalf("upgraded objects %v; fresh objects %v", upgraded, fresh)
	}
}

func TestMigrateVersionSevenRollsBackOnRebuildConflict(t *testing.T) {
	ctx := context.Background()
	db := openVersionSevenDatabase(t)
	if _, err := db.ExecContext(ctx, `CREATE TABLE task_operations_v8 (id TEXT PRIMARY KEY) STRICT`); err != nil {
		t.Fatal(err)
	}
	before, schemaBefore := readTaskOperationRows(t, db), taskOperationSchema(t, db)
	if err := migrate(ctx, db); err == nil {
		t.Fatal("migration with a conflicting rebuild table succeeded")
	}
	var version int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != 7 {
		t.Fatalf("schema version = %d, %v; want 7", version, err)
	}
	if after := readTaskOperationRows(t, db); !reflect.DeepEqual(after, before) {
		t.Fatalf("rows after failed migration = %#v; want %#v", after, before)
	}
	if schemaAfter := taskOperationSchema(t, db); !reflect.DeepEqual(schemaAfter, schemaBefore) {
		t.Fatalf("schema after failed migration = %#v; want %#v", schemaAfter, schemaBefore)
	}
	rename := versionSevenTaskOperationRows[0]
	rename.id, rename.operationType = "task-operation-0009", "rename"
	if err := tryInsertTaskOperationRow(db, rename); err == nil || !strings.Contains(err.Error(), "CHECK constraint failed") {
		t.Fatalf("rename on the rolled-back v7 table: %v; want a CHECK constraint failure", err)
	}
}
