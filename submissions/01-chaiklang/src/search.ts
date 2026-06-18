// search.ts — FTS5 (exact) + vector (semantic) + RRF hybrid + in-DB topics.
// Improvement over Kikyo: fusion uses Reciprocal Rank Fusion (rank-based, no fragile
// score normalization) instead of raw weighted scores. Deleted messages are excluded
// from the index (tombstones stay queryable in the DB, but not surfaced in search).
import type { Database } from "bun:sqlite";
import { embedText, dot, keywords, VECTOR_DIMS } from "./embed";

export function buildIndex(db: Database) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED, room_name, thread_name, author_name, content, tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS message_vectors (
      message_id TEXT PRIMARY KEY, dims INTEGER, model TEXT, embedding_json TEXT, text TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS topics (
      topic_id TEXT PRIMARY KEY, label TEXT, scope TEXT, room_id TEXT, thread_id TEXT,
      count INTEGER, keywords_json TEXT, updated_at TEXT);
  `);
  db.exec("DELETE FROM messages_fts; DELETE FROM message_vectors; DELETE FROM topics;");
  const rows = db.query(`
    SELECT m.id, r.name room_name, t.name thread_name, m.author_name, m.content, m.room_id, m.thread_id
    FROM messages m LEFT JOIN rooms r ON r.id=m.room_id LEFT JOIN threads t ON t.id=m.thread_id
    WHERE m.deleted_at IS NULL ORDER BY m.timestamp, m.id`).all() as any[];
  const fts = db.prepare("INSERT INTO messages_fts (message_id,room_name,thread_name,author_name,content) VALUES (?,?,?,?,?)");
  const vec = db.prepare("INSERT INTO message_vectors (message_id,dims,model,embedding_json,text,updated_at) VALUES (?,?,?,?,?,datetime('now'))");
  db.transaction(() => {
    for (const r of rows) {
      const text = [r.room_name, r.thread_name, r.author_name, r.content].filter(Boolean).join(" ");
      fts.run(r.id, r.room_name || "", r.thread_name || "", r.author_name || "", r.content || "");
      vec.run(r.id, VECTOR_DIMS, "hash-debug", JSON.stringify(embedText(text)), text);
    }
  })();
  const topics = buildTopics(db, rows);
  return { indexed: rows.length, dims: VECTOR_DIMS, topics };
}

function buildTopics(db: Database, rows: any[]): number {
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = r.thread_id ? `thread:${r.thread_id}` : `room:${r.room_id}`;
    (groups.get(key) || groups.set(key, []).get(key)!).push(r);
  }
  const ins = db.prepare("INSERT INTO topics (topic_id,label,scope,room_id,thread_id,count,keywords_json,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))");
  for (const [key, items] of groups) {
    const f = items[0]; const terms = keywords(items.map((i) => i.content || ""), 6);
    const base = f.thread_id ? `🧵 ${f.thread_name}` : `#${f.room_name}`;
    ins.run(key, terms.length ? `${base}: ${terms.slice(0, 3).join(", ")}` : base,
      f.thread_id ? "thread" : "room", f.room_id, f.thread_id || null, items.length, JSON.stringify(terms));
  }
  return groups.size;
}

export type Hit = { id: string; author_name: string; content: string; timestamp: string; room_name: string; thread_name?: string; score: number; via: string };

// Build a safe FTS5 MATCH string: quote each token so hyphens/colons/operators in the
// user query (e.g. "edit-history") are treated as literals, OR-joined for recall.
function ftsQuery(q: string): string {
  const toks = (q.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_#@]+/gu) || []).map((t) => `"${t}"`);
  return toks.join(" OR ");
}

// Reciprocal Rank Fusion: score = Σ 1/(k + rank) across each ranked list it appears in.
const RRF_K = 60;
export function search(db: Database, query: string, mode: "fts" | "vector" | "hybrid" = "hybrid", limit = 10): Hit[] {
  const meta = (id: string) => db.query(`SELECT m.id,m.author_name,m.content,m.timestamp,r.name room_name,t.name thread_name
    FROM messages m LEFT JOIN rooms r ON r.id=m.room_id LEFT JOIN threads t ON t.id=m.thread_id WHERE m.id=?`).get(id) as any;
  const acc = new Map<string, { rrf: number; via: Set<string> }>();
  const fuse = (id: string, rank: number, via: string) => {
    const e = acc.get(id) || { rrf: 0, via: new Set<string>() };
    e.rrf += 1 / (RRF_K + rank); e.via.add(via); acc.set(id, e);
  };

  if (mode !== "vector") {
    const fq = ftsQuery(query);
    if (fq) {
      const ftsRows = db.query(`SELECT message_id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`)
        .all(fq, limit * 3) as any[];
      ftsRows.forEach((r, i) => fuse(r.message_id, i, "fts"));
    }
  }
  if (mode !== "fts") {
    const qv = embedText(query);
    const vrows = db.query("SELECT message_id, embedding_json FROM message_vectors").all() as any[];
    const scored = vrows.map((r) => ({ id: r.message_id, s: dot(qv, JSON.parse(r.embedding_json)) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit * 3);
    scored.forEach((x, i) => fuse(x.id, i, "vector"));
  }
  return [...acc.entries()]
    .map(([id, e]) => { const m = meta(id); return m && { ...m, score: Number(e.rrf.toFixed(6)), via: [...e.via].join("+") }; })
    .filter(Boolean)
    .sort((a: Hit, b: Hit) => b.score - a.score).slice(0, limit) as Hit[];
}
