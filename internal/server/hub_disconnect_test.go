package server

import "testing"

func TestRevisionHubDisconnectClosesExistingStreamsAndResetsAccountRevision(t *testing.T) {
	hub := newRevisionHub()
	updates, unsubscribe := hub.subscribe("account", 1)
	hub.publish("account", 1, 42)
	if revision := <-updates; revision != 42 {
		t.Fatalf("initial revision = %d, want 42", revision)
	}

	hub.disconnect("account", 1)
	if _, open := <-updates; open {
		t.Fatal("account stream remained open after disconnect")
	}
	unsubscribe()

	fresh, freshUnsubscribe := hub.subscribe("account", 2)
	defer freshUnsubscribe()
	hub.publish("account", 2, 1)
	if revision := <-fresh; revision != 1 {
		t.Fatalf("recreated account revision = %d, want 1", revision)
	}
}

func TestRevisionHubLateOldGenerationEventsCannotAffectRecreatedAccount(t *testing.T) {
	hub := newRevisionHub()
	old, unsubscribeOld := hub.subscribe("account", 1, "shared-session", "shared-device")
	defer unsubscribeOld()
	hub.publish("account", 1, 42)
	receiveRevision(t, old, 42)

	fresh, unsubscribeFresh := hub.subscribe("account", 2, "shared-session", "shared-device")
	defer unsubscribeFresh()
	hub.publish("account", 2, 1)
	receiveRevision(t, fresh, 1)

	hub.publish("account", 1, 43)
	assertNoRevision(t, fresh)
	hub.disconnectSession("account", 1, "shared-session")
	assertRevisionStreamOpen(t, fresh)
	hub.disconnectDevice("account", 1, "shared-device")
	assertRevisionStreamOpen(t, fresh)
	hub.disconnect("account", 1)
	assertRevisionStreamOpen(t, fresh)
}

func TestRevisionHubDisconnectSessionOnlyClosesMatchingSession(t *testing.T) {
	hub := newRevisionHub()
	revoked, unsubscribeRevoked := hub.subscribe("account", 1, "session-1", "device-1")
	defer unsubscribeRevoked()
	unrelated, unsubscribeUnrelated := hub.subscribe("account", 1, "session-2", "device-2")
	defer unsubscribeUnrelated()

	hub.disconnectSession("account", 1, "session-1")
	assertRevisionStreamClosed(t, revoked)
	assertRevisionStreamOpen(t, unrelated)
	hub.publish("account", 1, 1)
	receiveRevision(t, unrelated, 1)
}

func TestRevisionHubDisconnectDeviceClosesEveryMatchingDeviceSession(t *testing.T) {
	hub := newRevisionHub()
	first, unsubscribeFirst := hub.subscribe("account", 1, "session-1", "device-1")
	defer unsubscribeFirst()
	second, unsubscribeSecond := hub.subscribe("account", 1, "session-2", "device-1")
	defer unsubscribeSecond()
	unrelated, unsubscribeUnrelated := hub.subscribe("account", 1, "session-3", "device-2")
	defer unsubscribeUnrelated()

	hub.disconnectDevice("account", 1, "device-1")
	assertRevisionStreamClosed(t, first)
	assertRevisionStreamClosed(t, second)
	assertRevisionStreamOpen(t, unrelated)
	hub.publish("account", 1, 1)
	receiveRevision(t, unrelated, 1)
}

func assertRevisionStreamClosed(t *testing.T, revisions <-chan int64) {
	t.Helper()
	select {
	case _, open := <-revisions:
		if open {
			t.Fatal("revision stream remained open")
		}
	default:
		t.Fatal("revision stream remained open")
	}
}

func assertRevisionStreamOpen(t *testing.T, revisions <-chan int64) {
	t.Helper()
	select {
	case revision, open := <-revisions:
		if !open {
			t.Fatal("unrelated revision stream closed")
		}
		t.Fatalf("unrelated revision stream received %d", revision)
	default:
	}
}
