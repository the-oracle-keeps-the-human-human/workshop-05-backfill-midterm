"""SQLite source-of-truth + FTS5 index. Zero external deps."""
from __future__ import annotations
import sqlite3
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- channels / threads metadata (kind: room|thread, state: active|archived)
CREATE TABLE IF NOT EXISTS channels (
  id        TEXT PRIMARY KEY,
  name      TEXT,
  type      TEXT,
  parent_id TEXT,
  kind      TEXT,
  state     TEXT,
  updated_at TEXT
);

-- messages: latest known state (current version). delete = tombstone, never row-removed.
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,        -- snowflake
  channel_id    TEXT NOT NULL,
  thread_id     TEXT,
  author_id     TEXT,
  author_name   TEXT,
  content       TEXT,
  ts            TEXT,                    -- ISO8601 derived from snowflake
  edited_ts     TEXT,
  has_attachment INTEGER DEFAULT 0,
  attachments_json TEXT,
  reactions_json   TEXT,
  deleted       INTEGER DEFAULT 0,       -- tombstone flag (Nothing is Deleted)
  version       INTEGER DEFAULT 1,
  first_seen_at TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_msg_thread  ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_msg_author  ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_msg_ts      ON messages(ts);

-- append-only edit history: every content change captured as a new version
CREATE TABLE IF NOT EXISTS message_versions (
  id          TEXT,
  version     INTEGER,
  content     TEXT,
  edited_ts   TEXT,
  captured_at TEXT,
  PRIMARY KEY (id, version)
);

-- resume cursor per channel (idempotent restart)
CREATE TABLE IF NOT EXISTS checkpoints (
  channel_id TEXT PRIMARY KEY,
  newest_id  TEXT,        -- highest message id ingested  -> warm `after` cursor
  oldest_id  TEXT,        -- lowest id reached so far     -> cold `before` cursor
  cold_done  INTEGER DEFAULT 0,
  updated_at TEXT
);

-- append-only run log (audit trail of every sync)
CREATE TABLE IF NOT EXISTS run_log (
  run_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  mode       TEXT,        -- cold | warm
  channel_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  fetched    INTEGER DEFAULT 0,
  inserted   INTEGER DEFAULT 0,
  edits      INTEGER DEFAULT 0,
  deletes    INTEGER DEFAULT 0,
  stats_json TEXT
);

-- vector slots (backend-agnostic: stores message_id -> embedding blob/model).
CREATE TABLE IF NOT EXISTS message_vectors (
  id        TEXT PRIMARY KEY,
  dims      INTEGER,
  model     TEXT,
  backend   TEXT,
  embedding TEXT,         -- json float array (swap for blob/sqlite-vec later)
  updated_at TEXT
);

-- FTS5 lexical index (standalone, upserted alongside messages)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id UNINDEXED, channel_id UNINDEXED, author_name, content,
  tokenize = 'unicode61'
);
"""


def connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn
