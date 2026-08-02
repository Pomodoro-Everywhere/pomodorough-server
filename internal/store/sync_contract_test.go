package store

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

func TestSyncLWWConvergesAcrossEveryInputArrivalPermutation(t *testing.T) {
	permutations := indexPermutations(3)
	if len(permutations) != 6 {
		t.Fatalf("permutation count = %d, want 6", len(permutations))
	}
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)

	t.Run("tasks", func(t *testing.T) {
		operations := []task.Operation{
			{ID: "task-arrival-old", DeviceID: "device-task-a", TaskID: "task-arrival", Type: "upsert", Title: "Old", OccurredAt: base, HLCWallMs: 100},
			{ID: "task-arrival-middle", DeviceID: "device-task-b", TaskID: "task-arrival", Type: "delete", OccurredAt: base, HLCWallMs: 200},
			{ID: "task-arrival-new", DeviceID: "device-task-c", TaskID: "task-arrival", Type: "upsert", Title: "New", OccurredAt: base, HLCWallMs: 300},
		}
		for permutationIndex, permutation := range permutations {
			permutationIndex, permutation := permutationIndex, permutation
			t.Run(fmt.Sprintf("permutation-%02d", permutationIndex), func(t *testing.T) {
				userStore, db, userID, _ := openTestUser(t, fmt.Sprintf("task-arrival-%02d", permutationIndex))
				defer db.Close()
				for revision, operationIndex := range permutation {
					operation := operations[operationIndex]
					result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{
						DeviceID: operation.DeviceID, LastRevision: int64(revision), TaskOperations: []task.Operation{operation},
					}, base)
					if err != nil || !result.Changed || result.Revision != int64(revision+1) {
						t.Fatalf("arrival %d result = %#v, %v", revision, result, err)
					}
				}
				result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{DeviceID: "device-pull", LastRevision: 3}, base)
				if err != nil || len(result.Tasks) != 1 || result.Tasks[0] != (task.Task{ID: "task-arrival", Title: "New"}) {
					t.Fatalf("final task state = %#v, %v", result.Tasks, err)
				}
			})
		}
	})

	t.Run("durations", func(t *testing.T) {
		operations := []DurationOperation{
			{ID: "duration-arrival-old", DeviceID: "device-duration-a", Phase: "focus", DurationMs: 1_200_000, OccurredAt: base, HLCWallMs: 100},
			{ID: "duration-arrival-middle", DeviceID: "device-duration-b", Phase: "focus", DurationMs: 1_500_000, OccurredAt: base, HLCWallMs: 200},
			{ID: "duration-arrival-new", DeviceID: "device-duration-c", Phase: "focus", DurationMs: 1_800_000, OccurredAt: base, HLCWallMs: 300},
		}
		for permutationIndex, permutation := range permutations {
			permutationIndex, permutation := permutationIndex, permutation
			t.Run(fmt.Sprintf("permutation-%02d", permutationIndex), func(t *testing.T) {
				userStore, db, userID, _ := openTestUser(t, fmt.Sprintf("duration-arrival-%02d", permutationIndex))
				defer db.Close()
				for revision, operationIndex := range permutation {
					operation := operations[operationIndex]
					result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{
						DeviceID: operation.DeviceID, LastRevision: int64(revision), DurationOperations: []DurationOperation{operation},
					}, base)
					if err != nil || !result.Changed || result.Revision != int64(revision+1) {
						t.Fatalf("arrival %d result = %#v, %v", revision, result, err)
					}
				}
				result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{DeviceID: "device-pull", LastRevision: 3}, base)
				if err != nil || result.DurationsMs.Focus != 1_800_000 {
					t.Fatalf("final duration state = %#v, %v", result.DurationsMs, err)
				}
			})
		}
	})

	t.Run("auto-start", func(t *testing.T) {
		operations := []AutoStartOperation{
			{ID: "auto-start-arrival-old", DeviceID: "device-auto-a", Enabled: true, OccurredAt: base, HLCWallMs: 100},
			{ID: "auto-start-arrival-middle", DeviceID: "device-auto-b", Enabled: false, OccurredAt: base, HLCWallMs: 200},
			{ID: "auto-start-arrival-new", DeviceID: "device-auto-c", Enabled: true, OccurredAt: base, HLCWallMs: 300},
		}
		for permutationIndex, permutation := range permutations {
			permutationIndex, permutation := permutationIndex, permutation
			t.Run(fmt.Sprintf("permutation-%02d", permutationIndex), func(t *testing.T) {
				userStore, db, userID, _ := openTestUser(t, fmt.Sprintf("auto-arrival-%02d", permutationIndex))
				defer db.Close()
				for revision, operationIndex := range permutation {
					operation := operations[operationIndex]
					result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{
						DeviceID: operation.DeviceID, LastRevision: int64(revision), AutoStartOperations: []AutoStartOperation{operation},
					}, base)
					if err != nil || !result.Changed || result.Revision != int64(revision+1) {
						t.Fatalf("arrival %d result = %#v, %v", revision, result, err)
					}
				}
				result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{DeviceID: "device-pull", LastRevision: 3}, base)
				if err != nil || !result.AutoStartBreaks {
					t.Fatalf("final auto-start state = %t, %v", result.AutoStartBreaks, err)
				}
			})
		}
	})
}

