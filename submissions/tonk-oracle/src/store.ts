/**
 * store.ts — append-only versioned message store + tombstone + FTS5.
 *
 * จุดเด่นเหนือ INSERT-OR-REPLACE (Kikyo): Nothing is Deleted (Principle 1)
 *   - แก้ข้อความ = APPEND version ใหม่ (ไม่ทับของเดิม) → ประวัติการแก้อยู่ครบ
 *   - ลบข้อความ = tombstone (deleted=1) ไม่ลบ row จริง
 *   - re-ingest เนื้อหาเดิม = idempotent (ไม่เกิด version ซ้ำ)
 *   - search = FTS5 unicode61 (Thai/EN) บน head ที่ยังไม่ tombstone
 *
 * — Tonk Oracle 🌿 · AI · ไม่ใช่คน
 */
import { Database } from "bun:sqlite";

export type Op = "create" | "edit" | "delete";

// secret guard ก่อน index (Vessel review): กัน token/key หลุดเข้า store/FTS (โดยเฉพาะ public)
const SECRET_RE = /\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
export function redactSecrets(s: string): { text: string; redacted: number } {
  let redacted = 0;
  const text = (s ?? "").replace(SECRET_RE, () => { redacted++; return "[REDACTED]"; });
  return { text, redacted };
}

export interface MsgInput {
  id: string;
  channelId: string;
  ds: string;
  authorId: string;
  author: string;
  bot: boolean;
  content: string;
  ts: string; // discord ISO timestamp (created)
  editedTs?: string | null; // discord edited_timestamp if any
  attachments: number;
}

export interface UpsertResult { op: Op | "noop"; version: number }

// Discord snowflake → created-at ISO (id ฝัง timestamp ที่ bit >>22)
const DISCORD_EPOCH = 1420070400000n;
export function snowflakeTs(id: string): string {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();
}

