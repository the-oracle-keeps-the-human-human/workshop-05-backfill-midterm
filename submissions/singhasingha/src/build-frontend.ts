// Build a static, self-contained HTML dashboard from the DB (only after parity passed).
// Live client-side search over the embedded data. Black-gold lion theme 🦁.
import { openDb } from "./db.ts";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const DB = process.argv[2] || "data/sing.sqlite";
const OUT = process.argv[3] || "frontend/index.html";

const db = openDb(DB);
const stats = {
  messages: (db.query("SELECT count(*) c FROM messages WHERE deleted_at IS NULL").get() as any).c,
  edited: (db.query("SELECT count(*) c FROM messages WHERE version > 1").get() as any).c,
  tombstoned: (db.query("SELECT count(*) c FROM messages WHERE deleted_at IS NOT NULL").get() as any).c,
  authors: (db.query("SELECT count(DISTINCT author_id) c FROM messages").get() as any).c,
  channels: (db.query("SELECT count(*) c FROM channels").get() as any).c,
};
const rows = db.query(`SELECT id, channel_name, author_name, is_bot, content, created_at, version
  FROM messages WHERE deleted_at IS NULL ORDER BY created_at, id`).all() as any[];
const cursor = db.query("SELECT * FROM cursor").all() as any[];
db.close();

const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const data = JSON.stringify(rows.map(r => ({ a: r.author_name, b: r.is_bot, c: r.content, t: r.created_at, v: r.version })));

const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🦁 Singhasingha Discord Backfill</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,'Sarabun',system-ui,sans-serif;background:#0B0B0B;color:#e8ecff}
.top{position:sticky;top:0;background:#0b0b0bdd;backdrop-filter:blur(12px);padding:18px 24px;border-bottom:1px solid #2a2410}
h1{margin:0;font-size:22px;background:linear-gradient(90deg,#FFD24A,#E8631B);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:#9a8a4c;font-size:12px;margin-top:2px}
.stats{display:flex;gap:14px;margin-top:12px;flex-wrap:wrap}
.stat{background:#171307;border:1px solid #3a2f12;border-radius:12px;padding:8px 14px}
.stat b{color:#FFD24A;font-size:18px;display:block}
.stat span{color:#9a8a4c;font-size:11px}
#q{width:100%;margin-top:12px;padding:11px 14px;border-radius:10px;border:1px solid #3a2f12;background:#0B0B0B;color:#e8ecff;font-size:14px}
.wrap{padding:16px 24px;max-width:1000px;margin:0 auto}
.msg{padding:10px 12px;border-bottom:1px solid #1a1608;line-height:1.5}
.msg.hidden{display:none}
.au{color:#FFD24A;font-weight:700}.bot{font-size:10px;color:#E8631B;border:1px solid #5a3010;border-radius:4px;padding:0 4px;margin-left:6px}
.ts{color:#6a5d33;font-size:11px;margin-left:8px}
.ver{color:#E8631B;font-size:10px;margin-left:6px}
.ct{margin-top:4px;color:#d8dcf0;white-space:pre-wrap;word-break:break-word}
.count{color:#9a8a4c;font-size:12px;margin:10px 0}
</style></head><body>
<div class="top">
  <h1>🦁 Singhasingha Discord Backfill</h1>
  <div class="sub">parity-verified mirror → SQLite → search · #${esc(rows[0]?.channel_name || "channel")} · v3 (incremental + edit-history + tombstone + hybrid RRF)</div>
  <div class="stats">
    <div class="stat"><b>${stats.messages}</b><span>messages</span></div>
    <div class="stat"><b>${stats.authors}</b><span>authors</span></div>
    <div class="stat"><b>${stats.edited}</b><span>edited (versioned)</span></div>
    <div class="stat"><b>${stats.tombstoned}</b><span>tombstoned (kept)</span></div>
    <div class="stat"><b>✓</b><span>parity gate</span></div>
  </div>
  <input id="q" placeholder="🔎 ค้นหา / search messages (live)…">
</div>
<div class="wrap"><div class="count" id="count"></div><div id="list"></div></div>
<script>
const DATA=${data};
const list=document.getElementById('list'),count=document.getElementById('count'),q=document.getElementById('q');
function render(items){
  list.innerHTML=items.map(m=>'<div class="msg"><span class="au">'+esc(m.a||'?')+'</span>'+(m.b?'<span class="bot">BOT</span>':'')+'<span class="ts">'+esc((m.t||'').slice(0,16).replace('T',' '))+'</span>'+(m.v>1?'<span class="ver">v'+m.v+'</span>':'')+'<div class="ct">'+esc(m.c||'')+'</div></div>').join('');
  count.textContent=items.length+' / '+DATA.length+' messages';
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
q.addEventListener('input',()=>{const s=q.value.toLowerCase().trim();render(!s?DATA:DATA.filter(m=>((m.c||'')+' '+(m.a||'')).toLowerCase().includes(s)));});
render(DATA);
</script></body></html>`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`✓ frontend: ${OUT} (${stats.messages} messages, ${stats.edited} edited, ${stats.tombstoned} tombstoned)`);
