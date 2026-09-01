package server

import (
	"net/http"
	"net/netip"
	"strings"
)

const (
	maxForwardedChainBytes  = 2048
	maxForwardedChainLength = 32
)

type clientIPPolicy struct {
	trustedProxyCIDRs []netip.Prefix
	trustedProxyHops  int
}

func newClientIPPolicy(cidrs []netip.Prefix, hops int) (clientIPPolicy, bool) {
	if len(cidrs) == 0 && hops == 0 {
		return clientIPPolicy{}, true
	}
	if len(cidrs) == 0 || hops < 1 || hops > 16 {
		return clientIPPolicy{}, false
	}
	normalized := make([]netip.Prefix, len(cidrs))
	for index, prefix := range cidrs {
		if !prefix.IsValid() {
			return clientIPPolicy{}, false
		}
		normalized[index] = prefix.Masked()
	}
	return clientIPPolicy{trustedProxyCIDRs: normalized, trustedProxyHops: hops}, true
}

func (policy clientIPPolicy) clientIP(r *http.Request) string {
	direct, valid := parseNetworkAddress(r.RemoteAddr)
	if !valid {
		return strings.TrimSpace(r.RemoteAddr)
	}
	if policy.trustedProxyHops == 0 || !policy.trusts(direct) {
		return direct.String()
	}
	chain, valid := forwardedChain(r.Header.Values("X-Forwarded-For"))
	if !valid || len(chain) < policy.trustedProxyHops {
		return direct.String()
	}
	clientIndex := len(chain) - policy.trustedProxyHops
	if !policy.validProxyBoundary(chain, clientIndex) {
		return direct.String()
	}
	return chain[clientIndex].String()
}

func (policy clientIPPolicy) validProxyBoundary(chain []netip.Addr, clientIndex int) bool {
	if policy.trusts(chain[clientIndex]) {
		return false
	}
	for _, proxy := range chain[clientIndex+1:] {
		if !policy.trusts(proxy) {
			return false
		}
	}
	return true
}

func (policy clientIPPolicy) trusts(address netip.Addr) bool {
	for _, prefix := range policy.trustedProxyCIDRs {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func forwardedChain(values []string) ([]netip.Addr, bool) {
	if len(values) != 1 || len(values[0]) == 0 || len(values[0]) > maxForwardedChainBytes {
		return nil, false
	}
	items := strings.Split(values[0], ",")
	if len(items) > maxForwardedChainLength {
		return nil, false
	}
	chain := make([]netip.Addr, len(items))
	for index, item := range items {
		address, valid := parseNetworkAddress(item)
		if !valid {
			return nil, false
		}
		chain[index] = address
	}
	return chain, true
}

func parseNetworkAddress(raw string) (netip.Addr, bool) {
	value := strings.TrimSpace(raw)
	if addressPort, err := netip.ParseAddrPort(value); err == nil {
		return normalizedAddress(addressPort.Addr()), true
	}
	address, err := netip.ParseAddr(value)
	if err != nil {
		return netip.Addr{}, false
	}
	return normalizedAddress(address), true
}

func normalizedAddress(address netip.Addr) netip.Addr {
	return address.WithZone("").Unmap()
}

func clientIP(r *http.Request) string {
	return (clientIPPolicy{}).clientIP(r)
}
