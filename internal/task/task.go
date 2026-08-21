package task

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
	"unicode"
	"unicode/utf8"

	"pomodorough/internal/sharedcore"

	"golang.org/x/text/unicode/norm"
)

const idNamespace = "pomodorough.task.v1\x00"

type Task struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type SharedIdentityValidationError struct {
	Detail string
}

func (e *SharedIdentityValidationError) Error() string { return e.Detail }

type SharedIdentityRuntimeError struct {
	Cause error
}

func (e *SharedIdentityRuntimeError) Error() string {
	return fmt.Sprintf("shared task identity runtime failure: %v", e.Cause)
}

func (e *SharedIdentityRuntimeError) Unwrap() error { return e.Cause }

func IsSharedIdentityRuntimeError(err error) bool {
	var target *SharedIdentityRuntimeError
	return errors.As(err, &target)
}

// SharedIdentity validates and derives task identity through the authoritative
// Rust core. NormalizeTitle and ID remain temporarily as differential oracles.
func SharedIdentity(ctx context.Context, title string) (Task, error) {
	identities, err := SharedIdentities(ctx, []string{title})
	if err != nil {
		return Task{}, err
	}
	return identities[0], nil
}

func SharedIdentities(ctx context.Context, titles []string) ([]Task, error) {
	if len(titles) == 0 {
		return []Task{}, nil
	}
	core, err := sharedcore.Default(ctx)
	if err != nil {
		return nil, &SharedIdentityRuntimeError{Cause: err}
	}
	calls := make([]sharedcore.Call, 0, len(titles))
	for _, title := range titles {
		input, err := json.Marshal(map[string]string{"title": title})
		if err != nil {
			return nil, &SharedIdentityRuntimeError{Cause: err}
		}
		calls = append(calls, sharedcore.Call{Operation: "task.identity.v1", Input: input})
	}
	results, err := core.CallBatch(ctx, calls)
	if err != nil {
		return nil, &SharedIdentityRuntimeError{Cause: err}
	}
	identities := make([]Task, 0, len(results))
	for _, result := range results {
		identity, err := decodeSharedIdentity(result)
		if err != nil {
			return nil, err
		}
		identities = append(identities, identity)
	}
	return identities, nil
}

func decodeSharedIdentity(result []byte) (Task, error) {
	var envelope struct {
		OK    *bool           `json:"ok"`
		Value json.RawMessage `json:"value"`
		Error *string         `json:"error"`
	}
	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return Task{}, &SharedIdentityRuntimeError{Cause: fmt.Errorf("decode shared task identity envelope: %w", err)}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Task{}, &SharedIdentityRuntimeError{Cause: errors.New("shared task identity envelope contains trailing data")}
	}
	if envelope.OK == nil {
		return Task{}, &SharedIdentityRuntimeError{Cause: errors.New("shared task identity envelope is missing ok")}
	}
	if !*envelope.OK {
		if envelope.Error == nil || *envelope.Error == "" || len(envelope.Value) != 0 {
			return Task{}, &SharedIdentityRuntimeError{Cause: errors.New("shared task identity failure envelope is malformed")}
		}
		return Task{}, &SharedIdentityValidationError{Detail: *envelope.Error}
	}
	if envelope.Error != nil || len(envelope.Value) == 0 || string(envelope.Value) == "null" {
		return Task{}, &SharedIdentityRuntimeError{Cause: errors.New("shared task identity success envelope is malformed")}
	}
	var value struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		UTF8Bytes *int   `json:"utf8Bytes"`
	}
	valueDecoder := json.NewDecoder(bytes.NewReader(envelope.Value))
	valueDecoder.DisallowUnknownFields()
	if err := valueDecoder.Decode(&value); err != nil {
		return Task{}, &SharedIdentityRuntimeError{Cause: fmt.Errorf("decode shared task identity: %w", err)}
	}
	if err := valueDecoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Task{}, &SharedIdentityRuntimeError{Cause: errors.New("shared task identity value contains trailing data")}
	}
	if value.ID == "" || value.Title == "" || value.UTF8Bytes == nil || *value.UTF8Bytes != len([]byte(value.Title)) || !utf8.ValidString(value.Title) {
		return Task{}, &SharedIdentityRuntimeError{Cause: errors.New("shared task identity returned an incomplete value")}
	}
	return Task{ID: value.ID, Title: value.Title}, nil
}

type Operation struct {
	ID         string
	DeviceID   string
	TaskID     string
	Type       string
	Title      string
	OccurredAt time.Time
	HLCWallMs  int64
	HLCCounter int64
}

func NormalizeTitle(value string) string {
	runes := []rune(norm.NFC.String(value))
	start := 0
	for start < len(runes) && !isPrintable(runes[start]) {
		start++
	}
	end := len(runes)
	for end > start && !isPrintable(runes[end-1]) {
		end--
	}
	return string(runes[start:end])
}

func isPrintable(value rune) bool {
	return value == ' ' || unicode.IsLetter(value) || unicode.IsMark(value) || unicode.IsNumber(value) ||
		unicode.IsPunct(value) || unicode.IsSymbol(value)
}

func ID(title string) string {
	digest := sha256.Sum256([]byte(idNamespace + NormalizeTitle(title)))
	bytes := digest[:16]
	bytes[6] = (bytes[6] & 0x0f) | 0x80
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}
