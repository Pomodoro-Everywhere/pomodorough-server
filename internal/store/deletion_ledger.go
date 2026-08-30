package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pomodorough/internal/authn"
)

const deletionRecordVersion = 1

type deletionRecord struct {
	Version           int   `json:"version"`
	DeletedGeneration int64 `json:"deletedGeneration"`
	DeletedAtMS       int64 `json:"deletedAtMs"`
}

func secureDeletionLedgerDirectory(dataDir string) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create deletion ledger directory: %w", err)
	}
	info, err := os.Lstat(dataDir)
	if err != nil {
		return fmt.Errorf("inspect deletion ledger directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("deletion ledger path must be a directory, not a symbolic link")
	}
	if err := os.Chmod(dataDir, 0o700); err != nil {
		return fmt.Errorf("secure deletion ledger directory: %w", err)
	}
	return nil
}

func validateIndependentDeletionLedger(dataDir, deletionLedgerDir string) error {
	dataPath, err := filepath.Abs(dataDir)
	if err != nil {
		return fmt.Errorf("resolve data directory: %w", err)
	}
	ledgerPath, err := filepath.Abs(deletionLedgerDir)
	if err != nil {
		return fmt.Errorf("resolve deletion ledger directory: %w", err)
	}
	relative, err := filepath.Rel(dataPath, ledgerPath)
	if err != nil {
		return fmt.Errorf("compare deletion ledger directory: %w", err)
	}
	if relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return errors.New("deletion ledger directory must be outside DATA_DIR")
	}
	return nil
}

func (s *Store) ledgerPath(userID string) (string, error) {
	if !authn.ValidateUserID(userID) {
		return "", authn.ErrInvalidToken
	}
	digest := sha256.Sum256([]byte(userID))
	return filepath.Join(s.deletionLedgerDir, fmt.Sprintf("%x.json", digest)), nil
}

func (s *Store) deletedGeneration(userID string) (int64, error) {
	path, err := s.ledgerPath(userID)
	if err != nil {
		return 0, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("inspect deletion record: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 4096 {
		return 0, errors.New("deletion record has unsafe metadata")
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("open deletion record: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	var record deletionRecord
	if err := decoder.Decode(&record); err != nil {
		return 0, fmt.Errorf("decode deletion record: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return 0, fmt.Errorf("decode deletion record: %w", err)
	}
	if record.Version != deletionRecordVersion || record.DeletedGeneration < 1 ||
		record.DeletedGeneration > MaxSafeRevision || record.DeletedAtMS < 1 {
		return 0, errors.New("deletion record is invalid")
	}
	return record.DeletedGeneration, nil
}

func requireJSONEnd(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func (s *Store) recordDeletion(userID string, generation int64, now time.Time) error {
	current, err := s.deletedGeneration(userID)
	if err != nil {
		return err
	}
	if current > generation {
		generation = current
	}
	if generation < 1 || generation > MaxSafeRevision {
		return errors.New("account generation is invalid")
	}
	path, err := s.ledgerPath(userID)
	if err != nil {
		return err
	}
	record := deletionRecord{
		Version:           deletionRecordVersion,
		DeletedGeneration: generation,
		DeletedAtMS:       now.UnixMilli(),
	}
	temporaryPath, err := s.writePendingDeletionRecord(record)
	if err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("publish deletion record: %w", err)
	}
	return syncDirectory(s.deletionLedgerDir, "deletion ledger")
}

func (s *Store) writePendingDeletionRecord(record any) (string, error) {
	temporary, err := os.CreateTemp(s.deletionLedgerDir, ".pending-deletion-")
	if err != nil {
		return "", fmt.Errorf("create deletion record: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		return "", fmt.Errorf("secure deletion record: %w", err)
	}
	encoder := json.NewEncoder(temporary)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(record); err != nil {
		cleanup()
		return "", fmt.Errorf("write deletion record: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return "", fmt.Errorf("sync deletion record: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return "", fmt.Errorf("close deletion record: %w", err)
	}
	return temporaryPath, nil
}

func syncDirectory(path, label string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s for sync: %w", label, err)
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if syncErr != nil {
		return fmt.Errorf("sync %s: %w", label, syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close %s: %w", label, closeErr)
	}
	return nil
}

func (s *Store) currentOrNextAccountGeneration(ctx context.Context, path, userID string) (int64, error) {
	deletedGeneration, err := s.deletedGeneration(userID)
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		if deletedGeneration > 0 {
			return deletedGeneration, nil
		}
		return 1, nil
	}
	if err != nil {
		return 0, fmt.Errorf("stat user database: %w", err)
	}
	if !info.Mode().IsRegular() {
		return 0, ErrNotFound
	}
	db, err := openDatabase(ctx, path)
	if err != nil {
		return 0, err
	}
	generation, generationErr := accountGeneration(ctx, db)
	closeErr := db.Close()
	if generationErr != nil {
		return 0, generationErr
	}
	if closeErr != nil {
		return 0, fmt.Errorf("close account before deletion: %w", closeErr)
	}
	if deletedGeneration > generation {
		return deletedGeneration, nil
	}
	return generation, nil
}

func accountGeneration(ctx context.Context, db *sql.DB) (int64, error) {
	var generation int64
	if err := db.QueryRowContext(ctx, `SELECT generation FROM account_metadata WHERE singleton = 1`).Scan(&generation); err != nil {
		return 0, fmt.Errorf("read account generation: %w", err)
	}
	if generation < 1 || generation > MaxSafeRevision {
		return 0, errors.New("account generation is invalid")
	}
	return generation, nil
}

func setAccountGeneration(ctx context.Context, db *sql.DB, generation int64) error {
	if generation < 1 || generation > MaxSafeRevision {
		return errors.New("account generation is invalid")
	}
	result, err := db.ExecContext(ctx, `UPDATE account_metadata SET generation = ? WHERE singleton = 1`, generation)
	if err != nil {
		return fmt.Errorf("write account generation: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return errors.New("account generation row is missing")
	}
	return nil
}

func (s *Store) applyDeletionObligations(ctx context.Context) error {
	paths, err := filepath.Glob(filepath.Join(s.usersDir, "*.sqlite"))
	if err != nil {
		return fmt.Errorf("list account databases for deletion obligations: %w", err)
	}
	for _, path := range paths {
		userID := strings.TrimSuffix(filepath.Base(path), ".sqlite")
		if !authn.ValidateUserID(userID) {
			continue
		}
		deletedGeneration, err := s.deletedGeneration(userID)
		if err != nil {
			return fmt.Errorf("apply deletion obligation: %w", err)
		}
		if deletedGeneration == 0 {
			continue
		}
		db, err := openDatabase(ctx, path)
		if err != nil {
			return fmt.Errorf("inspect account generation for deletion obligation: %w", err)
		}
		generation, generationErr := accountGeneration(ctx, db)
		closeErr := db.Close()
		if generationErr != nil {
			return fmt.Errorf("inspect account generation for deletion obligation: %w", generationErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close account during deletion obligation: %w", closeErr)
		}
		if generation <= deletedGeneration {
			if err := removeUserFiles(path); err != nil {
				return fmt.Errorf("apply deletion obligation: %w", err)
			}
		}
	}
	return nil
}

func removeUserFiles(path string) error {
	for _, candidate := range []string{path + "-wal", path + "-shm", path} {
		if err := os.Remove(candidate); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("delete account storage: %w", err)
		}
	}
	return nil
}
