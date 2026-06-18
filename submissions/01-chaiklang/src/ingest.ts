// ingest.ts — incremental, edit-aware ingestion (Design v2).
//
// Improvements over a full-rebuild mirror importer:
//  - incremental upsert (no clear-and-reimport) → scales to millions
//  - edit  → keep prior version in edit_history + bump version (Nothing is Deleted)
//  - delete→ tombstone (deleted_at), never DROP the row
//  - two-headed cursor per channel (resumable backfill + live)
//  - delta parity: verify only the ids touched this run, not the whole DB
import type { Database } from "bun:sqlite";

export type RawMsg = {
  id: string; content?: string; timestamp?: string; edited_timestamp?: string | null;
  author?: { id?: string; username?: string; global_name?: string; bot?: boolean };
  attachments?: any[]; [k: string]: any;
};
export type Channel = {
  id: string; name: string; kind: "room" | "thread"; parent_id?: string;
  position?: number; type?: number; state?: string; messages: RawMsg[];
};
export type Snapshot = { guild: { id: string; name: string }; channels: Channel[] };
export type Source = "backfill" | "live" | "reconcile";

const authorName = (m: RawMsg) =>
  m.author?.global_name || m.author?.username || (m.author?.id ? `user:${m.author.id}` : "unknown");
const big = (id?: string) => { try { return BigInt(id || "0"); } catch { return 0n; } };
const newer = (a?: string, b?: string) => !b ? !!a : !a ? false : big(a) > big(b);
const older = (a?: string, b?: string) => !b ? !!a : !a ? false : big(a) < big(b);

export type IngestStats = { inserted: number; edited: number; unchanged: number; deleted: number };

// Upsert one channel's messages. If `fullSnapshot`, ids present in DB for this channel but
// absent from `msgs` are tombstoned (a complete re-fetch reveals deletions).
export function ingestChannel(
  db: Database, guildId: string, ch: Channel, msgs: RawMsg[],
  opts: { source: Source; runId: string; fullSnapshot?: boolean }
): IngestStats {
  const roomId = ch.kind === "thread" ? (ch.parent_id || ch.id) : ch.id;
  const threadId = ch.kind === "thread" ? ch.id : null;
  const channelId = ch.id;
  const now = new Date().toISOString();
  const st: IngestStats = { inserted: 0, edited: 0, unchanged: 0, deleted: 0 };

  const getRow = db.prepare("SELECT id, content, version, deleted_at FROM messages WHERE id = ?");
  const insMsg = db.prepare(`INSERT INTO messages
    (id,guild_id,room_id,thread_id,channel_id,author_id,author_name,author_is_bot,content,timestamp,edited_at,deleted_at,version,source,run_id,attachments_json,raw_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?,?,?)`);
  const updMsg = db.prepare(`UPDATE messages SET content=?, edited_at=?, version=?, source=?, run_id=?, raw_json=?, deleted_at=NULL WHERE id=?`);
  const insHist = db.prepare(`INSERT OR IGNORE INTO edit_history (message_id,version,content,edited_at,observed_at) VALUES (?,?,?,?,?)`);
  const tomb = db.prepare(`UPDATE messages SET deleted_at=? WHERE id=? AND deleted_at IS NULL`);

  const tx = db.transaction(() => {
    let oldest: string | undefined, newest: string | undefined;
    const present = new Set<string>();
    for (const m of msgs) {
      present.add(m.id);
      if (older(m.id, oldest) || !oldest) oldest = m.id;
      if (newer(m.id, newest) || !newest) newest = m.id;
      const content = m.content ?? "";
      const prev = getRow.get(m.id) as any;
      if (!prev) {
        insMsg.run(m.id, guildId, roomId, threadId, channelId, m.author?.id ?? null,
          authorName(m), m.author?.bot ? 1 : 0, content, m.timestamp ?? null,
          m.edited_timestamp ?? null, opts.source, opts.runId,
          JSON.stringify(m.attachments ?? []), JSON.stringify(m));
        st.inserted++;
      } else if ((prev.content ?? "") !== content) {
        // archive the version we had, then advance — original is never lost
        insHist.run(m.id, prev.version, prev.content ?? "", m.edited_timestamp ?? null, now);
        updMsg.run(content, m.edited_timestamp ?? now, prev.version + 1, opts.source, opts.runId, JSON.stringify(m), m.id);
        st.edited++;
      } else {
        st.unchanged++;
      }
    }
    if (opts.fullSnapshot) {
      const dbIds = db.query("SELECT id FROM messages WHERE channel_id=? AND deleted_at IS NULL").all(channelId) as any[];
      for (const r of dbIds) if (!present.has(r.id)) { tomb.run(now, r.id); st.deleted++; }
    }
    upsertChannelMeta(db, guildId, ch, roomId, threadId);
    updateCursor(db, channelId, oldest, newest);
  });
  tx();
  return st;
}

