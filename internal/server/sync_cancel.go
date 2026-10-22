package server

import (
	"context"
	"errors"
	"net/http"
)

// isSyncCancellation reports typed request cancellation on the sync
// mutation path. Only errors.Is against context.Canceled and
// context.DeadlineExceeded on the failure or the live request context
// counts. Messages that merely mention cancellation stay actionable.
//
// Production signal (POMODOROUGH-1J): fmt.wrapError "sync account
// mutations" -> "reduce timer with shared core" -> dispatch shared core
// operation timer.reduce.v1 "module closed with context canceled".
// The request context is canceled (client gone or server shutting down)
// and wazero tears down the module instance; there is no actionable
// server fault, 13 events with 0 users.
//
// Typed demarcation matches S05 isRequestCancellation and S06
// monitoringCause: wazero sys.ExitError with a canceled or deadline
// exit code matches errors.Is against context.Canceled or
// context.DeadlineExceeded, while genuine traps use other exit codes
// and stay actionable. sharedcore.ErrClosed on a live context is an
// unexpectedly closed runtime and stays actionable; the same sentinel
// with a canceled context suppresses via explicit lifecycle evidence.
func isSyncCancellation(err error, ctx context.Context) bool {
	if errors.Is(err, context.Canceled) {
		return true
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if ctx == nil {
		return false
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return true
	}
	return errors.Is(ctx.Err(), context.DeadlineExceeded)
}

// writeSyncMutationError answers a failed sync mutation without sending
// shutdown/cancel noise to error monitoring. Canceled dispatch logs at
// info and keeps the existing 500 wire shape; genuine failures keep the
// sampled Sentry report via internalAPIError.
func (s *Server) writeSyncMutationError(w http.ResponseWriter, r *http.Request, err error) {
	if isSyncCancellation(err, requestContext(r)) {
		s.logger.Info("sync account mutations canceled", "cause", monitoringCause(err))
		echoIdempotencyKey(w, r)
		writeAPIError(w, r, http.StatusInternalServerError, "internal server error")
		return
	}
	s.internalAPIError(w, r, "sync account mutations", err)
}

func requestContext(r *http.Request) context.Context {
	if r == nil {
		return nil
	}
	return r.Context()
}
