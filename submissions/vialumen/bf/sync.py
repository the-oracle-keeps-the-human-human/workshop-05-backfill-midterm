"""Orchestrator. Cold backfill and warm tail share ONE idempotent write path.

  cold(ch): walk history backwards via `before` cursor until exhausted, resumable
            from checkpoint.oldest_id; marks cold_done when the source end is hit.
  warm(ch): pull only messages newer than checkpoint.newest_id via `after` cursor;
            also reconciles edits/deletes by re-reading the most-recent window.
"""
from __future__ import annotations
import json
import sqlite3

from .fetcher import Fetcher
from .store import upsert_channel, upsert_message, bump_checkpoint, get_checkpoint
from .util import now_iso

PAGE = 100


def _log_run(conn, mode, cid, started, counts):
    conn.execute(
        "INSERT INTO run_log(mode,channel_id,started_at,finished_at,fetched,inserted,"
        "edits,deletes,stats_json) VALUES(?,?,?,?,?,?,?,?,?)",
        (mode, cid, started, now_iso(), counts["fetched"], counts["inserted"],
         counts["edits"], counts["deletes"], json.dumps(counts)),
    )


def _apply(conn, msgs) -> dict:
    c = {"fetched": 0, "inserted": 0, "edits": 0, "deletes": 0, "unchanged": 0}
    ids = []
    for m in msgs:
        res = upsert_message(conn, m)
        c["fetched"] += 1
        c[{"inserted": "inserted", "edit": "edits", "delete": "deletes",
           "unchanged": "unchanged"}[res]] += 1
        ids.append(str(m["id"]))
    return c, ids


def cold(conn: sqlite3.Connection, fetcher: Fetcher, cid: str, max_pages=1000) -> dict:
    started = now_iso()
    cp = get_checkpoint(conn, cid)
    before = cp["oldest_id"] if cp and cp["oldest_id"] else None
    total = {"fetched": 0, "inserted": 0, "edits": 0, "deletes": 0, "unchanged": 0}
    for _ in range(max_pages):
        page = fetcher.messages(cid, before=before, limit=PAGE)
        if not page:
            bump_checkpoint(conn, cid, [], cold_done=True)
            break
        c, ids = _apply(conn, page)
        for k in total:
            total[k] += c[k]
        bump_checkpoint(conn, cid, ids)
        before = min(page, key=lambda m: int(m["id"]))["id"]
        if len(page) < PAGE:
            bump_checkpoint(conn, cid, [], cold_done=True)
            break
    _log_run(conn, "cold", cid, started, total)
    conn.commit()
    return total


def warm(conn: sqlite3.Connection, fetcher: Fetcher, cid: str, reconcile=50) -> dict:
    """Tail new messages after newest_id, then re-read the latest window to catch
    edits/deletes that happen on already-ingested messages."""
    started = now_iso()
    cp = get_checkpoint(conn, cid)
    after = cp["newest_id"] if cp and cp["newest_id"] else None
    total = {"fetched": 0, "inserted": 0, "edits": 0, "deletes": 0, "unchanged": 0}

    new = fetcher.messages(cid, after=after, limit=PAGE)
    if new:
        c, ids = _apply(conn, new)
        for k in total:
            total[k] += c[k]
        bump_checkpoint(conn, cid, ids)

    # reconcile mutations on the most recent window (catches edits)
    recent = fetcher.messages(cid, limit=reconcile)
    if recent:
        c, _ = _apply(conn, recent)
        for k in total:
            total[k] += c[k]

    # apply gateway MESSAGE_DELETE events for this channel (tombstone)
    for ev in fetcher.delete_events():
        if str(ev["channel_id"]) != cid:
            continue
        res = upsert_message(conn, {"id": ev["id"], "channel_id": cid, "deleted": True})
        total["fetched"] += 1
        if res == "delete":
            total["deletes"] += 1
    _log_run(conn, "warm", cid, started, total)
    conn.commit()
    return total


def sync_all(conn, fetcher: Fetcher, mode="cold") -> dict:
    chans = fetcher.channels()
    for ch in chans:
        upsert_channel(conn, ch)
    conn.commit()
    out = {}
    for ch in chans:
        cid = str(ch["id"])
        out[cid] = cold(conn, fetcher, cid) if mode == "cold" else warm(conn, fetcher, cid)
    return out