func TestSyncLWWTupleTieBoundariesAreArrivalIndependent(t *testing.T) {
	type clock struct {
		wall    int64
		counter int64
		device  string
		id      string
	}
	boundaries := []struct {
		name   string
		lower  clock
		higher clock
	}{
		{name: "wall", lower: clock{wall: 100, counter: 9, device: "device-z", id: "operation-z"}, higher: clock{wall: 101, counter: 0, device: "device-a", id: "operation-a"}},
		{name: "counter", lower: clock{wall: 100, counter: 0, device: "device-z", id: "operation-z"}, higher: clock{wall: 100, counter: 1, device: "device-a", id: "operation-a"}},
		{name: "device", lower: clock{wall: 100, counter: 0, device: "device-a", id: "operation-z"}, higher: clock{wall: 100, counter: 0, device: "device-z", id: "operation-a"}},
		{name: "operation ID", lower: clock{wall: 100, counter: 0, device: "device-a", id: "operation-a"}, higher: clock{wall: 100, counter: 0, device: "device-a", id: "operation-z"}},
	}
	base := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	orders := [][]int{{0, 1}, {1, 0}}

	for _, domain := range []string{"task", "duration", "auto-start"} {
		for _, boundary := range boundaries {
			for orderIndex, order := range orders {
				domain, boundary, orderIndex, order := domain, boundary, orderIndex, order
				t.Run(fmt.Sprintf("%s/%s/order-%d", domain, boundary.name, orderIndex), func(t *testing.T) {
					userStore, db, userID, _ := openTestUser(t, fmt.Sprintf("tie-%s-%s-%d", domain, boundary.name, orderIndex))
					defer db.Close()
					clocks := []clock{boundary.lower, boundary.higher}
					for _, clockIndex := range order {
						value := clocks[clockIndex]
						request := SyncRequest{DeviceID: value.device}
						switch domain {
						case "task":
							operationType, title := "delete", ""
							if clockIndex == 1 {
								operationType, title = "upsert", "Winner"
							}
							request.TaskOperations = []task.Operation{{ID: value.id, TaskID: "task-tie", Type: operationType, Title: title, OccurredAt: base, HLCWallMs: value.wall, HLCCounter: value.counter}}
						case "duration":
							duration := int64(1_200_000)
							if clockIndex == 1 {
								duration = 1_800_000
							}
							request.DurationOperations = []DurationOperation{{ID: value.id, Phase: "focus", DurationMs: duration, OccurredAt: base, HLCWallMs: value.wall, HLCCounter: value.counter}}
						case "auto-start":
							request.AutoStartOperations = []AutoStartOperation{{ID: value.id, Enabled: clockIndex == 1, OccurredAt: base, HLCWallMs: value.wall, HLCCounter: value.counter}}
						}
						if _, err := userStore.Sync(context.Background(), db, userID, request, base); err != nil {
							t.Fatal(err)
						}
					}
					result, err := userStore.Sync(context.Background(), db, userID, SyncRequest{DeviceID: "device-pull"}, base)
					if err != nil {
						t.Fatal(err)
					}
					switch domain {
					case "task":
						if len(result.Tasks) != 1 || result.Tasks[0].Title != "Winner" {
							t.Fatalf("task winner = %#v", result.Tasks)
						}
					case "duration":
						if result.DurationsMs.Focus != 1_800_000 {
							t.Fatalf("duration winner = %d", result.DurationsMs.Focus)
						}
					case "auto-start":
						if !result.AutoStartBreaks {
							t.Fatal("auto-start loser won")
						}
					}
				})
			}
		}
	}
}

