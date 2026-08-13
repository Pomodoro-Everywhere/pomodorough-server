package store

import (
	"context"
	"database/sql"
	"sync"
	"testing"
)

func TestMigrateVersionOneAddsTaskSchema(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/legacy.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE timer_commands (id TEXT PRIMARY KEY)`,
		`CREATE TABLE timer_sessions (timer_id TEXT PRIMARY KEY)`,
		`PRAGMA user_version = 1`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`SELECT task_id FROM timer_commands LIMIT 0`,
		`SELECT task_id FROM timer_sessions LIMIT 0`,
		`SELECT id FROM task_operations LIMIT 0`,
		`SELECT id FROM duration_operations LIMIT 0`,
		`SELECT id FROM selected_task_operations LIMIT 0`,
	} {
		rows, err := db.QueryContext(ctx, query)
		if err != nil {
			t.Fatalf("migration query %q failed: %v", query, err)
		}
		rows.Close()
	}
	var version int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version = %d, %v; want %d", version, err, schemaVersion)
	}
}

func TestMigrateVersionTwoAddsDurationSchemaWithoutRecreatingTasks(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/legacy.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE task_operations (id TEXT PRIMARY KEY, title TEXT NOT NULL)`,
		`INSERT INTO task_operations(id, title) VALUES ('task-operation-0001', 'Preserved')`,
		`PRAGMA user_version = 2`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	var title string
	if err := db.QueryRowContext(ctx, `SELECT title FROM task_operations WHERE id = 'task-operation-0001'`).Scan(&title); err != nil || title != "Preserved" {
		t.Fatalf("existing task operation = %q, %v", title, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO duration_operations(
		id, device_id, phase, duration_ms, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
	) VALUES ('duration-operation-0001', 'device-0001', 'focus', 1500000, '2026-07-15T10:00:00Z', 1784109600000, 1784109600000, 0)`); err != nil {
		t.Fatalf("insert migrated duration operation: %v", err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM duration_operations WHERE id = 'duration-operation-0001'`); err == nil {
		t.Fatal("migrated duration operation was deletable")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO duration_operations(
		id, device_id, phase, duration_ms, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter
	) VALUES ('duration-operation-0002', 'device-0001', 'focus', 60001, '2026-07-15T10:00:00Z', 1784109600000, 0, 0)`); err == nil {
		t.Fatal("migrated duration schema accepted partial-minute duration")
	}
	var indexSQL string
	if err := db.QueryRowContext(ctx, `SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'duration_operations_order_idx'`).Scan(&indexSQL); err != nil {
		t.Fatal(err)
	}
	if indexSQL != "CREATE INDEX duration_operations_order_idx ON duration_operations(phase, hlc_wall_ms, hlc_counter, device_id, id)" {
		t.Fatalf("duration order index = %q", indexSQL)
	}
	var version int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version = %d, %v; want %d", version, err, schemaVersion)
	}
}

func TestMigrateVersionThreeAddsBootstrapSchemaAndScopedDeleteBypass(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/legacy.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE timer_commands (id TEXT PRIMARY KEY)`,
		`CREATE TABLE task_operations (id TEXT PRIMARY KEY)`,
		`CREATE TABLE duration_operations (id TEXT PRIMARY KEY)`,
		`CREATE TRIGGER timer_commands_no_delete BEFORE DELETE ON timer_commands BEGIN SELECT RAISE(ABORT, 'timer commands are immutable'); END`,
		`CREATE TRIGGER task_operations_no_delete BEFORE DELETE ON task_operations BEGIN SELECT RAISE(ABORT, 'task operations are immutable'); END`,
		`CREATE TRIGGER duration_operations_no_delete BEFORE DELETE ON duration_operations BEGIN SELECT RAISE(ABORT, 'duration operations are immutable'); END`,
		`PRAGMA user_version = 3`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`SELECT name FROM maintenance_flags LIMIT 0`,
		`SELECT request_id, payload_hash, response_json FROM bootstrap_resolutions LIMIT 0`,
	} {
		rows, err := db.QueryContext(ctx, query)
		if err != nil {
			t.Fatalf("migration query %q failed: %v", query, err)
		}
		rows.Close()
	}
	for _, table := range []string{"timer_commands", "task_operations", "duration_operations"} {
		if _, err := db.ExecContext(ctx, `INSERT INTO `+table+`(id) VALUES ('operation-0001')`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `DELETE FROM `+table); err == nil {
			t.Fatalf("%s became deletable after migration", table)
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO maintenance_flags(name) VALUES ('bootstrap_replace')`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"timer_commands", "task_operations", "duration_operations"} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table); err != nil {
			t.Fatalf("scoped delete from %s failed: %v", table, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM maintenance_flags`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var flags int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM maintenance_flags`).Scan(&flags); err != nil || flags != 0 {
		t.Fatalf("maintenance flags = %d, %v", flags, err)
	}
}

func TestMigrateVersionFourAddsImmutableAutoStartSchema(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/legacy.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE maintenance_flags (name TEXT PRIMARY KEY CHECK (name = 'bootstrap_replace')) STRICT`,
		`PRAGMA user_version = 4`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO auto_start_operations(id, device_id, enabled, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter)
		VALUES ('auto-start-operation-0001', 'device-0001', 1, '2026-07-15T10:00:00Z', 1784109600000, 1784109600000, 0)`
	if _, err := db.ExecContext(ctx, insert); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE auto_start_operations SET enabled = 0`); err == nil {
		t.Fatal("migrated auto-start operation was mutable")
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM auto_start_operations`); err == nil {
		t.Fatal("migrated auto-start operation was deletable")
	}
	for _, invalid := range []string{
		`INSERT INTO auto_start_operations(id, device_id, enabled, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter) VALUES ('auto-start-invalid-enabled', 'device-0001', 2, '2026-07-15T10:00:00Z', 0, 0, 0)`,
		`INSERT INTO auto_start_operations(id, device_id, enabled, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter) VALUES ('auto-start-invalid-clock', 'device-0001', 0, '2026-07-15T10:00:00Z', 0, -1, 0)`,
	} {
		if _, err := db.ExecContext(ctx, invalid); err == nil {
			t.Fatalf("auto-start schema accepted invalid statement %q", invalid)
		}
	}
	var indexSQL string
	if err := db.QueryRowContext(ctx, `SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'auto_start_operations_order_idx'`).Scan(&indexSQL); err != nil {
		t.Fatal(err)
	}
	if indexSQL != "CREATE INDEX auto_start_operations_order_idx ON auto_start_operations(hlc_wall_ms, hlc_counter, device_id, id)" {
		t.Fatalf("auto-start order index = %q", indexSQL)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO maintenance_flags(name) VALUES ('bootstrap_replace')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM auto_start_operations`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM maintenance_flags`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateVersionFourRollsBackPartialAutoStartSchema(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/legacy.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE maintenance_flags (name TEXT PRIMARY KEY CHECK (name = 'bootstrap_replace')) STRICT`,
		`CREATE TABLE index_owner (id INTEGER PRIMARY KEY) STRICT`,
		`CREATE INDEX auto_start_operations_order_idx ON index_owner(id)`,
		`PRAGMA user_version = 4`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(ctx, db); err == nil {
		t.Fatal("migration with conflicting index succeeded")
	}
	var version, tableCount int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'auto_start_operations'`).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if version != 4 || tableCount != 0 {
		t.Fatalf("failed migration leaked version=%d tableCount=%d", version, tableCount)
	}
}

func TestMigrateVersionFiveAddsImmutableNullableSelectedTaskSchema(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/legacy.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE maintenance_flags (name TEXT PRIMARY KEY CHECK (name = 'bootstrap_replace')) STRICT`,
		`PRAGMA user_version = 5`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO selected_task_operations(id, device_id, task_id, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter)
		VALUES ('selected-task-operation-0001', 'device-0001', NULL, '2026-07-15T10:00:00Z', 1784109600000, 1784109600000, 0)`
	if _, err := db.ExecContext(ctx, insert); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE selected_task_operations SET task_id = 'task-0001'`); err == nil {
		t.Fatal("migrated selected-task operation was mutable")
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM selected_task_operations`); err == nil {
		t.Fatal("migrated selected-task operation was deletable")
	}
	for _, invalid := range []string{
		`INSERT INTO selected_task_operations(id, device_id, task_id, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter) VALUES ('selected-task-invalid-id', 'device-0001', 'short', '2026-07-15T10:00:00Z', 0, 0, 0)`,
		`INSERT INTO selected_task_operations(id, device_id, task_id, occurred_at, occurred_at_ms, hlc_wall_ms, hlc_counter) VALUES ('selected-task-invalid-clock', 'device-0001', NULL, '2026-07-15T10:00:00Z', 0, -1, 0)`,
	} {
		if _, err := db.ExecContext(ctx, invalid); err == nil {
			t.Fatalf("selected-task schema accepted invalid statement %q", invalid)
		}
	}
	var indexSQL string
	if err := db.QueryRowContext(ctx, `SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'selected_task_operations_order_idx'`).Scan(&indexSQL); err != nil {
		t.Fatal(err)
	}
	if indexSQL != "CREATE INDEX selected_task_operations_order_idx ON selected_task_operations(hlc_wall_ms, hlc_counter, device_id, id)" {
		t.Fatalf("selected-task order index = %q", indexSQL)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO maintenance_flags(name) VALUES ('bootstrap_replace')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM selected_task_operations`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM maintenance_flags`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateVersionFiveRollsBackPartialSelectedTaskSchema(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/legacy.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		`CREATE TABLE maintenance_flags (name TEXT PRIMARY KEY CHECK (name = 'bootstrap_replace')) STRICT`,
		`CREATE TABLE index_owner (id INTEGER PRIMARY KEY) STRICT`,
		`CREATE INDEX selected_task_operations_order_idx ON index_owner(id)`,
		`PRAGMA user_version = 5`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(ctx, db); err == nil {
		t.Fatal("migration with conflicting selected-task index succeeded")
	}
	var version, tableCount int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'selected_task_operations'`).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if version != 5 || tableCount != 0 {
		t.Fatalf("failed migration leaked version=%d tableCount=%d", version, tableCount)
	}
}

func TestConcurrentMigrationsSerializeSchemaOwnership(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir() + "/legacy.sqlite"
	setup, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE task_operations (id TEXT PRIMARY KEY, title TEXT NOT NULL)`,
		`PRAGMA user_version = 2`,
	} {
		if _, err := setup.ExecContext(ctx, statement); err != nil {
			setup.Close()
			t.Fatal(err)
		}
	}
	if err := setup.Close(); err != nil {
		t.Fatal(err)
	}

	const workers = 8
	start := make(chan struct{})
	errors := make(chan error, workers)
	var wait sync.WaitGroup
	for range workers {
		db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
		if err != nil {
			t.Fatal(err)
		}
		db.SetMaxOpenConns(1)
		wait.Add(1)
		go func() {
			defer wait.Done()
			defer db.Close()
			<-start
			errors <- migrate(ctx, db)
		}()
	}
	close(start)
	wait.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("concurrent migration failed: %v", err)
		}
	}

	verify, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer verify.Close()
	var version int
	if err := verify.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != schemaVersion {
		t.Fatalf("schema version = %d, %v; want %d", version, err, schemaVersion)
	}
	rows, err := verify.QueryContext(ctx, `SELECT id FROM duration_operations LIMIT 0`)
	if err != nil {
		t.Fatalf("duration schema unavailable after concurrent migration: %v", err)
	}
	rows.Close()
}
