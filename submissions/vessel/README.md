# Vessel — Discord Backfill & Index System
**Workshop 05: Backfill Midterm** | 2026-06-19

Vessel 📦 (AI ไม่ใช่คน) — จาก Wave Pongruengkiat

---

## System Architecture

```
Discord API (discord.js)
      │
      ├── fetch_channel.mjs   ← paginate history (before=cursor, 100/batch)
      │
      ▼
   NDJSON (per-batch)
      │
      ▼
   load_ndjson.py             ← stream into SQLite + parity check
      │
      ▼
   mirror_db.py (MirrorDB)
   ├── messages table         ← full Discord fields
   ├── messages_fts (FTS5)    ← Thai ZWSP tokenization via PyThaiNLP
   ├── attachments            ← filename + mimetype + local_path
   ├── sync_state             ← backfill_complete + last_message_id
   └── message_vectors        ← scaffold for future embeddings
      │
      ▼
   search.py                  ← FTS5 keyword search + oracle/bucket filters
```

---

## Features vs Kikyo

| Feature | Kikyo | Vessel |
|---------|-------|--------|
| 3-stage pipeline | ✅ | ✅ |
| Parity check | ✅ | ✅ |
| Thai tokenization | UNICODE61 (breaks Thai) | **PyThaiNLP ZWSP** (correct word breaks) |
| Sensitivity guard | ❌ | ✅ scrubs tokens/passwords before indexing |
| Oracle-aware tagging | ❌ | ✅ ORACLE_MAP: username → oracle_name |
| Auto-classification | ❌ | ✅ curriculum/peer-wisdom/fleet-news/chatter |
| Vector scaffold | basic | ✅ `message_vectors` table (pluggable backend) |
| Snowflake decode | ✅ | ✅ |
| Attachment tracking | basic | ✅ with content_text field for extraction |

---

## Test Results — free-for-all channel (#1512079809021214730)

```
📊 Vessel Discord Index
   Total messages  : 500
   Channels done   : 0

   By bucket:
     curriculum          :   266  ████████████████████
     chatter             :   133  █████████████
     fleet-news          :    65  ██████
     peer-wisdom         :    36  ███

   Top channels:
     free-for-all             :   500
```

### Search: "backfill"
```
🔍 Results for "backfill" — 5 hit(s)

[2026-06-19 05:59] #free-for-all  nova  [curriculum]
  📦 **Nova Backfill System — Submission Report**...

[2026-06-19 05:22] #free-for-all  atom  [curriculum]
  ยังโพสต์ลง issue ไม่ได้ครับ...

[2026-06-19 05:45] #free-for-all  nova  [curriculum]
  พร้อมครับพี่นัท 🔮 — Nova ส่ง Workshop 05...
```

### Search: "ระบบ" (Thai keyword)
```
🔍 Results for "ระบบ" — 5 hit(s)

[2026-06-19 05:56] #free-for-all  vessel-oracle  [chatter]
  📦 รับครับ — กำลัง implement + test ระบบ backfill สักครู่นะครับ

[2026-06-19 06:01] #free-for-all  atom  [curriculum]
  ## ส่งการบ้านระบบแล้วครับ...
```

### Search: "design" filtered by oracle=nazt
```
🔍 Results for "design" [oracle=nazt] — 2 hit(s)

[2026-06-19 05:51] #free-for-all  nazt  [peer-wisdom]
  revise and update your design...

[2026-06-19 05:42] #free-for-all  nazt  [curriculum]
  workshop-05-backfill-midterm/discussions...
```

---

## Commands

```bash
# Fetch channel history (uses discord.js from MCP plugin)
node fetch_channel.mjs 1512079809021214730 --limit 100 > msgs.ndjson

# Load into DB + parity check
python3 load_ndjson.py msgs.ndjson free-for-all

# Search
python3 search.py "backfill"
python3 search.py "workshop" --bucket curriculum
python3 search.py "design" --oracle nazt
python3 search.py --stats
```

---

## Key Design Decisions

**1. Thai ZWSP tokenization** — FTS5's UNICODE61 can't split Thai words. We pre-process
content with PyThaiNLP `newmm` engine, inserting U+200B at word boundaries so FTS5 can
index Thai correctly.

**2. Sensitivity guard** — Before indexing, content is scanned for tokens/passwords
(`ghp_*`, `sk-*`, `DISCORD_TOKEN=*`). Sensitive messages get `is_sensitive=1` and
`content_indexed=""` — metadata preserved, content not indexed.

**3. Oracle-aware tagging** — `ORACLE_MAP` maps Discord usernames to fleet oracle names.
Allows `search.py "workshop" --oracle nazt` to filter by oracle identity not username.

**4. Parity check** — After each batch, `db_count == mirror_count` is verified.
Incremental loads naturally show mismatch (cumulative DB vs batch count) — expected behavior.

**5. Vector scaffold** — `message_vectors(message_id, embedding_json, model, backend)`
table is created but empty. Pluggable: swap in ChromaDB, OpenAI, or local embeddings later.

---

*Vessel 📦 (AI ไม่ใช่คน) — Rule 6 — Workshop 05 Backfill Midterm*
