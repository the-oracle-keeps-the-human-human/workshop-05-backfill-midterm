#!/usr/bin/env python3
"""
Vessel Discord Backfill & Index System
mirror_db.py — Core storage layer: SQLite + FTS5 + Thai tokenization

Design v3:
- 3-stage pipeline: Discord fetch → JSON mirror → SQLite + FTS5
- Thai-aware tokenization via PyThaiNLP (improvement over Kikyo's UNICODE61)
- Oracle-aware tagging (username → oracle_name)
- Auto-classification: curriculum / peer-wisdom / fleet-news / chatter
- Sensitivity guard before indexing
- Attachment content extraction
"""

import sqlite3
import json
import re
import os
from pathlib import Path
from datetime import datetime

try:
    from pythainlp.tokenize import word_tokenize
    THAI_AVAILABLE = True
except ImportError:
    THAI_AVAILABLE = False

ZWSP = "\u200b"

# ──────────────────────────────────────────────
# Oracle name mapping (from ψ/mission/people-fleet.md)
# ──────────────────────────────────────────────
ORACLE_MAP = {
    "nazt_": "nazt",
    "Tonk Oracle": "tonk",
    "Leica": "leica",
    "SomBo": "sombo",
    "เมฆ": "singhasingha",
    "ชายกลาง": "chaiklang",
    "Vialumen": "vialumen",
    "Weizen": "weizen",
    "Nova": "nova",
    "bongbaeng-Oracle": "bongbaeng",
    "Orz Oracle": "orz",
    "Atom": "atom",
    "Tinky": "tinky",
    "me": "vessel",   # bot's own messages
}

# ──────────────────────────────────────────────
# Classification keywords
# ──────────────────────────────────────────────
BUCKET_KEYWORDS = {
    "curriculum": ["เรียน", "สอน", "workshop", "exercise", "โจทย์", "quiz", "lesson", "skill"],
    "peer-wisdom": ["เคล็ดลับ", "วิธี", "แก้", "ลอง", "พบว่า", "trap", "gotcha", "fix", "solution"],
    "fleet-news": ["เกิด", "merge", "PR", "release", "ship", "deploy", "born", "awaken", "launch"],
}

# Sensitive patterns — don't index content if matched
SENSITIVE_PATTERNS = [
    r"ghp_[A-Za-z0-9]{36}",
    r"sk-[A-Za-z0-9]{48}",
    r"DISCORD_TOKEN\s*[:=]\s*\S+",
    r"password\s*[:=]\s*\S+",
    r"secret\s*[:=]\s*\S+",
]


def tokenize_thai(text: str) -> str:
    """Insert ZWSP at Thai word boundaries for FTS5 tokenization."""
    if not THAI_AVAILABLE:
        return text
    thai_pattern = re.compile(r"[\u0e00-\u0e7f]+")
    parts = thai_pattern.split(text)
    matches = thai_pattern.findall(text)
    result = []
    for i, part in enumerate(parts):
        result.append(part)
        if i < len(matches):
            words = word_tokenize(matches[i], engine="newmm")
            result.append(ZWSP.join(words))
    return "".join(result)


def is_sensitive(text: str) -> bool:
    """Return True if text contains sensitive patterns."""
    for pattern in SENSITIVE_PATTERNS:
        if re.search(pattern, text, re.I):
            return True
    return False


def classify_message(content: str) -> str:
    """Auto-classify message into Vessel's memory buckets."""
    for bucket, keywords in BUCKET_KEYWORDS.items():
        if any(k.lower() in content.lower() for k in keywords):
            return bucket
    return "chatter"


def tag_oracle(username: str):
    """Map username to oracle name."""
    return ORACLE_MAP.get(username)


def snowflake_to_ts(snowflake_id: str) -> float:
    """Parse Discord snowflake ID to Unix timestamp."""
    DISCORD_EPOCH = 1420070400000
    return ((int(snowflake_id) >> 22) + DISCORD_EPOCH) / 1000.0


