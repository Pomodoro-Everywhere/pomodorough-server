package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
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
	Profile    Profile
	SessionID  string
	Kind       string
	DeviceID   string
	CSRFHash   []byte
	Generation int64
}

type SessionTokens struct {
	Session Session
	Tokens  []TokenRecord
}

type NativeChallengeConsumption struct {
	Digest  [sha256.Size]byte
	Domain  string
	Now     time.Time
	Profile Profile
	Session Session
	Tokens  []TokenRecord
}

type nativeChallengeIssuance struct {
	issuedAt  time.Time
	expiresAt time.Time
}

type nativeChallengeSpentKey struct {
	registryPath string
	digest       [sha256.Size]byte
}

var nativeChallengeSpent = struct {
	sync.Mutex
	expiresAt map[nativeChallengeSpentKey]int64
}{expiresAt: make(map[nativeChallengeSpentKey]int64)}

func HashNativeChallenge(domain, sealedChallenge string) [sha256.Size]byte {
	hash := sha256.New()
	_, _ = hash.Write([]byte(domain))
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(sealedChallenge))
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return digest
}

func (s *Store) CreateNativeChallenge(ctx context.Context, digest [sha256.Size]byte, domain string, issuedAt, expiresAt time.Time) error {
	if domain == "" || !expiresAt.After(issuedAt) {
		return errors.New("invalid native challenge record")
	}
	epoch, err := currentNativeChallengeEpoch()
	if err != nil {
		return err
	}
	db, err := s.openNativeChallengeDatabase(ctx)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin native challenge creation: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM native_auth_challenges WHERE expires_at_ms <= ?`, issuedAt.UnixMilli()); err != nil {
		return fmt.Errorf("prune native challenges: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO native_auth_challenges(digest, domain, issued_at_ms, expires_at_ms, process_epoch)
		VALUES (?, ?, ?, ?, ?)`, digest[:], domain, issuedAt.UnixMilli(), expiresAt.UnixMilli(), epoch[:]); err != nil {
		return fmt.Errorf("persist native challenge: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit native challenge creation: %w", err)
	}
	return nil
}

func (s *Store) ConsumeNativeChallengeAndCreateSession(ctx context.Context, db *sql.DB, consumption NativeChallengeConsumption) error {
	registry, err := s.openNativeChallengeDatabase(ctx)
	if err != nil {
		return err
	}
	defer registry.Close()
	conn, err := registry.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire native challenge registry connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		return fmt.Errorf("lock native challenge registry: %w", err)
	}
	defer conn.ExecContext(context.Background(), `ROLLBACK`)
	issuance, err := loadNativeChallengeIssuance(ctx, conn, consumption)
	if err != nil {
		return err
	}
	spentKey := nativeChallengeSpentKey{s.nativeChallengeDatabasePath(), consumption.Digest}
	if nativeChallengeWasSpent(spentKey, consumption.Now) {
		return ErrUnauthorized
	}
	consumed, err := s.nativeChallengeConsumed(ctx, db, consumption.Profile.ID, consumption.Digest)
	if err != nil {
		return err
	}
	if consumed {
		return ErrUnauthorized
	}
	if err := commitNativeChallengeAccount(ctx, db, consumption, issuance); err != nil {
		return err
	}
	rememberNativeChallengeSpent(spentKey, issuance.expiresAt)
	return nil
}

func nativeChallengeWasSpent(key nativeChallengeSpentKey, now time.Time) bool {
	nowMS := now.UnixMilli()
	nativeChallengeSpent.Lock()
	defer nativeChallengeSpent.Unlock()
	for candidate, expiresAt := range nativeChallengeSpent.expiresAt {
		if expiresAt <= nowMS {
			delete(nativeChallengeSpent.expiresAt, candidate)
		}
	}
	expiresAt, present := nativeChallengeSpent.expiresAt[key]
	return present && expiresAt > nowMS
}

func rememberNativeChallengeSpent(key nativeChallengeSpentKey, expiresAt time.Time) {
	nativeChallengeSpent.Lock()
	defer nativeChallengeSpent.Unlock()
	nativeChallengeSpent.expiresAt[key] = expiresAt.UnixMilli()
}

