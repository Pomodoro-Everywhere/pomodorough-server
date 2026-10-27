package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

const processSecret = "/private/path-canary https://url-canary.invalid/?token=credential-canary task-title-canary"

type processTransport struct {
	events  []*sentry.Event
	flushes []time.Duration
}

func (*processTransport) Configure(sentry.ClientOptions) {}
func (*processTransport) Close()                         {}
func (transport *processTransport) SendEvent(event *sentry.Event) {
	transport.events = append(transport.events, event)
}
func (transport *processTransport) Flush(timeout time.Duration) bool {
	transport.flushes = append(transport.flushes, timeout)
	return true
}
func (transport *processTransport) FlushWithContext(ctx context.Context) bool {
	deadline, _ := ctx.Deadline()
	return transport.Flush(time.Until(deadline))
}

func installProcessTransport(t *testing.T) *processTransport {
	t.Helper()
	transport := &processTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{
		Dsn: "https://public@example.invalid/1", Transport: transport,
		BeforeSend: sentryBeforeSend, Release: "pomodorough@test", Environment: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	hub := sentry.CurrentHub()
	previous := hub.Client()
	hub.PushScope()
	hub.BindClient(client)
	t.Cleanup(func() { hub.PopScope(); hub.BindClient(previous) })
	hub.Scope().AddEventProcessor(func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
		event.Message, event.ServerName, event.Transaction = processSecret, processSecret, processSecret
		event.Request = &sentry.Request{URL: processSecret}
		event.User = sentry.User{Email: processSecret}
		event.Contexts = map[string]sentry.Context{"secret": {"value": processSecret}}
		event.Tags = map[string]string{"secret": processSecret}
		event.Fingerprint = []string{processSecret}
		event.Breadcrumbs = []*sentry.Breadcrumb{{Message: processSecret, Category: processSecret}}
		event.Exception = append(event.Exception, sentry.Exception{Value: processSecret, Type: processSecret})
		event.Attachments = []*sentry.Attachment{{Filename: processSecret, Payload: []byte(processSecret)}}
		return event
	})
	return transport
}

func assertProcessCapture(t *testing.T, transport *processTransport, operation, cause string) {
	t.Helper()
	if len(transport.events) != 1 {
		t.Fatalf("events = %d, want 1", len(transport.events))
	}
	event := transport.events[0]
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, canary := range []string{"path-canary", "url-canary", "credential-canary", "task-title-canary"} {
		if strings.Contains(string(encoded), canary) {
			t.Fatalf("final SDK event leaked %q: %s", canary, encoded)
		}
	}
	if len(event.Attachments) != 0 {
		t.Fatal("final event retained attachments")
	}
	if event.Request != nil || !event.User.IsEmpty() {
		t.Fatal("final event retained request/user")
	}
	if event.Tags["error.operation"] != operation || len(event.Exception) != 1 {
		t.Fatalf("operation/exception lost: %s", encoded)
	}
	if !strings.Contains(event.Exception[0].Value, operation+" cause="+cause+" ") {
		t.Fatalf("operation/cause lost: %s", encoded)
	}
	if len(transport.flushes) != 1 || transport.flushes[0] > 2*time.Second || transport.flushes[0] < time.Second {
		t.Fatalf("flushes = %v, want [2s]", transport.flushes)
	}
}

func TestCaptureMainPanicSanitizesFinalSDKEventAndRepanics(t *testing.T) {
	cases := []struct {
		name  string
		value any
		cause string
	}{
		{"wrapped filesystem", fmt.Errorf("%s: %w", processSecret, &os.PathError{Op: "open", Path: processSecret, Err: os.ErrPermission}), "io_permission"},
		{"arbitrary error", errors.New(processSecret), "internal"},
		{"string", processSecret, "internal"},
		{"object", map[string]string{"secret": processSecret}, "internal"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			transport := installProcessTransport(t)
			var recovered any
			func() {
				defer func() { recovered = recover() }()
				defer captureMainPanic(testLogger())
				panic(test.value)
			}()
			if !reflect.DeepEqual(recovered, test.value) {
				t.Fatal("panic value changed")
			}
			assertProcessCapture(t, transport, "panic in main", test.cause)
		})
	}
}

func TestCaptureMainPanicWithoutPanicDoesNotCaptureOrFlush(t *testing.T) {
	transport := installProcessTransport(t)
	func() { defer captureMainPanic(testLogger()) }()
	if len(transport.events) != 0 || len(transport.flushes) != 0 {
		t.Fatal("normal return captured/flushed")
	}
}

func TestFailStartupSanitizesFlushesAndExits(t *testing.T) {
	for _, operation := range []string{"initialize storage", processSecret} {
		t.Run(operation, func(t *testing.T) {
			receipt := t.TempDir() + "/event.json"
			command := exec.Command(os.Args[0], "-test.run=^TestFailStartupSubprocess$")
			command.Env = append(os.Environ(), "R53_STARTUP_RECEIPT="+receipt, "R53_STARTUP_OPERATION="+operation)
			output, err := command.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 {
				t.Fatalf("exit = %v, output: %s", err, output)
			}
			payload, err := os.ReadFile(receipt)
			if err != nil {
				t.Fatal(err)
			}
			var transport processTransport
			var result struct {
				Event   *sentry.Event
				Timeout time.Duration
			}
			if err := json.Unmarshal(payload, &result); err != nil {
				t.Fatal(err)
			}
			transport.events, transport.flushes = []*sentry.Event{result.Event}, []time.Duration{result.Timeout}
			want := operation
			if operation == processSecret {
				want = "startup failure"
			}
			assertProcessCapture(t, &transport, want, "io_permission")
		})
	}
}

type startupReceiptTransport struct {
	*processTransport
	path string
}

func (transport *startupReceiptTransport) FlushWithContext(ctx context.Context) bool {
	deadline, _ := ctx.Deadline()
	return transport.Flush(time.Until(deadline))
}

func (transport *startupReceiptTransport) Flush(timeout time.Duration) bool {
	if len(transport.events) != 1 {
		return false
	}
	if len(transport.events[0].Attachments) != 0 {
		panic("startup event retained attachments")
	}
	payload, err := json.Marshal(struct {
		Event   *sentry.Event
		Timeout time.Duration
	}{transport.events[0], timeout})
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(transport.path, payload, 0600); err != nil {
		panic(err)
	}
	return transport.processTransport.Flush(timeout)
}

func TestFailStartupSubprocess(t *testing.T) {
	path := os.Getenv("R53_STARTUP_RECEIPT")
	if path == "" {
		t.Skip("subprocess only")
	}
	transport := installProcessTransport(t)
	client, err := sentry.NewClient(sentry.ClientOptions{
		Dsn: "https://public@example.invalid/1", BeforeSend: sentryBeforeSend,
		Transport: &startupReceiptTransport{transport, path},
	})
	if err != nil {
		t.Fatal(err)
	}
	sentry.CurrentHub().BindClient(client)
	failure := fmt.Errorf("%s: %w", processSecret, &os.PathError{Op: "open", Path: processSecret, Err: os.ErrPermission})
	failStartup(testLogger(), os.Getenv("R53_STARTUP_OPERATION"), failure)
	t.Fatal("failStartup returned instead of exiting")
}
