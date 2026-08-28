package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSyncRejectsNonJSONBodyWithoutPersistingCommands(t *testing.T) {
	fixture := newServerFixture(t)
	payload := validSyncRequestJSON(time.Now().UTC())
	payload.DeviceID = fixture.deviceID
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync", bytes.NewReader(body))
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("sync status=%d body=%s", response.Code, response.Body.String())
	}

	history := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/history", nil)
	history.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	historyResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(historyResponse, history)
	if historyResponse.Code != http.StatusOK {
		t.Fatalf("history status=%d body=%s", historyResponse.Code, historyResponse.Body.String())
	}
	var result struct {
		History []json.RawMessage `json:"history"`
	}
	if err := json.NewDecoder(historyResponse.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if len(result.History) != 0 {
		t.Fatalf("rejected sync persisted history: %s", historyResponse.Body.String())
	}

	retry := httptest.NewRequest(http.MethodPost, "https://pomodorough.egigoka.me/api/v1/sync", bytes.NewReader(body))
	retry.Header.Set("Content-Type", "application/json")
	retry.Header.Set("Authorization", "Bearer "+fixture.accessToken)
	retryResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(retryResponse, retry)
	if retryResponse.Code != http.StatusOK {
		t.Fatalf("valid retry after rejected sync status=%d body=%s", retryResponse.Code, retryResponse.Body.String())
	}
	var applied struct {
		Revision         int64 `json:"revision"`
		Acknowledgements []struct {
			CommandID string `json:"commandId"`
			Outcome   string `json:"outcome"`
		} `json:"acknowledgements"`
	}
	if err := json.NewDecoder(retryResponse.Body).Decode(&applied); err != nil {
		t.Fatal(err)
	}
	if applied.Revision != 1 || len(applied.Acknowledgements) != 1 || applied.Acknowledgements[0].CommandID != payload.Commands[0].ID || applied.Acknowledgements[0].Outcome != "applied" {
		t.Fatalf("valid retry did not apply exactly once: %#v", applied)
	}
}
