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
	"time"

	"pomodorough/internal/authn"
)

type DeletionCredential struct {
	TokenHash [sha256.Size]byte
	Method    string
}

type DeletionReceipt struct {
	Version    int    `json:"version"`
	Generation int64  `json:"generation"`
	CSRFHash   []byte `json:"csrfHash,omitempty"`
}

func (s *Store) deletionReceiptPath(userID string, credential DeletionCredential) (string, error) {
	if !authn.ValidateUserID(userID) || credential.TokenHash == [sha256.Size]byte{} ||
		(credential.Method != "bearer" && credential.Method != "cookie") {
		return "", ErrUnauthorized
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("delete-account:%s:%s:%x", userID, credential.Method, credential.TokenHash)))
	return filepath.Join(s.deletionLedgerDir, fmt.Sprintf("receipt-%x.json", digest)), nil
}

func (s *Store) CommittedDeletionReceipt(userID string, credential DeletionCredential) (DeletionReceipt, error) {
	path, err := s.deletionReceiptPath(userID, credential)
	if err != nil {
		return DeletionReceipt{}, err
	}
	receipt, err := readDeletionReceipt(path, credential.Method)
	if err != nil || receipt.Generation == 0 {
		return DeletionReceipt{}, err
	}
	generation, err := s.deletedGeneration(userID)
	if err != nil || generation < receipt.Generation {
		return DeletionReceipt{}, err
	}
	return receipt, nil
}

func readDeletionReceipt(path, method string) (DeletionReceipt, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return DeletionReceipt{}, nil
	}
	if err != nil {
		return DeletionReceipt{}, fmt.Errorf("inspect deletion receipt: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 4096 {
		return DeletionReceipt{}, errors.New("deletion receipt has unsafe metadata")
	}
	file, err := os.Open(path)
	if err != nil {
		return DeletionReceipt{}, fmt.Errorf("open deletion receipt: %w", err)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	var receipt DeletionReceipt
	if err := decoder.Decode(&receipt); err != nil {
		return DeletionReceipt{}, fmt.Errorf("decode deletion receipt: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return DeletionReceipt{}, fmt.Errorf("decode deletion receipt: %w", err)
	}
	if !validDeletionReceipt(receipt, method) {
		return DeletionReceipt{}, errors.New("deletion receipt is invalid")
	}
	return receipt, nil
}

func validDeletionReceipt(receipt DeletionReceipt, method string) bool {
	return receipt.Version == 1 && receipt.Generation >= 1 && receipt.Generation <= MaxSafeRevision &&
		((method == "cookie" && len(receipt.CSRFHash) == sha256.Size) ||
			(method == "bearer" && len(receipt.CSRFHash) == 0))
}

func (s *Store) writeDeletionReceipt(userID string, credential DeletionCredential, receipt DeletionReceipt) error {
	if !validDeletionReceipt(receipt, credential.Method) {
		return errors.New("deletion receipt is invalid")
	}
	path, err := s.deletionReceiptPath(userID, credential)
	if err != nil {
		return err
	}
	temporaryPath, err := s.writePendingDeletionRecord(receipt)
	if err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("publish deletion receipt: %w", err)
	}
	return syncDirectory(s.deletionLedgerDir, "deletion receipt")
}

func (s *Store) DeleteUserWithReceipt(ctx context.Context, userID string, generation int64, credential DeletionCredential, csrfHash []byte) error {
	return s.deleteUserWithReceipt(ctx, userID, generation, credential, csrfHash, nil)
}

// DeleteUserWithReceiptForSession serializes live session revocation with new
// deletion commitments. Committed receipts retain their independent replay path.
func (s *Store) DeleteUserWithReceiptForSession(ctx context.Context, userID string, generation int64, credential DeletionCredential, csrfHash []byte, sessionID string) error {
	return s.deleteUserWithReceipt(ctx, userID, generation, credential, csrfHash, &sessionID)
}

func (s *Store) deleteUserWithReceipt(ctx context.Context, userID string, generation int64, credential DeletionCredential, csrfHash []byte, sessionID *string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	unlock := s.LockUser(userID)
	defer unlock()
	receipt, err := s.CommittedDeletionReceipt(userID, credential)
	if err != nil {
		return err
	}
	if receipt.Generation != 0 {
		if receipt.Generation != generation || (credential.Method == "cookie" && !authn.EqualHash(receipt.CSRFHash, csrfHash)) {
			return ErrUnauthorized
		}
		return s.finishReceiptedDeletion(ctx, userID, generation)
	}
	db, err := s.OpenExistingUser(ctx, userID)
	if err != nil {
		return err
	}
	currentGeneration, generationErr := accountGeneration(ctx, db)
	if generationErr == nil && currentGeneration != generation {
		generationErr = ErrAccountGenerationChanged
	}
	if generationErr == nil && sessionID != nil {
		generationErr = validateDeletionSession(ctx, db, credential, *sessionID)
	}
	closeErr := db.Close()
	if generationErr != nil {
		return generationErr
	}
	if closeErr != nil {
		return fmt.Errorf("close account before deletion receipt: %w", closeErr)
	}
	receipt = DeletionReceipt{Version: 1, Generation: generation, CSRFHash: csrfHash}
	if err := s.writeDeletionReceipt(userID, credential, receipt); err != nil {
		return err
	}
	if err := s.recordDeletion(userID, generation, time.Now()); err != nil {
		return err
	}
	return s.finishReceiptedDeletion(ctx, userID, generation)
}

func validateDeletionSession(ctx context.Context, db *sql.DB, credential DeletionCredential, sessionID string) error {
	expectedKind := "web"
	if credential.Method == "bearer" {
		expectedKind = "access"
	}
	// Admission already checked expiration. Recheck revocation and credential
	// ownership under the account lock without changing in-flight expiry rules.
	var live bool
	err := db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM auth_tokens t JOIN auth_sessions s ON s.id = t.session_id
		WHERE t.token_hash = ? AND t.kind = ? AND s.id = ?
		AND t.revoked_at_ms IS NULL AND s.revoked_at_ms IS NULL
	)`, credential.TokenHash[:], expectedKind, sessionID).Scan(&live)
	if err != nil {
		return fmt.Errorf("validate deletion session: %w", err)
	}
	if !live {
		return ErrUnauthorized
	}
	return nil
}

func (s *Store) finishReceiptedDeletion(ctx context.Context, userID string, generation int64) error {
	if err := syncDirectory(s.deletionLedgerDir, "committed deletion"); err != nil {
		return err
	}
	path, err := s.userPath(userID)
	if err != nil {
		return err
	}
	if err := purgeReceiptedGeneration(ctx, path, generation); err != nil {
		return err
	}
	return syncDirectory(s.usersDir, "deleted account storage")
}

func purgeReceiptedGeneration(ctx context.Context, path string, generation int64) error {
	_, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return removeUserFiles(path)
	}
	if err != nil {
		return fmt.Errorf("inspect receipted account storage: %w", err)
	}
	db, err := openDatabase(ctx, path)
	if err != nil {
		return err
	}
	currentGeneration, generationErr := accountGeneration(ctx, db)
	closeErr := db.Close()
	if generationErr != nil {
		return generationErr
	}
	if closeErr != nil {
		return fmt.Errorf("close receipted account storage: %w", closeErr)
	}
	if currentGeneration > generation {
		return nil
	}
	return removeUserFiles(path)
}
