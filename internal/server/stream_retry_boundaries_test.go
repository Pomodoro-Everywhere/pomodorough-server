package server

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRevisionStreamStopsAfterUpdateWriteFailure(t *testing.T) {
	writer := &failAfterFirstWriteStreamWriter{header: make(http.Header)}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil)
	updates := make(chan int64, 1)
	updates <- 2

	revisionStream{w: writer, controller: http.NewResponseController(writer)}.
		serve(request, updates, 1, time.Hour)

	if writer.writes != 2 || writer.flushes != 1 {
		t.Fatalf("stream writes=%d flushes=%d, want second write failure after one flush", writer.writes, writer.flushes)
	}
	if got := writer.body.String(); got != "event: revision\ndata: {\"revision\":1}\n\n" {
		t.Fatalf("stream body before failed update = %q", got)
	}
}

func TestRevisionStreamStopsAfterKeepaliveWriteFailure(t *testing.T) {
	writer := &failAfterFirstWriteStreamWriter{header: make(http.Header)}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil)
	updates := make(chan int64)

	revisionStream{w: writer, controller: http.NewResponseController(writer)}.
		serve(request, updates, 4, time.Millisecond)

	if writer.writes != 2 || writer.flushes != 1 {
		t.Fatalf("stream writes=%d flushes=%d, want failed keepalive after initial revision", writer.writes, writer.flushes)
	}
}

func TestRevisionStreamReturnsWhenPublisherCloses(t *testing.T) {
	writer := &failAfterFirstWriteStreamWriter{header: make(http.Header), allowAllWrites: true}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil)
	updates := make(chan int64)
	close(updates)

	revisionStream{w: writer, controller: http.NewResponseController(writer)}.
		serve(request, updates, 9, time.Hour)

	if writer.writes != 1 || writer.flushes != 1 {
		t.Fatalf("closed publisher stream writes=%d flushes=%d, want initial event only", writer.writes, writer.flushes)
	}
}

type failAfterFirstWriteStreamWriter struct {
	header         http.Header
	body           bytes.Buffer
	writes         int
	flushes        int
	allowAllWrites bool
}

func (w *failAfterFirstWriteStreamWriter) Header() http.Header { return w.header }
func (w *failAfterFirstWriteStreamWriter) WriteHeader(int)     {}

func (w *failAfterFirstWriteStreamWriter) Write(body []byte) (int, error) {
	w.writes++
	if w.writes > 1 && !w.allowAllWrites {
		return 0, errors.New("stream peer disconnected")
	}
	return w.body.Write(body)
}

func (w *failAfterFirstWriteStreamWriter) FlushError() error {
	w.flushes++
	return nil
}

func (w *failAfterFirstWriteStreamWriter) SetWriteDeadline(time.Time) error { return nil }

func (w *failingStreamWriter) SetWriteDeadline(time.Time) error { return nil }

func (w *openStreamWriter) SetWriteDeadline(time.Time) error { return nil }

func TestRevisionStreamStopsWhenWriteDeadlineFails(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	writer := &deadlineStreamWriter{header: make(http.Header), deadlineErr: errors.New("hung SSE peer")}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil)
	updates := make(chan int64)

	revisionStream{w: writer, controller: http.NewResponseController(writer), logger: logger}.
		serve(request, updates, 7, time.Hour)

	if writer.writes != 0 || writer.flushes != 0 {
		t.Fatalf("deadline-failed stream writes=%d flushes=%d, want 0 0", writer.writes, writer.flushes)
	}
	if !strings.Contains(logs.String(), "write stream revision") {
		t.Fatalf("deadline failure not logged: %q", logs.String())
	}
}

func TestRevisionStreamKeepaliveStopsWhenWriteDeadlineFails(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	writer := &deadlineStreamWriter{header: make(http.Header), succeedDeadlines: 1}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/stream", nil)
	updates := make(chan int64)

	revisionStream{w: writer, controller: http.NewResponseController(writer), logger: logger}.
		serve(request, updates, 4, time.Millisecond)

	if writer.writes != 1 || writer.flushes != 1 {
		t.Fatalf("keepalive deadline stream writes=%d flushes=%d, want 1 1", writer.writes, writer.flushes)
	}
	if !strings.Contains(logs.String(), "write stream keepalive") {
		t.Fatalf("keepalive deadline failure not logged: %q", logs.String())
	}
}

type deadlineStreamWriter struct {
	header           http.Header
	body             bytes.Buffer
	writes           int
	flushes          int
	deadlines        int
	succeedDeadlines int
	deadlineErr      error
}

func (w *deadlineStreamWriter) Header() http.Header { return w.header }
func (w *deadlineStreamWriter) WriteHeader(int)     {}

func (w *deadlineStreamWriter) SetWriteDeadline(time.Time) error {
	w.deadlines++
	if w.deadlines > w.succeedDeadlines {
		if w.deadlineErr != nil {
			return w.deadlineErr
		}
		return errors.New("hung SSE peer")
	}
	return nil
}

func (w *deadlineStreamWriter) Write(body []byte) (int, error) {
	w.writes++
	return w.body.Write(body)
}

func (w *deadlineStreamWriter) FlushError() error {
	w.flushes++
	return nil
}
