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
	"sync"
	"time"

	"pomodorough/internal/authn"
)

const deletionRecordVersion = 1

const (
	accountLifecycleVersion = 1
	accountStateActive      = "active"
	accountStateDeleted     = "deleted"
)

var accountLedgerDirectories sync.Map

type deletionRecord struct {
	Version           int   `json:"version"`
	DeletedGeneration int64 `json:"deletedGeneration"`
	DeletedAtMS       int64 `json:"deletedAtMs"`
}

type accountLifecycleRecord struct {
	Version     int    `json:"version"`
	Generation  int64  `json:"generation"`
	State       string `json:"state"`
	UpdatedAtMS int64  `json:"updatedAtMs"`
}

type deferredDeletionCleanupError struct {
	err error
}

func (e *deferredDeletionCleanupError) Error() string {
	return e.err.Error()
}

func (e *deferredDeletionCleanupError) Unwrap() error {
	return e.err
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

func prepareDeletionLedgerDirectory(dataDir, ledgerDir string) error {
	if _, err := os.Lstat(ledgerDir); err == nil {
		return secureDeletionLedgerDirectory(ledgerDir)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect deletion ledger directory: %w", err)
	}
	entries, err := os.ReadDir(filepath.Join(dataDir, "users"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect account data before creating deletion ledger: %w", err)
	}
	for _, entry := range entries {
		if accountStorageUserID(entry.Name()) != "" {
			return errors.New("deletion ledger directory is missing while account databases exist")
		}
	}
	return secureDeletionLedgerDirectory(ledgerDir)
}

func validateIndependentDeletionLedger(dataDir, deletionLedgerDir string) error {
	dataPath, err := physicalPath(dataDir)
	if err != nil {
		return fmt.Errorf("resolve data directory: %w", err)
	}
	ledgerPath, err := physicalPath(deletionLedgerDir)
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

func physicalPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	current, suffix := absolute, []string{}
	for {
		if _, err := os.Lstat(current); err == nil {
			resolved, resolveErr := filepath.EvalSymlinks(current)
			if resolveErr != nil {
				return "", resolveErr
			}
			parts := append([]string{resolved}, suffix...)
			return filepath.Join(parts...), nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", errors.New("no existing parent directory")
		}
		suffix = append([]string{filepath.Base(current)}, suffix...)
		current = parent
	}
}

func registerAccountLedger(usersDir, ledgerDir string) error {
	usersPath, err := physicalPath(usersDir)
	if err != nil {
		return fmt.Errorf("resolve user data directory: %w", err)
	}
	accountLedgerDirectories.Store(usersPath, ledgerDir)
	return nil
}

func (s *Store) ledgerPath(userID string) (string, error) {
	if !authn.ValidateUserID(userID) {
		return "", authn.ErrInvalidToken
	}
	digest := sha256.Sum256([]byte(userID))
	return filepath.Join(s.deletionLedgerDir, fmt.Sprintf("%x.json", digest)), nil
}

func (s *Store) accountLifecyclePath(userID string) (string, error) {
	if !authn.ValidateUserID(userID) {
		return "", authn.ErrInvalidToken
	}
	digest := sha256.Sum256([]byte(userID))
	return filepath.Join(s.deletionLedgerDir, fmt.Sprintf("account-%x.json", digest)), nil
}

func (s *Store) accountLifecycle(userID string) (accountLifecycleRecord, error) {
	path, err := s.accountLifecyclePath(userID)
	if err != nil {
		return accountLifecycleRecord{}, err
	}
	var record accountLifecycleRecord
	found, err := readPrivateJSON(path, &record)
	if err != nil || !found {
		return record, err
	}
	if !validAccountLifecycle(record) {
		return accountLifecycleRecord{}, errors.New("account lifecycle record is invalid")
	}
	return record, nil
}

func (s *Store) validateAccountLifecycleInventory() error {
	entries, err := os.ReadDir(s.deletionLedgerDir)
	if err != nil {
		return fmt.Errorf("list account lifecycle ledger: %w", err)
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "account-") {
			continue
		}
		if err := s.validateAccountLifecycleEntry(entry.Name()); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) validateAccountLifecycleEntry(name string) error {
	digest := strings.TrimSuffix(strings.TrimPrefix(name, "account-"), ".json")
	if len(digest) != sha256.Size*2 || name != "account-"+digest+".json" || strings.Trim(digest, "0123456789abcdef") != "" {
		return errors.New("account lifecycle ledger contains an invalid filename")
	}
	var lifecycle accountLifecycleRecord
	if found, err := readPrivateJSON(filepath.Join(s.deletionLedgerDir, name), &lifecycle); err != nil || !found {
		return fmt.Errorf("read account lifecycle inventory: %w", err)
	}
	if !validAccountLifecycle(lifecycle) {
		return errors.New("account lifecycle inventory contains an invalid record")
	}
	deleted, err := readDeletionRecord(filepath.Join(s.deletionLedgerDir, digest+".json"))
	if err != nil {
		return err
	}
	if lifecycle.State == accountStateDeleted && deleted < lifecycle.Generation {
		return errors.New("deleted account lifecycle lacks its monotonic tombstone")
	}
	return nil
}

func readPrivateJSON(path string, destination any) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect private ledger record: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 4096 {
		return false, errors.New("private ledger record has unsafe metadata")
	}
	file, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("open private ledger record: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return false, fmt.Errorf("decode private ledger record: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return false, fmt.Errorf("decode private ledger record: %w", err)
	}
	return true, nil
}

func validAccountLifecycle(record accountLifecycleRecord) bool {
	return record.Version == accountLifecycleVersion && record.Generation >= 1 &&
		record.Generation <= MaxSafeRevision && record.UpdatedAtMS >= 1 &&
		(record.State == accountStateActive || record.State == accountStateDeleted)
}

func (s *Store) deletedGeneration(userID string) (int64, error) {
	path, err := s.ledgerPath(userID)
	if err != nil {
		return 0, err
	}
	generation, err := readDeletionRecord(path)
	if err != nil {
		return 0, err
	}
	if err := s.validateStoredAccountLifecycle(context.Background(), userID, generation); err != nil {
		return 0, err
	}
	return generation, nil
}

func (s *Store) validateStoredAccountLifecycle(ctx context.Context, userID string, deletedGeneration int64) error {
	path, err := s.userPath(userID)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect account lifecycle binding: %w", err)
	}
	generation, err := readStoredAccountGeneration(ctx, path)
	if err != nil || generation <= deletedGeneration {
		return err
	}
	lifecycle, err := s.accountLifecycle(userID)
	if err != nil {
		return err
	}
	if lifecycle.State != accountStateActive || lifecycle.Generation != generation {
		return errors.New("account database is not bound to current ledger lifecycle")
	}
	return nil
}

