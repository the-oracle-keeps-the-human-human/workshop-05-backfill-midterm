// Build a fixture (real Discord messages, this channel) from the MCP fetch dump.
// The text dump is `[ISO] author: content` (+ "(id: N)" when present). When the id is
// absent we reconstruct a valid, unique, time-ordered snowflake from the timestamp —
// consistent with the pipeline (snowflake>>22 = ms since Discord epoch).
import { readFileSync, writeFileSync } from "fs";

const DISCORD_EPOCH = 1420070400000;
const srcPath = process.argv[2];
const outPath = process.argv[3] || "data/fixture.json";

const txt = readFileSync(srcPath, "utf8");
const lines = txt.split("\n").filter(l => l.trim());

const out: any[] = [];
let seq = 0;
for (const line of lines) {
  const m = line.match(/^\[([^\]]+)\]\s+([^:]+):\s+([\s\S]*)$/);
  if (!m) continue;
  const [, ts, author, rest] = m;
  const idMatch = rest.match(/\(id:\s*(\d+)\)\s*$/);
  const content = rest.replace(/\(id:\s*\d+\)\s*$/, "").replace(/ ⏎ /g, "\n").trim();
  let id: string;
  if (idMatch) {
    id = idMatch[1];
  } else {
    const ms = new Date(ts).getTime();
    // reconstruct snowflake: ((ms - epoch) << 22) + monotonic seq (keeps uniqueness + order)
    id = ((BigInt(ms - DISCORD_EPOCH) << 22n) + BigInt(seq++)).toString();
  }
  const isBot = /Oracle|No\.\d|Atom|Nova|Tonk|Jizo|Tinky|vessel|me$/i.test(author) && author.trim() !== "nazt_";
  out.push({
    id,
    timestamp: new Date(ts).toISOString(),
    author: { id: `u_${author.trim().replace(/[^a-zA-Z0-9]/g, "")}`, username: author.trim(), bot: isBot },
    content,
  });
}

writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`fixture: ${out.length} messages → ${outPath}`);
