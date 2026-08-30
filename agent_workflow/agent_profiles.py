"""Provider-neutral agent profiles resolved at the platform boundary."""
from __future__ import annotations

from typing import Any

_PROFILES: dict[str, dict[str, dict[str, Any]]] = {
    "cheap_read": {
        "Codex": {"model": "gpt-5.6-luna", "reasoning_effort": "none", "sandbox_mode": "read-only", "tools": ["read"]},
        "Claude": {"model": "haiku", "sandbox_mode": "read-only", "tools": ["Read", "Glob", "Grep"]},
    },
}


def resolve(platform: str, profile: str) -> dict[str, Any]:
    """Resolve a declared profile for a supported platform, failing closed when unknown."""
    try:
        return dict(_PROFILES[profile][platform])
    except KeyError as exc:
        raise ValueError(f"unsupported agent profile for {platform}: {profile}") from exc


def request_fields(platform: str, profile: str) -> dict[str, Any]:
    """Return dispatcher fields for an explicit profile; worker keeps legacy defaults."""
    if profile == "worker":
        return {}
    return {"agent_profile": profile, **resolve(platform, profile)}


def main(argv: list[str] | None = None) -> int:
    import argparse, json
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", required=True, choices=("Codex", "Claude"))
    parser.add_argument("--profile", required=True, choices=("cheap_read",))
    args = parser.parse_args(argv)
    print(json.dumps(request_fields(args.platform, args.profile), ensure_ascii=False))
    return 0
