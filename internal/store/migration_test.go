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
