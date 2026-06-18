# Atom Submission — Discord Backfill v4 Proof

This is Atom Oracle's runnable proof for Workshop 05 Backfill Midterm.

## What it proves

- Raw mirror first: JSONL proof files are the source layer.
- SQLite/WAL truth: derived DB is rebuildable.
- Parity gate: mirror ↔ DB counts and message ID sets must match.
- Nothing is Deleted: edits/deletes/reactions are event envelopes, not overwrites.
- Oracle-aware scope: messages carry oracle/session/channel/thread scope.
- Permission probes: channel visibility/read/send checks are first-class rows.
- Attachment manifest: attachments are preserved for future extraction.
- Thai-ready search: searchable text is normalized separately from raw content.
- Secret quarantine: scanner reports risk without printing secret values.

## Run

```bash
cd submissions/atom
bun install
bun run demo
bun test
```

## Main files

- `src/atom-backfill.ts` — CLI + implementation
- `tests/atom-backfill.test.ts` — regression tests
- `artifacts/demo/report.md` — generated proof report
- `artifacts/demo/summary-card.svg` — generated terminal-style summary card from the demo run (not a screenshot)


## Real room run

After P'Nat allowed using this classroom channel's real data, Atom ran the proof against archived Discord data for channel `1512079809021214730`.

```bash
bun src/atom-backfill.ts demo-real --source <real-channel-raw-messages.jsonl> --root artifacts/real-room
bun test tests/*.test.ts
```

Observed output:

- real messages: 4,213
- real events after envelopes/reactions/edits/probe: 8,517
- parity: true
- attachments: 536
- search hits for backfill: 10
- tests: 6 pass / 0 fail

Artifacts:

- `artifacts/real-room/report.md`
- `artifacts/real-room/summary-card.svg` — generated terminal-style summary card (not a screenshot)
- `artifacts/real-room/capture.html` — browser-rendered proof page built from real run output
- `artifacts/real-room/real-browser-capture.png` — actual Chrome headless screenshot of `capture.html`
- `artifacts/real-room/DEMO_OUTPUT.txt`
- `artifacts/real-room/TEST_OUTPUT.txt`


### Screenshot correction

Earlier generated SVG proof cards were renamed to `summary-card.svg` so they are not confused with screenshots. The only screenshot artifact Atom claims is `artifacts/real-room/real-browser-capture.png`, produced with:

```bash
google-chrome --headless --no-sandbox --disable-gpu --window-size=1400,1600 \
  --screenshot=artifacts/real-room/real-browser-capture.png \
  file://$PWD/artifacts/real-room/capture.html
```

Sanity check: PNG, `1400 x 1600`, nonzero, non-blank.

The raw mirror events are intentionally not included in the public gist because they contain full classroom message content. The report/screenshot/test outputs prove the real-data run without republishing the entire channel transcript.


## Review response

Atom read the PR comments from Tonk, Vessel, ChaiKlang, and Nova/No.10-style comparative feedback, then made these decisions:

### Fixed now

- **Screenshot clarity** — generated SVG proof cards are named `summary-card.svg`, not screenshot. The real proof image is `artifacts/real-room/real-browser-capture.png`, captured by Chrome headless from `capture.html`.
- **Event ordering** — events now carry `sequence_no` in SQLite, so the append-only log has a stable fold order in addition to timestamp/message IDs.
- **Event ratio explanation** — `4,213 messages → 8,517 events` comes from one `message_create` per message, plus `message_update` for archived edits, `reaction_add` summary events per emoji reaction, and one `permission_probe` event.

### Design choice kept for now

- **Event envelopes vs version rows** — Atom keeps an event-sourcing model. The raw JSONL mirror is the append-only write-ahead/event log, and SQLite tables are rebuildable query views. `messages_current` is the materialized head produced by folding create/update/delete events, so search does not need to fold the whole event log at query time.
- **Permission probes** — this proof stores one archive-time probe because live REST returned `403` in Atom's environment. A production version should re-probe periodically and before export.
- **RRF/hybrid search** — not added in this PR because the submitted implementation is a proof-level FTS/Thai-ready search path. RRF with vector search is a good next phase, but adding a fake vector layer would overclaim.
