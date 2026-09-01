package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestS5TrustedProxyUsesRightBoundaryInsteadOfSpoofedLeftmost(t *testing.T) {
	policy := mustClientIPPolicyS5(t, []string{"127.0.0.0/8"}, 1)
	request := proxyRequestS5("127.0.0.1:443", "192.0.2.66, 198.51.100.8:8443")
	if got := policy.clientIP(request); got != "198.51.100.8" {
		t.Fatalf("client IP = %q, want right boundary 198.51.100.8", got)
	}
}

func TestS5TrustedProxySupportsMultipleIPv4AndIPv6Hops(t *testing.T) {
	tests := []struct {
		cidrs     []string
		hops      int
		remote    string
		forwarded string
		want      string
	}{
		{[]string{"127.0.0.0/8", "10.0.0.0/8"}, 2, "127.0.0.1:443", "198.51.100.9:80, 10.2.3.4:443", "198.51.100.9"},
		{[]string{"::1/128"}, 1, "[::1]:443", "[2001:db8::9]:8443", "2001:db8::9"},
		{[]string{"127.0.0.0/8"}, 1, "[::ffff:127.0.0.1]:443", "::ffff:198.51.100.10", "198.51.100.10"},
	}
	for _, test := range tests {
		policy := mustClientIPPolicyS5(t, test.cidrs, test.hops)
		if got := policy.clientIP(proxyRequestS5(test.remote, test.forwarded)); got != test.want {
			t.Fatalf("client IP for %q = %q, want %q", test.forwarded, got, test.want)
		}
	}
}

func TestS5TrustedProxyRejectsMalformedAndAmbiguousChains(t *testing.T) {
	policy := mustClientIPPolicyS5(t, []string{"127.0.0.0/8", "10.0.0.0/8"}, 2)
	tests := []string{"", "198.51.100.1", "bad, 10.0.0.1", "198.51.100.1, 192.0.2.1", "198.51.100.1, 10.0.0.1,", "10.0.0.3, 10.0.0.2"}
	for _, forwarded := range tests {
		request := proxyRequestS5("127.0.0.1:443", forwarded)
		if got := policy.clientIP(request); got != "127.0.0.1" {
			t.Fatalf("client IP for rejected chain %q = %q", forwarded, got)
		}
	}
	request := proxyRequestS5("127.0.0.1:443", "198.51.100.1, 10.0.0.1")
	request.Header.Add("X-Forwarded-For", "198.51.100.2, 10.0.0.2")
	if got := policy.clientIP(request); got != "127.0.0.1" {
		t.Fatalf("duplicate header client IP = %q", got)
	}
}

func TestS5UntrustedPeerCannotSupplyForwardingChain(t *testing.T) {
	policy := mustClientIPPolicyS5(t, []string{"127.0.0.0/8"}, 1)
	request := proxyRequestS5("198.51.100.7:443", "203.0.113.4")
	if got := policy.clientIP(request); got != "198.51.100.7" {
		t.Fatalf("untrusted peer client IP = %q", got)
	}
}

func TestS5RateLimitBucketsSanitizedBoundaryIdentity(t *testing.T) {
	policy := mustClientIPPolicyS5(t, []string{"127.0.0.0/8"}, 1)
	application := &Server{authIPLimiter: newWindowRateLimiter(1, time.Minute), clientIPs: policy, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	handler := application.rateLimitByIP(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for index, spoofed := range []string{"192.0.2.1, 198.51.100.8", "192.0.2.2, 198.51.100.8"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, proxyRequestS5("127.0.0.1:443", spoofed))
		want := []int{http.StatusNoContent, http.StatusTooManyRequests}[index]
		if response.Code != want {
			t.Fatalf("request %d status = %d, want %d", index, response.Code, want)
		}
	}
}

func TestS5ServerRejectsIncompleteManualProxyConfiguration(t *testing.T) {
	fixture := newServerFixture(t)
	fixture.application.cfg.TrustedProxyCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	fixture.application.cfg.TrustedProxyHops = 0
	if _, err := New(fixture.application.cfg, fixture.application.store, fixture.application.logger); err == nil {
		t.Fatal("New accepted trusted CIDRs without hop count")
	}
}

func mustClientIPPolicyS5(t *testing.T, rawCIDRs []string, hops int) clientIPPolicy {
	t.Helper()
	cidrs := make([]netip.Prefix, len(rawCIDRs))
	for index, raw := range rawCIDRs {
		cidrs[index] = netip.MustParsePrefix(raw)
	}
	policy, valid := newClientIPPolicy(cidrs, hops)
	if !valid {
		t.Fatal("trusted proxy fixture rejected")
	}
	return policy
}

func proxyRequestS5(remoteAddr, forwarded string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "https://pomodorough.egigoka.me/auth/google/start", nil)
	request.RemoteAddr = remoteAddr
	if forwarded != "" {
		request.Header.Set("X-Forwarded-For", forwarded)
	}
	return request
}

func TestS5TrustedProxyRejectsOversizedOrOverlongChains(t *testing.T) {
	policy := mustClientIPPolicyS5(t, []string{"127.0.0.0/8"}, 1)
	chains := []string{strings.Repeat("1", maxForwardedChainBytes+1), strings.Repeat("198.51.100.1,", maxForwardedChainLength) + "198.51.100.1"}
	for _, chain := range chains {
		if got := policy.clientIP(proxyRequestS5("127.0.0.1:443", chain)); got != "127.0.0.1" {
			t.Fatalf("oversized chain client IP = %q", got)
		}
	}
}
