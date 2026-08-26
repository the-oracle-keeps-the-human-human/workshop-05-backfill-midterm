// Thai tokenization for FTS5. FTS5 `unicode61` can't split Thai (no spaces) → it
// indexes whole runs as one token, so "ระบบ" won't match inside "ระบบแบ็คฟิล".
// Fix: insert U+200B (ZWSP) at PyThaiNLP word boundaries BEFORE indexing AND at query
// time, so unicode61 sees real word breaks. (Borrowed from Vessel's PR #17 — credited.)
//
// PyThaiNLP runs via `uvx` (no hard dep on a Python env). We batch ALL texts through one
// subprocess call (newline-delimited) so it's one spawn, not one-per-message.

const ZWSP = "​";
const hasThai = (s: string) => /[฀-๿]/.test(s);

// Batch-segment many texts in a single uvx call. Returns same-length array, ZWSP-joined.
// Falls back to the input unchanged if uvx/pythainlp is unavailable (graceful degrade).
export function segmentThaiBatch(texts: string[]): string[] {
  if (!texts.some(hasThai)) return texts;
  // sentinel separates records (newlines inside content are stripped for transport)
  const SEP = "␞"; // record separator symbol, won't appear in normal text
  const payload = texts.map(t => t.replace(/\n/g, " ")).join(SEP);
  const py = `
import sys
from pythainlp.tokenize import word_tokenize
ZWSP = "\\u200b"
data = sys.stdin.read().split("\\u241E")
out = []
for rec in data:
    parts = []
    buf = ""
    # tokenize whole record; pythainlp handles mixed Thai/EN
    parts = word_tokenize(rec, engine="newmm")
    out.append(ZWSP.join(parts))
sys.stdout.write("\\u241E".join(out))
`;
  try {
    const proc = Bun.spawnSync(["uvx", "--from", "pythainlp", "python3", "-c", py], {
      stdin: Buffer.from(payload),
    });
    if (proc.exitCode !== 0) return texts;
    const out = proc.stdout.toString().split(SEP);
    if (out.length !== texts.length) return texts;
    return out;
  } catch {
    return texts; // no uvx → degrade to unchanged (search still works, just unicode61-grade for Thai)
  }
}

// Single-text segment (used for the query string). Cached per-process for repeated queries.
const qCache = new Map<string, string>();
export function segmentThaiQuery(q: string): string {
  if (!hasThai(q)) return q;
  if (qCache.has(q)) return qCache.get(q)!;
  const seg = segmentThaiBatch([q])[0] ?? q;
  qCache.set(q, seg);
  return seg;
}

export { ZWSP, hasThai };
