// db.ts — SQLite schema + open. Mirror-first: JSON on disk is source of truth,
// this DB is the *derived* index (rebuildable). Design v2 (ChaiKlang) — builds on
// Kikyo's mirror+parity base and adds: edit-history (Nothing is Deleted), per-channel
// two-headed cursor (resumable incremental), and a `source` provenance column.
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL,
  position INTEGER, type INTEGER, raw_json TEXT
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, parent_room_id TEXT NOT NULL,
  name TEXT NOT NULL, state TEXT, raw_json TEXT
);

-- Current state of every message. content holds the latest version; edits + deletes
-- are NEVER destroyed — old versions live in edit_history, deletes set deleted_at.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  guild_id TEXT, room_id TEXT NOT NULL, thread_id TEXT, channel_id TEXT NOT NULL,
  author_id TEXT, author_name TEXT, author_is_bot INTEGER DEFAULT 0,
  content TEXT, timestamp TEXT,
  edited_at TEXT,                 -- last edit observed
  deleted_at TEXT,               -- tombstone (Nothing is Deleted)
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT,                    -- backfill | live | reconcile  (provenance)
  run_id TEXT,
  attachments_json TEXT, raw_json TEXT
);

-- Append-only history of every prior content version (Principle 1: Nothing is Deleted).
CREATE TABLE IF NOT EXISTS edit_history (
  message_id TEXT NOT NULL, version INTEGER NOT NULL,
  content TEXT, edited_at TEXT, observed_at TEXT NOT NULL,
  PRIMARY KEY (message_id, version)
);

-- Two-headed resumable cursor per channel: how far back we've backfilled and
-- how far forward we've ingested. Restart-safe (delta-only next run).
CREATE TABLE IF NOT EXISTS cursor (
  channel_id TEXT PRIMARY KEY,
  backfill_oldest_id TEXT,       -- oldest message id we have (walk further back from here)
  backfill_done INTEGER DEFAULT 0,
  live_newest_id TEXT,           -- newest id we have (fetch after= this next)
  last_swept_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_room_ts ON messages(room_id, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_msg_thread_ts ON messages(thread_id, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_msg_author ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_msg_deleted ON messages(deleted_at);
`;

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}
