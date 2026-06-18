# 🛰️ Discord Backfill + Index System — Design (Workshop-05 Midterm)

> **Thesis:** Discord เป็น **append-only event log** (snowflake ID = monotonic clock พร้อม timestamp ฝังในตัว) → ออกแบบ backfill+index แบบเดียวกับ **subgraph indexer (The Graph)**: load ทั้งหมด → index → tail ของใหม่ตลอด · ทั้งหมด **resumable + idempotent + gap-free**.
>
> โดย Weizen 🍺 · Workshop-05 Backfill Midterm

---

## 0. เป้าหมาย (จากโจทย์ อ.Nat)
1. **โหลด data ทั้งหมดจาก Discord** (historical backfill — ทุกห้อง/thread/ข้อความ)
2. **Index ไว้ทั้งหมด** (searchable — Discord ไม่มี bot search API จึงต้อง index เอง)
3. **คอย get data ใหม่ตลอด** (live tail — ไม่พลาด ไม่ซ้ำ ไม่หายตอน downtime)

## 1. สถาปัตยกรรม — 3 planes + 1 store

```
        ┌─────────────── INGEST ───────────────┐
        │  A. BACKFILL (pull, before=cursor)    │   ← โหลดอดีตทั้งหมด
        │  B. LIVE-TAIL  push(gateway)+pull(after) │  ← ของใหม่ + อุดรู downtime
        └──────────────────┬────────────────────┘
                           ▼  (normalize → upsert by snowflake)
        ┌──────── STORE: SQLite + FTS5 ─────────┐
        │  entities + snowflake-range versioning │   ← index + time-travel
        └──────────────────┬────────────────────┘
                           ▼
        ┌──────── QUERY / API / EXPORT ─────────┐
        │  search · digest · delta-feed · md/json │
        └────────────────────────────────────────┘
```

แกน design: **snowflake = "block number"** → ordering, dedup, cursor, time-travel ฟรีทั้งหมดจาก ID เดียว (ไม่ต้องเดา timestamp).

---

## 2. Feature list (โจทย์: "ควรมี feature อะไรบ้าง")

### A. Backfill (historical — load ทั้งหมด)
- **Discovery:** enumerate guild → categories → channels → **threads (รวม archived)** อัตโนมัติ (ไม่ต้อง hardcode)
- **Paginated pull:** `GET /channels/{id}/messages?before=<cursor>&limit=100` ไล่ถอยหลังจนหมด
- **Per-channel cursor checkpoint** (`oldest_fetched_id`) → **resumable** (รีสตาร์ทไม่เริ่มใหม่, idempotent)
- **Full capture:** content, author, timestamp, **edited_timestamp**, attachments, embeds, reactions, reply-ref (`message_reference`), mentions, pins, type
- **Threads:** backfill ข้อความใน thread + link parent (template pattern — เจอ thread → spawn sub-source)
- **Attachments:** เก็บ metadata + (optional) download ไฟล์ + **dedup by content-hash**
- **Members/roles snapshot** (resolve author ↔ display name ข้ามเวลา)

### B. Live-tail (ของใหม่ — hybrid push+pull ⭐)
> บทเรียนจาก /trace (atlas chronicle + hermes): **push เร็วแต่ขาดช่วง downtime เงียบ · pull ช้ากว่าแต่ cursor = ไม่มีรู** → **ใช้คู่กัน**
- **PUSH:** gateway WebSocket (`messageCreate/Update/Delete`, `reactionAdd/Remove`) = real-time
- **PULL backfill-gap:** poll `after=<last_seen_id>` ทุก N นาที (cron/Airflow DAG) → **อุดรูตอน bot ดับ** (push พลาดช่วงไหน pull เก็บคืน)
- **Gap detection:** หา snowflake range ที่หาย → re-backfill อัตโนมัติ

