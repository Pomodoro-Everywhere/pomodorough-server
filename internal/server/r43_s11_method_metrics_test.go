package server

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetricsBoundDistinctMethods(t *testing.T) {
	fixture := newServerFixture(t)

	const distinct = 50
	for i := 0; i < distinct; i++ {
		method := fmt.Sprintf("CUSTOMMETHOD%04d", i)
		request := httptest.NewRequest(method, "https://pomodorough.egigoka.me/healthz", nil)
		response := httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request)
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

	if strings.Contains(text, "CUSTOMMETHOD") {
		t.Errorf("metrics retain raw method tokens, want normalized OTHER")
	}
	if !strings.Contains(text, `method="OTHER"`) {
		t.Errorf("metrics missing normalized OTHER method:\n%s", text)
	}
	counts := countMetricSeries(text, "pomodorough_http_requests_total{")
	if counts > 4 {
		t.Errorf("request series = %d, want <= 4 for %d distinct methods", counts, distinct)
	}
	durationCounts := countMetricSeries(text, "pomodorough_http_request_duration_seconds_count{")
	if durationCounts > 4 {
		t.Errorf("duration series = %d, want <= 4 for %d distinct methods", durationCounts, distinct)
	}
}

func countMetricSeries(text, prefix string) int {
	count := 0
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, prefix) {
			count++
		}
	}
	return count
}
