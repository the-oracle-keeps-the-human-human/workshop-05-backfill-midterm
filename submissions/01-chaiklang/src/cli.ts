// cli.ts — maw-style entry. Standalone: `bun src/cli.ts <cmd>`.
//   ingest <snapshot.json> [--source=backfill|live|reconcile] [--full]
//   search <query> [--mode=fts|vector|hybrid] [--limit=N]
//   index            (re)build FTS5 + vectors + topics
//   frontend [out]   build static HTML dashboard
//   status           cursors + counts
//   demo             run the bundled two-run fixture end-to-end (offline)
import { openDb } from "./db";
import { ingestSnapshot, deltaParity, type Snapshot, type Source } from "./ingest";
import { buildIndex, search } from "./search";
import { buildFrontend } from "./frontend";
import { readFileSync } from "fs";

const DB = process.env.CK_DB || ".discord/chaiklang.sqlite";
const arg = (n: string, d?: string) => { const p = process.argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.split("=").slice(1).join("=") : d; };

function ingest(file: string) {
  const db = openDb(DB);
  const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  const source = (arg("source", "backfill") as Source);
  const runId = `${source}-${file}`;
  const st = ingestSnapshot(db, snap, { source, runId, fullSnapshot: process.argv.includes("--full") });
  let allOk = true;
  for (const ch of snap.channels) { const p = deltaParity(db, ch); if (!p.ok) { allOk = false; console.log(`✗ parity ${ch.name}: missing ${p.missing.length}`); } }
  console.log(`ingest[${source}] +${st.inserted} ~${st.edited} =${st.unchanged} †${st.deleted} · parity ${allOk ? "OK ✅" : "FAIL ✗"}`);
  db.close();
}

function status() {
  const db = openDb(DB);
  const c = (q: string) => (db.query(q).get() as any).c;
  console.log(`messages=${c("SELECT count(*) c FROM messages WHERE deleted_at IS NULL")} edited=${c("SELECT count(*) c FROM messages WHERE version>1")} deleted/kept=${c("SELECT count(*) c FROM messages WHERE deleted_at IS NOT NULL")} versions=${c("SELECT count(*) c FROM edit_history")}`);
  for (const r of db.query("SELECT * FROM cursor").all() as any[])
    console.log(`  cursor ${r.channel_id}: oldest=${r.backfill_oldest_id} newest=${r.live_newest_id}`);
  db.close();
}

const cmd = process.argv[2];
if (cmd === "ingest") ingest(process.argv[3]);
else if (cmd === "index") { const db = openDb(DB); console.log(buildIndex(db)); db.close(); }
else if (cmd === "search") { const db = openDb(DB); for (const h of search(db, process.argv[3], arg("mode", "hybrid") as any, Number(arg("limit", "10")))) console.log(`[${h.score}] (${h.via}) #${h.room_name}${h.thread_name ? "/" + h.thread_name : ""} @${h.author_name}: ${(h.content || "").slice(0, 80)}`); db.close(); }
else if (cmd === "frontend") { const db = openDb(DB); console.log("frontend →", buildFrontend(db, process.argv[3] || "dist/index.html")); db.close(); }
else if (cmd === "status") status();
else console.log("usage: bun src/cli.ts <ingest|index|search|frontend|status> …");
