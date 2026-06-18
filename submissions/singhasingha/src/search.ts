// sing-backfill — index + hybrid search. v3 over Kikyo: RRF fusion (no score-normalize)
// + VectorBackend abstraction (swap hashed scaffold → real embeddings later).
import { Database } from "bun:sqlite";
import { openDb } from "./db.ts";
import { segmentThaiBatch, segmentThaiQuery } from "./thai.ts";

const DIMS = 96;
const STOP = new Set("the a an and or to of in is are be for with you your from this that ครับ ค่ะ นะ คือ แล้ว ได้ ไม่ มี เรา ผม ของ ที่ ใน เป็น ให้ กับ จาก จะ ก็ แต่ อ่ะ".split(" "));

// ── VectorBackend abstraction (Kikyo's research recommends; lets us swap in real embeddings) ──
export interface VectorBackend {
  name: string; dims: number;
  embed(text: string): number[];
}

// hashed scaffold backend (zero-dep, honest: NOT real meaning — same caveat Kikyo flagged)
export const HashBackend: VectorBackend = {
  name: "hash-debug", dims: DIMS,
  embed(text: string): number[] {
    const v = new Array(DIMS).fill(0);
    for (const t of tokenize(text)) { const h = hashToken(t); v[h % DIMS] += (h & 1) ? 1 : -1; }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map(x => Number((x / norm).toFixed(6)));
  },
};
// To go real later: implement an OllamaBackend/OpenAIBackend with the same interface.

function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_#@:-]+/gu) || []).filter(t => !STOP.has(t));
}
function hashToken(token: string): number {
  let h = 2166136261; for (const ch of token) { h ^= ch.codePointAt(0) || 0; h = Math.imul(h, 16777619); } return h >>> 0;
}
function dot(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s; }

export function buildIndex(dbPath: string, backend: VectorBackend = HashBackend): { messages: number; dims: number } {
  const db = openDb(dbPath);
  db.exec("DELETE FROM messages_fts; DELETE FROM message_vectors;");
  // only index non-deleted (tombstoned stay in messages table for audit, out of search)
  const rows = db.query("SELECT id, channel_name, author_name, content FROM messages WHERE deleted_at IS NULL").all() as any[];
  // Thai fix: ZWSP-segment content for the FTS column so unicode61 sees word breaks.
  // Raw content stays untouched in messages table — only the FTS index gets segmented.
  const ftsContent = segmentThaiBatch(rows.map(r => r.content || ""));
  const fts = db.prepare("INSERT INTO messages_fts (message_id, channel_name, author_name, content) VALUES (?,?,?,?)");
  const vec = db.prepare("INSERT INTO message_vectors (message_id, dims, embedding_json) VALUES (?,?,?)");
  db.transaction(() => {
    rows.forEach((r, i) => {
      const text = [r.channel_name, r.author_name, r.content].filter(Boolean).join(" ");
      fts.run(r.id, r.channel_name || "", r.author_name || "", ftsContent[i] ?? r.content ?? "");
      vec.run(r.id, backend.dims, JSON.stringify(backend.embed(text)));
    });
  })();
  db.close();
  return { messages: rows.length, dims: backend.dims };
}

export interface SearchHit { id: string; author_name: string; content: string; created_at: string; channel_name: string; rrf: number; ftsRank?: number; vecRank?: number; }

// RRF (Reciprocal Rank Fusion): score = Σ 1/(k + rank). No score-normalization needed — v3 over Kikyo's weighted 0.65/0.35.
export function search(dbPath: string, query: string, mode: "fts" | "vector" | "hybrid" = "hybrid", limit = 10, backend: VectorBackend = HashBackend): SearchHit[] {
  const db = openDb(dbPath);
  const K = 60;
  const rrf = new Map<string, { fts?: number; vec?: number }>();

  if (mode !== "vector") {
    // Thai fix: segment the query the SAME way as the index so ZWSP-broken Thai words match.
    const ftsQuery = segmentThaiQuery(query).replace(/['"]/g, " ").replace(/​/g, " ").trim();
    const ftsRows = db.query(
      `SELECT m.id FROM messages_fts f JOIN messages m ON m.id=f.message_id
       WHERE messages_fts MATCH ? AND m.deleted_at IS NULL ORDER BY bm25(messages_fts) LIMIT ?`
    ).all(ftsQuery || query.replace(/['"]/g, " "), limit * 3) as any[];
    ftsRows.forEach((r, i) => { const e = rrf.get(r.id) || {}; e.fts = i + 1; rrf.set(r.id, e); });
  }
  if (mode !== "fts") {
    const qv = backend.embed(query);
    const vecRows = db.query(
      `SELECT v.message_id id, v.embedding_json FROM message_vectors v JOIN messages m ON m.id=v.message_id WHERE m.deleted_at IS NULL`
    ).all() as any[];
    const scored = vecRows.map(r => ({ id: r.id, score: dot(qv, JSON.parse(r.embedding_json)) }))
      .sort((a, b) => b.score - a.score).slice(0, limit * 3);
    scored.forEach((r, i) => { const e = rrf.get(r.id) || {}; e.vec = i + 1; rrf.set(r.id, e); });
  }

  const ranked = [...rrf.entries()].map(([id, r]) => ({
    id,
    rrf: (r.fts ? 1 / (K + r.fts) : 0) + (r.vec ? 1 / (K + r.vec) : 0),
    ftsRank: r.fts, vecRank: r.vec,
  })).sort((a, b) => b.rrf - a.rrf).slice(0, limit);

  const get = db.prepare("SELECT author_name, content, created_at, channel_name FROM messages WHERE id=?");
  const hits = ranked.map(x => { const m = get.get(x.id) as any; return { id: x.id, ...m, rrf: Number(x.rrf.toFixed(6)), ftsRank: x.ftsRank, vecRank: x.vecRank }; });
  db.close();
  return hits;
}
