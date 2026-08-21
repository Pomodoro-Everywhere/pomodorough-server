package server

import "testing"

func TestRevisionHubDisconnectClosesExistingStreamsAndResetsAccountRevision(t *testing.T) {
	hub := newRevisionHub()
	updates, unsubscribe := hub.subscribe("account")
	hub.publish("account", 42)
	if revision := <-updates; revision != 42 {
		t.Fatalf("initial revision = %d, want 42", revision)
	}

	hub.disconnect("account")
	if _, open := <-updates; open {
		t.Fatal("account stream remained open after disconnect")
	}
	unsubscribe()

	fresh, freshUnsubscribe := hub.subscribe("account")
	defer freshUnsubscribe()
	hub.publish("account", 1)
	if revision := <-fresh; revision != 1 {
		t.Fatalf("recreated account revision = %d, want 1", revision)
	}
}
