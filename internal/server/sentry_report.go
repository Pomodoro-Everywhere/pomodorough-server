package server

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/getsentry/sentry-go"
)

// sanitizedMonitoringError replaces a reported error with a static
// operation-scoped value. Request handling already logs the full error, so
// monitoring only needs the pattern: raw messages can carry task titles,
// tokens, emails, or URLs. The Go type name is static code identity, never
// user content.
func sanitizedMonitoringError(operation string, err error) error {
	if operation == "" {
		return errors.New("internal error")
	}
	return fmt.Errorf("%s (%T)", operation, err)
}

// reportPanicToErrorMonitoring forwards an already-logged request panic to
// error monitoring. It is a no-op when monitoring is disabled (empty DSN),
// so request handling never depends on monitoring availability. Only the
// route pattern is tagged; request paths can carry user identity material.
// The recovered value itself is never reported; it can carry user content.
func reportPanicToErrorMonitoring(recovered any, request *http.Request) {
	hub := sentry.CurrentHub().Clone()
	if request != nil {
		setRoutePatternTags(hub, request)
	}
	if err, ok := recovered.(error); ok {
		hub.CaptureException(sanitizedMonitoringError("panic serving request", err))
		return
	}
	hub.CaptureException(errors.New("panic serving request"))
}

// reportInternalErrorToErrorMonitoring forwards an already-logged internal
// request failure to error monitoring. It reports once per call, tags only
// the route pattern (never raw paths, queries, bodies, or credentials),
// carries only the static operation in the exception value (never the raw
// error message), and is a no-op when monitoring is disabled.
func reportInternalErrorToErrorMonitoring(err error, request *http.Request, operation string) {
	if err == nil {
		return
	}
	hub := sentry.CurrentHub().Clone()
	if request != nil {
		setRoutePatternTags(hub, request)
	}
	if operation != "" {
		hub.Scope().SetTag("error.operation", operation)
	}
	hub.CaptureException(sanitizedMonitoringError(operation, err))
}

func setRoutePatternTags(hub *sentry.Hub, request *http.Request) {
	hub.Scope().SetTag("http.method", request.Method)
	if request.Pattern != "" {
		hub.Scope().SetTag("http.route", request.Pattern)
	}
}
