package main

import (
	"testing"

	"github.com/getsentry/sentry-go"
)

// S69: the backend BeforeSend drop-list keeps identity and credential
// material out of error monitoring even if the SDK attaches it.
func TestSentryBeforeSendDropsRequestUserAndBreadcrumbs(t *testing.T) {
	event := &sentry.Event{
		Message: "sync account mutations",
		Request: &sentry.Request{
			URL:     "https://pomodorough.egigoka.me/api/v1/sync?token=token-secret-xyz",
			Headers: map[string]string{"Authorization": "Bearer bearer-secret-123"},
		},
		User:        sentry.User{ID: "user-1", Email: "user@example.com"},
		Breadcrumbs: []*sentry.Breadcrumb{{Message: "session-secret-456"}},
		Tags:        map[string]string{"error.operation": "sync account mutations"},
	}
	got := sentryBeforeSend(event, nil)
	if got == nil {
		t.Fatal("BeforeSend dropped the event; want scrubbed delivery")
	}
	if got.Request != nil {
		t.Fatalf("event request = %+v, want nil", got.Request)
	}
	if !got.User.IsEmpty() {
		t.Fatalf("event user = %+v, want empty", got.User)
	}
	if len(got.Breadcrumbs) != 0 {
		t.Fatalf("breadcrumbs = %d, want 0", len(got.Breadcrumbs))
	}
	if got.Tags["error.operation"] != "sync account mutations" {
		t.Fatalf("error.operation = %q, want pattern tag kept", got.Tags["error.operation"])
	}
	if sentryBeforeSend(nil, nil) != nil {
		t.Fatal("BeforeSend(nil) must stay nil")
	}
}