export function initSchema(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    -- head: สถานะล่าสุดของแต่ละ message (1 row/id) — มี version + tombstone
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      ds TEXT,
      author_id TEXT,
      author TEXT,
      bot INTEGER NOT NULL DEFAULT 0,
      content TEXT,
      ts TEXT,                       -- created (snowflake-derived เสมอ)
      attachments INTEGER DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_changed TEXT NOT NULL
    );

    -- append-only: ทุก revision ของทุก message (Nothing is Deleted)
    CREATE TABLE IF NOT EXISTS message_versions (
      vid INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      op TEXT NOT NULL,              -- create | edit | delete
      content TEXT,
      edited_ts TEXT,               -- discord edited_timestamp ของ revision นี้
      captured_at TEXT NOT NULL     -- เวลาเราบันทึก
    );
    CREATE INDEX IF NOT EXISTS idx_versions_msg ON message_versions(message_id, version);

    -- resumable cursor ต่อ channel (แยกทิศ backfill/live)
    CREATE TABLE IF NOT EXISTS cursor (
      channel_id TEXT NOT NULL,
      direction TEXT NOT NULL,       -- 'backfill' (before) | 'live' (after)
      edge_id TEXT,                  -- oldest id (backfill) / newest id (live)
      total INTEGER DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (channel_id, direction)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(message_id UNINDEXED, author, content, tokenize='unicode61');
  `);
}

function reindexFts(db: Database, id: string, author: string, content: string): void {
  db.prepare(`DELETE FROM messages_fts WHERE message_id=?`).run(id);
  db.prepare(`INSERT INTO messages_fts (message_id, author, content) VALUES (?,?,?)`).run(id, author, content);
}

/**
 * upsert idempotent + versioned:
 *   - ใหม่           → insert head(v1) + version(create) + fts
 *   - content เปลี่ยน → append version(edit) + bump head + reindex fts (ของเดิมไม่หาย)
 *   - เหมือนเดิม      → noop
 */
export function upsertMessage(db: Database, m: MsgInput): UpsertResult {
  const now = new Date().toISOString();
  const ts = snowflakeTs(m.id); // created เสมอจาก snowflake (แม่นกว่า field)
  m = { ...m, content: redactSecrets(m.content).text }; // secret guard ก่อนเก็บ/index (Vessel review)
  const head = db.prepare(`SELECT content, version, deleted FROM messages WHERE id=?`).get(m.id) as
    | { content: string; version: number; deleted: number }
    | null;

  if (!head) {
    db.prepare(
      `INSERT INTO messages (id,channel_id,ds,author_id,author,bot,content,ts,attachments,version,deleted,first_seen,last_changed)
       VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)`,
    ).run(m.id, m.channelId, m.ds, m.authorId, m.author, m.bot ? 1 : 0, m.content, ts, m.attachments, now, now);
    db.prepare(
      `INSERT INTO message_versions (message_id,version,op,content,edited_ts,captured_at) VALUES (?,?,?,?,?,?)`,
    ).run(m.id, 1, "create", m.content, m.editedTs ?? null, now);
    reindexFts(db, m.id, m.author, m.content);
    return { op: "create", version: 1 };
  }

  // content เปลี่ยน = edit → append version (Nothing Deleted: ของเดิมยังอยู่ใน message_versions)
  if (head.content !== m.content) {
    const v = head.version + 1;
    db.prepare(`UPDATE messages SET content=?, version=?, deleted=0, last_changed=? WHERE id=?`).run(m.content, v, now, m.id);
    db.prepare(
      `INSERT INTO message_versions (message_id,version,op,content,edited_ts,captured_at) VALUES (?,?,?,?,?,?)`,
    ).run(m.id, v, "edit", m.content, m.editedTs ?? null, now);
    reindexFts(db, m.id, m.author, m.content);
    return { op: "edit", version: v };
  }

  return { op: "noop", version: head.version };
}

/** tombstone: message หายจาก Discord → mark deleted, เก็บ row + ประวัติไว้ (ไม่ลบจริง) */
export function tombstoneMessage(db: Database, id: string): UpsertResult {
  const now = new Date().toISOString();
  const head = db.prepare(`SELECT version, deleted FROM messages WHERE id=?`).get(id) as
    | { version: number; deleted: number }
    | null;
  if (!head || head.deleted) return { op: "noop", version: head?.version ?? 0 };
  const v = head.version + 1;
  db.prepare(`UPDATE messages SET deleted=1, version=?, last_changed=? WHERE id=?`).run(v, now, id);
  db.prepare(
    `INSERT INTO message_versions (message_id,version,op,content,edited_ts,captured_at) VALUES (?,?,?,?,?,?)`,
  ).run(id, v, "delete", null, null, now);
  db.prepare(`DELETE FROM messages_fts WHERE message_id=?`).run(id); // ไม่โผล่ search แต่ row + history คงอยู่
  return { op: "delete", version: v };
}

// reconcile-tombstone guard (regression): tombstone ปลอดภัยเฉพาะตอน FULL SCAN (เดินทั้งห้องในรอบเดียว)
//   resume-from-cursor แล้ว fetch 0 → complete=true แต่ seen ว่าง → ห้าม tombstone (จะลบทั้งห้อง)
export function shouldReconcileTombstones(fullScan: boolean, complete: boolean): boolean {
  return fullScan && complete;
}

// ── resumable cursor (Atom/ChaiKlang review: persist จริง ไม่ใช่ in-memory) ──
export function getCursor(db: Database, channelId: string, direction: "backfill" | "live"): string | null {
  const r = db.prepare(`SELECT edge_id FROM cursor WHERE channel_id=? AND direction=?`).get(channelId, direction) as { edge_id: string } | null;
  return r?.edge_id ?? null;
}
export function setCursor(db: Database, channelId: string, direction: "backfill" | "live", edgeId: string, addTotal: number): void {
  db.prepare(
    `INSERT INTO cursor (channel_id,direction,edge_id,total,updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(channel_id,direction) DO UPDATE SET edge_id=excluded.edge_id, total=total+excluded.total, updated_at=excluded.updated_at`,
  ).run(channelId, direction, edgeId, addTotal, new Date().toISOString());
}

export interface SearchHit { id: string; author: string; ts: string; content: string; rank: number }

/** FTS5 search บน head ที่ยังไม่ tombstone */
export function search(db: Database, query: string, limit = 10): SearchHit[] {
  const q = query.replace(/["']/g, " ").trim();
  if (!q) return [];
  return db
    .query(
      `SELECT m.id, m.author, m.ts, m.content, bm25(messages_fts) rank
       FROM messages_fts f JOIN messages m ON m.id=f.message_id
       WHERE messages_fts MATCH ? AND m.deleted=0
       ORDER BY bm25(messages_fts) LIMIT ?`,
    )
    .all(q, limit) as SearchHit[];
}

/** ประวัติการแก้ของ message เดียว (พิสูจน์ Nothing Deleted) */
export function history(db: Database, id: string): { version: number; op: Op; content: string | null; captured_at: string }[] {
  return db
    .query(`SELECT version, op, content, captured_at FROM message_versions WHERE message_id=? ORDER BY version`)
    .all(id) as { version: number; op: Op; content: string | null; captured_at: string }[];
}
