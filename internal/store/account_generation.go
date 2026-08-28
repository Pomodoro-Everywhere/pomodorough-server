package store

import (
	"context"
	"database/sql"
	"fmt"
)

func (s *Store) ValidateAccountGeneration(ctx context.Context, userID string, generation int64) error {
	_, err := withAccountGeneration(s, ctx, userID, generation, func(*sql.DB) (struct{}, error) {
		return struct{}{}, nil
	})
	return err
}

func withAccountGeneration[T any](s *Store, ctx context.Context, userID string, generation int64, operation func(*sql.DB) (T, error)) (T, error) {
	var zero T
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	unlock := s.LockUser(userID)
	defer unlock()
	db, err := s.OpenExistingUser(ctx, userID)
	if err != nil {
		return zero, err
	}
	currentGeneration, err := accountGeneration(ctx, db)
	if err != nil {
		db.Close()
		return zero, err
	}
	if currentGeneration != generation {
		db.Close()
		return zero, ErrAccountGenerationChanged
	}
	result, operationErr := operation(db)
	closeErr := db.Close()
	if operationErr != nil {
		return zero, operationErr
	}
	if closeErr != nil {
		return zero, fmt.Errorf("close account generation: %w", closeErr)
	}
	return result, nil
}
