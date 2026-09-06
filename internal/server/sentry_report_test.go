package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReportPanicToErrorMonitoringWithoutMonitoring(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/api/v1/me", nil)
	request.Pattern = "GET /api/v1/me"
	reportPanicToErrorMonitoring(errors.New("boom"), request)
	reportPanicToErrorMonitoring("string panic", request)
	patternless := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/", nil)
	reportPanicToErrorMonitoring(errors.New("boom"), patternless)
}
