package sharedcore

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"slices"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

//go:embed pomodorough_core.wasm
var wasm []byte

const (
	maxOperationBytes      = 256
	maxInputBytes          = 64 << 20
	maxOutputBytes         = 64 << 20
	maxMemoryPages         = 4096 // 256 MiB per isolated invocation.
	maxConcurrentInstances = 4
)

var ErrInputTooLarge = errors.New("shared core input is too large")

var (
	defaultOnce sync.Once
	defaultCore *Core
	defaultErr  error
)

// Default returns the process-wide compiled shared core. Calls still use
// isolated module instances, so account memory is never shared.
func Default(ctx context.Context) (*Core, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	defaultOnce.Do(func() {
		defaultCore, defaultErr = New(context.Background())
	})
	return defaultCore, defaultErr
}

type Core struct {
	mu       sync.RWMutex
	runtime  wazero.Runtime
	compiled wazero.CompiledModule
	slots    chan struct{}
}

func New(ctx context.Context) (*Core, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// wazero 1.12's amd64 compiler backend corrupted bytes in larger Rust/chrono
	// JSON responses in differential tests. The interpreter produced byte-exact
	// output and remains sandboxed; retain the regression coverage before
	// reconsidering the compiler backend on a later wazero release.
	config := wazero.NewRuntimeConfigInterpreter().
		WithMemoryLimitPages(maxMemoryPages).
		WithCloseOnContextDone(true)
	runtime := wazero.NewRuntimeWithConfig(ctx, config)
	compiled, err := runtime.CompileModule(ctx, wasm)
	if err != nil {
		runtime.Close(ctx)
		return nil, fmt.Errorf("compile shared core: %w", err)
	}
	if err := validateCompiledModule(compiled); err != nil {
		runtime.Close(ctx)
		return nil, err
	}
	return &Core{
		runtime:  runtime,
		compiled: compiled,
		slots:    make(chan struct{}, maxConcurrentInstances),
	}, nil
}

func validateCompiledModule(compiled wazero.CompiledModule) error {
	expected := map[string]struct {
		parameters []api.ValueType
		results    []api.ValueType
	}{
		"pomodorough_alloc": {
			parameters: []api.ValueType{api.ValueTypeI32},
			results:    []api.ValueType{api.ValueTypeI32},
		},
		"pomodorough_free": {
			parameters: []api.ValueType{api.ValueTypeI32, api.ValueTypeI32},
		},
		"pomodorough_dispatch": {
			parameters: []api.ValueType{api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32},
			results:    []api.ValueType{api.ValueTypeI64},
		},
	}
	functions := compiled.ExportedFunctions()
	for name, signature := range expected {
		definition, ok := functions[name]
		if !ok || !slices.Equal(definition.ParamTypes(), signature.parameters) || !slices.Equal(definition.ResultTypes(), signature.results) {
			return fmt.Errorf("shared core export %s has an invalid signature", name)
		}
	}
	memory, ok := compiled.ExportedMemories()["memory"]
	if !ok {
		return errors.New("shared core memory export is missing")
	}
	maximum, bounded := memory.Max()
	if !bounded || maximum > maxMemoryPages {
		return errors.New("shared core memory export is not safely bounded")
	}
	return nil
}

func (c *Core) Close(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.runtime == nil {
		return nil
	}
	err := c.runtime.Close(ctx)
	c.runtime = nil
	c.compiled = nil
	return err
}

type Call struct {
	Operation string
	Input     []byte
}

func (c *Core) Call(ctx context.Context, operation string, input []byte) ([]byte, error) {
	results, err := c.CallBatch(ctx, []Call{{Operation: operation, Input: input}})
	if err != nil {
		return nil, err
	}
	return results[0], nil
}

func (c *Core) CallBatch(ctx context.Context, calls []Call) ([][]byte, error) {
	if len(calls) == 0 {
		return nil, errors.New("shared core call batch must not be empty")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for _, call := range calls {
		if len(call.Operation) == 0 || len(call.Input) == 0 {
			return nil, errors.New("shared core operation and input must not be empty")
		}
		if len(call.Operation) > maxOperationBytes || len(call.Input) > maxInputBytes {
			return nil, ErrInputTooLarge
		}
	}
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.runtime == nil || c.compiled == nil {
		return nil, errors.New("shared core is closed")
	}
	module, err := c.runtime.InstantiateModule(ctx, c.compiled, wazero.NewModuleConfig().WithName(""))
	if err != nil {
		return nil, fmt.Errorf("instantiate shared core: %w", err)
	}
	defer module.Close(context.Background())
	results := make([][]byte, 0, len(calls))
	for _, call := range calls {
		result, err := callModule(ctx, module, call.Operation, call.Input)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}

func callModule(ctx context.Context, module api.Module, operation string, input []byte) ([]byte, error) {
	alloc := module.ExportedFunction("pomodorough_alloc")
	free := module.ExportedFunction("pomodorough_free")
	dispatch := module.ExportedFunction("pomodorough_dispatch")
	if alloc == nil || free == nil || dispatch == nil {
		return nil, errors.New("shared core ABI exports are incomplete")
	}

	operationPointer, err := allocateAndWrite(ctx, module, alloc, []byte(operation))
	if err != nil {
		return nil, err
	}
	defer free.Call(context.Background(), uint64(operationPointer), uint64(len(operation)))
	inputPointer, err := allocateAndWrite(ctx, module, alloc, input)
	if err != nil {
		return nil, err
	}
	defer free.Call(context.Background(), uint64(inputPointer), uint64(len(input)))

	values, err := dispatch.Call(
		ctx,
		uint64(operationPointer), uint64(len(operation)),
		uint64(inputPointer), uint64(len(input)),
	)
	if err != nil {
		return nil, fmt.Errorf("dispatch shared core operation %q: %w", operation, err)
	}
	if len(values) != 1 {
		return nil, fmt.Errorf("shared core returned %d values, want 1", len(values))
	}
	resultPointer := uint32(values[0])
	resultLength := uint32(values[0] >> 32)
	if resultLength > maxOutputBytes {
		return nil, errors.New("shared core output is too large")
	}
	result, ok := module.Memory().Read(resultPointer, resultLength)
	if !ok {
		return nil, errors.New("shared core result is outside linear memory")
	}
	copyOfResult := append([]byte(nil), result...)
	if _, err := free.Call(context.Background(), uint64(resultPointer), uint64(resultLength)); err != nil {
		return nil, fmt.Errorf("free shared core result: %w", err)
	}
	return copyOfResult, nil
}

func allocateAndWrite(
	ctx context.Context,
	module api.Module,
	alloc api.Function,
	value []byte,
) (uint32, error) {
	values, err := alloc.Call(ctx, uint64(len(value)))
	if err != nil {
		return 0, fmt.Errorf("allocate shared core buffer: %w", err)
	}
	if len(values) != 1 {
		return 0, fmt.Errorf("shared core allocator returned %d values, want 1", len(values))
	}
	pointer := uint32(values[0])
	if len(value) > 0 && !module.Memory().Write(pointer, value) {
		return 0, errors.New("shared core input is outside linear memory")
	}
	return pointer, nil
}
