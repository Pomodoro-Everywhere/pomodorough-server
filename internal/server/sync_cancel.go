package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

// isSyncCancellation reports whether a sync mutation failure is
// shutdown/cancel noise that must not reach error monitoring.
//
// Production signal (POMODOROUGH-1J): fmt.wrapError "sync account
// mutations" -> "reduce timer with shared core" -> dispatch shared core
// operation timer.reduce.v1 "module closed with context canceled".
// The request context is canceled (client gone or server shutting down)
// and wazero tears down the module instance; there is no actionable
// server fault, 13 events with 0 users.
//
// Keep the predicate narrow: context cancellation plus the wazero/shared
// core closed-module strings observed on this path. Genuine dispatch
// failures (validation, corrupt output, real runtime faults) do not match
// and keep reporting.
func isSyncCancellation(err error, ctx context.Context) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return true
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	if ctx != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return true
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return true
		}
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"context canceled",
		"context deadline exceeded",
		"module closed",
		"shared core is closed",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// writeSyncMutationError answers a failed sync mutation without sending
// shutdown/cancel noise to error monitoring. Canceled dispatch logs at
// info and keeps the existing 500 wire shape; genuine failures keep the
// sampled Sentry report via internalAPIError.
func (s *Server) writeSyncMutationError(w http.ResponseWriter, r *http.Request, err error) {
	if isSyncCancellation(err, requestContext(r)) {
		s.logger.Info("sync account mutations canceled", "error", err)
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