func loadNativeChallengeIssuance(ctx context.Context, target *sql.Conn, consumption NativeChallengeConsumption) (nativeChallengeIssuance, error) {
	epoch, err := currentNativeChallengeEpoch()
	if err != nil {
		return nativeChallengeIssuance{}, err
	}
	var issuedMS, expiresMS int64
	err = target.QueryRowContext(ctx, `SELECT issued_at_ms, expires_at_ms FROM native_auth_challenges
		WHERE digest = ? AND domain = ? AND process_epoch = ? AND issued_at_ms <= ? AND expires_at_ms > ?`,
		consumption.Digest[:], consumption.Domain, epoch[:], consumption.Now.UnixMilli(), consumption.Now.UnixMilli()).Scan(&issuedMS, &expiresMS)
	if errors.Is(err, sql.ErrNoRows) {
		return nativeChallengeIssuance{}, ErrUnauthorized
	}
	if err != nil {
		return nativeChallengeIssuance{}, fmt.Errorf("read native challenge issuance: %w", err)
	}
	return nativeChallengeIssuance{time.UnixMilli(issuedMS), time.UnixMilli(expiresMS)}, nil
}

func (s *Store) nativeChallengeConsumed(ctx context.Context, target *sql.DB, targetUserID string, digest [sha256.Size]byte) (bool, error) {
	consumed, err := nativeChallengeConsumedInDatabase(ctx, target, digest)
	if err != nil || consumed {
		return consumed, err
	}
	userIDs, err := accountStorageUserIDs(s.usersDir)
	if err != nil {
		return false, fmt.Errorf("list native challenge account receipts: %w", err)
	}
	for _, userID := range userIDs {
		if userID == targetUserID {
			continue
		}
		consumed, err := s.nativeChallengeConsumedByUser(ctx, userID, digest)
		if err != nil || consumed {
			return consumed, err
		}
	}
	return false, nil
}

func (s *Store) nativeChallengeConsumedByUser(ctx context.Context, userID string, digest [sha256.Size]byte) (bool, error) {
	path, err := s.userPath(userID)
	if err != nil {
		return false, err
	}
	dsn := "file:" + filepath.ToSlash(path) + "?mode=ro&_pragma=query_only(ON)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return false, fmt.Errorf("open native challenge account receipt: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	consumed, err := nativeChallengeConsumedInDatabase(ctx, db, digest)
	if err != nil {
		return false, fmt.Errorf("read native challenge account receipt: %w", err)
	}
	return consumed, nil
}

