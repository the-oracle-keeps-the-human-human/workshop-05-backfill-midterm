"""Discord snowflake helpers — derive time from id, no extra API call."""
from __future__ import annotations
from datetime import datetime, timezone

DISCORD_EPOCH = 1420070400000  # 2015-01-01T00:00:00Z in ms


def snowflake_ts(message_id: str) -> str:
    """ISO8601 UTC timestamp encoded in a snowflake id."""
    ms = (int(message_id) >> 22) + DISCORD_EPOCH
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def id_max(a: str | None, b: str | None) -> str | None:
    """Snowflakes are monotonic; compare as ints for newest/oldest."""
    if a is None:
        return b
    if b is None:
        return a
    return a if int(a) >= int(b) else b


def id_min(a: str | None, b: str | None) -> str | None:
    if a is None:
        return b
    if b is None:
        return a
    return a if int(a) <= int(b) else b