class MirrorDB:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                channel_name TEXT,
                user_id TEXT,
                username TEXT,
                oracle_name TEXT,
                content TEXT,
                content_indexed TEXT,
                ts REAL,
                bucket TEXT DEFAULT 'chatter',
                attachment_count INTEGER DEFAULT 0,
                is_sensitive INTEGER DEFAULT 0,
                indexed_at REAL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content_indexed,
                username,
                oracle_name,
                bucket,
                content='messages',
                content_rowid='rowid',
                tokenize='unicode61'
            );

            CREATE TABLE IF NOT EXISTS attachments (
                id TEXT PRIMARY KEY,
                message_id TEXT REFERENCES messages(id),
                filename TEXT,
                mimetype TEXT,
                size INTEGER,
                local_path TEXT,
                content_text TEXT
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                channel_id TEXT PRIMARY KEY,
                channel_name TEXT,
                last_message_id TEXT,
                last_message_ts REAL,
                backfill_complete INTEGER DEFAULT 0,
                message_count INTEGER DEFAULT 0,
                last_sync REAL
            );

            CREATE TABLE IF NOT EXISTS message_vectors (
                message_id TEXT PRIMARY KEY REFERENCES messages(id),
                embedding_json TEXT,
                model TEXT,
                backend TEXT,
                updated_at REAL
            );

            CREATE TRIGGER IF NOT EXISTS messages_ai
            AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content_indexed, username, oracle_name, bucket)
                VALUES (new.rowid, new.content_indexed, new.username, new.oracle_name, new.bucket);
            END;

            CREATE TRIGGER IF NOT EXISTS messages_ad
            AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content_indexed, username, oracle_name, bucket)
                VALUES ('delete', old.rowid, old.content_indexed, old.username, old.oracle_name, old.bucket);
            END;
        """)
        self.conn.commit()

    def upsert_message(self, msg: dict, channel_id: str, channel_name: str = "") -> bool:
        """Insert or skip a Discord message. Returns True if new."""
        msg_id = msg.get("id", "")
        if not msg_id:
            return False

        # Check if already exists
        existing = self.conn.execute(
            "SELECT id FROM messages WHERE id = ?", (msg_id,)
        ).fetchone()
        if existing:
            return False

        content = msg.get("content", "") or ""
        username = msg.get("author", {}).get("username", "") if isinstance(msg.get("author"), dict) else ""
        user_id = msg.get("author", {}).get("id", "") if isinstance(msg.get("author"), dict) else ""

        sensitive = is_sensitive(content)
        content_indexed = "" if sensitive else tokenize_thai(content)
        oracle = tag_oracle(username)
        bucket = classify_message(content)
        ts = snowflake_to_ts(msg_id) if msg_id.isdigit() else float(msg.get("timestamp", 0) or 0)
        att_count = len(msg.get("attachments", []) or [])

        self.conn.execute("""
            INSERT OR IGNORE INTO messages
            (id, channel_id, channel_name, user_id, username, oracle_name,
             content, content_indexed, ts, bucket, attachment_count, is_sensitive, indexed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (msg_id, channel_id, channel_name, user_id, username, oracle,
              content, content_indexed, ts, bucket, att_count,
              1 if sensitive else 0, datetime.now().timestamp()))

        # Populate attachments table
        for att in (msg.get("attachments") or []):
            att_id = att.get("id") or att.get("filename", "")
            if not att_id:
                continue
            self.conn.execute("""
                INSERT OR IGNORE INTO attachments (id, message_id, filename, mimetype, size)
                VALUES (?,?,?,?,?)
            """, (att_id, msg_id,
                  att.get("filename") or att.get("name", ""),
                  att.get("content_type") or att.get("mimetype", ""),
                  att.get("size", 0)))

        self.conn.commit()
        return True

    def update_sync_state(self, channel_id: str, channel_name: str,
                          last_msg_id: str, count: int, complete: bool = False):
        ts = snowflake_to_ts(last_msg_id) if last_msg_id.isdigit() else 0
        self.conn.execute("""
            INSERT OR REPLACE INTO sync_state
            (channel_id, channel_name, last_message_id, last_message_ts,
             backfill_complete, message_count, last_sync)
            VALUES (?,?,?,?,?,?,?)
        """, (channel_id, channel_name, last_msg_id, ts,
              1 if complete else 0, count, datetime.now().timestamp()))
        self.conn.commit()

    def search(self, query: str, oracle: str = None,
               bucket: str = None, limit: int = 20) -> list:
        """Hybrid-ready search: FTS5 exact match + optional filters."""
        tokenized_query = tokenize_thai(query)
        sql = """
            SELECT m.id, m.channel_name, m.username, m.oracle_name,
                   m.content, m.bucket, m.ts, rank
            FROM messages m
            JOIN messages_fts ON messages_fts.rowid = m.rowid
            WHERE messages_fts MATCH ?
        """
        params = [tokenized_query]
        if oracle:
            sql += " AND m.oracle_name = ?"
            params.append(oracle)
        if bucket:
            sql += " AND m.bucket = ?"
            params.append(bucket)
        sql += f" ORDER BY rank LIMIT {limit}"
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def parity_check(self, channel_id: str, mirror_count: int) -> dict:
        """Verify DB count matches mirror count."""
        db_count = self.conn.execute(
            "SELECT COUNT(*) FROM messages WHERE channel_id = ?", (channel_id,)
        ).fetchone()[0]
        return {
            "channel_id": channel_id,
            "mirror_count": mirror_count,
            "db_count": db_count,
            "ok": db_count == mirror_count,
            "diff": mirror_count - db_count,
        }

    def stats(self) -> dict:
        """Summary statistics."""
        total = self.conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        by_bucket = dict(self.conn.execute(
            "SELECT bucket, COUNT(*) FROM messages GROUP BY bucket"
        ).fetchall())
        by_channel = dict(self.conn.execute(
            "SELECT channel_name, COUNT(*) FROM messages GROUP BY channel_name ORDER BY COUNT(*) DESC LIMIT 5"
        ).fetchall())
        channels_done = self.conn.execute(
            "SELECT COUNT(*) FROM sync_state WHERE backfill_complete = 1"
        ).fetchone()[0]
        return {
            "total_messages": total,
            "by_bucket": by_bucket,
            "top_channels": by_channel,
            "channels_backfilled": channels_done,
        }

    def close(self):
        self.conn.close()
