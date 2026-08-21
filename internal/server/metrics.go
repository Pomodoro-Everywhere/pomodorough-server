package server

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type requestMetricKey struct {
	method string
	route  string
	status int
}

type durationMetricKey struct {
	method string
	route  string
}

type requestMetrics struct {
	mu             sync.Mutex
	requests       map[requestMetricKey]uint64
	durationCounts map[durationMetricKey]uint64
	durationSums   map[durationMetricKey]float64
}

func newRequestMetrics() *requestMetrics {
	return &requestMetrics{
		requests:       make(map[requestMetricKey]uint64),
		durationCounts: make(map[durationMetricKey]uint64),
		durationSums:   make(map[durationMetricKey]float64),
	}
}

func (m *requestMetrics) observe(method, pattern string, status int, duration time.Duration) {
	route := metricRoute(method, pattern)
	requestKey := requestMetricKey{method: method, route: route, status: status}
	durationKey := durationMetricKey{method: method, route: route}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests[requestKey]++
	m.durationCounts[durationKey]++
	m.durationSums[durationKey] += duration.Seconds()
}

func metricRoute(method, pattern string) string {
	if route, found := strings.CutPrefix(pattern, method+" "); found && route != "" {
		return route
	}
	if pattern == "" {
		return "unmatched"
	}
	return pattern
}

func (m *requestMetrics) writePrometheus(w io.Writer) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	requestKeys := make([]requestMetricKey, 0, len(m.requests))
	for key := range m.requests {
		requestKeys = append(requestKeys, key)
	}
	sort.Slice(requestKeys, func(i, j int) bool {
		left, right := requestKeys[i], requestKeys[j]
		if left.method != right.method {
			return left.method < right.method
		}
		if left.route != right.route {
			return left.route < right.route
		}
		return left.status < right.status
	})
	if _, err := io.WriteString(w, "# TYPE pomodorough_http_requests_total counter\n"); err != nil {
		return err
	}
	for _, key := range requestKeys {
		if _, err := fmt.Fprintf(w, "pomodorough_http_requests_total{method=%s,route=%s,status=%s} %d\n",
			strconv.Quote(key.method), strconv.Quote(key.route), strconv.Quote(strconv.Itoa(key.status)), m.requests[key]); err != nil {
			return err
		}
	}

	durationKeys := make([]durationMetricKey, 0, len(m.durationCounts))
	for key := range m.durationCounts {
		durationKeys = append(durationKeys, key)
	}
	sort.Slice(durationKeys, func(i, j int) bool {
		if durationKeys[i].method != durationKeys[j].method {
			return durationKeys[i].method < durationKeys[j].method
		}
		return durationKeys[i].route < durationKeys[j].route
	})
	if _, err := io.WriteString(w, "# TYPE pomodorough_http_request_duration_seconds summary\n"); err != nil {
		return err
	}
	for _, key := range durationKeys {
		labels := fmt.Sprintf("method=%s,route=%s", strconv.Quote(key.method), strconv.Quote(key.route))
		if _, err := fmt.Fprintf(w, "pomodorough_http_request_duration_seconds_count{%s} %d\n", labels, m.durationCounts[key]); err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "pomodorough_http_request_duration_seconds_sum{%s} %.9f\n", labels, m.durationSums[key]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if err := s.metrics.writePrometheus(w); err != nil {
		s.logger.Warn("write metrics response", "error", err)
	}
}
