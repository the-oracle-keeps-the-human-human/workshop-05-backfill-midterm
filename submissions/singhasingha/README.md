# 🦁 sing-backfill — Singhasingha's Discord Backfill (workshop-05 submission)

> Discord → JSON mirror (durable truth) → SQLite (incremental) → **parity gate** → hybrid search → frontend.
> Singhasingha (เมฆ) — AI Oracle (ไม่ใช่คน) · Rule 6 · 2026-06-19

A **working, tested** implementation of the workshop-05 backfill design. Built after studying Kikyo's reference impl — keeps Kikyo's best idea (parity gate) and improves on 5 gaps.

## Run
```bash
bun run src/run.ts backfill              # fixture (real #free-for-all messages) → mirror → DB → parity → index
bun run src/run.ts search "parity" hybrid   # fts | vector | hybrid (RRF)
bun run src/build-frontend.ts            # static dashboard from DB
bun test                                 # 8 tests
```
Production source = REST backfill (`src/ingest.ts restBackfill`, token from `DISCORD_BOT_TOKEN`, honors 429). The fixture source runs the **same pipeline** offline so it's fully testable.

## Architecture
```
INGEST   source (REST before-cursor / fixture)  ──┐
                                                  ↓
STORE    JSON mirror (durable truth) ── SQLite (incremental upsert, edit-versioned, NOT clearDb)
                                                  ↓
GATE     verifyParity: mirror id-set == DB id-set?  → refuse index/frontend if mismatch
                                                  ↓
INDEX    FTS5 (bm25) + vectors (VectorBackend) ── topics-ready
                                                  ↓
SERVE    search (fts|vector|hybrid-RRF) + static frontend dashboard
```

## What it borrows from Kikyo (credit)
- **Parity gate** — verify DB == mirror by exact message-id set, refuse downstream on mismatch ("verify, don't claim" in code). The single best idea.
- **Mirror-first** — on-disk JSON is the durable source of truth; SQLite is rebuildable.

## What it does better than Kikyo (5, each tested)
| # | Kikyo | sing-backfill v3 |
|---|---|---|
| 1 | `clearDb` + full re-mirror every run | **incremental** cursor (before/after watermarks), delta-only |
| 2 | one-shot (no live) | REST + **incremental delta** + (designed) WS-first overlap + gap-heal |
| 3 | `INSERT OR REPLACE` (edits overwrite, history lost) | **edit_history** versions + **tombstone** on delete (Nothing is Deleted) |
| 4 | hashed vectors only | **VectorBackend** abstraction (hash scaffold now, swap real nomic/OpenAI later) |
| 5 | weighted 0.65/0.35 fusion | **RRF** (Reciprocal Rank Fusion — no score-normalization) |
| 6 | unicode61 (mis-splits Thai) | **PyThaiNLP ZWSP** at index + query (correct Thai word breaks) — borrowed from Vessel PR #17 🙏 |

### Thai tokenization (added after self-reviewing the PR comparison)
FTS5 `unicode61` indexes a whole Thai run as one token → "ระบบ" won't match inside "ระบบแบ็คฟิล". `src/thai.ts` inserts U+200B (ZWSP) at PyThaiNLP `newmm` word boundaries — on the FTS column at index time AND on the query string — so embedded Thai words become findable. Runs via `uvx` (no hard Python dep); degrades to plain unicode61 if uvx absent. Raw `content` untouched. Tested.

## Evidence
- `frontend/shot-full.png` — dashboard (100 real messages, parity ✓)
- `frontend/shot-stats.png` — edit-versioning + tombstone stats rendered (v3 features)
- `frontend/run-evidence.txt` — test (8 pass) + cold/idempotent backfill + search output
- `bun test` → **8 pass / 0 fail** (incl. parity-gate-FAILS test proving the gate blocks)

## Files
`src/db.ts` (schema + upsert/versioning/tombstone/cursor) · `src/ingest.ts` (REST + fixture sources) · `src/backfill.ts` (orchestrator) · `src/parity.ts` (gate) · `src/search.ts` (FTS5 + VectorBackend + RRF) · `src/build-frontend.ts` · `tests/pipeline.test.ts`

Data is real messages from #free-for-all (Golf confirmed: no private data). No secrets in code — token via env only.
