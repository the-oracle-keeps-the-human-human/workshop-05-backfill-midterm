// sing-backfill — orchestrator. Pipeline (v3):
//   source (REST or fixture) → JSON mirror (durable truth) → SQLite (incremental upsert
//   via cursor, edit-versioned) → PARITY GATE → index. Frontend only builds if parity ok.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { openDb, upsertMessage, getCursor, setCursor, snowflakeTs } from "./db.ts";
import { normalize, restBackfill, fixtureSource, type RawMsg } from "./ingest.ts";
import { verifyParity } from "./parity.ts";
import { buildIndex } from "./search.ts";

export interface BackfillOpts {
  dbPath: string; mirrorDir: string;
  channelId: string; channelName: string;
  source: { kind: "fixture"; messages: RawMsg[] } | { kind: "rest"; token: string; limit?: number };
  log?: (s: string) => void;
}

export interface BackfillResult {
  fetched: number; inserted: number; edited: number; same: number;
  parity: ReturnType<typeof verifyParity>;
  indexed?: { messages: number; dims: number };
}

// merge new raw messages into the channel's mirror JSON (idempotent by id) — durable truth
function writeMirror(mirrorDir: string, channelId: string, channelName: string, incoming: RawMsg[]): RawMsg[] {
  const dir = join(mirrorDir, `${channelName.replace(/[^a-zA-Z0-9_-]/g, "_")}__${channelId}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "messages.json");
  const prev: RawMsg[] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  const byId = new Map<string, RawMsg>(prev.map(m => [String(m.id), m]));
  for (const m of incoming) byId.set(String(m.id), m); // newer wins (captures edits)
  const merged = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  writeFileSync(f, JSON.stringify(merged, null, 2) + "\n");
  writeFileSync(join(dir, "channel.json"), JSON.stringify({ id: channelId, name: channelName }, null, 2) + "\n");
  return merged;
}

export async function backfill(opts: BackfillOpts): Promise<BackfillResult> {
  const log = opts.log || (() => {});
  const db = openDb(opts.dbPath);
  const cursor = getCursor(db, opts.channelId);

  // 1. fetch from source (incremental: REST uses after=live_newest_id for delta)
  let raw: RawMsg[];
  if (opts.source.kind === "fixture") {
    raw = fixtureSource(opts.source.messages);
  } else {
    raw = await restBackfill(opts.source.token, opts.channelId, {
      limit: opts.source.limit,
      after: cursor.backfill_done ? cursor.live_newest_id : undefined, // delta after first full pass
    });
  }
  log(`fetched ${raw.length} messages`);

  // 2. mirror JSON (durable source of truth) — merged, idempotent
  const merged = writeMirror(opts.mirrorDir, opts.channelId, opts.channelName, raw);

  // 3. SQLite upsert (incremental, edit-versioned — NOT clearDb)
  db.query("INSERT OR IGNORE INTO channels (id, name) VALUES (?,?)").run(opts.channelId, opts.channelName);
  let inserted = 0, edited = 0, same = 0;
  db.transaction(() => {
    for (const r of raw) {
      const res = upsertMessage(db, normalize(r, opts.channelId, opts.channelName, opts.source.kind === "rest" ? "backfill" : "live"));
      if (res === "insert") inserted++; else if (res === "edit") edited++; else same++;
    }
  })();
  log(`db: +${inserted} new, ${edited} edited, ${same} unchanged`);

  // 4. advance cursor (incremental watermarks)
  if (merged.length) {
    const ids = merged.map(m => String(m.id)).sort();
    setCursor(db, {
      channel_id: opts.channelId,
      backfill_oldest_id: ids[0],
      backfill_done: 1,
      live_newest_id: ids[ids.length - 1],
      last_swept_at: new Date().toISOString(),
    });
  }
  db.close();

  // 5. PARITY GATE — verify DB == mirror before any downstream (Kikyo's idea, exact id-set)
  const parity = verifyParity(opts.dbPath, opts.mirrorDir);
  log(`parity: mirror=${parity.mirrorCount} db=${parity.dbCount} missing=${parity.missingInDb.length} extra=${parity.extraInDb.length} → ${parity.ok ? "✓ PASS" : "✗ FAIL"}`);
  if (!parity.ok) {
    log("✗ refusing to index — parity failed (verify, don't claim)");
    return { fetched: raw.length, inserted, edited, same, parity };
  }

  // 6. index (FTS5 + vectors) — only after parity passes
  const indexed = buildIndex(opts.dbPath);
  log(`indexed: ${indexed.messages} messages (${indexed.dims}-dim vectors)`);
  return { fetched: raw.length, inserted, edited, same, parity, indexed };
}
