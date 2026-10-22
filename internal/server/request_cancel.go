package server

import (
	"context"
	"errors"
	"net/http"
)

// isRequestCancellation reports typed request cancellation without
// substring matching. Only errors.Is against context.Canceled and
// context.DeadlineExceeded on the failure or the live request context
// counts. Messages that merely mention cancellation stay actionable.
func isRequestCancellation(err error, ctx context.Context) bool {
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

// writeCanceledInternalError keeps the existing 500 wire shape for a
// canceled auth or initial stream-revision read without error-monitoring
// noise. Cancellation is logged at info and counted separately from
// actionable internal errors. Deferred limiter, subscription, and store
// releases still run at the caller.
func (s *Server) writeCanceledInternalError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	if s != nil && s.logger != nil {
		s.logger.Info(operation+" canceled", "cause", monitoringCause(err))
	}
	if s != nil && s.metrics != nil && r != nil {
		s.metrics.observeCancellation(r.Method, r.Pattern)
	}
	echoIdempotencyKey(w, r)
	writeAPIError(w, r, http.StatusInternalServerError, "internal server error")
}
