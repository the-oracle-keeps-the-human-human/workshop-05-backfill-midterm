// CLI: bun run src/run.ts backfill   — run pipeline on the fixture
//      bun run src/run.ts search "<q>" [fts|vector|hybrid]
import { backfill } from "./backfill.ts";
import { search } from "./search.ts";
import { readFileSync } from "fs";

const DB = "data/sing.sqlite";
const MIRROR = "data/mirror";
const CHANNEL_ID = "1512079809021214730";
const CHANNEL_NAME = "free-for-all";

const cmd = process.argv[2] || "backfill";

if (cmd === "backfill") {
  const messages = JSON.parse(readFileSync("data/fixture.json", "utf8"));
  const res = await backfill({
    dbPath: DB, mirrorDir: MIRROR, channelId: CHANNEL_ID, channelName: CHANNEL_NAME,
    source: { kind: "fixture", messages },
    log: (s) => console.log("  " + s),
  });
  console.log("\nRESULT:", JSON.stringify({ fetched: res.fetched, inserted: res.inserted, edited: res.edited, parityOk: res.parity.ok, indexed: res.indexed?.messages }, null, 2));
  if (!res.parity.ok) process.exit(1);
} else if (cmd === "search") {
  const q = process.argv[3] || "";
  const mode = (process.argv[4] as any) || "hybrid";
  const hits = search(DB, q, mode, 8);
  console.log(`\n🔎 "${q}" (${mode}) — ${hits.length} hits\n`);
  for (const h of hits) {
    const snippet = (h.content || "").replace(/\s+/g, " ").slice(0, 90);
    console.log(`  [rrf ${h.rrf}] ${h.author_name}: ${snippet}${snippet.length >= 90 ? "…" : ""}`);
  }
}