func nativeChallengeConsumedInDatabase(ctx context.Context, db *sql.DB, digest [sha256.Size]byte) (bool, error) {
	var present int
	err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master
		WHERE type = 'table' AND name = 'native_challenge_consumptions'`).Scan(&present)
	if err != nil {
		return false, err
	}
	if present != 1 {
		return false, nil
	}
	err = db.QueryRowContext(ctx, `SELECT count(*) FROM native_challenge_consumptions WHERE digest = ?`, digest[:]).Scan(&present)
	if err != nil {
		return false, err
	}
	return present == 1, nil
}

func commitNativeChallengeAccount(ctx context.Context, db *sql.DB, consumption NativeChallengeConsumption, issuance nativeChallengeIssuance) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin native challenge account commit: %w", err)
	}
	defer tx.Rollback()
	if err := writeNativeChallengeAccount(ctx, tx, consumption, issuance); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit native challenge account: %w", err)
	}
	return nil
}

func writeNativeChallengeAccount(ctx context.Context, target contextExecer, consumption NativeChallengeConsumption, issuance nativeChallengeIssuance) error {
	if _, err := target.ExecContext(ctx, nativeChallengeConsumptionSchema); err != nil {
		return fmt.Errorf("create native challenge account receipts: %w", err)
	}
	if _, err := target.ExecContext(ctx, `INSERT INTO native_challenge_consumptions(
		digest, domain, issued_at_ms, expires_at_ms, consumed_at_ms
	) VALUES (?, ?, ?, ?, ?)`, consumption.Digest[:], consumption.Domain, issuance.issuedAt.UnixMilli(), issuance.expiresAt.UnixMilli(), consumption.Now.UnixMilli()); err != nil {
		return fmt.Errorf("record native challenge consumption: %w", err)
	}
	if err := upsertProfile(ctx, target, consumption.Profile, consumption.Now); err != nil {
		return fmt.Errorf("provision native profile: %w", err)
	}
	return insertSession(ctx, target, consumption.Session, consumption.Tokens)
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
		generation                                  int64
	)
	err := db.QueryRowContext(ctx, `SELECT
		t.token_hash, t.kind, t.expires_at_ms, t.revoked_at_ms,
		s.id, s.kind, COALESCE(s.device_id, ''), s.expires_at_ms, s.revoked_at_ms, COALESCE(s.csrf_hash, X''),
		p.user_id, p.issuer, p.subject, p.email, p.name, p.avatar_url,
		m.generation
	FROM auth_tokens t
	JOIN auth_sessions s ON s.id = t.session_id
	JOIN profile p ON p.singleton = 1
	JOIN account_metadata m ON m.singleton = 1
	WHERE t.token_hash = ?`, tokenHash[:]).Scan(
		&storedHash, &tokenKind, &tokenExpires, &tokenRevoked,
		&sessionID, &sessionKind, &deviceID, &sessionExpires, &sessionRevoked, &csrfHash,
		&profile.ID, &profile.Issuer, &profile.Subject, &profile.Email, &profile.Name, &profile.AvatarURL,
		&generation,
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
	return AuthInfo{Profile: profile, SessionID: sessionID, Kind: sessionKind, DeviceID: deviceID, CSRFHash: csrfHash, Generation: generation}, nil
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

func (s *Store) UpdateCSRFForGeneration(ctx context.Context, userID string, generation int64, sessionID string, csrfHash [sha256.Size]byte) error {
	_, err := withAccountGeneration(s, ctx, userID, generation, func(db *sql.DB) (struct{}, error) {
		return struct{}{}, UpdateCSRF(ctx, db, sessionID, csrfHash)
	})
	return err
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

func (s *Store) RevokeSessionForGeneration(ctx context.Context, userID string, generation int64, sessionID string, now time.Time) error {
	_, err := withAccountGeneration(s, ctx, userID, generation, func(db *sql.DB) (struct{}, error) {
		return struct{}{}, RevokeSession(ctx, db, sessionID, now)
	})
	return err
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

func (s *Store) RevokeDeviceForGeneration(ctx context.Context, userID string, generation int64, deviceID string, now time.Time) error {
	_, err := withAccountGeneration(s, ctx, userID, generation, func(db *sql.DB) (struct{}, error) {
		return struct{}{}, RevokeDevice(ctx, db, deviceID, now)
	})
	return err
}

func RotateRefresh(ctx context.Context, db *sql.DB, oldHash [sha256.Size]byte, access, refresh TokenRecord, now time.Time) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin refresh rotation: %w", err)
	}
	defer tx.Rollback()
	stored, err := refreshTokenForRotation(ctx, tx, oldHash)
	if err != nil {
		return err
	}
	if !authn.EqualHash(stored.hash, oldHash[:]) || stored.kind != "refresh" {
		return ErrUnauthorized
	}
	if stored.usedAt.Valid {
		return revokeReusedRefresh(ctx, tx, stored.sessionID, now)
	}
	nowMS := now.UnixMilli()
	if stored.revokedAt.Valid || stored.sessionRevoked.Valid || stored.expiresAt <= nowMS || stored.sessionExpires <= nowMS {
		return ErrUnauthorized
	}
	if err := writeRefreshRotation(ctx, tx, oldHash, stored.sessionID, access, refresh, nowMS); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit refresh rotation: %w", err)
	}
	return nil
}

type storedRefreshToken struct {
	hash                      []byte
	sessionID, kind           string
	expiresAt, sessionExpires int64
	usedAt, revokedAt         sql.NullInt64
	sessionRevoked            sql.NullInt64
}

func refreshTokenForRotation(ctx context.Context, tx *sql.Tx, oldHash [sha256.Size]byte) (storedRefreshToken, error) {
	var stored storedRefreshToken
	err := tx.QueryRowContext(ctx, `SELECT t.token_hash, t.session_id, t.kind, t.expires_at_ms, t.used_at_ms, t.revoked_at_ms,
		s.expires_at_ms, s.revoked_at_ms
	FROM auth_tokens t JOIN auth_sessions s ON s.id = t.session_id WHERE t.token_hash = ?`, oldHash[:]).Scan(
		&stored.hash, &stored.sessionID, &stored.kind, &stored.expiresAt, &stored.usedAt, &stored.revokedAt,
		&stored.sessionExpires, &stored.sessionRevoked,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return storedRefreshToken{}, ErrUnauthorized
	}
	if err != nil {
		return storedRefreshToken{}, fmt.Errorf("read refresh token: %w", err)
	}
	return stored, nil
}

func revokeReusedRefresh(ctx context.Context, tx *sql.Tx, sessionID string, now time.Time) error {
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

func writeRefreshRotation(ctx context.Context, tx *sql.Tx, oldHash [sha256.Size]byte, sessionID string, access, refresh TokenRecord, nowMS int64) error {
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
	return nil
}
