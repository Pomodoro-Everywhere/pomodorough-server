package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"pomodorough/internal/task"
	"pomodorough/internal/timer"
)

const (
	sharedUUIDv7FixtureHash = "719bf4601f0e82aa9898e891184edcf8f37b183a05f3ddd6fa211e1ac8dc2f10"
	legacyUUIDv4            = "550e8400-e29b-41d4-a716-446655440000"
	maxTimestampUUIDv7      = "ffffffff-ffff-7fff-bfff-ffffffffffff"
)

type uuidv7Fixture struct {
	SchemaVersion int `json:"schemaVersion"`
	RFC9562       struct {
		UUID string `json:"uuid"`
	} `json:"rfc9562"`
}

func TestSharedUUIDv7FixtureMixedIDsAndImmutableCollisionContract(t *testing.T) {
	fixture := loadUUIDv7Fixture(t)
	for _, domain := range []string{"timer", "task", "duration", "auto-start"} {
		domain := domain
		t.Run(domain, func(t *testing.T) {
			ctx := context.Background()
			userStore, db, userID, now := openTestUser(t, "uuidv7-collision-"+domain)
			defer db.Close()
			winner, loser := domainRequests(domain, now)
			setDomainRequestID(&winner, domain, domainUUIDv7ID(domain, fixture.RFC9562.UUID))
			setDomainRequestID(&loser, domain, domainLegacyID(domain))

			first, err := userStore.Sync(ctx, db, userID, winner, now)
			firstAck := domainAck(first, domain)
			if err != nil || !first.Changed || first.Revision != 1 ||
				firstAck.ID != domainRequestID(winner, domain) || firstAck.Outcome != "applied" {
				t.Fatalf("UUIDv7 mutation = %#v, ack=%#v, err=%v", first, firstAck, err)
			}

			retry, err := userStore.Sync(ctx, db, userID, winner, now.Add(time.Second))
			if retryAck := domainAck(retry, domain); err != nil || retry.Changed ||
				retry.Revision != first.Revision || retryAck != firstAck {
				t.Fatalf("exact UUIDv7 retry = %#v, ack=%#v, err=%v", retry, retryAck, err)
			}

			changedPayload := winner
			mutateDomainPayload(&changedPayload, domain)
			rejected, err := userStore.Sync(ctx, db, userID, changedPayload, now.Add(2*time.Second))
			rejectedAck := domainAck(rejected, domain)
			if err != nil || rejected.Changed || rejected.Revision != first.Revision ||
				rejectedAck.Outcome != "rejected" || rejectedAck.Reason != domainConflictReason(domain) {
				t.Fatalf("changed UUIDv7 payload = %#v, ack=%#v, err=%v", rejected, rejectedAck, err)
			}

			changedDevice := winner
			changedDevice.DeviceID = "device-collision"
			rejected, err = userStore.Sync(ctx, db, userID, changedDevice, now.Add(3*time.Second))
			rejectedAck = domainAck(rejected, domain)
			if err != nil || rejected.Changed || rejected.Revision != first.Revision ||
				rejectedAck.Outcome != "rejected" || rejectedAck.Reason != domainConflictReason(domain) {
				t.Fatalf("changed UUIDv7 device = %#v, ack=%#v, err=%v", rejected, rejectedAck, err)
			}

			mixed, err := userStore.Sync(ctx, db, userID, loser, now.Add(4*time.Second))
			mixedAck := domainAck(mixed, domain)
			if err != nil || !mixed.Changed || mixed.Revision != 2 ||
				mixedAck.ID != domainRequestID(loser, domain) || mixedAck.Outcome != "ignored" {
				t.Fatalf("mixed UUIDv4 mutation = %#v, ack=%#v, err=%v", mixed, mixedAck, err)
			}
			if count := operationCount(t, db, domain); count != 2 {
				t.Fatalf("stored mixed-ID %s count = %d, want 2", domain, count)
			}
		})
	}
}

