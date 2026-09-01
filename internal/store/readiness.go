package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const readinessInventoryLimit = 4096

type readinessFailure struct {
	code string
	err  error
}

func (e *readinessFailure) Error() string {
	return e.err.Error()
}

func (e *readinessFailure) Unwrap() error {
	return e.err
}

func ReadinessErrorCode(err error) string {
	var failure *readinessFailure
	if errors.As(err, &failure) {
		return failure.code
	}
	return "storage_unavailable"
}

func readinessError(code string, err error) error {
	return &readinessFailure{code: code, err: err}
}

// Ready verifies runtime storage and lifecycle dependencies without changing them.
func (s *Store) Ready(ctx context.Context) error {
	if err := validateReadinessDirectory(ctx, s.usersDir); err != nil {
		return readinessError("storage_unavailable", err)
	}
	if err := validateReadinessDirectory(ctx, s.deletionLedgerDir); err != nil {
		return readinessError("ledger_unavailable", err)
	}
	if err := validateIndependentDeletionLedger(filepath.Dir(s.usersDir), s.deletionLedgerDir); err != nil {
		return readinessError("ledger_unavailable", err)
	}
	ledgerEntries, err := readinessEntries(ctx, s.deletionLedgerDir)
	if err != nil {
		return readinessError("ledger_unavailable", err)
	}
	if err := s.validateReadinessLedger(ctx, ledgerEntries); err != nil {
		return readinessError("lifecycle_invalid", err)
	}
	accountEntries, err := readinessEntries(ctx, s.usersDir)
	if err != nil {
		return readinessError("storage_unavailable", err)
	}
	return s.validateReadinessAccounts(ctx, accountEntries)
}

func validateReadinessDirectory(ctx context.Context, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect readiness directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("readiness path is not a directory")
	}
	if info.Mode().Perm() != 0o700 {
		return errors.New("readiness directory permissions are unsafe or unusable")
	}
	return nil
}

func readinessEntries(ctx context.Context, path string) ([]os.DirEntry, error) {
	directory, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open readiness directory: %w", err)
	}
	entries, readErr := directory.ReadDir(readinessInventoryLimit + 1)
	closeErr := directory.Close()
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return nil, fmt.Errorf("read readiness directory: %w", readErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close readiness directory: %w", closeErr)
	}
	if len(entries) > readinessInventoryLimit {
		return nil, errors.New("readiness inventory exceeds bounded limit")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}

func (s *Store) validateReadinessLedger(ctx context.Context, entries []os.DirEntry) error {
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.validateReadinessLedgerEntry(entry); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) validateReadinessLedgerEntry(entry os.DirEntry) error {
	name := entry.Name()
	switch {
	case strings.HasPrefix(name, "account-"):
		return s.validateReadinessLifecycleFile(entry, name)
	case strings.HasPrefix(name, "receipt-"):
		return s.validateReadinessReceiptFile(entry, name)
	case isDeletionRecordName(name):
		return s.validateReadinessDeletionFile(entry, name)
	default:
		return nil
	}
}

func (s *Store) validateReadinessLifecycleFile(entry os.DirEntry, name string) error {
	if err := validateReadinessLedgerFile(entry); err != nil {
		return err
	}
	return s.validateAccountLifecycleEntry(name)
}

func (s *Store) validateReadinessReceiptFile(entry os.DirEntry, name string) error {
	if err := validateReadinessLedgerFile(entry); err != nil {
		return err
	}
	return s.validateReadinessReceipt(name)
}

func (s *Store) validateReadinessDeletionFile(entry os.DirEntry, name string) error {
	if err := validateReadinessLedgerFile(entry); err != nil {
		return err
	}
	_, err := readDeletionRecord(filepath.Join(s.deletionLedgerDir, name))
	return err
}

func validateReadinessLedgerFile(entry os.DirEntry) error {
	info, err := entry.Info()
	if err != nil {
		return fmt.Errorf("inspect readiness ledger file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return errors.New("readiness ledger file has unsafe or unusable metadata")
	}
	return nil
}

func (s *Store) validateReadinessReceipt(name string) error {
	digest := strings.TrimSuffix(strings.TrimPrefix(name, "receipt-"), ".json")
	if len(digest) != 64 || name != "receipt-"+digest+".json" || strings.Trim(digest, "0123456789abcdef") != "" {
		return errors.New("deletion receipt ledger contains an invalid filename")
	}
	var receipt DeletionReceipt
	found, err := readPrivateJSON(filepath.Join(s.deletionLedgerDir, name), &receipt)
	if err != nil || !found {
		return fmt.Errorf("read deletion receipt inventory: %w", err)
	}
	if !validDeletionReceipt(receipt, "bearer") && !validDeletionReceipt(receipt, "cookie") {
		return errors.New("deletion receipt inventory contains an invalid record")
	}
	return nil
}

func isDeletionRecordName(name string) bool {
	digest := strings.TrimSuffix(name, ".json")
	return name == digest+".json" && len(digest) == 64 && strings.Trim(digest, "0123456789abcdef") == ""
}

func (s *Store) validateReadinessAccounts(ctx context.Context, entries []os.DirEntry) error {
	accounts := make(map[string]bool)
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return readinessError("storage_unavailable", err)
		}
		if err := s.collectReadinessAccount(entry, accounts); err != nil {
			return readinessError("storage_unavailable", err)
		}
	}
	return s.validateReadinessAccountInventory(ctx, accounts)
}

