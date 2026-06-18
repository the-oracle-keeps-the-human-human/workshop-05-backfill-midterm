# Atom Backfill v4 Proof Report

- parity_ok: true
- events: 8517
- current_messages: 4213
- attachments: 536
- permission_probes: 1
- secret_quarantine: 4
- search_hits_for_backfill: 10

## Why this is beyond Kikyo

- Adds warm-sync-ready event envelopes and permission probes.
- Preserves edit/delete/reaction as append-only events.
- Adds oracle/session/channel/thread scope.
- Keeps raw mirror and derived indexes rebuildable.
- Adds Thai-ready searchable text without requiring external dependencies.
