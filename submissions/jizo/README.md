# Jizo 🗿 — Discord Backfill + Grounded Index

> The monk's vow: *nothing is invented, nothing is silently lost.*

A faithful, append-only mirror of a Discord channel into SQLite, with a
full-text index — and a `verify` pass that **proves** the mirror still matches
its source. For a second brain, a grounded index that can fabricate is worse
than no index; Jizo's distinctive layer is the integrity proof.

## Run

```bash
python3 backfill.py ingest --db channel.sqlite --source messages.json --channel <id> --complete
python3 backfill.py search --db channel.sqlite 'ระบบ'      # Thai substring recall
python3 backfill.py parity --db channel.sqlite --source messages.json
python3 backfill.py verify --db channel.sqlite             # groundedness proof
python3 -m unittest -v test_backfill                       # 7 tests, stdlib only
```

`messages.json` is a list of Discord messages (`id, author, content, timestamp,
edited?, attachments?`). The export-style and the flat MCP-fetch shapes are both
accepted. `transcript_to_json.py` adapts a raw fetch transcript for the proof run.

## Design decisions

| Concern | Choice | Why |
|---|---|---|
| Timestamp | snowflake `>>22 + 1420070400000` | the id *is* the clock; no extra field to drift |
| Edits | append a new **version** row (PK `msg_id,version`) | Nothing-Deleted — v1 is never overwritten |
| Deletes | append a **tombstone** row (only under `--complete`) | a *partial* snapshot must never tombstone the world |
| Re-ingest | hash-dedup → 0 new rows | idempotent; safe to re-run / resume |
| Parity | source id-set vs alive mirror → missing/extra | a tombstone ≠ a gap; surfaces real drift |
| Thai | PyThaiNLP ZWSP at word boundaries (cluster fallback) | so `ระบบ` is found inside `ระบบแบ็คฟิล`; `unicode61` alone can't |
| **Integrity** | sha256 per row; `verify` re-hashes all | **Jizo's edge** — turns "trust me" into a checkable proof |

## Distinctive: the groundedness proof

Every row stores `content_hash = sha256(tombstone_flag ‖ content)` plus
provenance (channel, batch, fetched_at). `verify` re-hashes every stored version
and reports any mismatch — i.e. it detects if the mirror was mutated out from
under the index. `test_verify_detects_tamper` proves it catches a row edited
directly in SQLite. This is the anti-hallucination guarantee a memory layer needs.

## Proof (real data, raw stdout — no invented images)

See [`proof.txt`](proof.txt): ingests **98 real messages** fetched live from this
workshop channel, re-runs to show `+0 new / =98 idempotent-skips`, `parity
missing=0 extra=0`, Thai search hits, and `verify: 0 integrity failures`. Per the
no-fabricated-images rule, the proof is captured terminal output, not a picture.

## Honest caveats (verified vs not)

- **Scale**: a single MCP fetch caps at ~100 messages (Claude Code has no live
  bot websocket). The pipeline itself is shape-agnostic — the same `ingest` path
  takes a 10k-message REST export unchanged. Demoed at 98; not run at 10k here.
- **Live tailer**: incremental catch-up is by re-ingest (idempotent watermark via
  hash-dedup), not a push websocket. A WS tailer is designed, not built this round.
- **PyThaiNLP** is optional. Without it, Thai recall uses the cluster fallback +
  raw-substring search, which still passes `test_thai_substring_recall`.
- **FTS5**: used when the SQLite build has it (detected at runtime); otherwise the
  index degrades to raw `LIKE` substring search. No hard dependency either way.

— Jizo 🗿 (AI · Rule 6 — not a human)
