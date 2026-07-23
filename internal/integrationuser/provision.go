package integrationuser

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"pomodorough/internal/authn"
	"pomodorough/internal/store"
)

const (
	Issuer              = "https://integration.invalid"
	accessTokenLifetime = 15 * time.Minute
	markerName          = ".pomodorough-integration-data"
)

var (
	identityPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	platformPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$`)
	clientNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$`)
)

type Device struct {
	Name     string `json:"name"`
	DeviceID string `json:"deviceId"`
	Platform string `json:"platform"`
}

type Request struct {
	DataDir   string
	AppSecret []byte
	Subject   string
	Devices   []Device
	TTL       time.Duration
	Now       time.Time
}

type ClientCredentials struct {
	Name                  string `json:"name"`
	DeviceID              string `json:"deviceId"`
	Platform              string `json:"platform"`
	AccessToken           string `json:"accessToken"`
	AccessTokenExpiresAt  string `json:"accessTokenExpiresAt"`
	RefreshToken          string `json:"refreshToken"`
	RefreshTokenExpiresAt string `json:"refreshTokenExpiresAt"`
}

type Credentials struct {
	Issuer  string              `json:"issuer"`
	Subject string              `json:"subject"`
	UserID  string              `json:"userId"`
	Clients []ClientCredentials `json:"clients"`
}

func ParseDevices(value string) ([]Device, error) {
	if strings.TrimSpace(value) == "" {
		return nil, errors.New("devices are required")
	}
	parts := strings.Split(value, ",")
	devices := make([]Device, 0, len(parts))
	for _, part := range parts {
		name, remainder, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return nil, fmt.Errorf("invalid device %q: expected name=deviceId:platform", part)
		}
		deviceID, platform, ok := strings.Cut(remainder, ":")
		if !ok || strings.Contains(platform, ":") {
			return nil, fmt.Errorf("invalid device %q: expected name=deviceId:platform", part)
		}
		devices = append(devices, Device{Name: name, DeviceID: deviceID, Platform: platform})
	}
	return devices, nil
}

func Provision(ctx context.Context, request Request) (Credentials, error) {
	now, dataDir, err := validateRequest(request)
	if err != nil {
		return Credentials{}, err
	}
	userID := authn.UserID(request.AppSecret, Issuer, request.Subject)
	dataDirLock, err := store.AcquireDataDirLock(dataDir)
	if err != nil {
		return Credentials{}, fmt.Errorf("acquire stopped integration server data directory: %w", err)
	}
	defer dataDirLock.Close()
	if err := prepareDataDir(dataDir); err != nil {
		return Credentials{}, err
	}
	if err := store.VerifyDataDirSchemaVersion(ctx, dataDir); err != nil {
		return Credentials{}, fmt.Errorf("verify integration server schema: %w", err)
	}
	userStore, err := store.New(dataDir)
	if err != nil {
		return Credentials{}, fmt.Errorf("initialize integration user store: %w", err)
	}
	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		return Credentials{}, fmt.Errorf("open integration user: %w", err)
	}
	defer db.Close()

	sessionExpiresAt := now.Add(request.TTL)
	accessExpiresAt := now.Add(min(request.TTL, accessTokenLifetime))
	sessions := make([]store.SessionTokens, 0, len(request.Devices))
	credentials := Credentials{Issuer: Issuer, Subject: request.Subject, UserID: userID, Clients: make([]ClientCredentials, 0, len(request.Devices))}
	for _, device := range request.Devices {
		accessToken, accessHash, err := authn.NewOpaqueToken(userID)
		if err != nil {
			return Credentials{}, fmt.Errorf("generate %s access token: %w", device.Name, err)
		}
		refreshToken, refreshHash, err := authn.NewOpaqueToken(userID)
		if err != nil {
			return Credentials{}, fmt.Errorf("generate %s refresh token: %w", device.Name, err)
		}
		sessionID, err := authn.RandomString(32)
		if err != nil {
			return Credentials{}, fmt.Errorf("generate %s session ID: %w", device.Name, err)
		}
		sessions = append(sessions, store.SessionTokens{
			Session: store.Session{ID: sessionID, Kind: "native", DeviceID: device.DeviceID, Platform: device.Platform, CreatedAt: now, ExpiresAt: sessionExpiresAt},
			Tokens: []store.TokenRecord{
				{Hash: accessHash, Kind: "access", CreatedAt: now, ExpiresAt: accessExpiresAt},
				{Hash: refreshHash, Kind: "refresh", CreatedAt: now, ExpiresAt: sessionExpiresAt},
			},
		})
		credentials.Clients = append(credentials.Clients, ClientCredentials{
			Name: device.Name, DeviceID: device.DeviceID, Platform: device.Platform,
			AccessToken: accessToken, AccessTokenExpiresAt: accessExpiresAt.UTC().Format(time.RFC3339),
			RefreshToken: refreshToken, RefreshTokenExpiresAt: sessionExpiresAt.UTC().Format(time.RFC3339),
		})
	}
	profile := store.Profile{
		ID: userID, Issuer: Issuer, Subject: request.Subject,
		Email: "integration-" + strings.ToLower(userID) + "@integration.invalid", Name: "Integration Test User",
	}
	if err := store.ProvisionProfileAndSessions(ctx, db, profile, now, sessions); err != nil {
		return Credentials{}, fmt.Errorf("provision integration user: %w", err)
	}
	return credentials, nil
}

