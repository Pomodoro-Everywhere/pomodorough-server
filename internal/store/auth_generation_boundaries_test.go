package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"pomodorough/internal/authn"
)

func TestProvisionProfileAndSessionsReplacesNativeFamilyButPreservesWebSession(t *testing.T) {
	ctx := context.Background()
	_, db, userID, now := openTestUser(t, "provision-auth-boundary")
	defer db.Close()
	webHash := testTokenHash(t, userID)
	oldNativeHash := testTokenHash(t, userID)
	newAccessHash := testTokenHash(t, userID)
	newRefreshHash := testTokenHash(t, userID)
	if err := CreateSession(ctx, db, Session{
		ID: "existing-web", Kind: "web", Platform: "web", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour),
	}, []TokenRecord{{Hash: webHash, Kind: "web", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if err := CreateSession(ctx, db, Session{
		ID: "old-native", Kind: "native", DeviceID: "old-device", Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour),
	}, []TokenRecord{{Hash: oldNativeHash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}

	updated := Profile{ID: userID, Issuer: "https://accounts.google.com", Subject: "provision-auth-boundary", Email: "updated@example.com", Name: "Updated User"}
	newSession := Session{ID: "new-native", Kind: "native", DeviceID: "new-device", Platform: "android", CreatedAt: now.Add(time.Minute), ExpiresAt: now.Add(48 * time.Hour)}
	newTokens := []TokenRecord{
		{Hash: newAccessHash, Kind: "access", CreatedAt: now.Add(time.Minute), ExpiresAt: now.Add(time.Hour)},
		{Hash: newRefreshHash, Kind: "refresh", CreatedAt: now.Add(time.Minute), ExpiresAt: now.Add(48 * time.Hour)},
	}
	if err := ProvisionProfileAndSessions(ctx, db, updated, now.Add(time.Minute), []SessionTokens{{Session: newSession, Tokens: newTokens}}); err != nil {
		t.Fatal(err)
	}

	if _, err := Authenticate(ctx, db, oldNativeHash, "access", now.Add(2*time.Minute)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("replaced native token error = %v, want ErrUnauthorized", err)
	}
	if _, err := Authenticate(ctx, db, webHash, "web", now.Add(2*time.Minute)); err != nil {
		t.Fatalf("web session was revoked during native replacement: %v", err)
	}
	access, err := Authenticate(ctx, db, newAccessHash, "access", now.Add(2*time.Minute))
	if err != nil || access.DeviceID != "new-device" || access.Profile.Email != updated.Email {
		t.Fatalf("new native access = %#v, %v", access, err)
	}
	if _, err := Authenticate(ctx, db, newRefreshHash, "refresh", now.Add(2*time.Minute)); err != nil {
		t.Fatalf("new native refresh: %v", err)
	}
}

func TestGenerationScopedCSRFUpdateMutatesOnlyCurrentSession(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "generation-csrf-boundary")
	tokenHash := testTokenHash(t, userID)
	oldCSRF := authn.HashString("old-csrf")
	if err := CreateSession(ctx, db, Session{
		ID: "web-session", Kind: "web", Platform: "web", CSRFHash: oldCSRF[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}, []TokenRecord{{Hash: tokenHash, Kind: "web", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	newCSRF := authn.HashString("new-csrf")
	if err := userStore.UpdateCSRFForGeneration(ctx, userID, 1, "web-session", newCSRF); err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenExistingUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	info, err := Authenticate(ctx, db, tokenHash, "web", now.Add(time.Minute))
	if err != nil || !authn.EqualHash(info.CSRFHash, newCSRF[:]) {
		t.Fatalf("updated CSRF authentication = %#v, %v", info, err)
	}
}

func TestGenerationScopedRevocationsInvalidateOnlyTheirTarget(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "generation-revocation-boundary")
	sessionHash := testTokenHash(t, userID)
	deviceHash := testTokenHash(t, userID)
	otherHash := testTokenHash(t, userID)
	for _, entry := range []struct {
		id, device string
		hash       [32]byte
	}{
		{id: "session-target", device: "device-a", hash: sessionHash},
		{id: "device-target", device: "device-b", hash: deviceHash},
		{id: "other-session", device: "device-c", hash: otherHash},
	} {
		if err := CreateSession(ctx, db, Session{
			ID: entry.id, Kind: "native", DeviceID: entry.device, Platform: "ios", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
		}, []TokenRecord{{Hash: entry.hash, Kind: "access", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}}); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	if err := userStore.RevokeSessionForGeneration(ctx, userID, 1, "session-target", now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := userStore.RevokeDeviceForGeneration(ctx, userID, 1, "device-b", now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenExistingUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for name, hash := range map[string][32]byte{"session": sessionHash, "device": deviceHash} {
		if _, err := Authenticate(ctx, db, hash, "access", now.Add(3*time.Minute)); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("%s target authentication error = %v, want ErrUnauthorized", name, err)
		}
	}
	if _, err := Authenticate(ctx, db, otherHash, "access", now.Add(3*time.Minute)); err != nil {
		t.Fatalf("unrelated session was revoked: %v", err)
	}
}
