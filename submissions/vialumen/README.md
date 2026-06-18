# backfill-mvp — a *living* Discord mirror

A backfill system that loads Discord history, indexes it, and **stays in sync** —
cold backfill + warm tail through one idempotent write path. Zero external deps
(Python 3.10+ stdlib `sqlite3` with FTS5).

> Design note: kikyo's mirror nails the **cold snapshot + search** layer. This MVP
> extends it into a **living system**: real-time tail, edit/delete versioning,
> resumable checkpoints, gap detection, and a pluggable vector backend.

## Why it's more than a one-shot dump

| Capability | How |
|---|---|
| **Idempotent** | upsert by `message_id` — re-runs/resumes never duplicate |
| **Nothing deleted** | edit → new `message_versions` row; delete → tombstone flag |
| **Resumable** | `checkpoints(newest_id, oldest_id, cold_done)` per channel |
| **Fresh** | warm tail pulls `after=newest_id` + reconciles edits/deletes |
| **Provably complete** | parity gate (source count == DB) + gap-range detection |
| **Hybrid search** | FTS5/BM25 + vector, fused with RRF, metadata pre-filters |
| **Swappable semantics** | `Embedder` ABC + `message_vectors` → drop in real embeddings / sqlite-vec / Qdrant |
| **Token-safe** | Discord access lives behind a `Fetcher` adapter; no raw bot token in this code path |

## Architecture

```
Fetcher (adapter)  ──►  Store (idempotent upsert)  ──►  SQLite (source of truth)
  Fixture / Tool / REST        edit→version              messages + versions +
  cold: before-cursor          delete→tombstone          channels + checkpoints +
  warm: after-cursor                                     run_log + message_vectors
        │                                                        │
        └────────────► Parity + gap scan (completeness gate) ◄───┤
                                                                 ▼
                            Search:  FTS5/BM25  +  vector  ──RRF──►  ranked hits
```

Cold and warm share the **same** `upsert_message()` — that's what makes restarts,
re-runs, and live tail all safe.

## Run

```bash
python3 cli.py backfill --fixture fixtures/cold.json --db .data/m.sqlite   # cold
python3 cli.py parity   --fixture fixtures/cold.json --db .data/m.sqlite   # gate
python3 cli.py sync     --fixture fixtures/delta.json --db .data/m.sqlite  # warm tail
python3 cli.py search "semantic embeddings" --mode hybrid --db .data/m.sqlite
python3 cli.py stats    --db .data/m.sqlite

python3 tests/test_demo.py     # full-lifecycle assertions
```

## Adapters & the token-safety boundary

`bf/fetcher.py` is the only Discord-aware seam:

- `FixtureFetcher` — local JSON (tests/offline/demo).
- `ToolFetcher` — in-agent: backed by the approved `fetch_messages` tool (no raw token).
- `DiscordRestFetcher` — standalone deploy: pages the REST API honouring
  `X-RateLimit-*` + 429 `Retry-After`, token pulled from a secret store **at call
  time** (never at rest, never logged). Documented stub.

## Production roadmap (beyond MVP)

1. Gateway WebSocket for true real-time (`MESSAGE_CREATE/UPDATE/DELETE`).
2. Real embeddings (Ollama `nomic-embed-text` / `text-embedding-3-small`).
3. Vector index swap: `sqlite-vec` → LanceDB → Qdrant by scale.
4. Attachment download + hash-dedupe.
5. Reranker on the hybrid top-k; topic map (UMAP→HDBSCAN) UI.

## Proof & integrity

This runs in a **headless environment** (no desktop to screen-capture). Rather than
*render* a fake "screenshot" image — every number here is captured **real stdout**:

- `proof-run.txt` — the actual, unedited output of the commands below.
- **Don't trust a screenshot — reproduce it yourself** (zero deps, ~1s):

```bash
cd submissions/vialumen
python3 tests/test_demo.py          # → ✓ test_full_lifecycle PASSED
python3 cli.py backfill --fixture fixtures/cold.json  --db .data/m.sqlite
python3 cli.py sync     --fixture fixtures/delta.json --db .data/m.sqlite
python3 cli.py stats    --db .data/m.sqlite
```

The fixtures mirror Discord's message schema (rooms + threads, edits, deletes) so the
full pipeline is exercised end to end. Live Discord ingestion plugs in behind the
`Fetcher` adapter (`bf/fetcher.py`) — in-agent via the approved fetch tool, or
standalone via the REST adapter — with no raw bot token in this code path.
