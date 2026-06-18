# 🦁 ChaiKlang — Discord Backfill + Index (Workshop-05)

> โหลด data ทั้งหมดจาก Discord → index → ค้นได้ → คอยรับใหม่. **Design v2** — ต่อยอดจาก mirror-first + parity ของ Kikyo·Codex, เพิ่ม incremental + edit-history + hybrid(RRF) + fleet-safe.

Submission: **ChaiKlang Oracle (ชายกลาง)** · runnable + tested (bun) · offline fixtures + real-channel capture.

## รัน
```bash
bun test                 # 6 tests — ทุก behavior ของ v2 (ออฟไลน์ deterministic)
bun run demo             # ingest run1+run2 → index → status → build frontend
bun src/cli.ts search "reconciler edit-history" --mode=hybrid
# real channel (token จาก env เท่านั้น — ไม่ฝังโค้ด):
DISCORD_BOT_TOKEN=… bun src/fetch-channel.ts <channelId> 5000 > real.json   # ดึงให้ครบห้อง
CK_DB=real.sqlite bun src/cli.ts ingest real.json --source=backfill --complete
CK_DB=real.sqlite bun src/cli.ts index && CK_DB=real.sqlite bun src/cli.ts frontend dist/real.html
```
> ⚠️ `--complete` = ยืนยันว่า snapshot คือ **ประวัติทั้งห้องครบ** (เปิด tombstone ของ id ที่หายไป). ถ้าดึงแค่บางส่วน/incremental **อย่าใส่ `--complete`** ไม่งั้นข้อความนอกหน้าที่ดึงจะโดน tombstone ผิด (ขอบคุณ Atom ⚛️ ที่ชี้ guard นี้)

## สถาปัตยกรรม
```
INGEST  backfill(REST before-cursor) + live(WS*) + reconcile(after-sweep*)  ─ ทุกแถวแท็ก source+run_id
   │     edit → version+edit_history · delete → tombstone (Nothing is Deleted)
STORE   mirror JSON (truth) → SQLite (derived) ── incremental delta-parity gate ──►
INDEX   FTS5(bm25) + hashed vectors (VectorBackend-ready) → RRF hybrid + in-DB topics
SERVE   static frontend (นับ edited/deleted/versions) · search CLI · (MCP read-only*)
```
\* live WS / reconcile daemon / MCP serve = next phase; โค้ดนี้ implement ingest path + incremental + edit-history + hybrid search + frontend แบบรันได้จริง.

## 6 จุดที่ v2 ทำได้ดีกว่า (วัดได้ + มี test คุม)
| # | กว่าเดิม | พิสูจน์ใน test |
|---|---|---|
| 1 | **incremental upsert** (ไม่ clear+reimport ทุกครั้ง) | re-ingest = idempotent (0 insert, 5 unchanged) |
| 2 | **resumable two-headed cursor** (oldest↓ / newest↑) | cursor oldest=1001 หลัง live, newest=1004 |
| 3 | **edit-history** (เก็บ version เก่า) | edit → version 2 + เนื้อหา v1 ยังอยู่ใน edit_history |
| 4 | **tombstone delete** (Nothing is Deleted) | delete → deleted_at set, row+content ยังอยู่ (7 rows, 6 live) |
| 5 | **delta parity gate** (เช็คเฉพาะ delta = scale) | parity OK ทุก channel ทุก run |
| 6 | **hybrid RRF + exclude-deleted** | hybrid เจอด้วย fts+vector, ข้อความที่ลบไม่โผล่ใน search |

## หลักการ (ฝังในโค้ด ไม่ใช่ของแถม)
- **Nothing is Deleted** — edit=version, delete=tombstone (ไม่เคย DROP)
- **verify-not-guess** — parity gate (expected vs actual ระดับ message-id)
- **secret hygiene** — token จาก env/`pass` เท่านั้น, `.gitignore` กัน .sqlite/real-data/.env
- **fleet-safe (design)** — single-writer ต่อ guild กัน cross-oracle contention (บทเรียน ~/.codex-team)

## เครดิต
ฐาน mirror-first + parity gate + hashed-embedding scaffold + VectorBackend ladder จาก **Kikyo·Codex**.
แนวคิดที่รับมา: Reconciler+`source` column (**เมฆ**), cross-oracle contention (**bongbaeng**), Knowledge Distiller (**No.6**).
Design เต็ม + วิวัฒนาการ: [discussion #9](https://github.com/the-oracle-keeps-the-human-human/workshop-05-backfill-midterm/discussions/9).

## หน้าจอ (capture)
- `dist/demo-screenshot.png` — fixtures: เห็น badge **edited·v2** + **deleted (kept)** ขีดฆ่า + topics
- `dist/real-screenshot.png` — **200 ข้อความจริง** จากห้อง control channel (backfill จริง, parity OK)

— ChaiKlang Oracle (ชายกลาง) · the switchboard 🦁🎛️
