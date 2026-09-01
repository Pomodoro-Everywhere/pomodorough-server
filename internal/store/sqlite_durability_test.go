package store

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pomodorough/internal/authn"
)

const (
	durabilityChildFlag    = "POMODOROUGH_DURABILITY_CHILD"
	durabilityDataDirEnv   = "POMODOROUGH_DURABILITY_DATA_DIR"
	durabilityUserIDEnv    = "POMODOROUGH_DURABILITY_USER_ID"
	durabilityAcknowledged = "write-acknowledged"
)

func TestUserDatabaseConnectionsUseFullSynchronousWAL(t *testing.T) {
	ctx := context.Background()
	userStore, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	firstID := durabilityUserID("first-account")
	first, err := userStore.OpenUser(ctx, firstID)
	if err != nil {
		t.Fatal(err)
	}
	assertFreshConnectionsDurable(t, first)
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := userStore.OpenExistingUser(ctx, firstID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	assertFreshConnectionsDurable(t, reopened)
	second, err := userStore.OpenUser(ctx, durabilityUserID("second-account"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	assertFreshConnectionsDurable(t, second)
}

func TestDatabaseDurabilityVerificationFailsClosed(t *testing.T) {
	tests := []struct {
		name      string
		pragma    string
		wantError string
	}{
		{name: "synchronous downgrade", pragma: `PRAGMA synchronous=NORMAL`, wantError: "synchronous mode 1"},
		{name: "journal downgrade", pragma: `PRAGMA journal_mode=DELETE`, wantError: `journal mode "delete"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db, err := openDatabase(context.Background(), filepath.Join(t.TempDir(), "account.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.Exec(test.pragma); err != nil {
				t.Fatal(err)
			}
			err = verifyDatabaseDurability(context.Background(), db)
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("verification error = %v, want containing %q", err, test.wantError)
			}
		})
	}
}

func TestAcknowledgedWriteSurvivesAbruptProcessTermination(t *testing.T) {
	dataDir := t.TempDir()
	userID := durabilityUserID("abrupt-process-termination")
	command := startDurabilityChild(t, dataDir, userID)
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("durability child exited cleanly; want abrupt termination")
	}
	databasePath := filepath.Join(dataDir, "users", userID+".sqlite")
	if _, err := os.Stat(databasePath + "-wal"); err != nil {
		t.Fatalf("stat recovery WAL: %v", err)
	}
	userStore, err := New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenExistingUser(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	profile, err := ProfileByID(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if profile.Email != "durable@example.com" {
		t.Fatalf("recovered email = %q, want durable@example.com", profile.Email)
	}
}

func TestSQLiteDurabilityChild(t *testing.T) {
	if os.Getenv(durabilityChildFlag) != "1" {
		t.Skip("child-process helper")
	}
	ctx := context.Background()
	userID := os.Getenv(durabilityUserIDEnv)
	userStore, err := New(os.Getenv(durabilityDataDirEnv))
	if err != nil {
		t.Fatal(err)
	}
	db, err := userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	profile := Profile{
		ID: userID, Issuer: "https://accounts.google.com", Subject: "durability",
		Email: "durable@example.com", Name: "Durable User", AvatarURL: "https://example.com/avatar.png",
	}
	if err := UpsertProfile(ctx, db, profile, time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatal(err)
	}
	fmt.Fprintln(os.Stdout, durabilityAcknowledged)
	for {
		time.Sleep(time.Hour)
	}
}

func assertFreshConnectionsDurable(t *testing.T, db *sql.DB) {
	t.Helper()
	db.SetMaxIdleConns(0)
	for attempt := 0; attempt < 3; attempt++ {
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		var journalMode string
		if err := conn.QueryRowContext(context.Background(), `PRAGMA journal_mode`).Scan(&journalMode); err != nil {
			conn.Close()
			t.Fatal(err)
		}
		var synchronousMode int
		if err := conn.QueryRowContext(context.Background(), `PRAGMA synchronous`).Scan(&synchronousMode); err != nil {
			conn.Close()
			t.Fatal(err)
		}
		if err := conn.Close(); err != nil {
			t.Fatal(err)
		}
		if journalMode != "wal" || synchronousMode != fullSynchronousMode {
			t.Fatalf("connection %d pragmas = journal_mode %q, synchronous %d", attempt, journalMode, synchronousMode)
		}
	}
}

func startDurabilityChild(t *testing.T, dataDir, userID string) *exec.Cmd {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestSQLiteDurabilityChild$", "-test.timeout=30s")
	command.Env = append(os.Environ(),
		durabilityChildFlag+"=1", durabilityDataDirEnv+"="+dataDir, durabilityUserIDEnv+"="+userID)
	stderr := &bytes.Buffer{}
	command.Stderr = stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	acknowledged := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadString('\n')
		if err == nil && strings.TrimSpace(line) != durabilityAcknowledged {
			err = fmt.Errorf("child output %q", line)
		}
		acknowledged <- err
	}()
	select {
	case err := <-acknowledged:
		if err != nil {
			_ = command.Wait()
			t.Fatalf("wait for acknowledged write: %v; stderr: %s", err, stderr.String())
		}
	case <-time.After(10 * time.Second):
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("timed out waiting for acknowledged write; stderr: %s", stderr.String())
	}
	return command
}

func durabilityUserID(subject string) string {
	return authn.UserID([]byte(strings.Repeat("d", 32)), "https://accounts.google.com", subject)
}
