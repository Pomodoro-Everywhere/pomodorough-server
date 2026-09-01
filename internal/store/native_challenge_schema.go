package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	nativeChallengeDatabaseName    = "native-auth.sqlite"
	nativeChallengeSchemaVersion   = 2
	nativeChallengeDatabasePragmas = "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
)

const nativeChallengeSchema = `CREATE TABLE native_auth_challenges (
	digest BLOB PRIMARY KEY CHECK (length(digest) = 32),
	domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 128),
	issued_at_ms INTEGER NOT NULL,
	expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms),
	process_epoch BLOB NOT NULL CHECK (length(process_epoch) = 32)
) STRICT`

const nativeChallengeConsumptionSchema = `CREATE TABLE IF NOT EXISTS native_challenge_consumptions (
	digest BLOB PRIMARY KEY CHECK (length(digest) = 32),
	domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 128),
	issued_at_ms INTEGER NOT NULL,
	expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms),
	consumed_at_ms INTEGER NOT NULL CHECK (consumed_at_ms >= issued_at_ms)
) STRICT`

var (
	nativeChallengeEpochOnce sync.Once
	nativeChallengeEpoch     [32]byte
	nativeChallengeEpochErr  error
)

func currentNativeChallengeEpoch() ([32]byte, error) {
	nativeChallengeEpochOnce.Do(func() {
		_, nativeChallengeEpochErr = rand.Read(nativeChallengeEpoch[:])
	})
	if nativeChallengeEpochErr != nil {
		return [32]byte{}, fmt.Errorf("generate native challenge process epoch: %w", nativeChallengeEpochErr)
	}
	return nativeChallengeEpoch, nil
}

func (s *Store) nativeChallengeDatabasePath() string {
	return filepath.Join(filepath.Dir(s.usersDir), nativeChallengeDatabaseName)
}

func (s *Store) openNativeChallengeDatabase(ctx context.Context) (*sql.DB, error) {
	path := s.nativeChallengeDatabasePath()
	if err := secureNativeChallengeDatabase(path); err != nil {
		return nil, err
	}
	dsn := "file:" + filepath.ToSlash(path) + nativeChallengeDatabasePragmas
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open native challenge database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect to native challenge database: %w", err)
	}
	if err := verifyDatabaseDurability(ctx, db); err != nil {
		db.Close()
		return nil, fmt.Errorf("verify native challenge database durability: %w", err)
	}
	if err := migrateNativeChallengeDatabase(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func secureNativeChallengeDatabase(path string) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("create native challenge database: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close native challenge database: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("secure native challenge database: %w", err)
	}
	return nil
}

func migrateNativeChallengeDatabase(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire native challenge migration connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		return fmt.Errorf("begin native challenge migration: %w", err)
	}
	defer conn.ExecContext(context.Background(), `ROLLBACK`)
	var version int
	if err := conn.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("read native challenge schema version: %w", err)
	}
	if version > nativeChallengeSchemaVersion {
		return fmt.Errorf("native challenge schema %d is newer than supported schema %d", version, nativeChallengeSchemaVersion)
	}
	if err := applyNativeChallengeMigrations(ctx, conn, version); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		return fmt.Errorf("commit native challenge migration: %w", err)
	}
	return nil
}

func applyNativeChallengeMigrations(ctx context.Context, conn *sql.Conn, version int) error {
	if version == 1 {
		if _, err := conn.ExecContext(ctx, `DROP TABLE native_auth_challenges`); err != nil {
			return fmt.Errorf("discard legacy native challenge state: %w", err)
		}
	}
	if version <= 1 {
		if _, err := conn.ExecContext(ctx, nativeChallengeSchema); err != nil {
			return fmt.Errorf("create native challenge schema: %w", err)
		}
		if _, err := conn.ExecContext(ctx, `CREATE INDEX native_auth_challenges_expiry_idx ON native_auth_challenges(expires_at_ms)`); err != nil {
			return fmt.Errorf("index native challenge expiry: %w", err)
		}
		if _, err := conn.ExecContext(ctx, `PRAGMA user_version = 2`); err != nil {
			return fmt.Errorf("set native challenge schema version: %w", err)
		}
	}
	return nil
}