function upsertChannelMeta(db: Database, guildId: string, ch: Channel, roomId: string, threadId: string | null) {
  db.prepare("INSERT OR REPLACE INTO guilds (id,name,raw_json) VALUES (?,?,?)").run(guildId, guildId, "{}");
  if (threadId) {
    db.prepare("INSERT OR IGNORE INTO rooms (id,guild_id,name,position,type,raw_json) VALUES (?,?,?,?,?,?)")
      .run(roomId, guildId, ch.parent_id ? `room:${ch.parent_id}` : roomId, ch.position ?? null, ch.type ?? null, "{}");
    db.prepare("INSERT OR REPLACE INTO threads (id,guild_id,parent_room_id,name,state,raw_json) VALUES (?,?,?,?,?,?)")
      .run(threadId, guildId, roomId, ch.name, ch.state ?? "active", "{}");
  } else {
    db.prepare("INSERT OR REPLACE INTO rooms (id,guild_id,name,position,type,raw_json) VALUES (?,?,?,?,?,?)")
      .run(roomId, guildId, ch.name, ch.position ?? null, ch.type ?? null, "{}");
  }
}

// Two-headed cursor: only ever extend outward (oldest down, newest up).
export function updateCursor(db: Database, channelId: string, oldest?: string, newest?: string) {
  const cur = db.prepare("SELECT * FROM cursor WHERE channel_id=?").get(channelId) as any;
  const now = new Date().toISOString();
  if (!cur) {
    db.prepare("INSERT INTO cursor (channel_id,backfill_oldest_id,backfill_done,live_newest_id,last_swept_at) VALUES (?,?,0,?,?)")
      .run(channelId, oldest ?? null, newest ?? null, now);
    return;
  }
  const o = older(oldest, cur.backfill_oldest_id) ? oldest : cur.backfill_oldest_id;
  const n = newer(newest, cur.live_newest_id) ? newest : cur.live_newest_id;
  db.prepare("UPDATE cursor SET backfill_oldest_id=?, live_newest_id=?, last_swept_at=? WHERE channel_id=?")
    .run(o ?? null, n ?? null, now, channelId);
}

export function ingestSnapshot(db: Database, snap: Snapshot, opts: { source: Source; runId: string; fullSnapshot?: boolean }) {
  const totals: IngestStats = { inserted: 0, edited: 0, unchanged: 0, deleted: 0 };
  for (const ch of snap.channels) {
    const s = ingestChannel(db, snap.guild.id, ch, ch.messages, opts);
    totals.inserted += s.inserted; totals.edited += s.edited; totals.unchanged += s.unchanged; totals.deleted += s.deleted;
  }
  return totals;
}

// Incremental parity: verify ONLY the ids this run touched, per channel — not a full-DB
// rebuild compare. Live (non-deleted) ids in DB must cover every id we just ingested.
export type Parity = { ok: boolean; channelId: string; expected: number; present: number; missing: string[] };
export function deltaParity(db: Database, ch: Channel): Parity {
  const expectedIds = ch.messages.map((m) => m.id);
  const rows = db.query("SELECT id FROM messages WHERE channel_id=? AND deleted_at IS NULL").all(ch.id) as any[];
  const have = new Set(rows.map((r) => String(r.id)));
  const missing = expectedIds.filter((id) => !have.has(id));
  return { ok: missing.length === 0, channelId: ch.id, expected: expectedIds.length, present: expectedIds.length - missing.length, missing };
}