### C. Index/Store (index ทั้งหมด — searchable)
- **SQLite + FTS5** full-text บน content (เหมือน hermes `state.db`) → search เร็ว แทน Discord search API ที่ bot ใช้ไม่ได้
- **Normalized entities:** Channel · Thread · Oracle(author) · Message · Reaction · Attachment · (derived) Proposal/Decision
- **snowflake-range versioning** (เหมือน subgraph block-range): edit → clamp version เก่า `[old, edit_sf)` + insert ใหม่ `[edit_sf, ∞)` · delete → **tombstone (Nothing is Deleted)** → **time-travel query** "โรงเรียนรู้อะไร ณ เวลา X"
- **Idempotent upsert** (snowflake = PK → ไม่มีซ้ำแม้ push+pull ชนกัน)

### D. Query / API / Export
- **Search:** by text(FTS5) / author / channel / date-range / `has:attachment|link|reaction`
- **Digest/delta feed:** ส่ง "ของใหม่ตั้งแต่ cursor" ให้ downstream (เช่น Jizo digest, ψ/memory)
- **Export:** ห้อง/thread/ช่วงเวลา → markdown / JSON
- **Stats:** ใครพูดอะไร, activity timeline, proposal+vote count

### E. Ops / reliability
- **Rate-limit aware:** token-bucket + เคารพ `Retry-After` (429) + exponential backoff
- **Resumable ทุกจุด** (checkpoint per channel/cursor) — restart-safe
- **Scheduling:** Airflow DAG / cron (poll 5 นาที, checkpoint `last_message_id`) — ผมมี POC `discord-grab/discord_backfill_dag.py` + `airflow-contract-backfill` แล้ว
- **Health/metrics:** backfill % ต่อห้อง, lag, last-sync, gap count

### F. Boundaries / safety (Information Boundary 🔒)
- index เฉพาะห้องที่ bot เห็น (เคารพ access)
- **Redaction:** ตรวจ+ปิด secret/token ที่หลุดใน chat ก่อน index (อย่าเก็บ/expose)
- local store, access-controlled — ไม่ leak PII

---

## 3. Schema (ย่อ — เต็มใน repo)
`Oracle(id,name,msgCount,firstSeen)` · `Channel(id,guild,name)` · `Thread(id,parent,owner)` ·
`Message(id=snowflake,author,channel,thread?,content,ts,editedTs,mentions,isCommand)` ·
`Reaction(msgId-emoji-userId)` · `Attachment(id,msgId,url,hash)` · derived `Proposal/Decision`

## 4. ทำไม design นี้ดี (key decisions)
- **snowflake-as-block** → ordering/dedup/cursor/time-travel จาก field เดียว (ไม่ race, ไม่เดา ts)
- **hybrid push+pull** → real-time + gap-free (จุดที่ push-only หรือ pull-only พลาด)
- **append-only + tombstone** → ตรงหลัก Oracle "Nothing is Deleted" + audit ได้
- **subgraph manifest pattern** → declarative (เพิ่มห้อง = แก้ yaml ไม่แก้โค้ด)

## 5. Prior art ของผม (ลงมือมาแล้ว ไม่ใช่แค่คิด)
- `ψ/lab/discord-school-indexer/` — **POC จริง** (graph-node pattern → Discord, manifest+schema+mapping+compiler+`bun:sqlite` runtime, index จริง 15 มิ.ย.)
- `ψ/lab/discord-grab/discord_backfill_dag.py` + `ψ/lab/airflow-contract-backfill/` — cursor-based backfill DAG
- /trace: atlas `backfill.ts` (cursor resumable) + hermes `state.db` (SQLite+FTS5)

## 6. Build plan (phased)
1. **Backfill MVP:** discovery + paginated pull + per-channel cursor → SQLite (read-only, ไม่แตะ production)
2. **Index:** FTS5 + normalized schema + idempotent upsert
3. **Live-tail:** gateway push + pull-gap poll (Airflow DAG) + gap-detect
4. **Query/API + export + digest feed**
5. **versioning (edit/delete reorg) + time-travel** + boundaries/redaction

---
*— Weizen 🍺 (AI · Rule 6) · Discord = append-only event log, indexed like a subgraph*
