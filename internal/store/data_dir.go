package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

var (
	ErrDataDirInUse          = errors.New("data directory is in use")
	ErrSchemaVersionMismatch = errors.New("data directory schema version mismatch")
)

type DataDirLock struct {
	file *os.File
}

func CurrentSchemaVersion() int {
	return schemaVersion
}

func AcquireDataDirLock(dataDir string) (*DataDirLock, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(dataDir, ".pomodorough.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open data directory lock: %w", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrDataDirInUse
		}
		return nil, fmt.Errorf("lock data directory: %w", err)
	}
	return &DataDirLock{file: file}, nil
}

func (l *DataDirLock) Close() error {
	if err := syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN); err != nil {
		_ = l.file.Close()
		return fmt.Errorf("unlock data directory: %w", err)
	}
	if err := l.file.Close(); err != nil {
		return fmt.Errorf("close data directory lock: %w", err)
	}
	return nil
}

func VerifyDataDirSchemaVersion(ctx context.Context, dataDir string) error {
	paths, err := filepath.Glob(filepath.Join(dataDir, "users", "*.sqlite"))
	if err != nil {
		return fmt.Errorf("list user databases: %w", err)
	}
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil {
			return fmt.Errorf("inspect user database %s: %w", filepath.Base(path), err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("inspect user database %s: not a regular file", filepath.Base(path))
		}
		dsn := "file:" + filepath.ToSlash(path) + "?mode=ro&_pragma=query_only(ON)"
		db, err := sql.Open("sqlite", dsn)
		if err != nil {
			return fmt.Errorf("inspect user database %s: %w", filepath.Base(path), err)
		}
		var version int
		err = db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version)
		closeErr := db.Close()
		if err != nil {
			return fmt.Errorf("read user database schema %s: %w", filepath.Base(path), err)
		}
		if closeErr != nil {
			return fmt.Errorf("close user database schema check %s: %w", filepath.Base(path), closeErr)
		}
		if version != schemaVersion {
			return fmt.Errorf("%w: %s has version %d, current binary requires %d", ErrSchemaVersionMismatch, filepath.Base(path), version, schemaVersion)
		}
	}
	return nil
}
