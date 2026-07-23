package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pomodorough/internal/authn"
)

type Profile struct {
	ID        string `json:"id"`
	Issuer    string `json:"-"`
	Subject   string `json:"-"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl"`
}

type Session struct {
	ID        string
	Kind      string
	DeviceID  string
	Platform  string
	CSRFHash  []byte
	CreatedAt time.Time
	ExpiresAt time.Time
}

type TokenRecord struct {
	Hash      [sha256.Size]byte
	Kind      string
	CreatedAt time.Time
	ExpiresAt time.Time
}

type AuthInfo struct {
	Profile   Profile
	SessionID string
	Kind      string
	DeviceID  string
	CSRFHash  []byte
}

type SessionTokens struct {
	Session Session
	Tokens  []TokenRecord
}

func UpsertProfile(ctx context.Context, db *sql.DB, profile Profile, now time.Time) error {
	if err := upsertProfile(ctx, db, profile, now); err != nil {
		return fmt.Errorf("upsert profile: %w", err)
	}
	return nil
}

func upsertProfile(ctx context.Context, target contextExecer, profile Profile, now time.Time) error {
	_, err := target.ExecContext(ctx, `INSERT INTO profile(
		singleton, user_id, issuer, subject, email, email_verified, name, avatar_url, updated_at_ms
	) VALUES (1, ?, ?, ?, ?, 1, ?, ?, ?)
	ON CONFLICT(singleton) DO UPDATE SET
		user_id = excluded.user_id,
		issuer = excluded.issuer,
		subject = excluded.subject,
		email = excluded.email,
		email_verified = excluded.email_verified,
		name = excluded.name,
		avatar_url = excluded.avatar_url,
		updated_at_ms = excluded.updated_at_ms`,
		profile.ID, profile.Issuer, profile.Subject, profile.Email, profile.Name, profile.AvatarURL, now.UnixMilli())
	return err
}

func ProfileByID(ctx context.Context, db *sql.DB) (Profile, error) {
	var profile Profile
	err := db.QueryRowContext(ctx, `SELECT user_id, issuer, subject, email, name, avatar_url FROM profile WHERE singleton = 1`).Scan(
		&profile.ID, &profile.Issuer, &profile.Subject, &profile.Email, &profile.Name, &profile.AvatarURL,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Profile{}, ErrUnauthorized
	}
	if err != nil {
		return Profile{}, fmt.Errorf("read profile: %w", err)
	}
	return profile, nil
}

func CreateSession(ctx context.Context, db *sql.DB, session Session, tokens []TokenRecord) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin session: %w", err)
	}
	defer tx.Rollback()
	if err := insertSession(ctx, tx, session, tokens); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit session: %w", err)
	}
	return nil
}

func ProvisionProfileAndSessions(ctx context.Context, db *sql.DB, profile Profile, now time.Time, sessions []SessionTokens) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin account provisioning: %w", err)
	}
	defer tx.Rollback()
	if err := upsertProfile(ctx, tx, profile, now); err != nil {
		return fmt.Errorf("provision profile: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_tokens SET revoked_at_ms = COALESCE(revoked_at_ms, ?)
		WHERE session_id IN (SELECT id FROM auth_sessions WHERE kind = 'native')`, now.UnixMilli()); err != nil {
		return fmt.Errorf("revoke replaced native session tokens: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ?)
		WHERE kind = 'native'`, now.UnixMilli()); err != nil {
		return fmt.Errorf("revoke replaced native sessions: %w", err)
	}
	for _, entry := range sessions {
		if err := insertSession(ctx, tx, entry.Session, entry.Tokens); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit account provisioning: %w", err)
	}
	return nil
}

type contextExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func insertSession(ctx context.Context, target contextExecer, session Session, tokens []TokenRecord) error {
	if session.DeviceID != "" {
		if _, err := target.ExecContext(ctx, `INSERT INTO devices(id, platform, created_at_ms, last_seen_at_ms, revoked_at_ms)
			VALUES (?, ?, ?, ?, NULL)
			ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, last_seen_at_ms = excluded.last_seen_at_ms, revoked_at_ms = NULL`,
			session.DeviceID, session.Platform, session.CreatedAt.UnixMilli(), session.CreatedAt.UnixMilli()); err != nil {
			return fmt.Errorf("upsert device: %w", err)
		}
	}
	var deviceID any
	if session.DeviceID != "" {
		deviceID = session.DeviceID
	}
	var csrfHash any
	if len(session.CSRFHash) != 0 {
		csrfHash = session.CSRFHash
	}
	if _, err := target.ExecContext(ctx, `INSERT INTO auth_sessions(
		id, kind, device_id, platform, csrf_hash, created_at_ms, expires_at_ms, revoked_at_ms, reuse_detected_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`, session.ID, session.Kind, deviceID, session.Platform, csrfHash, session.CreatedAt.UnixMilli(), session.ExpiresAt.UnixMilli()); err != nil {
		return fmt.Errorf("insert session: %w", err)
	}
	for _, token := range tokens {
		if _, err := target.ExecContext(ctx, `INSERT INTO auth_tokens(token_hash, session_id, kind, created_at_ms, expires_at_ms, used_at_ms, revoked_at_ms)
			VALUES (?, ?, ?, ?, ?, NULL, NULL)`, token.Hash[:], session.ID, token.Kind, token.CreatedAt.UnixMilli(), token.ExpiresAt.UnixMilli()); err != nil {
			return fmt.Errorf("insert auth token: %w", err)
		}
	}
	return nil
}

func Authenticate(ctx context.Context, db *sql.DB, tokenHash [sha256.Size]byte, expectedKind string, now time.Time) (AuthInfo, error) {
	var (
		storedHash                                  []byte
		tokenKind, sessionID, sessionKind, deviceID string
		tokenExpires, sessionExpires                int64
		tokenRevoked, sessionRevoked                sql.NullInt64
		csrfHash                                    []byte
		profile                                     Profile
	)
	err := db.QueryRowContext(ctx, `SELECT
		t.token_hash, t.kind, t.expires_at_ms, t.revoked_at_ms,
		s.id, s.kind, COALESCE(s.device_id, ''), s.expires_at_ms, s.revoked_at_ms, COALESCE(s.csrf_hash, X''),
		p.user_id, p.issuer, p.subject, p.email, p.name, p.avatar_url
	FROM auth_tokens t
	JOIN auth_sessions s ON s.id = t.session_id
	JOIN profile p ON p.singleton = 1
	WHERE t.token_hash = ?`, tokenHash[:]).Scan(
		&storedHash, &tokenKind, &tokenExpires, &tokenRevoked,
		&sessionID, &sessionKind, &deviceID, &sessionExpires, &sessionRevoked, &csrfHash,
		&profile.ID, &profile.Issuer, &profile.Subject, &profile.Email, &profile.Name, &profile.AvatarURL,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthInfo{}, ErrUnauthorized
	}
	if err != nil {
		return AuthInfo{}, fmt.Errorf("authenticate token: %w", err)
	}
	nowMS := now.UnixMilli()
	if !authn.EqualHash(storedHash, tokenHash[:]) || tokenKind != expectedKind || tokenRevoked.Valid || sessionRevoked.Valid || tokenExpires <= nowMS || sessionExpires <= nowMS {
		return AuthInfo{}, ErrUnauthorized
	}
	return AuthInfo{Profile: profile, SessionID: sessionID, Kind: sessionKind, DeviceID: deviceID, CSRFHash: csrfHash}, nil
}

func UpdateCSRF(ctx context.Context, db *sql.DB, sessionID string, csrfHash [sha256.Size]byte) error {
	result, err := db.ExecContext(ctx, `UPDATE auth_sessions SET csrf_hash = ? WHERE id = ? AND revoked_at_ms IS NULL`, csrfHash[:], sessionID)
	if err != nil {
		return fmt.Errorf("update CSRF token: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return ErrUnauthorized
	}
	return nil
}

func RevokeSession(ctx context.Context, db *sql.DB, sessionID string, now time.Time) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin session revocation: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ?) WHERE id = ?`, now.UnixMilli(), sessionID); err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_tokens SET revoked_at_ms = COALESCE(revoked_at_ms, ?) WHERE session_id = ?`, now.UnixMilli(), sessionID); err != nil {
		return fmt.Errorf("revoke session tokens: %w", err)
	}
	return tx.Commit()
}