func TestUUIDv7TimestampCannotOverrideHybridClockOrRevision(t *testing.T) {
	fixture := loadUUIDv7Fixture(t)
	base := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	for _, domain := range []string{"task", "duration", "auto-start"} {
		domain := domain
		t.Run(domain, func(t *testing.T) {
			ctx := context.Background()
			userStore, db, userID, _ := openTestUser(t, "uuidv7-order-"+domain)
			defer db.Close()
			request := SyncRequest{DeviceID: "device-uuid-order"}
			lowerID := domainUUIDv7ID(domain, maxTimestampUUIDv7)
			higherID := domainUUIDv7ID(domain, fixture.RFC9562.UUID)
			switch domain {
			case "task":
				request.TaskOperations = []task.Operation{
					{ID: lowerID, TaskID: "task-uuid-order", Type: "delete", OccurredAt: base, HLCWallMs: base.UnixMilli() - 1},
					{ID: higherID, TaskID: "task-uuid-order", Type: "upsert", Title: "HLC winner", OccurredAt: base, HLCWallMs: base.UnixMilli()},
				}
			case "duration":
				request.DurationOperations = []DurationOperation{
					{ID: lowerID, Phase: "focus", DurationMs: 1_200_000, OccurredAt: base, HLCWallMs: base.UnixMilli() - 1},
					{ID: higherID, Phase: "focus", DurationMs: 1_800_000, OccurredAt: base, HLCWallMs: base.UnixMilli()},
				}
			case "auto-start":
				request.AutoStartOperations = []AutoStartOperation{
					{ID: lowerID, Enabled: false, OccurredAt: base, HLCWallMs: base.UnixMilli() - 1},
					{ID: higherID, Enabled: true, OccurredAt: base, HLCWallMs: base.UnixMilli()},
				}
			}

			result, err := userStore.Sync(ctx, db, userID, request, base)
			if err != nil || !result.Changed || result.Revision != 1 ||
				result.ServerHLCWallMs != base.UnixMilli() || result.ServerHLCCounter != 0 {
				t.Fatalf("UUID-opaque %s reduction = %#v, %v", domain, result, err)
			}
			switch domain {
			case "task":
				if len(result.Tasks) != 1 || result.Tasks[0].Title != "HLC winner" {
					t.Fatalf("UUID timestamp overrode task HLC: %#v", result.Tasks)
				}
			case "duration":
				if result.DurationsMs.Focus != 1_800_000 {
					t.Fatalf("UUID timestamp overrode duration HLC: %#v", result.DurationsMs)
				}
			case "auto-start":
				if !result.AutoStartBreaks {
					t.Fatal("UUID timestamp overrode auto-start HLC")
				}
			}
		})
	}

	t.Run("timer display and final ID tie-break", func(t *testing.T) {
		ctx := context.Background()
		userStore, db, userID, _ := openTestUser(t, "uuidv7-timer-order")
		defer db.Close()
		lowID := fixture.RFC9562.UUID
		highID := maxTimestampUUIDv7
		low := testTimerCommand(lowID, "device-uuid-timer", "timer-uuid-low", "start", 1, base)
		high := testTimerCommand(highID, "device-uuid-timer", "timer-uuid-high", "start", 2, base)
		low.HLCWallMs, high.HLCWallMs = base.UnixMilli(), base.UnixMilli()

		result, err := userStore.Sync(ctx, db, userID, SyncRequest{
			DeviceID: low.DeviceID,
			Commands: []timer.Command{high, low},
		}, base)
		if err != nil || !result.Changed || result.Revision != 1 ||
			result.ServerHLCWallMs != base.UnixMilli() || result.CanonicalTimer == nil {
			t.Fatalf("UUID-opaque timer reduction = %#v, %v", result, err)
		}
		if result.CanonicalTimer.ID != high.TimerID ||
			result.CanonicalTimer.AnchorAt != base.Format(time.RFC3339Nano) ||
			result.CanonicalTimer.LastIntent == nil ||
			result.CanonicalTimer.LastIntent.OccurredAt != base.Format(time.RFC3339Nano) {
			t.Fatalf("timer UUID affected display time or final tie-break: %#v", result.CanonicalTimer)
		}
	})
}

func loadUUIDv7Fixture(t *testing.T) uuidv7Fixture {
	t.Helper()
	bytes, err := os.ReadFile("../timer/testdata/uuidv7-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(bytes)
	if got := hex.EncodeToString(digest[:]); got != sharedUUIDv7FixtureHash {
		t.Fatalf("UUIDv7 fixture hash = %s, want %s", got, sharedUUIDv7FixtureHash)
	}
	var fixture uuidv7Fixture
	if err := json.Unmarshal(bytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.RFC9562.UUID == "" {
		t.Fatalf("invalid UUIDv7 fixture: %#v", fixture)
	}
	return fixture
}

func setDomainRequestID(request *SyncRequest, domain, id string) {
	switch domain {
	case "timer":
		request.Commands[0].ID = id
	case "task":
		request.TaskOperations[0].ID = id
	case "duration":
		request.DurationOperations[0].ID = id
	case "auto-start":
		request.AutoStartOperations[0].ID = id
	default:
		panic("unknown domain: " + domain)
	}
}

func domainUUIDv7ID(domain, id string) string {
	switch domain {
	case "task":
		return "task-operation-" + id
	case "duration":
		return "duration-operation-" + id
	default:
		return id
	}
}

func domainLegacyID(domain string) string {
	return domainUUIDv7ID(domain, legacyUUIDv4)
}
