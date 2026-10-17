package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestR49S08MutationCancellation(t *testing.T) {
	for _, mutation := range r49S08Mutations() {
		for _, sentinel := range []error{context.Canceled, context.DeadlineExceeded} {
			for _, authentication := range []string{"bearer", "cookie"} {
				t.Run(mutation.name+"/"+sentinel.Error()+"/"+authentication, func(t *testing.T) {
					r49S08TestCanceledMutation(t, mutation, sentinel, authentication)
				})
			}
		}
	}
}

func r49S08TestCanceledMutation(t *testing.T, mutation r49S08Mutation, sentinel error, authentication string) {
	t.Helper()
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	response := r49S08Serve(t, fixture, mutation, authentication, func(w http.ResponseWriter, request *http.Request, identity principal) {
		ctx := r49S08CanceledContext(t, request.Context(), sentinel)
		// Observe the real store error before exercising the production handler.
		if failure := mutation.storeFailure(fixture, ctx, identity); !errors.Is(failure, sentinel) {
			t.Fatalf("production store error=%v, want typed %v", failure, sentinel)
		}
		mutation.serve(fixture.application, w, request.WithContext(ctx), identity)
	})
	r49S08AssertWire(t, response)
	r49S08AssertMetrics(t, fixture.application, mutation, 1, 1)
	r49S08Events(t, transport, 0)
	if !strings.Contains(logs.String(), "level=INFO msg=\""+mutation.operation+" canceled\"") {
		t.Error("missing operation-specific cancellation info log")
	}
	if strings.Contains(logs.String(), "level=ERROR") {
		t.Error("cancellation logged at error level")
	}
	r49S08AssertUnchanged(t, fixture)
}

type r49S08DatabaseFault struct {
	name, command, message, cause string
	code                          int
}

func r49S08DatabaseFaults(mutation r49S08Mutation) []r49S08DatabaseFault {
	faults := []r49S08DatabaseFault{{"missing-metadata", "DROP TABLE account_metadata", "no such table", "sqlite_other", 1}}
	for _, message := range []string{"context canceled", "context deadline exceeded"} {
		// The revocation triggers fail after earlier UPDATEs in the real transaction.
		command := fmt.Sprintf("CREATE TRIGGER r49_s08_fault BEFORE %s BEGIN SELECT RAISE(ABORT, '%s: database failure'); END", mutation.triggerTarget, message)
		faults = append(faults, r49S08DatabaseFault{message + "-text", command, message, "sqlite_constraint", 1811})
	}
	return faults
}

func TestR49S08GenuineMutationFailureReports(t *testing.T) {
	for _, mutation := range r49S08Mutations() {
		for _, fault := range r49S08DatabaseFaults(mutation) {
			for _, authentication := range []string{"bearer", "cookie"} {
				t.Run(mutation.name+"/"+fault.name+"/"+authentication, func(t *testing.T) {
					r49S08TestDatabaseFailure(t, mutation, fault, authentication)
				})
			}
		}
	}
}

func r49S08TestDatabaseFailure(t *testing.T, mutation r49S08Mutation, fault r49S08DatabaseFault, authentication string) {
	t.Helper()
	transport := initMockSentry(t)
	fixture := newServerFixture(t)
	logs := r49S08CaptureLogs(fixture.application)
	response := r49S08Serve(t, fixture, mutation, authentication, func(w http.ResponseWriter, request *http.Request, identity principal) {
		r49S08DatabaseCommand(t, fixture, fault.command)
		failure := mutation.storeFailure(fixture, request.Context(), identity)
		r49S08AssertSQLiteFailure(t, request.Context(), failure, fault.code, fault.message)
		mutation.serve(fixture.application, w, request, identity)
	})
	r49S08AssertWire(t, response)
	r49S08AssertMetrics(t, fixture.application, mutation, 1, 0)
	events := r49S08Events(t, transport, 1)
	if len(events) == 1 {
		for key, want := range map[string]string{
			"error.operation": mutation.operation, "error.cause": fault.cause,
			"http.method": "POST", "http.route": "POST " + mutation.path, "http.idempotency_key": "present",
		} {
			if got := events[0].Tags[key]; got != want {
				t.Errorf("Sentry %s=%q, want %q", key, got, want)
			}
		}
		assertEventHasNoPII(t, events[0], []string{fixture.userID, fixture.accessToken, fixture.webToken, fixture.csrfToken, "database failure"})
	}
	if !strings.Contains(logs.String(), "level=ERROR msg=\""+mutation.operation+"\"") {
		t.Error("missing operation-specific error log")
	}
	if strings.Contains(logs.String(), "msg=\""+mutation.operation+" canceled\"") {
		t.Error("genuine database failure logged as cancellation")
	}
	if fault.name != "missing-metadata" {
		r49S08AssertUnchanged(t, fixture)
	}
}

func TestR49S08RepeatedMutationCancellationCountsOnce(t *testing.T) {
	for _, mutation := range r49S08Mutations() {
		t.Run(mutation.name, func(t *testing.T) {
			transport := initMockSentry(t)
			fixture := newServerFixture(t)
			for call := uint64(1); call <= 4; call++ {
				authentication, sentinel := "bearer", context.Canceled
				if call%2 == 0 {
					authentication, sentinel = "cookie", context.DeadlineExceeded
				}
				response := r49S08Serve(t, fixture, mutation, authentication, func(w http.ResponseWriter, request *http.Request, identity principal) {
					ctx := r49S08CanceledContext(t, request.Context(), sentinel)
					mutation.serve(fixture.application, w, request.WithContext(ctx), identity)
				})
				r49S08AssertWire(t, response)
				r49S08AssertMetrics(t, fixture.application, mutation, call, call)
				r49S08Events(t, transport, 0)
				r49S08AssertUnchanged(t, fixture)
			}
		})
	}
}
