package store

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

const dataDirLockHelperEnvironment = "POMODOROUGH_DATA_DIR_LOCK_HELPER"

func TestDataDirLockExcludesConcurrentOwnerAndReleases(t *testing.T) {
	dataDir := t.TempDir()
	first, err := AcquireDataDirLock(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireDataDirLock(dataDir); !errors.Is(err, ErrDataDirInUse) {
		t.Fatalf("second lock error = %v, want ErrDataDirInUse", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := AcquireDataDirLock(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDataDirLockExcludesOtherProcessAndReleases(t *testing.T) {
	dataDir := t.TempDir()
	command, input, stderr := startDataDirLockHelper(t, dataDir)
	if _, err := AcquireDataDirLock(dataDir); !errors.Is(err, ErrDataDirInUse) {
		t.Fatalf("contending process lock error = %v, want ErrDataDirInUse", err)
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("lock helper failed: %v: %s", err, stderr.String())
	}
	lock, err := AcquireDataDirLock(dataDir)
	if err != nil {
		t.Fatalf("lock after process exit: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDataDirLockHelperProcess(t *testing.T) {
	if os.Getenv(dataDirLockHelperEnvironment) != "1" {
		t.Skip("subprocess helper")
	}
	lock, err := AcquireDataDirLock(os.Getenv("POMODOROUGH_DATA_DIR_LOCK_PATH"))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("locked")
	_, _ = io.Copy(io.Discard, os.Stdin)
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
}

func startDataDirLockHelper(t *testing.T, dataDir string) (*exec.Cmd, io.WriteCloser, *bytes.Buffer) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestDataDirLockHelperProcess$")
	command.Env = append(os.Environ(), dataDirLockHelperEnvironment+"=1", "POMODOROUGH_DATA_DIR_LOCK_PATH="+dataDir)
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr := &bytes.Buffer{}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = input.Close()
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() || scanner.Text() != "locked" {
		_ = input.Close()
		_ = command.Wait()
		t.Fatalf("lock helper did not become ready: %s", stderr.String())
	}
	return command, input, stderr
}

func TestVerifyDataDirSchemaVersionIsReadOnly(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	usersDir := filepath.Join(dataDir, "users")
	if err := createPrivateDir(usersDir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(usersDir, "legacy.sqlite")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `PRAGMA user_version = 4`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := VerifyDataDirSchemaVersion(ctx, dataDir); !errors.Is(err, ErrSchemaVersionMismatch) {
		t.Fatalf("schema check error = %v, want ErrSchemaVersionMismatch", err)
	}
	db, err = sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version int
	if err := db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != 4 {
		t.Fatalf("schema version after check = %d, %v; want 4", version, err)
	}
}

func createPrivateDir(path string) error {
	return os.MkdirAll(path, 0o700)
}
