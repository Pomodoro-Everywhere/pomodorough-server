#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def require_fragment(path: str, fragment: str) -> None:
    content = (ROOT / path).read_text(encoding="utf-8")
    if fragment not in content:
        raise SystemExit(f"{path} missing {fragment!r}")


def main() -> None:
    for name in ("TRUSTED_PROXY_CIDRS", "TRUSTED_PROXY_HOPS"):
        require_fragment("internal/config/config.go", f'os.Getenv("{name}")')
        require_fragment("README.md", f"`{name}`")
        require_fragment("deploy/pomodorough.env.example", name)
        require_fragment("docs/trusted-proxy-rate-limits.md", f"`{name}`")
    require_fragment("docs/trusted-proxy-rate-limits.md", "Loopback is not")
    require_fragment("docs/trusted-proxy-rate-limits.md", "falls back to the direct peer")


if __name__ == "__main__":
    main()
