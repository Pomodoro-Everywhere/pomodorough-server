package server

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
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
