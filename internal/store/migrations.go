package store

import (
	"context"
	"database/sql"
	"fmt"
)

type immutableTable struct {
	table   string
	trigger string
	message string
}

var immutableTables = []immutableTable{
	{table: "timer_commands", trigger: "timer_commands_no_delete", message: "timer commands are immutable"},
	{table: "task_operations", trigger: "task_operations_no_delete", message: "task operations are immutable"},
	{table: "duration_operations", trigger: "duration_operations_no_delete", message: "duration operations are immutable"},
	{table: "auto_start_operations", trigger: "auto_start_operations_no_delete", message: "auto-start operations are immutable"},
	{table: "selected_task_operations", trigger: "selected_task_operations_no_delete", message: "selected-task operations are immutable"},
}

func migrate(ctx context.Context, db *sql.DB) error {
	version, err := readSchemaVersion(ctx, db)
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if err := validateSchemaVersion(version); err != nil || version == schemaVersion {
		return err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		return fmt.Errorf("begin migration: %w", err)
	}
	defer conn.ExecContext(context.Background(), `ROLLBACK`)
	return migrateConnection(ctx, conn)
}

func migrateConnection(ctx context.Context, conn *sql.Conn) error {
	version, err := readSchemaVersion(ctx, conn)
	if err != nil {
		return fmt.Errorf("re-read schema version: %w", err)
	}
	if err := validateSchemaVersion(version); err != nil {
		return err
	}
	if version == schemaVersion {
		return commitMigration(ctx, conn, "commit migration check")
	}
	if err := executeMigrationStatements(ctx, conn, migrationStatements(version)); err != nil {
		return err
	}
	if version < 6 {
		if err := replaceImmutableDeleteTriggers(ctx, conn); err != nil {
			return err
		}
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return fmt.Errorf("set schema version: %w", err)
	}
	return commitMigration(ctx, conn, "commit migration")
}

type schemaVersionReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readSchemaVersion(ctx context.Context, reader schemaVersionReader) (int, error) {
	var version int
	err := reader.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version)
	return version, err
}

func validateSchemaVersion(version int) error {
	if version > schemaVersion {
		return fmt.Errorf("user database schema %d is newer than supported schema %d", version, schemaVersion)
	}
	return nil
}

func migrationStatements(version int) []string {
	var statements []string
	if version == 0 {
		statements = append(statements, initialSchemaStatements...)
	} else if version == 1 {
		statements = append(statements, taskLinkStatements...)
	}
	for _, migration := range incrementalMigrations {
		if version < migration.version {
			statements = append(statements, migration.statements...)
		}
	}
	return statements
}

func executeMigrationStatements(ctx context.Context, conn *sql.Conn, statements []string) error {
	for _, statement := range statements {
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate user database: %w", err)
		}
	}
	return nil
}

func replaceImmutableDeleteTriggers(ctx context.Context, conn *sql.Conn) error {
	for _, immutable := range immutableTables {
		var count int
		err := conn.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?`, immutable.table,
		).Scan(&count)
		if err != nil {
			return fmt.Errorf("inspect immutable table %s: %w", immutable.table, err)
		}
		if count > 0 {
			if err := replaceImmutableDeleteTrigger(ctx, conn, immutable); err != nil {
				return err
			}
		}
	}
	return nil
}

func replaceImmutableDeleteTrigger(ctx context.Context, conn *sql.Conn, immutable immutableTable) error {
	if _, err := conn.ExecContext(ctx, "DROP TRIGGER IF EXISTS "+immutable.trigger); err != nil {
		return fmt.Errorf("replace immutable trigger %s: %w", immutable.trigger, err)
	}
	statement := fmt.Sprintf(`CREATE TRIGGER %s BEFORE DELETE ON %s
		WHEN NOT EXISTS (SELECT 1 FROM maintenance_flags WHERE name = 'bootstrap_replace')
		BEGIN SELECT RAISE(ABORT, '%s'); END`, immutable.trigger, immutable.table, immutable.message)
	if _, err := conn.ExecContext(ctx, statement); err != nil {
		return fmt.Errorf("create immutable trigger %s: %w", immutable.trigger, err)
	}
	return nil
}

func commitMigration(ctx context.Context, conn *sql.Conn, action string) error {
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		return fmt.Errorf("%s: %w", action, err)
	}
	return nil
}
