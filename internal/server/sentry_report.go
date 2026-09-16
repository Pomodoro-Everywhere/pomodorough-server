package server

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
)

const (
	errorRepeatBaseBackoff = 30 * time.Second
	errorRepeatMaxBackoff  = 10 * time.Minute
)

type errorSampleEntry struct {
	last    time.Time
	repeats int
}

var (
	errorSampleMu     sync.Mutex
	errorSampleState  = map[string]errorSampleEntry{}
	errorSampleNow    = time.Now
	errorSampleJitter = func() float64 { return rand.Float64() }
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
// request failure to error monitoring. Repeat bursts for one operation and
// route pattern collapse to a single sampled error plus one breadcrumb per
// suppressed repeat, so a hot failure cannot spam monitoring. Tags carry
// only the route pattern (never raw paths, queries, bodies, or
// credentials), the exception value carries only the static operation
// (never the raw error message), and the call is a no-op when monitoring
// is disabled.
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
	key := internalErrorKey(operation, request)
	if repeats, sampled := sampleInternalError(key); !sampled {
		noteInternalErrorRepeat(hub, operation, repeats)
		return
	}
	hub.CaptureException(sanitizedMonitoringError(operation, err))
}

// internalErrorKey groups repeats by static operation plus route pattern.
// Raw paths, queries, and header values never enter the key.
func internalErrorKey(operation string, request *http.Request) string {
	if request == nil {
		return "no-request|" + operation
	}
	route := request.Pattern
	if route == "" {
		route = "unpatterned"
	}
	return request.Method + "|" + route + "|" + operation
}

// sampleInternalError applies jittered exponential backoff per key. The
// first sighting reports; repeats inside the backoff window suppress the
// event (the caller records a breadcrumb instead).
func sampleInternalError(key string) (int, bool) {
	now := errorSampleNow()
	errorSampleMu.Lock()
	defer errorSampleMu.Unlock()
	entry := errorSampleState[key]
	if entry.last.IsZero() {
		errorSampleState[key] = errorSampleEntry{last: now}
		return 0, true
	}
	backoff := internalErrorBackoff(entry.repeats)
	if now.Sub(entry.last) < backoff {
		entry.repeats++
		errorSampleState[key] = entry
		return entry.repeats, false
	}
	errorSampleState[key] = errorSampleEntry{last: now}
	return 0, true
}

// internalErrorBackoff doubles per consecutive repeat from a 30s base,
// capped at 10m, with ±20% jitter so fleet-wide failures desynchronize.
func internalErrorBackoff(repeats int) time.Duration {
	shift := min(max(repeats, 0), 5)
	backoff := errorRepeatBaseBackoff << shift
	if backoff > errorRepeatMaxBackoff || backoff <= 0 {
		backoff = errorRepeatMaxBackoff
	}
	jitter := (errorSampleJitter()*2 - 1) * 0.2
	scaled := float64(backoff) * (1 + jitter)
	if scaled < float64(errorRepeatBaseBackoff)/2 {
		scaled = float64(errorRepeatBaseBackoff) / 2
	}
	return time.Duration(scaled)
}

// noteInternalErrorRepeat records one breadcrumb for a suppressed repeat.
// The breadcrumb carries only the static operation and the repeat count.
func noteInternalErrorRepeat(hub *sentry.Hub, operation string, repeats int) {
	if hub == nil {
		return
	}
	hub.AddBreadcrumb(&sentry.Breadcrumb{
		Message:  "suppressed repeat " + operation,
		Level:    sentry.LevelWarning,
		Category: "error.repeat",
		Data:     map[string]interface{}{"repeats": repeats},
	}, nil)
}

func resetInternalErrorSamplerForTest() {
	errorSampleMu.Lock()
	defer errorSampleMu.Unlock()
	errorSampleState = map[string]errorSampleEntry{}
}

func setRoutePatternTags(hub *sentry.Hub, request *http.Request) {
	hub.Scope().SetTag("http.method", request.Method)
	if request.Pattern != "" {
		hub.Scope().SetTag("http.route", request.Pattern)
	}
	hub.Scope().SetTag("http.idempotency_key", idempotencyPresence(request))
}

// idempotencyPresence records only whether the client sent an
// Idempotency-Key, never its value.
func idempotencyPresence(request *http.Request) string {
	if request != nil && request.Header.Get("Idempotency-Key") != "" {
		return "present"
	}
	return "absent"
}