func prepareDataDir(dataDir string) error {
	markerPath := filepath.Join(dataDir, markerName)
	want := fmt.Sprintf("pomodorough integration data\nschema=%d\n", store.CurrentSchemaVersion())
	info, err := os.Lstat(markerPath)
	if err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("integration data directory marker is not a regular file")
		}
		marker, err := os.ReadFile(markerPath)
		if err != nil {
			return fmt.Errorf("read integration data directory marker: %w", err)
		}
		if string(marker) != want {
			return errors.New("integration data directory marker belongs to a different schema version")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect integration data directory marker: %w", err)
	}
	databases, err := filepath.Glob(filepath.Join(dataDir, "users", "*.sqlite"))
	if err != nil {
		return fmt.Errorf("inspect unmarked data directory: %w", err)
	}
	if len(databases) != 0 {
		return errors.New("refusing unmarked data directory containing user databases")
	}
	if err := os.WriteFile(markerPath, []byte(want), 0o600); err != nil {
		return fmt.Errorf("mark dedicated integration data directory: %w", err)
	}
	return nil
}

func validateRequest(request Request) (time.Time, string, error) {
	if strings.TrimSpace(request.DataDir) == "" {
		return time.Time{}, "", errors.New("data directory is required")
	}
	dataDir, err := filepath.Abs(request.DataDir)
	if err != nil {
		return time.Time{}, "", fmt.Errorf("resolve data directory: %w", err)
	}
	if dataDir == string(filepath.Separator) {
		return time.Time{}, "", errors.New("refusing filesystem root as data directory")
	}
	if len(request.AppSecret) < 32 {
		return time.Time{}, "", errors.New("app secret must contain at least 32 bytes")
	}
	if !identityPattern.MatchString(request.Subject) {
		return time.Time{}, "", errors.New("subject must be 8-128 safe identifier characters")
	}
	if len(request.Devices) == 0 || len(request.Devices) > 32 {
		return time.Time{}, "", errors.New("between 1 and 32 devices are required")
	}
	if request.TTL < time.Minute || request.TTL > 30*24*time.Hour {
		return time.Time{}, "", errors.New("TTL must be between one minute and 30 days")
	}
	seenNames := make(map[string]struct{}, len(request.Devices))
	seenDeviceIDs := make(map[string]struct{}, len(request.Devices))
	for _, device := range request.Devices {
		if !clientNamePattern.MatchString(device.Name) || !identityPattern.MatchString(device.DeviceID) || !platformPattern.MatchString(device.Platform) {
			return time.Time{}, "", fmt.Errorf("invalid device %q", device.Name)
		}
		if _, duplicate := seenNames[device.Name]; duplicate {
			return time.Time{}, "", fmt.Errorf("duplicate device name %q", device.Name)
		}
		if _, duplicate := seenDeviceIDs[device.DeviceID]; duplicate {
			return time.Time{}, "", fmt.Errorf("duplicate device ID %q", device.DeviceID)
		}
		seenNames[device.Name] = struct{}{}
		seenDeviceIDs[device.DeviceID] = struct{}{}
	}
	now := request.Now
	if now.IsZero() {
		now = time.Now()
	}
	return now.UTC(), dataDir, nil
}
