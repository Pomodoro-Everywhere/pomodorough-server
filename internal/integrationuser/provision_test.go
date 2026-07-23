package integrationuser

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

func TestProvisionCreatesSyntheticProfileAndDistinctNativeCredentials(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	secret := []byte(strings.Repeat("integration-secret-", 2))
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	request := Request{
		DataDir: dataDir, AppSecret: secret, Subject: "integration-subject", TTL: 2 * time.Hour, Now: now,
		Devices: []Device{
			{Name: "client-pwa", DeviceID: "device-pwa", Platform: "web"},
			{Name: "client-ios", DeviceID: "device-ios", Platform: "ios"},
		},
	}
	credentials, err := Provision(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if credentials.Issuer != Issuer || credentials.Subject != request.Subject || !authn.ValidateUserID(credentials.UserID) || len(credentials.Clients) != 2 {
		t.Fatalf("credentials metadata = %#v", credentials)
	}
	if credentials.Clients[0].AccessToken == credentials.Clients[1].AccessToken || credentials.Clients[0].RefreshToken == credentials.Clients[1].RefreshToken || credentials.Clients[0].AccessToken == credentials.Clients[0].RefreshToken {
		t.Fatal("provisioned tokens are not distinct")
	}
	for _, client := range credentials.Clients {
		if client.AccessTokenExpiresAt != now.Add(15*time.Minute).Format(time.RFC3339) || client.RefreshTokenExpiresAt != now.Add(2*time.Hour).Format(time.RFC3339) {
			t.Fatalf("%s token expirations = %s/%s", client.Name, client.AccessTokenExpiresAt, client.RefreshTokenExpiresAt)
		}
	}
	encoded, err := json.Marshal(credentials)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), string(secret)) {
		t.Fatal("credentials output leaked app secret")
	}

	userStore, err := store.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenExistingUser(ctx, credentials.UserID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	profile, err := store.ProfileByID(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if profile.Issuer != Issuer || profile.Subject != request.Subject || !strings.HasSuffix(profile.Email, "@integration.invalid") {
		t.Fatalf("synthetic profile = %#v", profile)
	}
	for _, client := range credentials.Clients {
		userID, accessHash, err := authn.ParseOpaqueToken(client.AccessToken)
		if err != nil || userID != credentials.UserID {
			t.Fatalf("parse %s access token: user=%q err=%v", client.Name, userID, err)
		}
		info, err := store.Authenticate(ctx, db, accessHash, "access", now.Add(14*time.Minute))
		if err != nil || info.DeviceID != client.DeviceID || info.Kind != "native" {
			t.Fatalf("authenticate %s access token: info=%#v err=%v", client.Name, info, err)
		}
		if _, err := store.Authenticate(ctx, db, accessHash, "access", now.Add(15*time.Minute)); !errors.Is(err, store.ErrUnauthorized) {
			t.Fatalf("%s access token exact expiry error = %v, want ErrUnauthorized", client.Name, err)
		}
		_, refreshHash, err := authn.ParseOpaqueToken(client.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Authenticate(ctx, db, refreshHash, "refresh", now.Add(time.Hour)); err != nil {
			t.Fatalf("authenticate %s refresh token: %v", client.Name, err)
		}
		if _, err := store.Authenticate(ctx, db, refreshHash, "refresh", now.Add(2*time.Hour)); !errors.Is(err, store.ErrUnauthorized) {
			t.Fatalf("%s refresh/session exact expiry error = %v, want ErrUnauthorized", client.Name, err)
		}
		var sessionExpiresAt int64
		if err := db.QueryRowContext(ctx, `SELECT expires_at_ms FROM auth_sessions WHERE device_id = ?`, client.DeviceID).Scan(&sessionExpiresAt); err != nil || sessionExpiresAt != now.Add(2*time.Hour).UnixMilli() {
			t.Fatalf("%s session expiration = %d, %v", client.Name, sessionExpiresAt, err)
		}
	}
}

func TestProvisionCapsAccessLifetimeAtShorterSessionTTL(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	request := Request{
		DataDir: t.TempDir(), AppSecret: []byte(strings.Repeat("s", 32)), Subject: "short-ttl-subject", TTL: 5 * time.Minute, Now: now,
		Devices: []Device{{Name: "client-pwa", DeviceID: "device-pwa", Platform: "web"}},
	}
	credentials, err := Provision(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	client := credentials.Clients[0]
	wantExpiry := now.Add(5 * time.Minute).Format(time.RFC3339)
	if client.AccessTokenExpiresAt != wantExpiry || client.RefreshTokenExpiresAt != wantExpiry {
		t.Fatalf("short TTL expirations = %s/%s, want %s", client.AccessTokenExpiresAt, client.RefreshTokenExpiresAt, wantExpiry)
	}
	userStore, err := store.New(request.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenExistingUser(ctx, credentials.UserID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, accessHash, err := authn.ParseOpaqueToken(client.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Authenticate(ctx, db, accessHash, "access", now.Add(4*time.Minute)); err != nil {
		t.Fatalf("short TTL access token expired early: %v", err)
	}
	if _, err := store.Authenticate(ctx, db, accessHash, "access", now.Add(5*time.Minute)); !errors.Is(err, store.ErrUnauthorized) {
		t.Fatalf("short TTL access token exact expiry error = %v", err)
	}
}

func TestProvisionReplacesCredentialsForSameSubjectAndDevice(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	request := Request{
		DataDir: t.TempDir(), AppSecret: []byte(strings.Repeat("s", 32)), Subject: "reusable-integration-subject", TTL: 2 * time.Hour, Now: now,
		Devices: []Device{
			{Name: "client-pwa", DeviceID: "device-pwa", Platform: "web"},
			{Name: "client-ios", DeviceID: "device-ios", Platform: "ios"},
		},
	}
	first, err := Provision(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	request.Now = now.Add(time.Minute)
	request.Devices = request.Devices[:1]
	second, err := Provision(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if second.UserID != first.UserID {
		t.Fatalf("reprovisioned user ID = %q, want %q", second.UserID, first.UserID)
	}
	if second.Clients[0].AccessToken == first.Clients[0].AccessToken || second.Clients[0].RefreshToken == first.Clients[0].RefreshToken {
		t.Fatal("reprovisioning reused credentials")
	}

	userStore, err := store.New(request.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenExistingUser(ctx, first.UserID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, client := range first.Clients {
		for _, token := range []struct {
			name  string
			value string
			kind  string
		}{
			{name: "access", value: client.AccessToken, kind: "access"},
			{name: "refresh", value: client.RefreshToken, kind: "refresh"},
		} {
			_, hash, err := authn.ParseOpaqueToken(token.value)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.Authenticate(ctx, db, hash, token.kind, request.Now); !errors.Is(err, store.ErrUnauthorized) {
				t.Fatalf("old %s %s authentication error = %v, want ErrUnauthorized", client.Name, token.name, err)
			}
		}
	}
	for _, token := range []struct {
		value string
		kind  string
	}{
		{value: second.Clients[0].AccessToken, kind: "access"},
		{value: second.Clients[0].RefreshToken, kind: "refresh"},
	} {
		_, hash, err := authn.ParseOpaqueToken(token.value)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Authenticate(ctx, db, hash, token.kind, request.Now); err != nil {
			t.Fatalf("replacement %s token authentication: %v", token.kind, err)
		}
	}
	var active, revoked int
	if err := db.QueryRowContext(ctx, `SELECT
		COUNT(*) FILTER (WHERE revoked_at_ms IS NULL),
		COUNT(*) FILTER (WHERE revoked_at_ms IS NOT NULL)
		FROM auth_sessions WHERE kind = 'native'`).Scan(&active, &revoked); err != nil {
		t.Fatal(err)
	}
	if active != 1 || revoked != 2 {
		t.Fatalf("native sessions active=%d revoked=%d, want 1/2", active, revoked)
	}
}

func TestProvisionRefusesRunningUnmarkedAndOlderSchemaDataDirs(t *testing.T) {
	ctx := context.Background()
	secret := []byte(strings.Repeat("s", 32))
	request := Request{
		AppSecret: secret, Subject: "safety-test-subject", TTL: time.Hour,
		Devices: []Device{{Name: "client-pwa", DeviceID: "device-pwa", Platform: "web"}},
	}

	runningDir := t.TempDir()
	lock, err := store.AcquireDataDirLock(runningDir)
	if err != nil {
		t.Fatal(err)
	}
	request.DataDir = runningDir
	if _, err := Provision(ctx, request); !errors.Is(err, store.ErrDataDirInUse) {
		lock.Close()
		t.Fatalf("running data directory error = %v, want ErrDataDirInUse", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}

	unmarkedDir := t.TempDir()
	userStore, err := store.New(unmarkedDir)
	if err != nil {
		t.Fatal(err)
	}
	existingID := authn.UserID(secret, Issuer, "existing-account-subject")
	db, err := userStore.OpenUser(ctx, existingID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	request.DataDir = unmarkedDir
	if _, err := Provision(ctx, request); err == nil || !strings.Contains(err.Error(), "unmarked data directory") {
		t.Fatalf("unmarked data directory error = %v", err)
	}

	markerMismatchDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(markerMismatchDir, markerName), []byte("pomodorough integration data\nschema=4\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	request.DataDir = markerMismatchDir
	if _, err := Provision(ctx, request); err == nil || !strings.Contains(err.Error(), "different schema version") {
		t.Fatalf("marker schema mismatch error = %v", err)
	}

	legacyDir := t.TempDir()
	if _, err := store.New(legacyDir); err != nil {
		t.Fatal(err)
	}
	if err := prepareDataDir(legacyDir); err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(legacyDir, "users", "legacy.sqlite")
	legacy, err := sql.Open("sqlite", "file:"+legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(ctx, `PRAGMA user_version = 4`); err != nil {
		legacy.Close()
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	request.DataDir = legacyDir
	if _, err := Provision(ctx, request); !errors.Is(err, store.ErrSchemaVersionMismatch) {
		t.Fatalf("legacy schema error = %v, want ErrSchemaVersionMismatch", err)
	}
	legacy, err = sql.Open("sqlite", "file:"+legacyPath+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	var version int
	if err := legacy.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != 4 {
		t.Fatalf("legacy schema after refusal = %d, %v; want 4", version, err)
	}
}

func TestProvisionRejectsUnsafeInputsWithoutCreatingAccount(t *testing.T) {
	valid := Request{
		DataDir: t.TempDir(), AppSecret: []byte(strings.Repeat("s", 32)), Subject: "integration-subject", TTL: time.Hour,
		Devices: []Device{{Name: "client-pwa", DeviceID: "device-pwa", Platform: "web"}},
	}
	tests := []struct {
		name   string
		mutate func(*Request)
	}{
		{name: "missing data directory", mutate: func(value *Request) { value.DataDir = "" }},
		{name: "filesystem root", mutate: func(value *Request) { value.DataDir = "/" }},
		{name: "short app secret", mutate: func(value *Request) { value.AppSecret = []byte("short") }},
		{name: "unsafe subject", mutate: func(value *Request) { value.Subject = "real user@example.com" }},
		{name: "missing devices", mutate: func(value *Request) { value.Devices = nil }},
		{name: "duplicate device ID", mutate: func(value *Request) {
			value.Devices = append(value.Devices, Device{Name: "client-ios", DeviceID: "device-pwa", Platform: "ios"})
		}},
		{name: "invalid platform", mutate: func(value *Request) { value.Devices[0].Platform = "i" }},
		{name: "short TTL", mutate: func(value *Request) { value.TTL = time.Second }},
		{name: "long TTL", mutate: func(value *Request) { value.TTL = 31 * 24 * time.Hour }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			request := valid
			request.Devices = append([]Device(nil), valid.Devices...)
			testCase.mutate(&request)
			if _, err := Provision(context.Background(), request); err == nil {
				t.Fatal("Provision accepted unsafe input")
			}
		})
	}
}

func TestParseDevices(t *testing.T) {
	devices, err := ParseDevices("client-pwa=device-pwa:web,client-ios=device-ios:ios")
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 2 || devices[0] != (Device{Name: "client-pwa", DeviceID: "device-pwa", Platform: "web"}) || devices[1].Platform != "ios" {
		t.Fatalf("parsed devices = %#v", devices)
	}
	for _, invalid := range []string{"", "missing-shape", "name=device", "name=device:ios:extra"} {
		if _, err := ParseDevices(invalid); err == nil {
			t.Fatalf("ParseDevices(%q) succeeded", invalid)
		}
	}
}