func TestSyncDeviceSequenceGapsRegressionsRetriesAndReuse(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "device-sequence-contract")
	defer db.Close()
	deviceID := "device-sequence-a"
	steps := []timer.Command{
		testTimerCommand("command-sequence-10", deviceID, "timer-sequence", "start", 10, now),
		testTimerCommand("command-sequence-02", deviceID, "timer-sequence", "pause", 2, now.Add(time.Second)),
		testTimerCommand("command-sequence-100", deviceID, "timer-sequence", "resume", 100, now.Add(2*time.Second)),
	}
	for index, command := range steps {
		result, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: deviceID, Commands: []timer.Command{command}}, command.OccurredAt)
		if err != nil || !result.Changed || result.Revision != int64(index+1) || result.Acknowledgements[0].Outcome != "applied" {
			t.Fatalf("sequence step %d = %#v, %v", index, result, err)
		}
	}

	retry, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: deviceID, LastRevision: 1, Commands: []timer.Command{steps[1]}}, now.Add(3*time.Second))
	if err != nil || retry.Changed || retry.Revision != 3 || retry.Acknowledgements[0].Outcome != "applied" {
		t.Fatalf("exact sequence retry = %#v, %v", retry, err)
	}

	reused := testTimerCommand("command-sequence-reused", deviceID, "timer-sequence", "cancel", 10, now.Add(4*time.Second))
	conflict, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: deviceID, Commands: []timer.Command{reused}}, now.Add(4*time.Second))
	if err != nil || conflict.Changed || conflict.Revision != 3 || conflict.Acknowledgements[0] != (Acknowledgement{
		CommandID: reused.ID, Outcome: "rejected", Reason: "device sequence already used",
	}) {
		t.Fatalf("reused sequence = %#v, %v", conflict, err)
	}

	otherDevice := testTimerCommand("command-sequence-other", "device-sequence-b", "timer-other", "start", 10, now.Add(5*time.Second))
	accepted, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-sequence-b", Commands: []timer.Command{otherDevice}}, now.Add(5*time.Second))
	if err != nil || !accepted.Changed || accepted.Revision != 4 || accepted.Acknowledgements[0].Outcome != "applied" {
		t.Fatalf("other-device sequence reuse = %#v, %v", accepted, err)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM timer_commands`).Scan(&count); err != nil || count != 4 {
		t.Fatalf("stored command count = %d, %v; want 4", count, err)
	}
}

func TestSyncLowerEqualAndHigherLastRevisionAllReconcile(t *testing.T) {
	for _, testCase := range []struct {
		name         string
		lastRevision int64
	}{
		{name: "lower", lastRevision: 0},
		{name: "equal", lastRevision: 1},
		{name: "higher", lastRevision: 2},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			userStore, db, userID, now := openTestUser(t, "last-revision-"+testCase.name)
			defer db.Close()
			seed := AutoStartOperation{ID: "auto-start-seed", Enabled: true, OccurredAt: now, HLCWallMs: now.UnixMilli()}
			if _, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-revision", AutoStartOperations: []AutoStartOperation{seed}}, now); err != nil {
				t.Fatal(err)
			}

			pull, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: "device-revision", LastRevision: testCase.lastRevision}, now.Add(time.Second))
			if err != nil || pull.Changed || pull.Revision != 1 || !pull.AutoStartBreaks {
				t.Fatalf("reconciliation pull = %#v, %v", pull, err)
			}

			operation := AutoStartOperation{ID: "auto-start-next", Enabled: false, OccurredAt: now.Add(2 * time.Second), HLCWallMs: now.Add(2 * time.Second).UnixMilli()}
			mutation, err := userStore.Sync(ctx, db, userID, SyncRequest{
				DeviceID: "device-revision", LastRevision: testCase.lastRevision, AutoStartOperations: []AutoStartOperation{operation},
			}, now.Add(2*time.Second))
			if err != nil || !mutation.Changed || mutation.Revision != 2 || mutation.AutoStartBreaks || mutation.AutoStartAcknowledgements[0].Outcome != "applied" {
				t.Fatalf("reconciliation mutation = %#v, %v", mutation, err)
			}
		})
	}
}

func TestSyncExactLostResponseRetriesAndIgnoredStoredBatchesByDomain(t *testing.T) {
	for _, domain := range []string{"timer", "task", "duration", "auto-start"} {
		domain := domain
		t.Run(domain, func(t *testing.T) {
			ctx := context.Background()
			userStore, db, userID, now := openTestUser(t, "retry-domain-"+domain)
			defer db.Close()
			winner, loser := domainRequests(domain, now)

			first, err := userStore.Sync(ctx, db, userID, winner, now)
			firstAck := domainAck(first, domain)
			if err != nil || !first.Changed || first.Revision != 1 || firstAck.Count != 1 || firstAck.ID != domainRequestID(winner, domain) || firstAck.Outcome != "applied" {
				t.Fatalf("first response = %#v, %v", first, err)
			}
			retry, err := userStore.Sync(ctx, db, userID, winner, now.Add(time.Second))
			retryAck := domainAck(retry, domain)
			if err != nil || retry.Changed || retry.Revision != 1 || retryAck != firstAck {
				t.Fatalf("lost-response retry first=%#v retry=%#v err=%v", firstAck, retryAck, err)
			}

			ignored, err := userStore.Sync(ctx, db, userID, loser, now.Add(2*time.Second))
			ignoredAck := domainAck(ignored, domain)
			if err != nil || !ignored.Changed || ignored.Revision != 2 || ignoredAck.Count != 1 || ignoredAck.ID != domainRequestID(loser, domain) || ignoredAck.Outcome != "ignored" || ignoredAck.Reason == "" {
				t.Fatalf("newly stored loser = %#v, %v", ignored, err)
			}
			ignoredRetry, err := userStore.Sync(ctx, db, userID, loser, now.Add(3*time.Second))
			ignoredRetryAck := domainAck(ignoredRetry, domain)
			if err != nil || ignoredRetry.Changed || ignoredRetry.Revision != 2 || ignoredRetryAck != ignoredAck {
				t.Fatalf("ignored lost-response retry first=%#v retry=%#v err=%v", ignoredAck, ignoredRetryAck, err)
			}
			if count := operationCount(t, db, domain); count != 2 {
				t.Fatalf("stored %s operation count = %d, want 2", domain, count)
			}
		})
	}
}

func TestSyncAcknowledgesEveryTerminalOutcomeInEveryDomain(t *testing.T) {
	for _, domain := range []string{"timer", "task", "duration", "auto-start"} {
		domain := domain
		t.Run(domain, func(t *testing.T) {
			ctx := context.Background()
			userStore, db, userID, now := openTestUser(t, "ack-outcomes-"+domain)
			defer db.Close()
			winner, loser := domainRequests(domain, now)
			applied, err := userStore.Sync(ctx, db, userID, winner, now)
			appliedAck := domainAck(applied, domain)
			if err != nil || appliedAck.Count != 1 || appliedAck.ID != domainRequestID(winner, domain) || appliedAck.Outcome != "applied" || appliedAck.Reason != "" {
				t.Fatalf("applied acknowledgement = %#v, %v", appliedAck, err)
			}
			ignored, err := userStore.Sync(ctx, db, userID, loser, now.Add(time.Second))
			ignoredAck := domainAck(ignored, domain)
			if err != nil || ignoredAck.Count != 1 || ignoredAck.ID != domainRequestID(loser, domain) || ignoredAck.Outcome != "ignored" || ignoredAck.Reason == "" {
				t.Fatalf("ignored acknowledgement = %#v, %v", ignoredAck, err)
			}
			conflicting := winner
			mutateDomainPayload(&conflicting, domain)
			rejected, err := userStore.Sync(ctx, db, userID, conflicting, now.Add(2*time.Second))
			rejectedAck := domainAck(rejected, domain)
			if err != nil || rejected.Changed || rejected.Revision != 2 || rejectedAck.Count != 1 || rejectedAck.ID != domainRequestID(conflicting, domain) || rejectedAck.Outcome != "rejected" || rejectedAck.Reason != domainConflictReason(domain) {
				t.Fatalf("rejected acknowledgement = %#v, %v", rejectedAck, err)
			}
		})
	}
}

func TestSyncAutoCompletionAdvancesCanonicalRevision(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "equal-revision-auto-completion")
	defer db.Close()
	start := testTimerCommand("command-auto-complete", "device-auto-complete", "timer-auto-complete", "start", 1, now)
	start.PlannedDurationMs = 60_000
	started, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: start.DeviceID, LastRevision: 0, Commands: []timer.Command{start}}, now)
	if err != nil || started.Revision != 1 || started.CanonicalTimer == nil || started.CanonicalTimer.Status != "running" {
		t.Fatalf("started response = %#v, %v", started, err)
	}

	completed, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: start.DeviceID, LastRevision: 1}, now.Add(time.Minute))
	if err != nil || !completed.Changed || completed.Revision != 2 || completed.CanonicalTimer == nil || completed.CanonicalTimer.Status != "completed" {
		t.Fatalf("revisioned completion = %#v, %v", completed, err)
	}
	if len(completed.History) != 1 || completed.History[0].TimerID != start.TimerID || completed.History[0].CompletedAt != now.Add(time.Minute).Format(time.RFC3339Nano) {
		t.Fatalf("auto-completed history = %#v", completed.History)
	}
	var status string
	if err := db.QueryRowContext(ctx, `SELECT status FROM timer_sessions WHERE timer_id = ?`, start.TimerID).Scan(&status); err != nil || status != "completed" {
		t.Fatalf("persisted status = %q, %v; want completed", status, err)
	}
	var revision int64
	if err := db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil || revision != 2 {
		t.Fatalf("persisted revision = %d, %v; want 2", revision, err)
	}
	idempotent, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: start.DeviceID, LastRevision: 2}, now.Add(2*time.Minute))
	if err != nil || idempotent.Changed || idempotent.Revision != 2 || idempotent.CanonicalTimer == nil || idempotent.CanonicalTimer.Status != "completed" {
		t.Fatalf("idempotent materialization = %#v, %v", idempotent, err)
	}
}

func TestSyncOperationAndProjectionChangeAdvanceRevisionOnce(t *testing.T) {
	ctx := context.Background()
	userStore, db, userID, now := openTestUser(t, "operation-projection-revision")
	defer db.Close()
	start := testTimerCommand("command-operation-projection", "device-operation-projection", "timer-operation-projection", "start", 1, now)
	start.PlannedDurationMs = 60_000
	started, err := userStore.Sync(ctx, db, userID, SyncRequest{DeviceID: start.DeviceID, Commands: []timer.Command{start}}, now)
	if err != nil || started.Revision != 1 || !started.Changed {
		t.Fatalf("started response = %#v, %v", started, err)
	}

	operation := task.Operation{
		ID: "task-operation-projection", DeviceID: start.DeviceID, TaskID: "task-operation-projection",
		Type: "upsert", Title: "Projection", OccurredAt: now.Add(time.Minute), HLCWallMs: now.Add(time.Minute).UnixMilli(),
	}
	result, err := userStore.Sync(ctx, db, userID, SyncRequest{
		DeviceID: start.DeviceID, LastRevision: 1, TaskOperations: []task.Operation{operation},
	}, now.Add(time.Minute))
	if err != nil || !result.Changed || result.Revision != 2 || result.CanonicalTimer == nil || result.CanonicalTimer.Status != "completed" || len(result.Tasks) != 1 {
		t.Fatalf("combined operation and projection response = %#v, %v", result, err)
	}
	var revision int64
	if err := db.QueryRowContext(ctx, `SELECT revision FROM account_state WHERE singleton = 1`).Scan(&revision); err != nil || revision != 2 {
		t.Fatalf("persisted revision = %d, %v; want 2", revision, err)
	}
}

type anyAcknowledgement struct {
	Count   int
	ID      string
	Outcome string
	Reason  string
}

func domainRequests(domain string, now time.Time) (SyncRequest, SyncRequest) {
	winner := SyncRequest{DeviceID: "device-domain"}
	loser := SyncRequest{DeviceID: "device-domain"}
	switch domain {
	case "timer":
		winner.Commands = []timer.Command{testTimerCommand("command-domain-winner", winner.DeviceID, "timer-domain", "start", 1, now)}
		loser.Commands = []timer.Command{testTimerCommand("command-domain-loser", loser.DeviceID, "timer-domain", "start", 2, now.Add(time.Second))}
	case "task":
		winner.TaskOperations = []task.Operation{{ID: "task-domain-winner", TaskID: "task-domain", Type: "upsert", Title: "Winner", OccurredAt: now, HLCWallMs: 200}}
		loser.TaskOperations = []task.Operation{{ID: "task-domain-loser", TaskID: "task-domain", Type: "delete", OccurredAt: now.Add(-time.Second), HLCWallMs: 100}}
	case "duration":
		winner.DurationOperations = []DurationOperation{{ID: "duration-domain-winner", Phase: "focus", DurationMs: 1_800_000, OccurredAt: now, HLCWallMs: 200}}
		loser.DurationOperations = []DurationOperation{{ID: "duration-domain-loser", Phase: "focus", DurationMs: 1_200_000, OccurredAt: now.Add(-time.Second), HLCWallMs: 100}}
	case "auto-start":
		winner.AutoStartOperations = []AutoStartOperation{{ID: "auto-start-domain-winner", Enabled: true, OccurredAt: now, HLCWallMs: 200}}
		loser.AutoStartOperations = []AutoStartOperation{{ID: "auto-start-domain-loser", Enabled: false, OccurredAt: now.Add(-time.Second), HLCWallMs: 100}}
	default:
		panic("unknown domain: " + domain)
	}
	return winner, loser
}

func domainAck(result SyncResult, domain string) anyAcknowledgement {
	switch domain {
	case "timer":
		if len(result.Acknowledgements) != 1 {
			return anyAcknowledgement{Count: len(result.Acknowledgements)}
		}
		return anyAcknowledgement{Count: 1, ID: result.Acknowledgements[0].CommandID, Outcome: result.Acknowledgements[0].Outcome, Reason: result.Acknowledgements[0].Reason}
	case "task":
		if len(result.TaskAcknowledgements) != 1 {
			return anyAcknowledgement{Count: len(result.TaskAcknowledgements)}
		}
		return anyAcknowledgement{Count: 1, ID: result.TaskAcknowledgements[0].OperationID, Outcome: result.TaskAcknowledgements[0].Outcome, Reason: result.TaskAcknowledgements[0].Reason}
	case "duration":
		if len(result.DurationAcknowledgements) != 1 {
			return anyAcknowledgement{Count: len(result.DurationAcknowledgements)}
		}
		return anyAcknowledgement{Count: 1, ID: result.DurationAcknowledgements[0].OperationID, Outcome: result.DurationAcknowledgements[0].Outcome, Reason: result.DurationAcknowledgements[0].Reason}
	case "auto-start":
		if len(result.AutoStartAcknowledgements) != 1 {
			return anyAcknowledgement{Count: len(result.AutoStartAcknowledgements)}
		}
		return anyAcknowledgement{Count: 1, ID: result.AutoStartAcknowledgements[0].OperationID, Outcome: result.AutoStartAcknowledgements[0].Outcome, Reason: result.AutoStartAcknowledgements[0].Reason}
	default:
		panic("unknown domain: " + domain)
	}
}

func domainRequestID(request SyncRequest, domain string) string {
	switch domain {
	case "timer":
		return request.Commands[0].ID
	case "task":
		return request.TaskOperations[0].ID
	case "duration":
		return request.DurationOperations[0].ID
	case "auto-start":
		return request.AutoStartOperations[0].ID
	default:
		panic("unknown domain: " + domain)
	}
}

func mutateDomainPayload(request *SyncRequest, domain string) {
	switch domain {
	case "timer":
		request.Commands[0].Phase = "short_break"
	case "task":
		request.TaskOperations[0].Title = "Changed"
	case "duration":
		request.DurationOperations[0].DurationMs = 1_500_000
	case "auto-start":
		request.AutoStartOperations[0].Enabled = false
	default:
		panic("unknown domain: " + domain)
	}
}

func domainConflictReason(domain string) string {
	if domain == "timer" {
		return "command ID already used with different payload"
	}
	return "operation ID already used with different payload"
}

func operationCount(t *testing.T, db *sql.DB, domain string) int {
	t.Helper()
	tables := map[string]string{
		"timer":      "timer_commands",
		"task":       "task_operations",
		"duration":   "duration_operations",
		"auto-start": "auto_start_operations",
	}
	table, ok := tables[domain]
	if !ok {
		t.Fatalf("unknown domain %q", domain)
	}
	var count int
	if err := db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func indexPermutations(size int) [][]int {
	values := make([]int, size)
	for index := range values {
		values[index] = index
	}
	var result [][]int
	var permute func(int)
	permute = func(index int) {
		if index == len(values) {
			result = append(result, append([]int(nil), values...))
			return
		}
		for candidate := index; candidate < len(values); candidate++ {
			values[index], values[candidate] = values[candidate], values[index]
			permute(index + 1)
			values[index], values[candidate] = values[candidate], values[index]
		}
	}
	permute(0)
	return result
}
