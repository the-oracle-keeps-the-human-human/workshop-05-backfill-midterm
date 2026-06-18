"""Idempotent write path. Same code for cold backfill and warm tail.

Rules (Novus: Nothing is Deleted):
  * upsert by message_id        -> re-runs are safe, no dupes
  * content changed             -> bump version + append to message_versions
  * deleted=True                -> set tombstone, keep the row + history
"""
from __future__ import annotations
import json
import sqlite3

from .util import snowflake_ts, now_iso, id_max, id_min


def _norm(m: dict) -> dict:
    atts = m.get("attachments") or []
    return {
        "id": str(m["id"]),
        "channel_id": str(m["channel_id"]),
        "thread_id": str(m["thread_id"]) if m.get("thread_id") else None,
        "author_id": str(m.get("author_id") or ""),
        "author_name": m.get("author_name") or "",
        "content": m.get("content") or "",
        "ts": m.get("ts") or snowflake_ts(str(m["id"])),
        "edited_ts": m.get("edited_ts"),
        "has_attachment": 1 if atts else 0,
        "attachments_json": json.dumps(atts, ensure_ascii=False),
        "reactions_json": json.dumps(m.get("reactions") or [], ensure_ascii=False),
        "deleted": 1 if m.get("deleted") else 0,
    }


def upsert_channel(conn: sqlite3.Connection, ch: dict) -> None:
    conn.execute(
        """INSERT INTO channels(id,name,type,parent_id,kind,state,updated_at)
           VALUES(:id,:name,:type,:parent_id,:kind,:state,:updated_at)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, type=excluded.type, parent_id=excluded.parent_id,
             kind=excluded.kind, state=excluded.state, updated_at=excluded.updated_at""",
        {"id": str(ch["id"]), "name": ch.get("name"), "type": ch.get("type"),
         "parent_id": ch.get("parent_id"), "kind": ch.get("kind"),
         "state": ch.get("state"), "updated_at": now_iso()},
    )


def _fts_put(conn, r):
    conn.execute("DELETE FROM messages_fts WHERE id=?", (r["id"],))
    if not r["deleted"]:
        conn.execute(
            "INSERT INTO messages_fts(id,channel_id,author_name,content) VALUES(?,?,?,?)",
            (r["id"], r["channel_id"], r["author_name"], r["content"]),
        )


def upsert_message(conn: sqlite3.Connection, raw: dict) -> str:
    """Returns one of: 'inserted' | 'edit' | 'delete' | 'unchanged'."""
    r = _norm(raw)
    now = now_iso()
    cur = conn.execute(
        "SELECT content, deleted, version FROM messages WHERE id=?", (r["id"],)
    ).fetchone()

    if cur is None:
        conn.execute(
            """INSERT INTO messages(id,channel_id,thread_id,author_id,author_name,
                 content,ts,edited_ts,has_attachment,attachments_json,reactions_json,
                 deleted,version,first_seen_at,updated_at)
               VALUES(:id,:channel_id,:thread_id,:author_id,:author_name,:content,:ts,
                 :edited_ts,:has_attachment,:attachments_json,:reactions_json,:deleted,
                 1,:fs,:ua)""",
            {**r, "fs": now, "ua": now},
        )
        conn.execute(
            "INSERT INTO message_versions(id,version,content,edited_ts,captured_at)"
            " VALUES(?,?,?,?,?)", (r["id"], 1, r["content"], r["edited_ts"], now),
        )
        _fts_put(conn, r)
        return "inserted"

    # existing row — detect delete / edit
    if r["deleted"] and not cur["deleted"]:
        conn.execute("UPDATE messages SET deleted=1, updated_at=? WHERE id=?", (now, r["id"]))
        _fts_put(conn, r)
        return "delete"

    if (not r["deleted"]) and r["content"] != cur["content"]:
        ver = cur["version"] + 1
        conn.execute(
            "UPDATE messages SET content=?, edited_ts=?, reactions_json=?,"
            " attachments_json=?, has_attachment=?, deleted=0, version=?, updated_at=? WHERE id=?",
            (r["content"], r["edited_ts"], r["reactions_json"], r["attachments_json"],
             r["has_attachment"], ver, now, r["id"]),
        )
        conn.execute(
            "INSERT OR REPLACE INTO message_versions(id,version,content,edited_ts,captured_at)"
            " VALUES(?,?,?,?,?)", (r["id"], ver, r["content"], r["edited_ts"], now),
        )
        _fts_put(conn, r)
        return "edit"

    return "unchanged"


def bump_checkpoint(conn, channel_id: str, ids: list[str], cold_done: bool | None = None):
    if not ids and cold_done is None:
        return
    row = conn.execute(
        "SELECT newest_id, oldest_id, cold_done FROM checkpoints WHERE channel_id=?",
        (channel_id,),
    ).fetchone()
    newest = row["newest_id"] if row else None
    oldest = row["oldest_id"] if row else None
    done = row["cold_done"] if row else 0
    for i in ids:
        newest = id_max(newest, i)
        oldest = id_min(oldest, i)
    if cold_done is not None:
        done = 1 if cold_done else 0
    conn.execute(
        """INSERT INTO checkpoints(channel_id,newest_id,oldest_id,cold_done,updated_at)
           VALUES(?,?,?,?,?)
           ON CONFLICT(channel_id) DO UPDATE SET
             newest_id=excluded.newest_id, oldest_id=excluded.oldest_id,
             cold_done=excluded.cold_done, updated_at=excluded.updated_at""",
        (channel_id, newest, oldest, done, now_iso()),
    )


def get_checkpoint(conn, channel_id: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM checkpoints WHERE channel_id=?", (channel_id,)
    ).fetchone()
    return dict(row) if row else None
