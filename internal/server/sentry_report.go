package server

import (
	"fmt"
	"net/http"

	"github.com/getsentry/sentry-go"
)

// reportPanicToErrorMonitoring forwards an already-logged request panic to
// error monitoring. It is a no-op when monitoring is disabled (empty DSN),
// so request handling never depends on monitoring availability. Only the
// route pattern is tagged; request paths can carry user identity material.
func reportPanicToErrorMonitoring(recovered any, request *http.Request) {
	hub := sentry.CurrentHub().Clone()
	if request != nil {
		setRoutePatternTags(hub, request)
	}
	if err, ok := recovered.(error); ok {
		hub.CaptureException(err)
		return
	}
	hub.CaptureException(fmt.Errorf("panic serving request: %v", recovered))
}

// reportInternalErrorToErrorMonitoring forwards an already-logged internal
// request failure to error monitoring. It reports once per call, tags only
// the route pattern (never raw paths, queries, bodies, or credentials), and
// is a no-op when monitoring is disabled.
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
	if operation == "" {
		hub.CaptureException(err)
		return
	}
	hub.CaptureException(fmt.Errorf("%s: %w", operation, err))
}

func setRoutePatternTags(hub *sentry.Hub, request *http.Request) {
	hub.Scope().SetTag("http.method", request.Method)
	if request.Pattern != "" {
		hub.Scope().SetTag("http.route", request.Pattern)
	}
}
