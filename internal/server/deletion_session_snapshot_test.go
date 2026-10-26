package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/store"
	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

type deletionSQLTable struct {
	Name    string
	Columns []string
	Rows    []string
}

func deletionSessionAccount(t *testing.T, fixture serverFixture) []deletionSQLTable {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(t.Context(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close SQL snapshot: %v", err)
		}
	}()
	tables := deletionSQLTableNames(t, db)
	account := make([]deletionSQLTable, 0, len(tables))
	for _, name := range tables {
		account = append(account, deletionSQLRows(t, db, name))
	}
	return account
}

func deletionSQLTableNames(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			t.Errorf("close table inventory: %v", err)
		}
	}()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return names
}

func deletionSQLRows(t *testing.T, db *sql.DB, name string) deletionSQLTable {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `SELECT * FROM "`+strings.ReplaceAll(name, `"`, `""`)+`"`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := rows.Close(); err != nil {
			t.Errorf("close table %s: %v", name, err)
		}
	}()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	table := deletionSQLTable{Name: name, Columns: columns, Rows: []string{}}
	for rows.Next() {
		values, pointers := make([]any, len(columns)), make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		cells := make([]string, len(values))
		for i, value := range values {
			// Preserve SQL value types, NULLs, and blob bytes before the next Scan.
			cells[i] = fmt.Sprintf("%T:%#v", value, value)
		}
		table.Rows = append(table.Rows, fmt.Sprintf("%q", cells))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Strings(table.Rows)
	return table
}

func seedDeletionSessionAccount(t *testing.T, fixture serverFixture) {
	t.Helper()
	db, err := fixture.userStore.OpenExistingUser(t.Context(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close seeded account: %v", err)
		}
	}()
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	err = store.CreateSession(context.Background(), db, store.Session{
		ID: "preserved-session", Kind: "native", DeviceID: "preserved-device", CreatedAt: now, ExpiresAt: now.AddDate(1, 0, 0),
	}, []store.TokenRecord{{Hash: sha256.Sum256([]byte("preserved-refresh")), Kind: "refresh", CreatedAt: now, ExpiresAt: now.AddDate(1, 0, 0)}})
	if err != nil {
		t.Fatal(err)
	}
	taskID := task.ID("Preserved task")
	request := store.SyncRequest{
		DeviceID: "preserved-device",
		Commands: []timer.Command{{ID: "preserved-start", DeviceID: "preserved-device", DeviceSequence: 1, TimerID: "preserved-timer",
			TaskID: taskID, Type: "start", Phase: "focus", PlannedDurationMs: 1_800_000, OccurredAt: now, HLCWallMs: now.UnixMilli()}},
		TaskOperations: []task.Operation{{ID: "preserved-task", DeviceID: "preserved-device", TaskID: taskID,
			Type: "upsert", Title: "Preserved task", OccurredAt: now, HLCWallMs: now.UnixMilli()}},
		DurationOperations: []store.DurationOperation{{ID: "preserved-duration", DeviceID: "preserved-device",
			Phase: "focus", DurationMs: 1_800_000, OccurredAt: now, HLCWallMs: now.UnixMilli()}},
	}
	result, err := fixture.userStore.Sync(t.Context(), db, fixture.userID, request, now)
	if err != nil || len(result.Tasks) != 1 || result.CanonicalTimer == nil || result.DurationsMs.Focus != 1_800_000 {
		t.Fatalf("seed account content: result=%+v error=%v", result, err)
	}
}
