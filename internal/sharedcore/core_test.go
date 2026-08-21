package sharedcore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestDefaultCoreIsProcessSingleton(t *testing.T) {
	first, err := Default(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := Default(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("Default returned different shared-core runtimes")
	}
}

func TestCoreRejectsOversizedAndCancelledCalls(t *testing.T) {
	ctx := context.Background()
	core, err := New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close(ctx)
	if _, err := core.Call(ctx, "", []byte(`{}`)); err == nil {
		t.Fatal("empty operation was accepted")
	}
	if _, err := core.Call(ctx, "core.version", nil); err == nil {
		t.Fatal("empty input was accepted")
	}

	if _, err := core.Call(ctx, strings.Repeat("x", maxOperationBytes+1), []byte(`{}`)); !errors.Is(err, ErrInputTooLarge) {
		t.Fatalf("oversized operation error = %v", err)
	}
	if _, err := core.Call(ctx, "core.version", make([]byte, maxInputBytes+1)); !errors.Is(err, ErrInputTooLarge) {
		t.Fatalf("oversized input error = %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := core.Call(cancelled, "core.version", []byte(`{}`)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled call error = %v", err)
	}
}

func TestCoreCallsAreConcurrentAndInstanceIsolated(t *testing.T) {
	ctx := context.Background()
	core, err := New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close(ctx)

	var wait sync.WaitGroup
	callErrors := make(chan error, 24)
	for index := 0; index < 24; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			input := fmt.Sprintf(`{"selectedTaskId":"task-%d"}`, index)
			result, err := core.Call(ctx, "selectedTask.classify", []byte(input))
			if err != nil {
				callErrors <- err
				return
			}
			if !bytes.Contains(result, []byte(fmt.Sprintf("selected:task-%d", index))) {
				callErrors <- fmt.Errorf("call %d returned %s", index, result)
			}
		}(index)
	}
	wait.Wait()
	close(callErrors)
	for err := range callErrors {
		t.Error(err)
	}
}

func TestServerCIRebuildsPinnedCoreArtifact(t *testing.T) {
	commitBytes, err := os.ReadFile("CORE_COMMIT")
	if err != nil {
		t.Fatal(err)
	}
	commit := strings.TrimSpace(string(commitBytes))
	workflow, err := os.ReadFile("../../.github/workflows/ci.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(workflow)
	for _, required := range []string{
		"repository: Pomodoro-Everywhere/pomodorough-core",
		"ref: " + commit,
		"cargo +1.97.1 build --release --target wasm32-unknown-unknown --locked",
		"cmp internal/sharedcore/pomodorough_core.wasm",
		"cmp web/pomodorough_core.wasm",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("server CI does not verify embedded shared core: missing %q", required)
		}
	}
}

func TestEmbeddedCoreArtifactHasPinnedProvenance(t *testing.T) {
	commit, err := os.ReadFile("CORE_COMMIT")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(commit)); got != "a78a312314dd9466557c3dbdd12184b698c3d156" {
		t.Fatalf("embedded core commit = %q", got)
	}
	checksum, err := os.ReadFile("pomodorough_core.wasm.sha256")
	if err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(string(checksum))
	if len(fields) != 2 || fields[1] != "pomodorough_core.wasm" {
		t.Fatalf("invalid checksum manifest: %q", checksum)
	}
	expected, err := hex.DecodeString(fields[0])
	if err != nil {
		t.Fatal(err)
	}
	actual := sha256.Sum256(wasm)
	if !strings.EqualFold(hex.EncodeToString(actual[:]), hex.EncodeToString(expected)) {
		t.Fatalf("embedded core checksum mismatch: got %x want %x", actual, expected)
	}
}

func TestEmbeddedCoreVersion(t *testing.T) {
	ctx := context.Background()
	core, err := New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close(ctx)

	result, err := core.Call(ctx, "core.version", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		OK    bool `json:"ok"`
		Value struct {
			SchemaVersion int    `json:"schemaVersion"`
			CoreVersion   string `json:"coreVersion"`
		} `json:"value"`
	}
	if err := json.Unmarshal(result, &envelope); err != nil {
		t.Fatal(err)
	}
	if !envelope.OK || envelope.Value.SchemaVersion != 1 || envelope.Value.CoreVersion != "0.1.0" {
		t.Fatalf("unexpected core version envelope: %s", result)
	}
}

func TestEmbeddedCoreDistinguishesSelectedTaskNullFromOmission(t *testing.T) {
	ctx := context.Background()
	core, err := New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer core.Close(ctx)

	for input, want := range map[string]string{
		`{}`:                      "omitted",
		`{"selectedTaskId":null}`: "deselected",
		`{"selectedTaskId":"x"}`:  "selected:x",
	} {
		result, err := core.Call(ctx, "selectedTask.classify", []byte(input))
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			OK    bool   `json:"ok"`
			Value string `json:"value"`
		}
		if err := json.Unmarshal(result, &envelope); err != nil {
			t.Fatal(err)
		}
		if !envelope.OK || envelope.Value != want {
			t.Fatalf("input %s result = %s, want %q", input, result, want)
		}
	}
}
