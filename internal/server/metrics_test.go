package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsExposeBoundedRequestCountsAndLatencyWithoutRequestData(t *testing.T) {
	fixture := newServerFixture(t)

	healthRequest := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/healthz?user=secret", nil)
	healthResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(healthResponse, healthRequest)
	if healthResponse.Code != http.StatusOK {
		t.Fatalf("health status = %d", healthResponse.Code)
	}

	metricsRequest := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/metrics", nil)
	metricsResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(metricsResponse, metricsRequest)
	result := metricsResponse.Result()
	defer result.Body.Close()
	body, err := io.ReadAll(result.Body)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if result.StatusCode != http.StatusOK {
		t.Fatalf("metrics status = %d; body = %s", result.StatusCode, text)
	}
	if contentType := result.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/plain") {
		t.Fatalf("metrics content type = %q", contentType)
	}
	for _, want := range []string{
		`pomodorough_http_requests_total{method="GET",route="/healthz",status="200"} 1`,
		`pomodorough_http_request_duration_seconds_count{method="GET",route="/healthz"} 1`,
		`pomodorough_http_request_duration_seconds_sum{method="GET",route="/healthz"}`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("metrics missing %q:\n%s", want, text)
		}
	}
	for _, secret := range []string{"user=secret", fixture.userID, "user@example.com"} {
		if strings.Contains(text, secret) {
			t.Errorf("metrics leaked %q", secret)
		}
	}
}
