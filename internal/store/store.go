package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"pomodorough/internal/authn"

	_ "modernc.org/sqlite"
)

const (
	schemaVersion   = 6
	MaxSafeRevision = int64(9_007_199_254_740_991)
)

var (
	ErrNotFound          = errors.New("user database not found")
	ErrUnauthorized      = errors.New("unauthorized")
	ErrRefreshReuse      = errors.New("refresh token reuse detected")
	ErrRevisionConflict  = errors.New("revision conflict")
	ErrRevisionExhausted = errors.New("canonical revision exhausted")
	ErrRequestIDConflict = errors.New("request ID conflict")
)

func safeRevisionIncrement(revision int64) (int64, error) {
	if err := validateCanonicalRevision(revision); err != nil || revision == MaxSafeRevision {
		return 0, ErrRevisionExhausted
	}
	return revision + 1, nil
}

func validateCanonicalRevision(revision int64) error {
	if revision < 0 || revision > MaxSafeRevision {
		return ErrRevisionExhausted
	}
	return nil
}

type Store struct {
	usersDir string
	locksMu  sync.Mutex
	locks    map[string]*userLock
}

type userLock struct {
	mutex sync.Mutex
	refs  int
}

func New(dataDir string) (*Store, error) {
	usersDir := filepath.Join(dataDir, "users")
	if err := os.MkdirAll(usersDir, 0o700); err != nil {
		return nil, fmt.Errorf("create user data directory: %w", err)
	}
	if err := os.Chmod(usersDir, 0o700); err != nil {
		return nil, fmt.Errorf("secure user data directory: %w", err)
	}
	return &Store{usersDir: usersDir, locks: make(map[string]*userLock)}, nil
}

func (s *Store) OpenUser(ctx context.Context, userID string) (*sql.DB, error) {
	path, err := s.userPath(userID)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create user database: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close new user database: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, fmt.Errorf("secure user database: %w", err)
	}
	return openDatabase(ctx, path)
}

func (s *Store) OpenExistingUser(ctx context.Context, userID string) (*sql.DB, error) {
	path, err := s.userPath(userID)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("stat user database: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, ErrNotFound
	}
	return openDatabase(ctx, path)
}

func (s *Store) LockUser(userID string) func() {
	s.locksMu.Lock()
	lock := s.locks[userID]
	if lock == nil {
		lock = &userLock{}
		s.locks[userID] = lock
	}
	lock.refs++
	s.locksMu.Unlock()

	lock.mutex.Lock()
	return func() {
		lock.mutex.Unlock()
		s.locksMu.Lock()
		lock.refs--
		if lock.refs == 0 {
			delete(s.locks, userID)
		}
		s.locksMu.Unlock()
	}
}

func (s *Store) userPath(userID string) (string, error) {
	if !authn.ValidateUserID(userID) {
		return "", authn.ErrInvalidToken
	}
	return filepath.Join(s.usersDir, userID+".sqlite"), nil
}

