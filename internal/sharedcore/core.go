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
	maxInputBytes          = 16 << 20
	maxOutputBytes         = 16 << 20
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

func (c *Core) CallBatch(ctx context.Context, calls []Call) (results [][]byte, err error) {
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
	defer func() {
		if closeErr := module.Close(context.Background()); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close shared-core module: %w", closeErr))
			results = nil
		}
	}()
	results = make([][]byte, 0, len(calls))
	for _, call := range calls {
		result, err := callModule(ctx, module, call.Operation, call.Input)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, nil
}

type abiCalls struct {
	allocate func(context.Context, uint64) ([]uint64, error)
	free     func(context.Context, uint64, uint64) ([]uint64, error)
	dispatch func(context.Context, uint64, uint64, uint64, uint64) ([]uint64, error)
	read     func(uint32, uint32) ([]byte, bool)
	write    func(uint32, []byte) bool
}

type ownedBuffer struct {
	pointer uint32
	length  uint32
}

func callModule(ctx context.Context, module api.Module, operation string, input []byte) ([]byte, error) {
	alloc := module.ExportedFunction("pomodorough_alloc")
	free := module.ExportedFunction("pomodorough_free")
	dispatch := module.ExportedFunction("pomodorough_dispatch")
	memory := module.Memory()
	if alloc == nil || free == nil || dispatch == nil || memory == nil {
		return nil, errors.New("shared core ABI exports are incomplete")
	}
	return callABI(ctx, abiCalls{
		allocate: func(ctx context.Context, length uint64) ([]uint64, error) {
			return alloc.Call(ctx, length)
		},
		free: func(ctx context.Context, pointer, length uint64) ([]uint64, error) {
			return free.Call(ctx, pointer, length)
		},
		dispatch: func(ctx context.Context, operationPointer, operationLength, inputPointer, inputLength uint64) ([]uint64, error) {
			return dispatch.Call(ctx, operationPointer, operationLength, inputPointer, inputLength)
		},
		read:  memory.Read,
		write: memory.Write,
	}, operation, input)
}

func callABI(ctx context.Context, abi abiCalls, operation string, input []byte) (result []byte, err error) {
	owned := make([]ownedBuffer, 0, 3)
	defer func() {
		var cleanupErr error
		for index := len(owned) - 1; index >= 0; index-- {
			buffer := owned[index]
			if buffer.pointer == 0 || buffer.length == 0 {
				continue
			}
			if _, freeErr := abi.free(context.Background(), uint64(buffer.pointer), uint64(buffer.length)); freeErr != nil {
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("free shared-core buffer %d/%d: %w", buffer.pointer, buffer.length, freeErr))
			}
		}
		if cleanupErr != nil {
			err = errors.Join(err, cleanupErr)
			result = nil
		}
	}()

	operationPointer, allocateErr := allocateAndWrite(ctx, abi, []byte(operation))
	if allocateErr != nil {
		return nil, allocateErr
	}
	owned = append(owned, ownedBuffer{operationPointer, uint32(len(operation))})
	inputPointer, allocateErr := allocateAndWrite(ctx, abi, input)
	if allocateErr != nil {
		return nil, allocateErr
	}
	owned = append(owned, ownedBuffer{inputPointer, uint32(len(input))})

	values, dispatchErr := abi.dispatch(
		ctx,
		uint64(operationPointer), uint64(len(operation)),
		uint64(inputPointer), uint64(len(input)),
	)
	if dispatchErr != nil {
		return nil, fmt.Errorf("dispatch shared core operation %q: %w", operation, dispatchErr)
	}
	if len(values) != 1 {
		return nil, fmt.Errorf("shared core returned %d values, want 1", len(values))
	}
	resultPointer := uint32(values[0])
	resultLength := uint32(values[0] >> 32)
	if resultPointer != 0 && resultLength != 0 {
		owned = append(owned, ownedBuffer{resultPointer, resultLength})
	}
	if resultPointer == 0 || resultLength == 0 {
		return nil, errors.New("shared core returned an empty result buffer")
	}
	if resultLength > maxOutputBytes {
		return nil, errors.New("shared core output is too large")
	}
	view, ok := abi.read(resultPointer, resultLength)
	if !ok {
		return nil, errors.New("shared core result is outside linear memory")
	}
	return append([]byte(nil), view...), nil
}

func allocateAndWrite(ctx context.Context, abi abiCalls, value []byte) (pointer uint32, err error) {
	values, err := abi.allocate(ctx, uint64(len(value)))
	if err != nil {
		return 0, fmt.Errorf("allocate shared core buffer: %w", err)
	}
	if len(values) != 1 {
		return 0, fmt.Errorf("shared core allocator returned %d values, want 1", len(values))
	}
	pointer = uint32(values[0])
	if len(value) > 0 && pointer == 0 {
		return 0, errors.New("shared core allocator returned a null pointer")
	}
	if len(value) > 0 && !abi.write(pointer, value) {
		_, cleanupErr := abi.free(context.Background(), uint64(pointer), uint64(len(value)))
		writeErr := errors.New("shared core input is outside linear memory")
		if cleanupErr != nil {
			return 0, errors.Join(writeErr, fmt.Errorf("free failed allocation %d/%d: %w", pointer, len(value), cleanupErr))
		}
		return 0, writeErr
	}
	return pointer, nil
}
