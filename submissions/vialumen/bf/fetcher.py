"""Fetcher adapter — the ONLY component that knows how to read Discord.

The store/index/parity layers depend on this interface, never on Discord directly.
Swap the adapter to change the source without touching the pipeline:

  * FixtureFetcher    — reads local JSON (tests, offline, demo)
  * ToolFetcher       — in-agent, backed by the approved fetch_messages MCP tool
                        (no raw bot token handled here — token-safety boundary)
  * DiscordRestFetcher — standalone deploy; reads token from a secret store at
                        runtime (never at rest, never logged). Stub below.

A message dict is normalised to:
  {id, channel_id, thread_id, author_id, author_name, content, edited_ts,
   attachments:[...], reactions:[...], deleted:bool}
"""
from __future__ import annotations
import json
from abc import ABC, abstractmethod
from pathlib import Path


class Fetcher(ABC):
    @abstractmethod
    def channels(self) -> list[dict]:
        """Return [{id,name,type,parent_id,kind,state}] — rooms + threads
        (active + archived public + archived private). Coverage completeness."""

    @abstractmethod
    def messages(self, channel_id: str, *, before: str | None = None,
                 after: str | None = None, limit: int = 100) -> list[dict]:
        """One page of normalised messages. `before`=cold walk, `after`=warm tail."""

    def delete_events(self) -> list[dict]:
        """Pending MESSAGE_DELETE events (gateway). Each: {id, channel_id}.
        Default none — only a live/gateway source emits these."""
        return []


class FixtureFetcher(Fetcher):
    """Replays a JSON fixture. Supports `before`/`after` cursors over an in-memory
    list so the same pagination code path is exercised as a live source."""

    def __init__(self, fixture_path: str):
        data = json.loads(Path(fixture_path).read_text())
        self._channels = data.get("channels", [])
        self._deletes = data.get("delete_events", [])
        # channel_id -> sorted-by-id list of message dicts
        self._msgs: dict[str, list[dict]] = {}
        for m in data.get("messages", []):
            self._msgs.setdefault(m["channel_id"], []).append(m)
        for cid in self._msgs:
            self._msgs[cid].sort(key=lambda m: int(m["id"]))

    def channels(self) -> list[dict]:
        return list(self._channels)

    def delete_events(self) -> list[dict]:
        return list(self._deletes)

    def messages(self, channel_id, *, before=None, after=None, limit=100):
        rows = self._msgs.get(channel_id, [])
        if after is not None:
            rows = [m for m in rows if int(m["id"]) > int(after)]
        if before is not None:
            rows = [m for m in rows if int(m["id"]) < int(before)]
            rows = rows[-limit:]          # newest page below `before`
        else:
            rows = rows[:limit]
        return [dict(m) for m in rows]


class DiscordRestFetcher(Fetcher):
    """Standalone production adapter (not used in the agent sandbox).

    Real impl would page GET /channels/{id}/messages?before|after&limit=100,
    honouring X-RateLimit-* headers + 429 Retry-After, with the bot token pulled
    from a secret store at call time. Left as a documented stub here so the
    token-safety boundary is never crossed inside the agent."""

    def channels(self):
        raise NotImplementedError("standalone adapter — runs outside the agent sandbox")

    def messages(self, channel_id, *, before=None, after=None, limit=100):
        raise NotImplementedError("standalone adapter — runs outside the agent sandbox")