func openDatabase(ctx context.Context, path string) (*sql.DB, error) {
	dsn := "file:" + filepath.ToSlash(path) + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open user database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect to user database: %w", err)
	}
	if err := migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version > schemaVersion {
		return fmt.Errorf("user database schema %d is newer than supported schema %d", version, schemaVersion)
	}
	if version == schemaVersion {
		return nil
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
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("re-read schema version: %w", err)
	}
	if version > schemaVersion {
		return fmt.Errorf("user database schema %d is newer than supported schema %d", version, schemaVersion)
	}
	if version == schemaVersion {
		if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
			return fmt.Errorf("commit migration check: %w", err)
		}
		return nil
	}

	var statements []string
	if version == 0 {
		statements = []string{
			`CREATE TABLE profile (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			user_id TEXT NOT NULL UNIQUE,
			issuer TEXT NOT NULL,
			subject TEXT NOT NULL,
			email TEXT NOT NULL,
			email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
			name TEXT NOT NULL,
			avatar_url TEXT NOT NULL,
			updated_at_ms INTEGER NOT NULL
		) STRICT`,
			`CREATE TABLE devices (
			id TEXT PRIMARY KEY,
			platform TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL,
			last_seen_at_ms INTEGER NOT NULL,
			revoked_at_ms INTEGER
		) STRICT`,
			`CREATE TABLE auth_sessions (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('web', 'native')),
			device_id TEXT,
			platform TEXT NOT NULL,
			csrf_hash BLOB,
			created_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			revoked_at_ms INTEGER,
			reuse_detected_at_ms INTEGER
		) STRICT`,
			`CREATE INDEX auth_sessions_device_idx ON auth_sessions(device_id)`,
			`CREATE TABLE auth_tokens (
			token_hash BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
			session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
			kind TEXT NOT NULL CHECK (kind IN ('web', 'access', 'refresh')),
			created_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL,
			used_at_ms INTEGER,
			revoked_at_ms INTEGER
		) STRICT`,
			`CREATE INDEX auth_tokens_session_idx ON auth_tokens(session_id)`,
			`CREATE TABLE timer_commands (
			id TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			device_sequence INTEGER NOT NULL CHECK (device_sequence > 0),
			timer_id TEXT NOT NULL,
			task_id TEXT,
			command_type TEXT NOT NULL,
			phase TEXT NOT NULL,
			planned_duration_ms INTEGER NOT NULL,
			occurred_at TEXT NOT NULL,
			occurred_at_ms INTEGER NOT NULL,
			hlc_wall_ms INTEGER NOT NULL,
			hlc_counter INTEGER NOT NULL,
			observed_elapsed_ms INTEGER NOT NULL,
			UNIQUE(device_id, device_sequence)
		) STRICT`,
			`CREATE INDEX timer_commands_order_idx ON timer_commands(hlc_wall_ms, hlc_counter, device_id, id)`,
			`CREATE TRIGGER timer_commands_no_update BEFORE UPDATE ON timer_commands
		BEGIN SELECT RAISE(ABORT, 'timer commands are immutable'); END`,
			`CREATE TRIGGER timer_commands_no_delete BEFORE DELETE ON timer_commands
		BEGIN SELECT RAISE(ABORT, 'timer commands are immutable'); END`,
			`CREATE TABLE command_outcomes (
			command_id TEXT PRIMARY KEY REFERENCES timer_commands(id) ON DELETE CASCADE,
			outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'ignored', 'rejected')),
			reason TEXT NOT NULL
		) STRICT`,
			`CREATE TABLE account_state (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			revision INTEGER NOT NULL,
			current_timer_id TEXT
		) STRICT`,
			`INSERT INTO account_state(singleton, revision, current_timer_id) VALUES (1, 0, NULL)`,
			`CREATE TABLE timer_sessions (
			timer_id TEXT PRIMARY KEY,
			task_id TEXT,
			phase TEXT NOT NULL,
			status TEXT NOT NULL,
			planned_duration_ms INTEGER NOT NULL,
			elapsed_at_anchor_ms INTEGER NOT NULL,
			anchor_at_ms INTEGER NOT NULL,
			started_at_ms INTEGER NOT NULL,
			ended_at_ms INTEGER,
			last_command_id TEXT NOT NULL,
			terminal_command_id TEXT,
			superseded_by_timer_id TEXT
		) STRICT`,
		}
	} else if version == 1 {
		statements = []string{
			`ALTER TABLE timer_commands ADD COLUMN task_id TEXT`,
			`ALTER TABLE timer_sessions ADD COLUMN task_id TEXT`,
		}
	}
	if version < 2 {
		statements = append(statements,
			`CREATE TABLE task_operations (
			id TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			task_id TEXT NOT NULL,
			operation_type TEXT NOT NULL CHECK (operation_type IN ('upsert', 'delete')),
			title TEXT NOT NULL,
			occurred_at TEXT NOT NULL,
			occurred_at_ms INTEGER NOT NULL,
			hlc_wall_ms INTEGER NOT NULL,
			hlc_counter INTEGER NOT NULL
		) STRICT`,
			`CREATE INDEX task_operations_order_idx ON task_operations(task_id, hlc_wall_ms, hlc_counter, device_id, id)`,
			`CREATE TRIGGER task_operations_no_update BEFORE UPDATE ON task_operations
		BEGIN SELECT RAISE(ABORT, 'task operations are immutable'); END`,
			`CREATE TRIGGER task_operations_no_delete BEFORE DELETE ON task_operations
		BEGIN SELECT RAISE(ABORT, 'task operations are immutable'); END`,
		)
	}
	if version < 3 {
		statements = append(statements,
			`CREATE TABLE duration_operations (
			id TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			phase TEXT NOT NULL CHECK (phase IN ('focus', 'short_break', 'long_break')),
			duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 60000 AND 10800000 AND duration_ms % 60000 = 0),
			occurred_at TEXT NOT NULL,
			occurred_at_ms INTEGER NOT NULL,
			hlc_wall_ms INTEGER NOT NULL CHECK (hlc_wall_ms >= 0),
			hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0)
		) STRICT`,
			`CREATE INDEX duration_operations_order_idx ON duration_operations(phase, hlc_wall_ms, hlc_counter, device_id, id)`,
			`CREATE TRIGGER duration_operations_no_update BEFORE UPDATE ON duration_operations
		BEGIN SELECT RAISE(ABORT, 'duration operations are immutable'); END`,
			`CREATE TRIGGER duration_operations_no_delete BEFORE DELETE ON duration_operations
		BEGIN SELECT RAISE(ABORT, 'duration operations are immutable'); END`,
		)
	}
	if version < 4 {
		statements = append(statements,
			`CREATE TABLE maintenance_flags (
			name TEXT PRIMARY KEY CHECK (name = 'bootstrap_replace')
		) STRICT`,
			`CREATE TABLE bootstrap_resolutions (
			request_id TEXT PRIMARY KEY,
			payload_hash BLOB NOT NULL CHECK (length(payload_hash) = 32),
			response_json TEXT NOT NULL CHECK (json_valid(response_json)),
			created_at_ms INTEGER NOT NULL
		) STRICT`,
		)
	}
	if version < 5 {
		statements = append(statements,
			`CREATE TABLE auto_start_operations (
			id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 128),
			device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 8 AND 128),
			enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
			occurred_at TEXT NOT NULL,
			occurred_at_ms INTEGER NOT NULL,
			hlc_wall_ms INTEGER NOT NULL CHECK (hlc_wall_ms >= 0),
			hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0)
		) STRICT`,
			`CREATE INDEX auto_start_operations_order_idx ON auto_start_operations(hlc_wall_ms, hlc_counter, device_id, id)`,
			`CREATE TRIGGER auto_start_operations_no_update BEFORE UPDATE ON auto_start_operations
		BEGIN SELECT RAISE(ABORT, 'auto-start operations are immutable'); END`,
		)
	}
	if version < 6 {
		statements = append(statements,
			`CREATE TABLE selected_task_operations (
			id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 128),
			device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 8 AND 128),
			task_id TEXT CHECK (task_id IS NULL OR length(task_id) BETWEEN 8 AND 128),
			occurred_at TEXT NOT NULL,
			occurred_at_ms INTEGER NOT NULL,
			hlc_wall_ms INTEGER NOT NULL CHECK (hlc_wall_ms >= 0),
			hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0)
		) STRICT`,
			`CREATE INDEX selected_task_operations_order_idx ON selected_task_operations(hlc_wall_ms, hlc_counter, device_id, id)`,
			`CREATE TRIGGER selected_task_operations_no_update BEFORE UPDATE ON selected_task_operations
		BEGIN SELECT RAISE(ABORT, 'selected-task operations are immutable'); END`,
		)
	}
	for _, statement := range statements {
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate user database: %w", err)
		}
	}
	if version < 6 {
		immutableTables := []struct {
			table   string
			trigger string
			message string
		}{
			{table: "timer_commands", trigger: "timer_commands_no_delete", message: "timer commands are immutable"},
			{table: "task_operations", trigger: "task_operations_no_delete", message: "task operations are immutable"},
			{table: "duration_operations", trigger: "duration_operations_no_delete", message: "duration operations are immutable"},
			{table: "auto_start_operations", trigger: "auto_start_operations_no_delete", message: "auto-start operations are immutable"},
			{table: "selected_task_operations", trigger: "selected_task_operations_no_delete", message: "selected-task operations are immutable"},
		}
		for _, immutable := range immutableTables {
			var tableCount int
			if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?`, immutable.table).Scan(&tableCount); err != nil {
				return fmt.Errorf("inspect immutable table %s: %w", immutable.table, err)
			}
			if tableCount == 0 {
				continue
			}
			if _, err := conn.ExecContext(ctx, "DROP TRIGGER IF EXISTS "+immutable.trigger); err != nil {
				return fmt.Errorf("replace immutable trigger %s: %w", immutable.trigger, err)
			}
			statement := fmt.Sprintf(`CREATE TRIGGER %s BEFORE DELETE ON %s
			WHEN NOT EXISTS (SELECT 1 FROM maintenance_flags WHERE name = 'bootstrap_replace')
			BEGIN SELECT RAISE(ABORT, '%s'); END`, immutable.trigger, immutable.table, immutable.message)
			if _, err := conn.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("create immutable trigger %s: %w", immutable.trigger, err)
			}
		}
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return fmt.Errorf("set schema version: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		return fmt.Errorf("commit migration: %w", err)
	}
	return nil
}

func unixMilli(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UnixMilli()
}