func (s *Store) collectReadinessAccount(entry os.DirEntry, accounts map[string]bool) error {
	name := entry.Name()
	userID := accountStorageUserID(name)
	if userID == "" {
		if hasAccountStorageSuffix(name) {
			return errors.New("account storage filename is invalid")
		}
		return nil
	}
	if err := validateReadinessDatabaseFile(filepath.Join(s.usersDir, name)); err != nil {
		return err
	}
	if strings.HasSuffix(name, ".sqlite") {
		accounts[userID] = true
	} else if _, exists := accounts[userID]; !exists {
		accounts[userID] = false
	}
	return nil
}

func (s *Store) validateReadinessAccountInventory(ctx context.Context, accounts map[string]bool) error {
	userIDs := make([]string, 0, len(accounts))
	for userID := range accounts {
		userIDs = append(userIDs, userID)
	}
	sort.Strings(userIDs)
	for _, userID := range userIDs {
		hasDatabase := accounts[userID]
		if !hasDatabase {
			return readinessError("storage_unavailable", errors.New("account sidecar lacks its database"))
		}
		if err := s.validateReadinessAccount(ctx, userID); err != nil {
			return err
		}
	}
	return nil
}

func hasAccountStorageSuffix(name string) bool {
	return strings.HasSuffix(name, ".sqlite") || strings.HasSuffix(name, ".sqlite-wal") || strings.HasSuffix(name, ".sqlite-shm")
}

func (s *Store) validateReadinessAccount(ctx context.Context, userID string) error {
	path := filepath.Join(s.usersDir, userID+".sqlite")
	if err := validateReadinessDatabaseFile(path); err != nil {
		return readinessError("storage_unavailable", err)
	}
	db, err := openReadinessDatabase(path)
	if err != nil {
		return readinessError("database_unavailable", err)
	}
	generation, checkErr := validateReadinessDatabase(ctx, db)
	closeErr := db.Close()
	if checkErr != nil {
		return readinessError("database_unavailable", checkErr)
	}
	if closeErr != nil {
		return readinessError("database_unavailable", closeErr)
	}
	if err := s.validateReadinessLifecycle(userID, generation); err != nil {
		return readinessError("lifecycle_invalid", err)
	}
	return nil
}

func validateReadinessDatabaseFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect account database: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return errors.New("account database has unsafe metadata")
	}
	return nil
}

func openReadinessDatabase(path string) (*sql.DB, error) {
	walExists, err := readinessSidecarExists(path + "-wal")
	if err != nil {
		return nil, err
	}
	shmExists, err := readinessSidecarExists(path + "-shm")
	if err != nil {
		return nil, err
	}
	if walExists != shmExists {
		return nil, errors.New("account database sidecars are incomplete")
	}
	options := "?mode=ro&_pragma=query_only(ON)&_pragma=busy_timeout(1000)"
	if !walExists {
		options += "&immutable=1"
	}
	dsn := (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String() + options
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open account database read-only: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

func readinessSidecarExists(path string) (bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect account database sidecar: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return false, errors.New("account database sidecar has unsafe metadata")
	}
	return true, nil
}

func validateReadinessDatabase(ctx context.Context, db *sql.DB) (int64, error) {
	if err := db.PingContext(ctx); err != nil {
		return 0, fmt.Errorf("connect to account database: %w", err)
	}
	var queryOnly, version int
	if err := db.QueryRowContext(ctx, `PRAGMA query_only`).Scan(&queryOnly); err != nil || queryOnly != 1 {
		return 0, errors.New("account database is not read-only")
	}
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		return 0, fmt.Errorf("read account schema version: %w", err)
	}
	if version != schemaVersion {
		return 0, fmt.Errorf("account schema version %d is unsupported", version)
	}
	var integrity string
	if err := db.QueryRowContext(ctx, `PRAGMA quick_check(1)`).Scan(&integrity); err != nil || integrity != "ok" {
		return 0, errors.New("account database integrity check failed")
	}
	return accountGeneration(ctx, db)
}

func (s *Store) validateReadinessLifecycle(userID string, generation int64) error {
	path, err := s.ledgerPath(userID)
	if err != nil {
		return err
	}
	deletedGeneration, err := readDeletionRecord(path)
	if err != nil {
		return err
	}
	lifecycle, err := s.accountLifecycle(userID)
	if err != nil {
		return err
	}
	if generation <= deletedGeneration || lifecycle.State != accountStateActive || lifecycle.Generation != generation {
		return errors.New("account database is not bound to current ledger lifecycle")
	}
	return nil
}
