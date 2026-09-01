# Trusted proxy client addresses

Authentication rate limiting uses the TCP peer address unless both
`TRUSTED_PROXY_CIDRS` and `TRUSTED_PROXY_HOPS` are configured. Loopback is not
implicitly trusted.

`TRUSTED_PROXY_CIDRS` is a comma-separated list of IPv4 or IPv6 CIDRs.
`TRUSTED_PROXY_HOPS` is the exact number of proxies between the client and this
server, including the direct peer. Values from 1 through 16 are accepted.

For one local reverse proxy:

```env
TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128
TRUSTED_PROXY_HOPS=1
```

For an edge proxy followed by an internal proxy, list both proxy networks and
set the hop count to two. Do not include ordinary client networks in the trusted
CIDRs.

## Header contract

Configure the public edge to remove any incoming `X-Forwarded-For` value or
append the directly observed source address. Every intermediate proxy must
append its directly observed source address without reordering the chain. The
server reads from the right edge, validates the configured trusted hops, and
uses the address immediately left of that boundary. Extra valid addresses to
the left cannot select the limiter identity.

Each chain element must be an IPv4 address, IPv6 address, IPv4 address with a
port, or bracketed IPv6 address with a port. Multiple header fields, empty or
invalid elements, overlong chains, untrusted required hops, and a boundary that
still belongs to a trusted proxy network invalidate the entire header. The
request remains serviceable, but rate limiting falls back to the direct peer.

## Deployment checks

Restrict `LISTEN_ADDR` with host or network policy so clients cannot bypass the
configured proxies. Treat proxy topology changes as configuration changes:
update CIDRs and hop count together, restart the service, then verify different
clients receive independent authentication rate-limit buckets. If topology is
uncertain, remove both variables and use direct-peer limiting.
