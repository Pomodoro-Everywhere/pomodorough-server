package timer

import (
	"fmt"
	"testing"
	"time"
)

func TestReduceCompleteStateCommandTargetMatrix(t *testing.T) {
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	states := []string{"absent", "running", "paused", "completed", "cancelled", "superseded"}
	commandTypes := []string{"start", "pause", "resume", "finish", "cancel", "clear"}
	targets := []string{"same", "foreign"}
	cases := 0

	for _, state := range states {
		for _, commandType := range commandTypes {
			for _, target := range targets {
				state, commandType, target := state, commandType, target
				t.Run(fmt.Sprintf("%s/%s/%s", state, commandType, target), func(t *testing.T) {
					commands := matrixSetup(base, state)
					targetID := "timer-state"
					if target == "foreign" {
						targetID = "timer-foreign"
					}
					action := command("matrix-action", "device-action", targetID, commandType, 99, 1_000, base.Add(10*time.Second), 10_000)
					result := Reduce(append(commands, action), base.Add(11*time.Second))
					wantOutcome := matrixOutcome(state, commandType, target)
					if got := result.Outcomes[action.ID]; got != wantOutcome {
						t.Fatalf("outcome = %#v, want %#v", got, wantOutcome)
					}
					wantStateStatus, wantPresent := matrixStateSession(state, commandType, target)
					stateSession, present := matrixSession(result.Sessions, "timer-state")
					if present != wantPresent || present && stateSession.Status != wantStateStatus {
						t.Fatalf("state session = %#v/%t, want status %q present %t", stateSession, present, wantStateStatus, wantPresent)
					}
					foreignSession, foreignPresent := matrixSession(result.Sessions, "timer-foreign")
					wantForeign := target == "foreign" && commandType == "start"
					if foreignPresent != wantForeign || foreignPresent && foreignSession.Status != "running" {
						t.Fatalf("foreign session = %#v/%t, want running present %t", foreignSession, foreignPresent, wantForeign)
					}
					wantSessionCount := 0
					if wantPresent {
						wantSessionCount++
					}
					if wantForeign {
						wantSessionCount++
					}
					if state == "superseded" {
						wantSessionCount++
					}
					if len(result.Sessions) != wantSessionCount {
						t.Fatalf("sessions = %#v, want %d exact sessions", result.Sessions, wantSessionCount)
					}
					wantCanonicalID, wantCanonicalStatus := matrixCanonical(state, commandType, target)
					if wantCanonicalID == "" {
						if result.Canonical != nil {
							t.Fatalf("canonical = %#v, want nil", result.Canonical)
						}
					} else if result.Canonical == nil || result.Canonical.ID != wantCanonicalID || result.Canonical.Status != wantCanonicalStatus {
						t.Fatalf("canonical = %#v, want %s/%s", result.Canonical, wantCanonicalID, wantCanonicalStatus)
					}
				})
				cases++
			}
		}
	}
	if cases != 72 {
		t.Fatalf("matrix covered %d cases, want 72", cases)
	}
}

func matrixSetup(base time.Time, state string) []Command {
	start := command("setup-start", "device-setup", "timer-state", "start", 1, 100, base, 0)
	switch state {
	case "absent":
		return nil
	case "running":
		return []Command{start}
	case "paused":
		return []Command{start, command("setup-pause", "device-setup", "timer-state", "pause", 2, 200, base.Add(time.Second), 1_000)}
	case "completed":
		return []Command{start, command("setup-finish", "device-setup", "timer-state", "finish", 2, 200, base.Add(time.Second), 1_000)}
	case "cancelled":
		return []Command{start, command("setup-cancel", "device-setup", "timer-state", "cancel", 2, 200, base.Add(time.Second), 1_000)}
	case "superseded":
		return []Command{start, command("setup-replacement", "device-setup", "timer-current", "start", 2, 200, base.Add(time.Second), 0)}
	default:
		panic("unknown matrix state: " + state)
	}
}

func matrixOutcome(state, commandType, target string) Outcome {
	same := target == "same"
	switch commandType {
	case "start":
		if same && state != "absent" {
			return Outcome{Outcome: "ignored", Reason: "timer already exists"}
		}
		return Outcome{Outcome: "applied"}
	case "pause":
		if same && state == "running" {
			return Outcome{Outcome: "applied"}
		}
		return Outcome{Outcome: "ignored", Reason: "timer is not the active running timer"}
	case "resume":
		if same && (state == "paused" || state == "superseded") {
			return Outcome{Outcome: "applied"}
		}
		return Outcome{Outcome: "ignored", Reason: "timer cannot be resumed"}
	case "finish", "cancel":
		if same && (state == "running" || state == "paused") {
			return Outcome{Outcome: "applied"}
		}
		return Outcome{Outcome: "ignored", Reason: "timer is not active"}
	case "clear":
		if same && (state == "completed" || state == "cancelled") {
			return Outcome{Outcome: "applied"}
		}
		return Outcome{Outcome: "ignored", Reason: "timer cannot be cleared"}
	default:
		panic("unknown matrix command: " + commandType)
	}
}

func matrixStateSession(state, commandType, target string) (string, bool) {
	if state == "absent" {
		if commandType == "start" && target == "same" {
			return "running", true
		}
		return "", false
	}
	if target == "foreign" {
		if commandType == "start" && (state == "running" || state == "paused") {
			return "superseded", true
		}
		return state, true
	}
	switch commandType {
	case "pause":
		if state == "running" {
			return "paused", true
		}
	case "resume":
		if state == "paused" || state == "superseded" {
			return "running", true
		}
	case "finish":
		if state == "running" || state == "paused" {
			return "completed", true
		}
	case "cancel":
		if state == "running" || state == "paused" {
			return "cancelled", true
		}
	}
	return state, true
}

func matrixCanonical(state, commandType, target string) (string, string) {
	if commandType == "start" && (target == "foreign" || state == "absent") {
		if target == "foreign" {
			return "timer-foreign", "running"
		}
		return "timer-state", "running"
	}
	if state == "absent" {
		return "", ""
	}
	if state == "superseded" {
		if commandType == "resume" && target == "same" {
			return "timer-state", "running"
		}
		return "timer-current", "running"
	}
	if commandType == "clear" && target == "same" && (state == "completed" || state == "cancelled") {
		return "", ""
	}
	status, _ := matrixStateSession(state, commandType, target)
	return "timer-state", status
}

func matrixSession(sessions []Session, timerID string) (Session, bool) {
	for _, session := range sessions {
		if session.TimerID == timerID {
			return session, true
		}
	}
	return Session{}, false
}
