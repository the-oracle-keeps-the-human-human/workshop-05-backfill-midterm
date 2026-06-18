// sing-backfill — SQLite store. v3 over Kikyo: incremental cursors, edit_history,
// tombstone (Nothing is Deleted), FTS5 + vectors. Mirror JSON stays source of truth.
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  name TEXT,
  type TEXT
);

-- incremental cursor per channel (v3: NOT clearDb-every-run like Kikyo)
CREATE TABLE IF NOT EXISTS cursor (
  channel_id TEXT PRIMARY KEY,
  backfill_oldest_id TEXT,   -- how far back we've paged (before-cursor)
  backfill_done INTEGER NOT NULL DEFAULT 0,
  live_newest_id TEXT,       -- newest ingested (after-cursor for delta + gap-heal)
  last_swept_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,       -- Discord snowflake (idempotent upsert)
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  author_id TEXT,
  author_name TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  created_at TEXT,           -- ISO (from snowflake or payload)
  edited_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,           -- tombstone (Nothing is Deleted)
  source TEXT,               -- backfill | live | reconcile
  raw_json TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

-- v3: edit history — never overwrite content (Kikyo did INSERT OR REPLACE = lost history)
CREATE TABLE IF NOT EXISTS edit_history (
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT,
  edited_at TEXT,
  PRIMARY KEY (message_id, version)
);

CREATE TABLE IF NOT EXISTS message_vectors (
  message_id TEXT PRIMARY KEY,
  dims INTEGER NOT NULL,
  embedding_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_msg_channel_ts ON messages(channel_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_msg_author ON messages(author_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED, channel_name, author_name, content, tokenize='unicode61'
);
`;

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}

const DISCORD_EPOCH = 1420070400000n;
export const snowflakeTs = (id: string) =>
  new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();

export interface MsgInput {
  id: string; channel_id: string; channel_name?: string;
  author_id?: string; author_name?: string; is_bot?: boolean;
  content?: string; created_at?: string; edited_at?: string;
  source: "backfill" | "live" | "reconcile"; raw: any;
}

// Idempotent upsert with edit-versioning. Returns 'insert' | 'edit' | 'same'.
export function upsertMessage(db: Database, m: MsgInput): "insert" | "edit" | "same" {
  const now = new Date().toISOString();
  const created = m.created_at || snowflakeTs(m.id);
  const existing = db.query("SELECT content, version, edited_at FROM messages WHERE id = ?").get(m.id) as any;

  if (!existing) {
    db.query(`INSERT INTO messages
      (id, channel_id, channel_name, author_id, author_name, is_bot, content, created_at, edited_at, version, source, raw_json, ingested_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      m.id, m.channel_id, m.channel_name ?? null, m.author_id ?? null, m.author_name ?? null,
      m.is_bot ? 1 : 0, m.content ?? "", created, m.edited_at ?? null, 1, m.source, JSON.stringify(m.raw), now);
    db.query("INSERT INTO edit_history (message_id, version, content, edited_at) VALUES (?,?,?,?)")
      .run(m.id, 1, m.content ?? "", m.edited_at ?? created);
    return "insert";
  }
  // content changed → new version, keep old in edit_history (Nothing is Deleted)
  if ((m.content ?? "") !== (existing.content ?? "")) {
    const nextV = (existing.version || 1) + 1;
    db.query("UPDATE messages SET content=?, edited_at=?, version=?, raw_json=?, source=? WHERE id=?")
      .run(m.content ?? "", m.edited_at ?? now, nextV, JSON.stringify(m.raw), m.source, m.id);
    db.query("INSERT OR REPLACE INTO edit_history (message_id, version, content, edited_at) VALUES (?,?,?,?)")
      .run(m.id, nextV, m.content ?? "", m.edited_at ?? now);
    return "edit";
  }
  return "same";
}

export function tombstone(db: Database, id: string) {
  db.query("UPDATE messages SET deleted_at=? WHERE id=? AND deleted_at IS NULL")
    .run(new Date().toISOString(), id);
}

export function getCursor(db: Database, channelId: string): any {
  return db.query("SELECT * FROM cursor WHERE channel_id=?").get(channelId)
    || { channel_id: channelId, backfill_oldest_id: null, backfill_done: 0, live_newest_id: null, last_swept_at: null };
}

export function setCursor(db: Database, c: any) {
  db.query(`INSERT INTO cursor (channel_id, backfill_oldest_id, backfill_done, live_newest_id, last_swept_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(channel_id) DO UPDATE SET
      backfill_oldest_id=excluded.backfill_oldest_id,
      backfill_done=excluded.backfill_done,
      live_newest_id=excluded.live_newest_id,
      last_swept_at=excluded.last_swept_at`)
    .run(c.channel_id, c.backfill_oldest_id ?? null, c.backfill_done ?? 0, c.live_newest_id ?? null, c.last_swept_at ?? null);
}