func readDeletionRecord(path string) (int64, error) {
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
	if err := syncDirectory(s.deletionLedgerDir, "deletion ledger"); err != nil {
		return err
	}
	return s.recordDeletedAccountLifecycle(userID, generation, now)
}

func (s *Store) recordDeletedAccountLifecycle(userID string, generation int64, now time.Time) error {
	current, err := s.accountLifecycle(userID)
	if err != nil {
		return err
	}
	if current.Generation > generation {
		return nil
	}
	return s.recordAccountLifecycle(userID, generation, accountStateDeleted, now)
}

func (s *Store) recordAccountLifecycle(userID string, generation int64, state string, now time.Time) error {
	current, err := s.accountLifecycle(userID)
	if err != nil {
		return err
	}
	if generation < 1 || generation > MaxSafeRevision || (state != accountStateActive && state != accountStateDeleted) {
		return errors.New("account lifecycle transition is invalid")
	}
	if current.Generation > generation || (current.Generation == generation && current.State == accountStateDeleted && state == accountStateActive) {
		return errors.New("account lifecycle transition would roll back deletion state")
	}
	record := accountLifecycleRecord{Version: accountLifecycleVersion, Generation: generation, State: state, UpdatedAtMS: now.UnixMilli()}
	path, err := s.accountLifecyclePath(userID)
	if err != nil {
		return err
	}
	temporaryPath, err := s.writePendingDeletionRecord(record)
	if err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("publish account lifecycle record: %w", err)
	}
	return syncDirectory(s.deletionLedgerDir, "account lifecycle ledger")
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
	userID, ledgerDir, err := accountLedgerForDatabase(ctx, db)
	if err != nil {
		return err
	}
	ledgerStore := &Store{deletionLedgerDir: ledgerDir}
	if err := ledgerStore.recordAccountLifecycle(userID, generation, accountStateActive, time.Now()); err != nil {
		return err
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

func accountLedgerForDatabase(ctx context.Context, db *sql.DB) (string, string, error) {
	var sequence int
	var name, path string
	if err := db.QueryRowContext(ctx, `PRAGMA database_list`).Scan(&sequence, &name, &path); err != nil {
		return "", "", fmt.Errorf("locate account database: %w", err)
	}
	if sequence != 0 || name != "main" || filepath.Ext(path) != ".sqlite" {
		return "", "", errors.New("account database path is invalid")
	}
	userID := strings.TrimSuffix(filepath.Base(path), ".sqlite")
	if !authn.ValidateUserID(userID) {
		return "", "", errors.New("account database identifier is invalid")
	}
	usersDir, err := physicalPath(filepath.Dir(path))
	if err != nil {
		return "", "", fmt.Errorf("resolve account database directory: %w", err)
	}
	ledgerDir, ok := accountLedgerDirectories.Load(usersDir)
	if !ok {
		return "", "", errors.New("account deletion ledger binding is unavailable")
	}
	return userID, ledgerDir.(string), nil
}

func (s *Store) applyDeletionObligations(ctx context.Context) error {
	userIDs, err := accountStorageUserIDs(s.usersDir)
	if err != nil {
		return fmt.Errorf("list account databases for deletion obligations: %w", err)
	}
	for _, userID := range userIDs {
		if err := s.applyAccountDeletionObligation(ctx, userID); err != nil {
			var deferred *deferredDeletionCleanupError
			if errors.As(err, &deferred) {
				continue
			}
			return fmt.Errorf("apply deletion obligation: %w", err)
		}
	}
	return nil
}

func accountStorageUserIDs(usersDir string) ([]string, error) {
	entries, err := os.ReadDir(usersDir)
	if err != nil {
		return nil, err
	}
	unique := make(map[string]struct{})
	for _, entry := range entries {
		if userID := accountStorageUserID(entry.Name()); userID != "" {
			unique[userID] = struct{}{}
		}
	}
	userIDs := make([]string, 0, len(unique))
	for userID := range unique {
		userIDs = append(userIDs, userID)
	}
	return userIDs, nil
}

func accountStorageUserID(name string) string {
	for _, suffix := range []string{".sqlite", ".sqlite-wal", ".sqlite-shm"} {
		if strings.HasSuffix(name, suffix) {
			userID := strings.TrimSuffix(name, suffix)
			if authn.ValidateUserID(userID) {
				return userID
			}
		}
	}
	return ""
}

func (s *Store) applyAccountDeletionObligation(ctx context.Context, userID string) error {
	path := filepath.Join(s.usersDir, userID+".sqlite")
	deletedGeneration, err := s.deletedGeneration(userID)
	if err != nil {
		return err
	}
	lifecycle, err := s.accountLifecycle(userID)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		if deletedGeneration >= lifecycle.Generation && deletedGeneration > 0 {
			if err := s.recordDeletedAccountLifecycle(userID, deletedGeneration, time.Now()); err != nil {
				return err
			}
			return removeDeferredUserFiles(path)
		}
		return errors.New("account sidecars lack a deletion obligation")
	} else if err != nil {
		return fmt.Errorf("inspect account storage: %w", err)
	}
	generation, err := readStoredAccountGeneration(ctx, path)
	if err != nil {
		return err
	}
	if generation <= deletedGeneration {
		if err := s.recordDeletedAccountLifecycle(userID, generation, time.Now()); err != nil {
			return err
		}
		return removeDeferredUserFiles(path)
	}
	if lifecycle.State != accountStateActive || lifecycle.Generation != generation {
		return errors.New("account database is not bound to current ledger lifecycle")
	}
	return nil
}

func removeDeferredUserFiles(path string) error {
	if err := removeUserFiles(path); err != nil {
		return &deferredDeletionCleanupError{err: err}
	}
	return nil
}

func readStoredAccountGeneration(ctx context.Context, path string) (int64, error) {
	db, err := openDatabase(ctx, path)
	if err != nil {
		return 0, fmt.Errorf("inspect account generation for deletion obligation: %w", err)
	}
	generation, generationErr := accountGeneration(ctx, db)
	closeErr := db.Close()
	if generationErr != nil {
		return 0, fmt.Errorf("inspect account generation for deletion obligation: %w", generationErr)
	}
	if closeErr != nil {
		return 0, fmt.Errorf("close account during deletion obligation: %w", closeErr)
	}
	return generation, nil
}

func removeUserFiles(path string) error {
	for _, candidate := range []string{path + "-wal", path + "-shm", path} {
		if err := os.Remove(candidate); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("delete account storage: %w", err)
		}
	}
	return nil
}
