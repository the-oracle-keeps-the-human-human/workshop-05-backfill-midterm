/**
 * run-backfill.ts — backfill จริง #free-for-all ผ่าน versioned store (Nothing Deleted)
 *   bun run-backfill.ts            # backfill (before-cursor) + reconcile tombstone + demo
 * token จาก .env (DISCORD_BOT_TOKEN) — Rule 6: ไม่แปะ public
 * — Tonk Oracle 🌿 · AI · ไม่ใช่คน
 */
import { Database } from "bun:sqlite";
import { initSchema, upsertMessage, tombstoneMessage, search, history, type MsgInput } from "./src/store.ts";

const API = "https://discord.com/api/v10";
const CH = process.env.CHANNEL_ID ?? "1512079809021214730"; // #free-for-all (พี่นัทยืนยัน: ไม่มี private data)
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) throw new Error("ต้องตั้ง DISCORD_BOT_TOKEN ใน .env");

interface DMsg {
  id: string; content: string; timestamp: string; edited_timestamp: string | null;
  author: { id: string; username: string; bot?: boolean }; attachments: { id: string }[];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": "tonk-indexer/0.2" } });
  if (!res.ok) throw new Error(`Discord ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

// backfill ย้อนหลัง: before-cursor ไล่จากใหม่→เก่า จนสุดห้อง
async function backfill(db: Database): Promise<{ ingested: string[]; create: number; edit: number; noop: number }> {
  let before: string | undefined;
  const ingested: string[] = [];
  const tally = { create: 0, edit: 0, noop: 0 };
  while (true) {
    const q = new URLSearchParams({ limit: "100" });
    if (before) q.set("before", before);
    const batch = await api<DMsg[]>(`/channels/${CH}/messages?${q}`);
    if (!batch.length) break;
    for (const m of batch) {
      const input: MsgInput = {
        id: m.id, channelId: CH, ds: "FreeForAll", authorId: m.author.id, author: m.author.username,
        bot: !!m.author.bot, content: m.content ?? "", ts: m.timestamp, editedTs: m.edited_timestamp, attachments: m.attachments?.length ?? 0,
      };
      const r = upsertMessage(db, input);
      if (r.op === "create") tally.create++; else if (r.op === "edit") tally.edit++; else tally.noop++;
      ingested.push(m.id);
    }
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
    await sleep(350); // rate-limit
  }
  return { ingested, ...tally };
}

// reconcile tombstone: id ที่เคยเก็บแต่ไม่อยู่ใน backfill รอบนี้ = ถูกลบใน Discord → tombstone (ไม่ลบจริง)
function reconcileTombstones(db: Database, seen: Set<string>): number {
  const known = db.query(`SELECT id FROM messages WHERE deleted=0`).all() as { id: string }[];
  let n = 0;
  for (const { id } of known) if (!seen.has(id)) { tombstoneMessage(db, id); n++; }
  return n;
}

// ── run ──
const db = new Database("index.db");
initSchema(db);

console.log(`🌿 tonk-indexer backfill — #free-for-all (${CH})\n`);
const t0 = Date.now();
const res = await backfill(db);
const dt = ((Date.now() - t0) / 1000).toFixed(1);
const tomb = reconcileTombstones(db, new Set(res.ingested));

const total = (db.query(`SELECT COUNT(*) n FROM messages`).get() as { n: number }).n;
const live = (db.query(`SELECT COUNT(*) n FROM messages WHERE deleted=0`).get() as { n: number }).n;
const versions = (db.query(`SELECT COUNT(*) n FROM message_versions`).get() as { n: number }).n;
const edited = (db.query(`SELECT COUNT(*) n FROM messages WHERE version>1 AND deleted=0`).get() as { n: number }).n;

console.log(`✓ backfilled in ${dt}s`);
console.log(`   create +${res.create} · edit +${res.edit} · noop ${res.noop} · tombstone ${tomb}`);
console.log(`📊 store: ${total} messages (${live} live / ${total - live} tombstoned) · ${versions} versions · ${edited} edited`);

// demo search (FTS5)
const demoKw = process.env.Q ?? "backfill";
const hits = search(db, demoKw, 5);
console.log(`\n🔍 FTS5 search "${demoKw}" → ${hits.length} hit(s):`);
for (const h of hits) console.log(`   ${h.ts.slice(0, 16)}  ${h.author}: ${h.content.slice(0, 64).replace(/\n/g, " ")}`);

// demo: หา message ที่ถูกแก้ (version>1) → โชว์ประวัติครบ (Nothing Deleted บนข้อมูลจริง)
const editedRow = db.query(`SELECT id FROM messages WHERE version>1 ORDER BY last_changed DESC LIMIT 1`).get() as { id: string } | null;
if (editedRow) {
  console.log(`\n🕓 edit history (Nothing Deleted) — message ${editedRow.id}:`);
  for (const h of history(db, editedRow.id)) console.log(`   v${h.version} [${h.op}] ${(h.content ?? "(deleted)").slice(0, 56).replace(/\n/g, " ")}`);
} else {
  console.log(`\n🕓 ยังไม่เจอ message ที่ถูกแก้ในรอบนี้ (versioning พร้อม จับ edit ทันทีที่มีคนแก้)`);
}
db.close();
