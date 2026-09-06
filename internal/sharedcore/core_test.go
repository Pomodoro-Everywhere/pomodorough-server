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
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/tetratelabs/wazero"
)

func TestABICleanupCoversMalformedResultsAndPreservesFailures(t *testing.T) {
	tests := []struct {
		name      string
		result    uint64
		readOK    bool
		freeFails bool
		wantError []string
		wantFreed []ownedBuffer
	}{
		{
			name:      "oversized result",
			result:    uint64(maxOutputBytes+1)<<32 | 300,
			readOK:    true,
			wantError: []string{"output is too large"},
			wantFreed: []ownedBuffer{{300, maxOutputBytes + 1}, {200, 2}, {100, 1}},
		},
		{
			name:      "out of range result and cleanup failure",
			result:    uint64(5)<<32 | 300,
			readOK:    false,
			freeFails: true,
			wantError: []string{"outside linear memory", "free shared-core buffer"},
			wantFreed: []ownedBuffer{{300, 5}, {200, 2}, {100, 1}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			allocated := []uint64{100, 200}
			var freed []ownedBuffer
			abi := abiCalls{
				allocate: func(context.Context, uint64) ([]uint64, error) {
					pointer := allocated[0]
					allocated = allocated[1:]
					return []uint64{pointer}, nil
				},
				free: func(_ context.Context, pointer, length uint64) ([]uint64, error) {
					freed = append(freed, ownedBuffer{uint32(pointer), uint32(length)})
					if test.freeFails {
						return nil, errors.New("free trap")
					}
					return []uint64{1}, nil
				},
				dispatch: func(context.Context, uint64, uint64, uint64, uint64) ([]uint64, error) {
					return []uint64{test.result}, nil
				},
				read:  func(uint32, uint32) ([]byte, bool) { return []byte(`{}`), test.readOK },
				write: func(uint32, []byte) bool { return true },
			}
			_, err := callABI(context.Background(), abi, "v", []byte(`{}`))
			if err == nil {
				t.Fatal("malformed ABI result was accepted")
			}
			for _, fragment := range test.wantError {
				if !strings.Contains(err.Error(), fragment) {
					t.Fatalf("error %q does not contain %q", err, fragment)
				}
			}
			if !slices.Equal(freed, test.wantFreed) {
				t.Fatalf("freed = %#v, want %#v", freed, test.wantFreed)
			}
		})
	}
}

func TestDispatchTrapReleasesInputsAndPreservesCleanupFailures(t *testing.T) {
	allocated := []uint64{100, 200}
	var freed []ownedBuffer
	abi := abiCalls{
		allocate: func(context.Context, uint64) ([]uint64, error) {
			pointer := allocated[0]
			allocated = allocated[1:]
			return []uint64{pointer}, nil
		},
		free: func(_ context.Context, pointer, length uint64) ([]uint64, error) {
			freed = append(freed, ownedBuffer{uint32(pointer), uint32(length)})
			return nil, errors.New("free trap")
		},
		dispatch: func(context.Context, uint64, uint64, uint64, uint64) ([]uint64, error) {
			return nil, errors.New("dispatch trap")
		},
		write: func(uint32, []byte) bool { return true },
	}
	_, err := callABI(context.Background(), abi, "v", []byte(`{}`))
	if err == nil || !strings.Contains(err.Error(), "dispatch trap") || !strings.Contains(err.Error(), "free shared-core buffer") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !slices.Equal(freed, []ownedBuffer{{200, 2}, {100, 1}}) {
		t.Fatalf("freed = %#v", freed)
	}
}

func TestAllocationWriteFailureReleasesAllocationAndPreservesCleanupFailure(t *testing.T) {
	var freed []ownedBuffer
	abi := abiCalls{
		allocate: func(context.Context, uint64) ([]uint64, error) { return []uint64{77}, nil },
		free: func(_ context.Context, pointer, length uint64) ([]uint64, error) {
			freed = append(freed, ownedBuffer{uint32(pointer), uint32(length)})
			return nil, errors.New("free trap")
		},
		write: func(uint32, []byte) bool { return false },
	}
	_, err := allocateAndWrite(context.Background(), abi, []byte("abc"))
	if err == nil || !strings.Contains(err.Error(), "outside linear memory") || !strings.Contains(err.Error(), "free failed allocation") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !slices.Equal(freed, []ownedBuffer{{77, 3}}) {
		t.Fatalf("freed = %#v", freed)
	}
}

