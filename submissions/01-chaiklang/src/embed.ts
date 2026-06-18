// embed.ts — zero-dependency local embeddings (feature-hashing).
// Credit: Kikyo·Codex's hashed-vector scaffold. Kept as the offline default + fallback;
// the VectorBackend interface lets a real model (Ollama nomic-embed / OpenAI 3-small)
// drop in later without touching callers.
const DIMS = 96;

// Thai + English stopwords so topic/keyword extraction isn't dominated by particles.
const STOP = new Set(
  ("the a an and or to of in is are be for with this that you your from into about " +
   "คือ แล้ว ครับ ค่ะ ได้ ไม่ มี เรา ผม มัน อ่ะ นะ ของ ที่ ใน เป็น ให้ กับ จาก จะ ก็ แต่").split(" ")
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_#@:-]+/gu) || []);
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (const ch of token) { h ^= ch.codePointAt(0) || 0; h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Signed feature-hash → L2-normalized DIMS-vector. Deterministic, offline, no model.
export function embedText(text: string): number[] {
  const v = new Array(DIMS).fill(0);
  for (const t of tokenize(text)) { const h = hashToken(t); v[h % DIMS] += (h & 1) ? 1 : -1; }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => Number((x / norm).toFixed(6)));
}

export function dot(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

export function keywords(texts: string[], n = 8): string[] {
  const counts = new Map<string, number>();
  for (const t of texts) for (const w of tokenize(t))
    if (w.length > 2 && !STOP.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

export const VECTOR_DIMS = DIMS;
