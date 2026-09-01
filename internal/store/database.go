package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	fullSynchronousMode     = 2
	userDatabasePragmaQuery = "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"
)

func (s *Store) OpenUser(ctx context.Context, userID string) (*sql.DB, error) {
	path, err := s.userPath(userID)
	if err != nil {
		return nil, err
	}
	deletedGeneration, err := s.deletedGeneration(userID)
	if err != nil {
		return nil, err
	}
	db, reusable, err := openReusableAccount(ctx, path, deletedGeneration)
	if err != nil || reusable {
		return db, err
	}
	return createAccountDatabase(ctx, path, deletedGeneration)
}

func openReusableAccount(ctx context.Context, path string, deletedGeneration int64) (*sql.DB, bool, error) {
	_, statErr := os.Stat(path)
	if errors.Is(statErr, os.ErrNotExist) {
		return nil, false, nil
	}
	if statErr != nil {
		return nil, false, fmt.Errorf("stat user database: %w", statErr)
	}
	db, err := openDatabase(ctx, path)
	if err != nil {
		return nil, false, err
	}
	generation, err := accountGeneration(ctx, db)
	if err != nil {
		db.Close()
		return nil, false, err
	}
	if generation > deletedGeneration {
		return db, true, nil
	}
	if err := db.Close(); err != nil {
		return nil, false, fmt.Errorf("close deleted account generation: %w", err)
	}
	if err := removeUserFiles(path); err != nil {
		return nil, false, err
	}
	return nil, false, nil
}

func createAccountDatabase(ctx context.Context, path string, deletedGeneration int64) (*sql.DB, error) {
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
	db, err := openDatabase(ctx, path)
	if err != nil {
		return nil, err
	}
	if deletedGeneration == MaxSafeRevision {
		db.Close()
		return nil, ErrRevisionExhausted
	}
	if err := setAccountGeneration(ctx, db, deletedGeneration+1); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
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
	return s.openExistingAccount(ctx, path, userID)
}

func (s *Store) openExistingAccount(ctx context.Context, path, userID string) (*sql.DB, error) {
	db, err := openDatabase(ctx, path)
	if err != nil {
		return nil, err
	}
	generation, err := accountGeneration(ctx, db)
	if err != nil {
		db.Close()
		return nil, err
	}
	deletedGeneration, err := s.deletedGeneration(userID)
	if err != nil {
		db.Close()
		return nil, err
	}
	if generation > deletedGeneration {
		return db, nil
	}
	if err := db.Close(); err != nil {
		return nil, fmt.Errorf("close deleted account generation: %w", err)
	}
	if err := removeUserFiles(path); err != nil {
		return nil, err
	}
	return nil, ErrAccountDeleted
}

func openDatabase(ctx context.Context, path string) (*sql.DB, error) {
	dsn := "file:" + filepath.ToSlash(path) + userDatabasePragmaQuery
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
	if err := verifyDatabaseDurability(ctx, db); err != nil {
		db.Close()
		return nil, fmt.Errorf("verify user database durability: %w", err)
	}
	if err := migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func verifyDatabaseDurability(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire database connection: %w", err)
	}
	defer conn.Close()
	var journalMode string
	if err := conn.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		return fmt.Errorf("read journal mode: %w", err)
	}
	if journalMode != "wal" {
		return fmt.Errorf("journal mode %q; require WAL", journalMode)
	}
	var synchronousMode int
	if err := conn.QueryRowContext(ctx, `PRAGMA synchronous`).Scan(&synchronousMode); err != nil {
		return fmt.Errorf("read synchronous mode: %w", err)
	}
	if synchronousMode != fullSynchronousMode {
		return fmt.Errorf("synchronous mode %d; require FULL (%d)", synchronousMode, fullSynchronousMode)
	}
	return nil
}