func TestABIFreeRejectsInvalidStatusAndPreservesPrimaryFailure(t *testing.T) {
	for _, test := range []struct {
		name       string
		freeResult []uint64
	}{
		{name: "rejected ownership", freeResult: []uint64{0}},
		{name: "unexpected success value", freeResult: []uint64{2}},
		{name: "missing status", freeResult: nil},
		{name: "extra status", freeResult: []uint64{1, 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			allocated := []uint64{100, 200}
			abi := abiCalls{
				allocate: func(context.Context, uint64) ([]uint64, error) {
					pointer := allocated[0]
					allocated = allocated[1:]
					return []uint64{pointer}, nil
				},
				free: func(context.Context, uint64, uint64) ([]uint64, error) {
					return test.freeResult, nil
				},
				dispatch: func(context.Context, uint64, uint64, uint64, uint64) ([]uint64, error) {
					return nil, errors.New("dispatch trap")
				},
				write: func(uint32, []byte) bool { return true },
			}

			_, err := callABI(context.Background(), abi, "v", []byte(`{}`))
			if err == nil || !strings.Contains(err.Error(), "dispatch trap") || !strings.Contains(err.Error(), "free shared-core buffer") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

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
		"cd shared-core",
		"cargo +1.97.1 build --release --target wasm32-unknown-unknown --locked",
		"shared-core/scripts/canonicalize_wasm_artifact.py",
		"shared-core/scripts/verify_wasm_artifact.py",
		"scripts/verify_shared_core_provenance.py",
		`"$rebuilt"`,
		"cmp internal/sharedcore/pomodorough_core.wasm web/pomodorough_core.wasm",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("server CI does not verify embedded shared core: missing %q", required)
		}
	}
}

func TestServerReleaseRebuildsPinnedCoreArtifact(t *testing.T) {
	workflow, err := os.ReadFile("../../.github/workflows/release.yml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(workflow)
	for _, required := range []string{
		"repository: Pomodoro-Everywhere/pomodorough-core",
		"Rebuild and verify embedded shared core",
		"shared-core/scripts/canonicalize_wasm_artifact.py",
		"scripts/verify_shared_core_provenance.py",
		"internal/sharedcore/pomodorough_core.wasm",
		"web/pomodorough_core.wasm",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("server release does not verify embedded shared core: missing %q", required)
		}
	}
}

func TestEmbeddedCoreArtifactHasPinnedProvenance(t *testing.T) {
	commit, err := os.ReadFile("CORE_COMMIT")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(commit)); got != "20f9696b9a7c5dd9f0a253b21a5c9bd225f9e9b2" {
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
	if !envelope.OK || envelope.Value.SchemaVersion != 1 || envelope.Value.CoreVersion != "0.14.0" {
		t.Fatalf("unexpected core version envelope: %s", result)
	}
}

func TestEmbeddedCoreRejectsInvalidAndDuplicateFrees(t *testing.T) {
	ctx := context.Background()
	runtime := wazero.NewRuntime(ctx)
	defer runtime.Close(ctx)
	module, err := runtime.Instantiate(ctx, wasm)
	if err != nil {
		t.Fatal(err)
	}
	defer module.Close(ctx)

	alloc := module.ExportedFunction("pomodorough_alloc")
	free := module.ExportedFunction("pomodorough_free_v2")
	if alloc == nil || free == nil {
		t.Fatal("embedded core is missing allocation ownership exports")
	}
	allocated, err := alloc.Call(ctx, 8)
	if err != nil || len(allocated) != 1 || allocated[0] == 0 {
		t.Fatalf("allocate embedded buffer: values=%v err=%v", allocated, err)
	}
	pointer := allocated[0]
	for _, test := range []struct {
		name      string
		arguments []uint64
		want      uint64
	}{
		{"wrong length", []uint64{pointer, 7}, 0},
		{"valid", []uint64{pointer, 8}, 1},
		{"duplicate", []uint64{pointer, 8}, 0},
		{"null", []uint64{0, 8}, 0},
	} {
		values, callErr := free.Call(ctx, test.arguments...)
		if callErr != nil || len(values) != 1 || values[0] != test.want {
			t.Errorf("%s free: values=%v err=%v want status=%d", test.name, values, callErr, test.want)
		}
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
