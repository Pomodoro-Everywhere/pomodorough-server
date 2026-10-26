package store

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"testing"
)

type deletionSQLTable struct {
	Name    string
	Columns []string
	Rows    []string
}

func deletionSessionAccount(t *testing.T, userStore *Store, userID string) []deletionSQLTable {
	t.Helper()
	db, err := userStore.OpenExistingUser(t.Context(), userID)
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
