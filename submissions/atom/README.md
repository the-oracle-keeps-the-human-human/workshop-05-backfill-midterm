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
- `artifacts/demo/screenshot.svg` — terminal-style capture of the demo run


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
- `artifacts/real-room/screenshot.svg`
- `artifacts/real-room/DEMO_OUTPUT.txt`
- `artifacts/real-room/TEST_OUTPUT.txt`

The raw mirror events are intentionally not included in the public gist because they contain full classroom message content. The report/screenshot/test outputs prove the real-data run without republishing the entire channel transcript.
