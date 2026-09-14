package main

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/getsentry/sentry-go"
)

const errorMonitoringEnvironment = "production"

// initErrorMonitoring starts Sentry error monitoring when dsn is non-empty.
// An empty DSN disables monitoring. Init failure is non-fatal: the service
// keeps running without error monitoring. The returned function flushes
// buffered events and must be deferred by the caller.
func initErrorMonitoring(identity buildIdentity, dsn string, logger *slog.Logger) func() {
	if dsn == "" {
		return func() {}
	}
	if err := sentry.Init(sentry.ClientOptions{
		Dsn:         dsn,
		Release:     errorMonitoringRelease(identity),
		Environment: errorMonitoringEnvironment,
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
// static operation; the SDK must not reattach raw requests, users, or
// breadcrumbs on top of those tags.
func sentryBeforeSend(event *sentry.Event, hint *sentry.EventHint) *sentry.Event {
	if event == nil {
		return nil
	}
	event.Request = nil
	event.User = sentry.User{}
	event.Breadcrumbs = nil
	return event
}

// captureMainPanic reports a panic escaping main to monitoring, then
// re-panics to preserve the default crash behavior. Request-scoped panics
// are handled by the server recovery middleware instead.
func captureMainPanic(logger *slog.Logger) {
	recovered := recover()
	if recovered == nil {
		return
	}
	logger.Error("panic in main", "error", recovered)
	if err, ok := recovered.(error); ok {
		sentry.CaptureException(err)
	} else {
		sentry.CaptureException(fmt.Errorf("panic in main: %v", recovered))
	}
	sentry.Flush(2 * time.Second)
	panic(recovered)
}

// failStartup reports a fatal startup error to monitoring (no-op when
// disabled), logs it, and exits. Buffered monitoring events flush before exit.
func failStartup(logger *slog.Logger, message string, err error) {
	logger.Error(message, "error", err)
	sentry.CaptureException(err)
	sentry.Flush(2 * time.Second)
	os.Exit(1)
}
