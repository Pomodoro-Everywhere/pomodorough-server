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
	hub.Scope().SetTag("http.method", request.Method)
	if request.Pattern != "" {
		hub.Scope().SetTag("http.route", request.Pattern)
	}
	if err, ok := recovered.(error); ok {
		hub.CaptureException(err)
		return
	}
	hub.CaptureException(fmt.Errorf("panic serving request: %v", recovered))
}
