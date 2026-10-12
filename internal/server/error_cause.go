package server

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net"
	"os"

	"github.com/tetratelabs/wazero/sys"

	"pomodorough/internal/sharedcore"
)

// monitoringCause returns a bounded allowlisted cause class for error
// monitoring grouping and sampling. Classification uses only errors.Is
// and errors.As, never substring matching or raw messages. All return
// values are static strings; raw paths, tokens, task text, URLs, and
// account identifiers never leave this function.
func monitoringCause(err error) string {
	if err == nil {
		return "internal"
	}
	if errors.Is(err, context.Canceled) {
		return "request_canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline_exceeded"
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return "deadline_exceeded"
	}
	if cause := monitoringRuntimeCause(err); cause != "" {
		return cause
	}
	if cause := monitoringSQLiteCause(err); cause != "" {
		return cause
	}
	if errors.Is(err, sql.ErrConnDone) || errors.Is(err, sql.ErrTxDone) {
		return "store_conn"
	}
	if cause := monitoringIOCause(err); cause != "" {
		return cause
	}
	return "internal"
}

// monitoringRuntimeCause classifies typed runtime lifecycle failures.
// Empty means no runtime class matched.
func monitoringRuntimeCause(err error) string {
	if errors.Is(err, sharedcore.ErrClosed) {
		return "runtime_closed"
	}
	var exitErr *sys.ExitError
	if errors.As(err, &exitErr) {
		return "runtime_exit"
	}
	if isRequestRuntimeError(err) {
		return "runtime_output"
	}
	return ""
}

// sqliteCoder matches the embedded SQLite driver error without importing
// the driver into the server package. Code is a numeric result code.
type sqliteCoder interface {
	error
	Code() int
}

// monitoringSQLiteCause maps SQLite result codes to bounded classes.
// Empty means the error is not a SQLite error.
func monitoringSQLiteCause(err error) string {
	var coder sqliteCoder
	if !errors.As(err, &coder) {
		return ""
	}
	return sqliteCauseFromCode(coder.Code())
}

// sqliteCauseFromCode maps a SQLite result code to a static class using
// only the primary result byte. Extended codes collapse to the same
// bounded class so grouping stays finite.
func sqliteCauseFromCode(code int) string {
	switch code & 0xFF {
	case 5:
		return "sqlite_busy"
	case 6:
		return "sqlite_locked"
	case 8:
		return "sqlite_readonly"
	case 10:
		return "sqlite_io"
	case 11:
		return "sqlite_corrupt"
	case 13:
		return "sqlite_full"
	case 14:
		return "sqlite_cantopen"
	case 15:
		return "sqlite_protocol"
	case 19:
		return "sqlite_constraint"
	default:
		return "sqlite_other"
	}
}

// monitoringIOCause classifies typed filesystem and transport failures.
// Empty means no IO class matched.
func monitoringIOCause(err error) string {
	if errors.Is(err, os.ErrNotExist) {
		return "io_not_exist"
	}
	if errors.Is(err, os.ErrPermission) {
		return "io_permission"
	}
	if errors.Is(err, os.ErrClosed) || errors.Is(err, io.ErrClosedPipe) {
		return "io_closed"
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return "io_unexpected"
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		if netErr.Timeout() {
			return "deadline_exceeded"
		}
		return "io_error"
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return "io_error"
	}
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) {
		return "io_error"
	}
	var syscallErr *os.SyscallError
	if errors.As(err, &syscallErr) {
		return "io_error"
	}
	return ""
}
