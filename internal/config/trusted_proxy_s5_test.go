package config

import (
	"net/netip"
	"testing"
)

func TestS5LoadTrustedProxyBoundary(t *testing.T) {
	setConfigEnvironment(t)
	t.Setenv("TRUSTED_PROXY_CIDRS", " 127.0.0.1/8, ::1/128,127.0.0.0/8 ")
	t.Setenv("TRUSTED_PROXY_HOPS", "2")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}
	if len(cfg.TrustedProxyCIDRs) != len(want) || cfg.TrustedProxyHops != 2 {
		t.Fatalf("trusted proxy config = %#v hops=%d", cfg.TrustedProxyCIDRs, cfg.TrustedProxyHops)
	}
	for index := range want {
		if cfg.TrustedProxyCIDRs[index] != want[index] {
			t.Fatalf("trusted proxy CIDR %d = %s, want %s", index, cfg.TrustedProxyCIDRs[index], want[index])
		}
	}
}

func TestS5LoadDefaultsToNoTrustedProxy(t *testing.T) {
	setConfigEnvironment(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.TrustedProxyCIDRs) != 0 || cfg.TrustedProxyHops != 0 {
		t.Fatalf("default trusted proxy config = %#v hops=%d", cfg.TrustedProxyCIDRs, cfg.TrustedProxyHops)
	}
}

func TestS5LoadRejectsIncompleteOrInvalidProxySettings(t *testing.T) {
	tests := []struct{ cidrs, hops string }{
		{cidrs: "127.0.0.0/8"},
		{hops: "1"},
		{cidrs: "127.0.0.0/8", hops: "0"},
		{cidrs: "127.0.0.0/8", hops: "17"},
		{cidrs: "127.0.0.0/8", hops: "many"},
		{cidrs: "127.0.0.1", hops: "1"},
		{cidrs: "127.0.0.0/8,", hops: "1"},
	}
	for _, test := range tests {
		setConfigEnvironment(t)
		t.Setenv("TRUSTED_PROXY_CIDRS", test.cidrs)
		t.Setenv("TRUSTED_PROXY_HOPS", test.hops)
		if _, err := Load(); err == nil {
			t.Fatalf("Load accepted CIDRs %q with hops %q", test.cidrs, test.hops)
		}
	}
}
