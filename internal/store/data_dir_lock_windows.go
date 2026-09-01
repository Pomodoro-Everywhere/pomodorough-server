//go:build windows

package store

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

const dataDirLockRange = ^uint32(0)

func lockDataDirFile(file *os.File) error {
	err := windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0,
		dataDirLockRange,
		dataDirLockRange,
		&windows.Overlapped{},
	)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return ErrDataDirInUse
	}
	return err
}

func unlockDataDirFile(file *os.File) error {
	return windows.UnlockFileEx(
		windows.Handle(file.Fd()),
		0,
		dataDirLockRange,
		dataDirLockRange,
		&windows.Overlapped{},
	)
}
