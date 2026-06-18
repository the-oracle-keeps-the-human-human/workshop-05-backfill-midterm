"""Completeness verification — never trust a backfill silently.

  * parity      : DB live-message count == source count per channel (the gate)
  * gap scan    : find holes in the ingested id range vs the source, per channel
"""
from __future__ import annotations
import sqlite3

from .fetcher import Fetcher


def _source_ids(fetcher: Fetcher, channel_id: str) -> list[str]:
    out, before = [], None
    while True:
        page = fetcher.messages(channel_id, before=before, limit=100)
        if not page:
            break
        out.extend(str(m["id"]) for m in page)
        before = min(page, key=lambda m: int(m["id"]))["id"]
        if len(page) < 100:
            break
    return sorted(set(out), key=int)


def verify(conn: sqlite3.Connection, fetcher: Fetcher) -> dict:
    report = {"ok": True, "channels": [], "missing_total": 0}
    for ch in fetcher.channels():
        cid = str(ch["id"])
        src = set(_source_ids(fetcher, cid))
        db_rows = conn.execute(
            "SELECT id FROM messages WHERE channel_id=?", (cid,)
        ).fetchall()
        db = {r["id"] for r in db_rows}
        missing = sorted(src - db, key=int)   # in source, not ingested  -> real gap
        extra = sorted(db - src, key=int)     # in db, not in source     -> deletes/tombstones
        ok = len(missing) == 0
        report["ok"] = report["ok"] and ok
        report["missing_total"] += len(missing)
        report["channels"].append({
            "channel_id": cid, "name": ch.get("name"),
            "source": len(src), "db": len(db),
            "missing": missing, "extra": extra, "ok": ok,
        })
    return report


def gap_ranges(missing: list[str]) -> list[tuple[str, str]]:
    """Collapse missing ids into contiguous [lo,hi] ranges for targeted re-fetch."""
    if not missing:
        return []
    ids = sorted(missing, key=int)
    ranges, lo, prev = [], ids[0], ids[0]
    for cur in ids[1:]:
        if int(cur) == int(prev) + 1:
            prev = cur
        else:
            ranges.append((lo, prev)); lo = prev = cur
    ranges.append((lo, prev))
    return ranges