func RevokeDevice(ctx context.Context, db *sql.DB, deviceID string, now time.Time) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin device revocation: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at_ms = COALESCE(revoked_at_ms, ?) WHERE id = ?`, now.UnixMilli(), deviceID); err != nil {
		return fmt.Errorf("revoke device: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ?) WHERE device_id = ?`, now.UnixMilli(), deviceID); err != nil {
		return fmt.Errorf("revoke device sessions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_tokens SET revoked_at_ms = COALESCE(revoked_at_ms, ?)
		WHERE session_id IN (SELECT id FROM auth_sessions WHERE device_id = ?)`, now.UnixMilli(), deviceID); err != nil {
		return fmt.Errorf("revoke device tokens: %w", err)
	}
	return tx.Commit()
}

func RotateRefresh(ctx context.Context, db *sql.DB, oldHash [sha256.Size]byte, access, refresh TokenRecord, now time.Time) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin refresh rotation: %w", err)
	}
	defer tx.Rollback()
	var (
		storedHash                []byte
		sessionID, kind           string
		expiresAt, sessionExpires int64
		usedAt, revokedAt         sql.NullInt64
		sessionRevoked            sql.NullInt64
	)
	err = tx.QueryRowContext(ctx, `SELECT t.token_hash, t.session_id, t.kind, t.expires_at_ms, t.used_at_ms, t.revoked_at_ms,
		s.expires_at_ms, s.revoked_at_ms
	FROM auth_tokens t JOIN auth_sessions s ON s.id = t.session_id WHERE t.token_hash = ?`, oldHash[:]).Scan(
		&storedHash, &sessionID, &kind, &expiresAt, &usedAt, &revokedAt, &sessionExpires, &sessionRevoked,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return fmt.Errorf("read refresh token: %w", err)
	}
	if !authn.EqualHash(storedHash, oldHash[:]) || kind != "refresh" {
		return ErrUnauthorized
	}
	if usedAt.Valid {
		if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ?), reuse_detected_at_ms = ? WHERE id = ?`, now.UnixMilli(), now.UnixMilli(), sessionID); err != nil {
			return fmt.Errorf("revoke reused session: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE auth_tokens SET revoked_at_ms = COALESCE(revoked_at_ms, ?) WHERE session_id = ?`, now.UnixMilli(), sessionID); err != nil {
			return fmt.Errorf("revoke reused token family: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit reuse revocation: %w", err)
		}
		return ErrRefreshReuse
	}
	nowMS := now.UnixMilli()
	if revokedAt.Valid || sessionRevoked.Valid || expiresAt <= nowMS || sessionExpires <= nowMS {
		return ErrUnauthorized
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_tokens SET used_at_ms = ? WHERE token_hash = ? AND used_at_ms IS NULL`, nowMS, oldHash[:]); err != nil {
		return fmt.Errorf("consume refresh token: %w", err)
	}
	for _, token := range []TokenRecord{access, refresh} {
		if _, err := tx.ExecContext(ctx, `INSERT INTO auth_tokens(token_hash, session_id, kind, created_at_ms, expires_at_ms, used_at_ms, revoked_at_ms)
			VALUES (?, ?, ?, ?, ?, NULL, NULL)`, token.Hash[:], sessionID, token.Kind, token.CreatedAt.UnixMilli(), token.ExpiresAt.UnixMilli()); err != nil {
			return fmt.Errorf("insert rotated token: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET expires_at_ms = ? WHERE id = ?`, refresh.ExpiresAt.UnixMilli(), sessionID); err != nil {
		return fmt.Errorf("extend refresh session: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit refresh rotation: %w", err)
	}
	return nil
}
