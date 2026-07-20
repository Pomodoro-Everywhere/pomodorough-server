package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
)

func TestRefreshReuseRevokesSessionFamily(t *testing.T) {
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	userID := authn.UserID([]byte(strings.Repeat("s", 32)), "https://accounts.google.com", "refresh-subject")
	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	if err := UpsertProfile(ctx, db, Profile{ID: userID, Issuer: "https://accounts.google.com", Subject: "refresh-subject", Email: "user@example.com"}, now); err != nil {
		t.Fatal(err)
	}
	oldRefreshToken, oldRefreshHash, err := authn.NewOpaqueToken(userID)
	if err != nil {
		t.Fatal(err)
	}
	_ = oldRefreshToken
	if err := CreateSession(ctx, db, Session{
		ID: "session-family", Kind: "native", DeviceID: "device-0001", Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour),
	}, []TokenRecord{{Hash: oldRefreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)}}); err != nil {
		t.Fatal(err)
	}

	_, firstAccessHash, _ := authn.NewOpaqueToken(userID)
	_, firstRefreshHash, _ := authn.NewOpaqueToken(userID)
	firstAccess := TokenRecord{Hash: firstAccessHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	firstRefresh := TokenRecord{Hash: firstRefreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)}
	if err := RotateRefresh(ctx, db, oldRefreshHash, firstAccess, firstRefresh, now); err != nil {
		t.Fatal(err)
	}

	_, secondAccessHash, _ := authn.NewOpaqueToken(userID)
	_, secondRefreshHash, _ := authn.NewOpaqueToken(userID)
	err = RotateRefresh(ctx, db, oldRefreshHash,
		TokenRecord{Hash: secondAccessHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		TokenRecord{Hash: secondRefreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)},
		now.Add(time.Second),
	)
	if !errors.Is(err, ErrRefreshReuse) {
		t.Fatalf("reuse error = %v, want ErrRefreshReuse", err)
	}
	if _, err := Authenticate(ctx, db, firstAccessHash, "access", now.Add(2*time.Second)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("rotated access token remained valid after reuse: %v", err)
	}
}
