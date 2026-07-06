import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

type Row = Record<string, any>;
const DIMS = 96;
const STOP = new Set("the a an and or to of in is are be for with this that you your was were have has had from into about can could should would there here คือ แล้ว ครับ ค่ะ ได้ ไม่ มี เรา ผม มัน อ่ะ นะ ของ ที่ ใน เป็น ให้ กับ จาก จะ ก็ แต่".split(" "));

function open(dbPath: string) { mkdirSync(dirname(dbPath), { recursive: true }); return new Database(dbPath); }
function tokenize(text: string): string[] { return text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_#@:-]+/gu) || []; }
function hashToken(token: string) { let h = 2166136261; for (const ch of token) { h ^= ch.codePointAt(0) || 0; h = Math.imul(h, 16777619); } return h >>> 0; }
export function embedText(text: string): number[] { const v = Array(DIMS).fill(0); for (const t of tokenize(text)) { const h = hashToken(t); v[h % DIMS] += (h & 1) ? 1 : -1; } const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map(x => Number((x / norm).toFixed(6))); }
function dot(a: number[], b: number[]) { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; }
function ftsQuery(query: string): string { const tokens = query.normalize("NFKC").match(/[\p{L}\p{N}_#]+/gu) || []; return tokens.length ? tokens.map(t => `"${t}"`).join(" ") : ""; }
function topTerms(rows: Row[]) { const counts = new Map<string, number>(); for (const r of rows) for (const t of tokenize([r.room_name, r.thread_name, r.author_name, r.content].filter(Boolean).join(" "))) if (t.length > 2 && !STOP.has(t)) counts.set(t, (counts.get(t) || 0) + 1); return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w); }
function representative(rows: Row[]) { return rows.filter(r => String(r.content || "").trim()).sort((a, b) => String(b.content || "").length - String(a.content || "").length).slice(0, 8).map(r => String(r.id)); }
function centroid(rows: Row[]) { const acc = Array(DIMS).fill(0); let n = 0; for (const r of rows) { const v = JSON.parse(r.embedding_json || "[]"); for (let i = 0; i < DIMS; i++) acc[i] += v[i] || 0; n++; } return acc.map(x => Number((x / Math.max(1, n)).toFixed(6))); }

export function buildTopics(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS topics (topic_id TEXT PRIMARY KEY, label TEXT NOT NULL, scope TEXT NOT NULL, room_id TEXT, thread_id TEXT, count INTEGER NOT NULL, keywords_json TEXT NOT NULL, representative_message_ids_json TEXT NOT NULL, centroid_json TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  db.exec("DELETE FROM topics;");
  const rows = db.query(`SELECT m.id, m.room_id, m.thread_id, m.author_name, m.content, r.name room_name, t.name thread_name, v.embedding_json FROM messages m JOIN rooms r ON r.id=m.room_id LEFT JOIN threads t ON t.id=m.thread_id JOIN message_vectors v ON v.message_id=m.id`).all() as Row[];
  const groups = new Map<string, Row[]>();
  for (const r of rows) { const key = r.thread_id ? `thread:${r.thread_id}` : `room:${r.room_id}`; const arr = groups.get(key) || []; arr.push(r); groups.set(key, arr); }
  const insert = db.prepare("INSERT INTO topics (topic_id,label,scope,room_id,thread_id,count,keywords_json,representative_message_ids_json,centroid_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))");
  for (const [key, items] of groups) {
    const first = items[0]; const scope = first.thread_id ? "thread" : "room"; const terms = topTerms(items);
    const base = first.thread_id ? `🧵 ${first.thread_name}` : `#${first.room_name}`;
    const label = terms.length ? `${base}: ${terms.slice(0, 3).join(", ")}` : base;
    insert.run(key, label, scope, first.room_id, first.thread_id || null, items.length, JSON.stringify(terms), JSON.stringify(representative(items)), JSON.stringify(centroid(items)));
  }
  return { topics: groups.size };
}

export function ensureSearchIndex(dbPath: string) {
  const db = open(dbPath);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, guild_name, room_name, thread_name, author_name, content, tokenize='unicode61'); CREATE TABLE IF NOT EXISTS message_vectors (message_id TEXT PRIMARY KEY, dims INTEGER NOT NULL, embedding_json TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  db.exec("DELETE FROM messages_fts; DELETE FROM message_vectors;");
  const rows = db.query(`SELECT m.id message_id, g.name guild_name, r.name room_name, t.name thread_name, m.author_id, m.author_name, m.content, m.timestamp FROM messages m JOIN guilds g ON g.id=m.guild_id JOIN rooms r ON r.id=m.room_id LEFT JOIN threads t ON t.id=m.thread_id ORDER BY m.timestamp, m.id`).all() as Row[];
  const fts = db.prepare("INSERT INTO messages_fts (message_id,guild_name,room_name,thread_name,author_name,content) VALUES (?,?,?,?,?,?)");
  const vec = db.prepare("INSERT INTO message_vectors (message_id,dims,embedding_json,text,updated_at) VALUES (?,?,?,?,datetime('now'))");
  db.transaction(() => { for (const r of rows) { const text = [r.guild_name, r.room_name, r.thread_name, r.author_name, r.content].filter(Boolean).join(" "); fts.run(r.message_id, r.guild_name || "", r.room_name || "", r.thread_name || "", r.author_name || "", r.content || ""); vec.run(r.message_id, DIMS, JSON.stringify(embedText(text)), text); } })();
  const topicResult = buildTopics(db); db.close(); return { messages: rows.length, dims: DIMS, topics: topicResult.topics };
}

export function searchDb(dbPath: string, query: string, mode: "fts" | "vector" | "hybrid" = "hybrid", limit = 12) {
  const db = open(dbPath); const qv = embedText(query); const byId = new Map<string, any>();
  if (mode !== "vector") for (const r of db.query(`SELECT m.id, m.author_id, m.author_name, m.content, m.timestamp, g.name guild_name, r.id room_id, r.name room_name, t.id thread_id, t.name thread_name, bm25(messages_fts) fts_rank FROM messages_fts JOIN messages m ON m.id=messages_fts.message_id JOIN guilds g ON g.id=m.guild_id JOIN rooms r ON r.id=m.room_id LEFT JOIN threads t ON t.id=m.thread_id WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`).all(ftsQuery(query), limit * 3) as Row[]) byId.set(r.id, { ...r, ftsScore: 1 / (1 + Math.abs(Number(r.fts_rank || 0))), vectorScore: 0 });
  if (mode !== "fts") for (const r of db.query(`SELECT m.id, m.author_id, m.author_name, m.content, m.timestamp, g.name guild_name, r.id room_id, r.name room_name, t.id thread_id, t.name thread_name, v.embedding_json FROM message_vectors v JOIN messages m ON m.id=v.message_id JOIN guilds g ON g.id=m.guild_id JOIN rooms r ON r.id=m.room_id LEFT JOIN threads t ON t.id=m.thread_id`).all() as Row[]) { const score = dot(qv, JSON.parse(r.embedding_json)); if (score <= 0 && mode === "vector") continue; const prev = byId.get(r.id) || { ...r, ftsScore: 0 }; byId.set(r.id, { ...prev, vectorScore: Math.max(prev.vectorScore || 0, score) }); }
  const results = [...byId.values()].map(r => ({ ...r, score: (r.ftsScore || 0) * 0.65 + (r.vectorScore || 0) * 0.35 })).sort((a, b) => b.score - a.score).slice(0, limit); db.close(); return results;
}
