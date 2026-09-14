package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"pomodorough/internal/timer"
)

func TestLifetimeReplayCrossesTenThousandAndRetriesImmutableRetarget(t *testing.T) {
	userStore, db, userID, now := openTestUser(t, "lifetime-retarget")
	defer db.Close()
	ctx := context.Background()
	commands := make([]timer.Command, 10001)
	for index := range commands {
		kind := "pause"
		if index == 0 {
			kind = "start"
		}
		commands[index] = testTimerCommand(fmt.Sprintf("operation-%08d", index), "device-lifetime", "timer-lifetime", kind,
			int64(index+1), now.Add(time.Duration(index)*time.Millisecond))
	}
	commands[0].TaskID = "task-original"
	first, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-lifetime", Commands: commands}, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if first.CanonicalTimer == nil || first.CanonicalTimer.Status != "paused" {
		t.Fatalf("unexpected projection: %#v", first)
	}
	retarget := testTimerCommand("retarget-lifetime", "device-lifetime", "timer-lifetime", "retarget", 10002, now.Add(11*time.Second))
	retarget.TaskID = "task-next"
	request := SyncRequest{DeviceID: "device-lifetime", LastRevision: first.Revision, Commands: []timer.Command{retarget}}
	applied, err := userStore.Sync(ctx, db, userID, request, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = userStore.OpenUser(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	retry, err := userStore.Sync(ctx, db, userID, request, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if retry.Changed || retry.Revision != applied.Revision || retry.CanonicalTimer.TaskID != "task-next" {
		t.Fatalf("retry changed immutable operation: %#v", retry)
	}
	request.Commands[0].TaskID = "different-payload"
	conflict, err := userStore.Sync(ctx, db, userID, request, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Acknowledgements[0].Outcome != "rejected" || conflict.CanonicalTimer.TaskID != "task-next" {
		t.Fatalf("immutable collision not rejected: %#v", conflict)
	}
	var original string
	if err := db.QueryRowContext(ctx, "SELECT task_id FROM timer_commands WHERE id = ?", commands[0].ID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if original != "task-original" {
		t.Fatal("Start payload changed")
	}
}

func TestLifetimeReplayRetainsOverTenThousandHistoriesAndResurrectsOldSession(t *testing.T) {
	userStore, db, userID, now := openTestUser(t, "lifetime-history")
	defer db.Close()
	ctx := context.Background()
	commands := make([]timer.Command, 10001)
	for index := range commands {
		commands[index] = testTimerCommand(fmt.Sprintf("start-%08d", index), "device-history", fmt.Sprintf("timer-%08d", index),
			"start", int64(index+1), now.Add(time.Duration(index)*time.Millisecond))
	}
	result, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-history", Commands: commands}, now.Add(30*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.History) != 10001 {
		t.Fatalf("lost history: %d", len(result.History))
	}
	if result.History[10000].TimerID != commands[0].TimerID {
		t.Fatal("oldest session missing or reordered")
	}
	pause := testTimerCommand("pause-old-session", "device-history", commands[0].TimerID, "pause", 10002, now.Add(31*time.Minute))
	revived, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-history", LastRevision: result.Revision,
		Commands: []timer.Command{pause}}, now.Add(32*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(revived.History) != 10000 || revived.CanonicalTimer == nil || revived.CanonicalTimer.ID != pause.TimerID || revived.CanonicalTimer.Status != "paused" {
		t.Fatalf("old session resurrection lost historical semantics: %#v", revived.CanonicalTimer)
	}
}

func TestStreamingHLCBoundsEveryCoreCallAndValidatesEveryClock(t *testing.T) {
	calls := 0
	call := func(ctx context.Context, operation string, input, output any) error {
		count := len(input.(coreHLCHeadInput).Observed)
		if count > 10000 {
			t.Fatalf("unbounded HLC input: %d", count)
		}
		calls++
		return callAccountSharedCore(ctx, operation, input, output)
	}
	sequence := func(yield func(coreHLC) bool) {
		for counter := int64(0); counter <= 20000; counter++ {
			if !yield(coreHLC{WallMs: 200, Counter: counter}) {
				return
			}
		}
	}
	head, err := hlcHeadSequenceWithCore(context.Background(), call, 100, sequence)
	if err != nil || head != (coreHLC{WallMs: 200, Counter: 20000}) || calls != 3 {
		t.Fatalf("streamed HLC = %#v, calls=%d, err=%v", head, calls, err)
	}
	invalid := func(yield func(coreHLC) bool) {
		sequence(yield)
		yield(coreHLC{WallMs: -1})
	}
	if _, err := hlcHeadSequenceWithCore(context.Background(), call, 100, invalid); err == nil {
		t.Fatal("invalid dominated clock accepted")
	}
}
