// frontend.ts — static HTML dashboard built from the DB. Renders edits (version badge)
// and deletes (struck-through tombstone) so "Nothing is Deleted" is visible, not just claimed.
import type { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function buildFrontend(db: Database, outPath: string): string {
  const stats = {
    guilds: (db.query("SELECT count(*) c FROM guilds").get() as any).c,
    rooms: (db.query("SELECT count(*) c FROM rooms").get() as any).c,
    threads: (db.query("SELECT count(*) c FROM threads").get() as any).c,
    messages: (db.query("SELECT count(*) c FROM messages WHERE deleted_at IS NULL").get() as any).c,
    edited: (db.query("SELECT count(*) c FROM messages WHERE version>1").get() as any).c,
    deleted: (db.query("SELECT count(*) c FROM messages WHERE deleted_at IS NOT NULL").get() as any).c,
    versions: (db.query("SELECT count(*) c FROM edit_history").get() as any).c,
    topics: (db.query("SELECT count(*) c FROM topics").get() as any).c,
  };
  const topics = db.query("SELECT label, count FROM topics ORDER BY count DESC LIMIT 12").all() as any[];
  const rooms = db.query("SELECT id, name FROM rooms ORDER BY position, name").all() as any[];

  const msgLi = (m: any) => {
    const badge = m.version > 1 ? ` <span class="b edit">edited · v${m.version}</span>` : "";
    const del = m.deleted_at ? ' <span class="b del">deleted (kept)</span>' : "";
    const cls = m.deleted_at ? "msg gone" : "msg";
    return `<li class="${cls}"><span class="ts">${esc((m.timestamp || "").slice(0, 19))}</span> <b>${esc(m.author_name)}</b>: <span>${esc(m.content || "(no content)")}</span>${badge}${del}</li>`;
  };

  const roomHtml = rooms.map((r) => {
    const msgs = db.query("SELECT * FROM messages WHERE room_id=? AND thread_id IS NULL ORDER BY timestamp,id").all(r.id) as any[];
    const threads = db.query("SELECT id,name,state FROM threads WHERE parent_room_id=? ORDER BY name").all(r.id) as any[];
    const tHtml = threads.map((t) => {
      const tm = db.query("SELECT * FROM messages WHERE thread_id=? ORDER BY timestamp,id").all(t.id) as any[];
      return `<details class="thread" open><summary>🧵 ${esc(t.name)} <span>${esc(t.state || "")} · ${tm.length} msg</span></summary><ul>${tm.map(msgLi).join("")}</ul></details>`;
    }).join("");
    return `<details class="room" open><summary>#${esc(r.name)} <span>${msgs.length} msg · ${threads.length} threads</span></summary><ul>${msgs.map(msgLi).join("")}</ul>${tHtml}</details>`;
  }).join("");

  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChaiKlang Discord Mirror — backfill+index</title><style>
:root{color-scheme:dark}body{margin:0;padding:24px;background:#0b1020;color:#e8ecff;font-family:Inter,'Noto Sans Thai',system-ui,sans-serif}
.top{position:sticky;top:0;background:#0b1020e6;backdrop-filter:blur(12px);padding:14px 0;border-bottom:1px solid #26304d;z-index:5}
h1{margin:0;font-size:22px}h1 small{color:#9aa7d8;font-weight:400;font-size:13px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}.stat{background:#172142;border:1px solid #2b3760;border-radius:10px;padding:6px 12px;font-size:13px}.stat b{color:#7cc7ff;font-size:16px}
.topics{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.chip{background:#1b294f;border:1px solid #2b3760;border-radius:999px;padding:4px 12px;font-size:12px;color:#bcd0ff}
.room,.thread{margin:10px 0;padding:10px 14px;border:1px solid #26304d;border-radius:12px;background:#111936}.thread{margin-left:18px;background:#16204a}
summary{cursor:pointer;font-weight:700}summary span{color:#9aa7d8;font-weight:500;font-size:12px;margin-left:8px}
ul{margin:8px 0 0;padding-left:16px;list-style:none}.msg{margin:6px 0;line-height:1.4;font-size:14px}.ts{color:#8591bd;font-size:11px;margin-right:6px}b{color:#b7c5ff}
.b{font-size:10px;padding:1px 7px;border-radius:999px;margin-left:6px;vertical-align:middle}.edit{background:#3a2f12;color:#ffd479;border:1px solid #6b551c}.del{background:#3a1620;color:#ff8aa6;border:1px solid #6b1c2e}
.gone span:nth-child(2),.gone span:nth-child(3){text-decoration:line-through;opacity:.55}
input{width:100%;box-sizing:border-box;margin-top:12px;padding:10px;border-radius:10px;border:1px solid #39466f;background:#0b1020;color:#e8ecff}.hidden{display:none}
</style></head><body>
<div class="top"><h1>🦁 ChaiKlang Discord Mirror <small>backfill + index + search · Nothing is Deleted</small></h1>
<div class="stats">
  <div class="stat"><b>${stats.messages}</b> messages</div><div class="stat"><b>${stats.rooms}</b> rooms</div>
  <div class="stat"><b>${stats.threads}</b> threads</div><div class="stat"><b>${stats.edited}</b> edited</div>
  <div class="stat"><b>${stats.deleted}</b> deleted (kept)</div><div class="stat"><b>${stats.versions}</b> old versions</div>
  <div class="stat"><b>${stats.topics}</b> topics</div></div>
<input id="q" placeholder="filter messages / rooms / threads…"></div>
<div class="topics">${topics.map((t) => `<span class="chip">${esc(t.label)} · ${t.count}</span>`).join("")}</div>
${roomHtml}
<script>const q=document.getElementById('q');q.addEventListener('input',()=>{const s=q.value.toLowerCase();document.querySelectorAll('.room,.thread,.msg').forEach(el=>el.classList.toggle('hidden',s&&!el.textContent.toLowerCase().includes(s)));});</script>
</body></html>`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  return outPath;
}
