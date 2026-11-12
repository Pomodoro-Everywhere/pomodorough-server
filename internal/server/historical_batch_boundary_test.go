package server

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestHistoricalIDLessBatchesFailClosedAtAggregateAndIdentityBoundaries(t *testing.T) {
	for _, maximum := range []int{256, 4096} {
		batch := operationBatch{
			deviceID: "device", maximum: maximum,
			commands:           make([]syncCommandJSON, maximum),
			taskOperations:     make([]syncTaskOperationJSON, maximum),
			durationOperations: []syncDurationOperationJSON{{}},
		}
		_, err := parseOperationBatch(context.Background(), batch, time.Now())
		if err == nil || err.Error() != "too many operations" {
			t.Fatalf("maximum=%d over-aggregate err=%v", maximum, err)
		}
		batch.durationOperations = nil
		if !batch.validCount() {
			t.Fatalf("maximum=%d exact aggregate rejected", maximum)
		}
		_, err = parseOperationBatch(context.Background(), batch, time.Now())
		if err == nil || !strings.Contains(err.Error(), "invalid command identity") {
			t.Fatalf("maximum=%d ID-less exact aggregate err=%v", maximum, err)
		}
	}
}
