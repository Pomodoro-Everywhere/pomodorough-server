package main

import (
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"

	"pomodorough/internal/server"
)

const defaultErrorMonitoringEnvironment = "production"

var sentryInTest = testing.Testing

func errorMonitoringEnvironment() string {
	if value := strings.TrimSpace(os.Getenv("SENTRY_ENVIRONMENT")); value != "" {
		return value
	}
	return defaultErrorMonitoringEnvironment
}

func errorMonitoringBlockedInTests() bool {
	return sentryInTest() && os.Getenv("SENTRY_ALLOW_IN_TESTS") != "1"
}

// initErrorMonitoring starts Sentry error monitoring when dsn is non-empty.
// An empty DSN disables monitoring. Init failure is non-fatal: the service
// keeps running without error monitoring. The returned function flushes
// buffered events and must be deferred by the caller.
func initErrorMonitoring(identity buildIdentity, dsn string, logger *slog.Logger) func() {
	if dsn == "" {
		return func() {}
	}
	if errorMonitoringBlockedInTests() {
		return func() {}
	}
	if err := sentry.Init(sentry.ClientOptions{
		Dsn:         dsn,
		Release:     errorMonitoringRelease(identity),
		Environment: errorMonitoringEnvironment(),
		BeforeSend:  sentryBeforeSend,
	}); err != nil {
		logger.Warn("error monitoring disabled", "error", err)
		return func() {}
	}
	return func() {
		sentry.Flush(5 * time.Second)
	}
}

func errorMonitoringRelease(identity buildIdentity) string {
	return "pomodorough@" + identity.version
}

// sentryBeforeSend drops event material that can carry identity or
// credential content. Capture sites tag only the route pattern and the
// static operation; the SDK must not reattach raw requests or users on top
// of those tags. At most one breadcrumb survives: the sampler records a
// single static repeat marker per suppressed burst, and any older trail is
// dropped here.
func sentryBeforeSend(event *sentry.Event, hint *sentry.EventHint) *sentry.Event {
	if event == nil {
		return nil
	}
	if hint != nil {
		if failure, ok := hint.OriginalException.(*processMonitoringError); ok {
			return sanitizedProcessEvent(event, failure)
		}
	}
	event.Request = nil
	event.User = sentry.User{}
	event.Breadcrumbs = keepLastBreadcrumb(event.Breadcrumbs)
	return event
}

// keepLastBreadcrumb retains only the newest breadcrumb. Repeat bursts
// carry one static marker; SDK-attached trails can carry URLs or tokens.
func keepLastBreadcrumb(crumbs []*sentry.Breadcrumb) []*sentry.Breadcrumb {
	if len(crumbs) == 0 {
		return nil
	}
	last := crumbs[len(crumbs)-1]
	if last == nil {
		return nil
	}
	scrubbed := *last
	scrubbed.Message = "suppressed repeat"
	scrubbed.Data = nil
	return []*sentry.Breadcrumb{&scrubbed}
}

// captureMainPanic reports a panic escaping main to monitoring, then
// re-panics to preserve the default crash behavior. Request-scoped panics
// are handled by the server recovery middleware instead.
func captureMainPanic(logger *slog.Logger) {
	recovered := recover()
	if recovered == nil {
		return
	}
	err, _ := recovered.(error)
	failure := newProcessMonitoringError("panic in main", err)
	// Local operational logs retain the failure; only static diagnostics go to Sentry.
	logger.Error("panic in main", "error", recovered)
	sentry.CaptureException(failure)
	sentry.Flush(2 * time.Second)
	panic(recovered)
}

// failStartup reports a fatal startup error to monitoring (no-op when
// disabled), logs it, and exits. Buffered monitoring events flush before exit.
func failStartup(logger *slog.Logger, message string, err error) {
	failure := newProcessMonitoringError(startupMonitoringOperation(message), err)
	// Local operational logs retain the failure; only static diagnostics go to Sentry.
	logger.Error(message, "error", err)
	sentry.CaptureException(failure)
	sentry.Flush(2 * time.Second)
	os.Exit(1)
}

// processMonitoringError never wraps the original failure: SDK unwrapping must
// not recover raw operational errors containing credentials or filesystem paths.
type processMonitoringError struct {
	operation string
	value     string
}

func (failure *processMonitoringError) Error() string { return failure.value }

func newProcessMonitoringError(operation string, err error) *processMonitoringError {
	return &processMonitoringError{
		operation: operation,
		value:     server.SanitizedMonitoringError(operation, err).Error(),
	}
}

func startupMonitoringOperation(message string) string {
	switch message {
	case "invalid build identity", "write build identity", "invalid configuration",
		"initialize shared core", "lock storage", "initialize storage",
		"initialize server", "server stopped":
		return message
	default:
		return "startup failure"
	}
}

// Rebuild process events after scope and SDK processors run. A drop-list would
// miss raw values in exception chains, stack frames, or future SDK fields.
func sanitizedProcessEvent(event *sentry.Event, failure *processMonitoringError) *sentry.Event {
	return &sentry.Event{
		EventID: event.EventID, Timestamp: event.Timestamp, Level: event.Level,
		Release: event.Release, Environment: event.Environment, Platform: "go",
		Tags:      map[string]string{"error.operation": failure.operation},
		Exception: []sentry.Exception{{Type: "process failure", Value: failure.value}},
	}
}
