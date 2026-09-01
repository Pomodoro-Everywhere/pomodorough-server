package store

import (
	"context"
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
	schemaVersion   = 7
	MaxSafeRevision = int64(9_007_199_254_740_991)
)

var (
	ErrNotFound                 = errors.New("user database not found")
	ErrUnauthorized             = errors.New("unauthorized")
	ErrRefreshReuse             = errors.New("refresh token reuse detected")
	ErrRevisionConflict         = errors.New("revision conflict")
	ErrRevisionExhausted        = errors.New("canonical revision exhausted")
	ErrRequestIDConflict        = errors.New("request ID conflict")
	ErrAccountDeleted           = errors.New("account generation was deleted")
	ErrAccountGenerationChanged = errors.New("authenticated account generation changed")
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
	usersDir          string
	deletionLedgerDir string
	locksMu           sync.Mutex
	locks             map[string]*userLock
}

type userLock struct {
	mutex sync.Mutex
	refs  int
}

func New(dataDir string) (*Store, error) {
	return NewWithDeletionLedger(dataDir, dataDir+"-deletion-ledger")
}

func NewWithDeletionLedger(dataDir, deletionLedgerDir string) (*Store, error) {
	if err := validateIndependentDeletionLedger(dataDir, deletionLedgerDir); err != nil {
		return nil, err
	}
	usersDir := filepath.Join(dataDir, "users")
	if err := os.MkdirAll(usersDir, 0o700); err != nil {
		return nil, fmt.Errorf("create user data directory: %w", err)
	}
	if err := os.Chmod(usersDir, 0o700); err != nil {
		return nil, fmt.Errorf("secure user data directory: %w", err)
	}
	if err := prepareDeletionLedgerDirectory(dataDir, deletionLedgerDir); err != nil {
		return nil, err
	}
	if err := validateIndependentDeletionLedger(dataDir, deletionLedgerDir); err != nil {
		return nil, err
	}
	store := &Store{
		usersDir:          usersDir,
		deletionLedgerDir: deletionLedgerDir,
		locks:             make(map[string]*userLock),
	}
	if err := registerAccountLedger(usersDir, deletionLedgerDir); err != nil {
		return nil, err
	}
	if err := store.validateAccountLifecycleInventory(); err != nil {
		return nil, err
	}
	if err := store.applyDeletionObligations(context.Background()); err != nil {
		return nil, err
	}
	return store, nil
}

// DeleteUser permanently removes an account database and its SQLite sidecars.
// The per-user lock prevents concurrent mutation handlers from reopening the
// account between path validation and deletion. Callers must close their own
// database handle before invoking this method.
func (s *Store) DeleteUser(ctx context.Context, userID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := s.userPath(userID)
	if err != nil {
		return err
	}
	unlock := s.LockUser(userID)
	defer unlock()
	generation, err := s.currentOrNextAccountGeneration(ctx, path, userID)
	if err != nil {
		return err
	}
	if err := s.recordDeletion(userID, generation, time.Now()); err != nil {
		return err
	}
	return removeUserFiles(path)
}

func (s *Store) DeleteUserForGeneration(ctx context.Context, userID string, generation int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := s.userPath(userID)
	if err != nil {
		return err
	}
	unlock := s.LockUser(userID)
	defer unlock()
	db, err := s.OpenExistingUser(ctx, userID)
	if err != nil {
		return err
	}
	currentGeneration, generationErr := accountGeneration(ctx, db)
	closeErr := db.Close()
	if generationErr != nil {
		return generationErr
	}
	if closeErr != nil {
		return fmt.Errorf("close account before deletion: %w", closeErr)
	}
	if currentGeneration != generation {
		return ErrAccountGenerationChanged
	}
	if err := s.recordDeletion(userID, currentGeneration, time.Now()); err != nil {
		return err
	}
	return removeUserFiles(path)
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

func unixMilli(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UnixMilli()
}
