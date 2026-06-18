/**
 * store.test.ts — พิสูจน์จุดเด่น: Nothing Deleted (append-only versioning + tombstone)
 * รัน: bun test
 * — Tonk Oracle 🌿
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema, upsertMessage, tombstoneMessage, search, history, snowflakeTs, redactSecrets, getCursor, setCursor, shouldReconcileTombstones, type MsgInput } from "../src/store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

const base: MsgInput = {
  id: "1512079809021214730", channelId: "C1", ds: "FreeForAll",
  authorId: "A1", author: "tonk", bot: false,
  content: "hello world", ts: "", attachments: 0,
};

test("create: insert head v1 + 1 version + searchable", () => {
  const db = freshDb();
  const r = upsertMessage(db, base);
  expect(r).toEqual({ op: "create", version: 1 });
  const head = db.query(`SELECT content, version, deleted FROM messages WHERE id=?`).get(base.id) as any;
  expect(head.version).toBe(1);
  expect(head.deleted).toBe(0);
  expect(history(db, base.id)).toHaveLength(1);
  expect(search(db, "hello")).toHaveLength(1);
});

test("idempotent: re-ingest เนื้อหาเดิม = noop, ไม่เกิด version ซ้ำ", () => {
  const db = freshDb();
  upsertMessage(db, base);
  const r = upsertMessage(db, base);
  expect(r.op).toBe("noop");
  expect(history(db, base.id)).toHaveLength(1); // ยังมี version เดียว
});

test("edit: content เปลี่ยน = append version (ประวัติเดิมไม่หาย) + head อัปเดต + fts ตามใหม่", () => {
  const db = freshDb();
  upsertMessage(db, base);
  const r = upsertMessage(db, { ...base, content: "hello universe", editedTs: "2026-06-18T00:00:00Z" });
  expect(r).toEqual({ op: "edit", version: 2 });

  const hist = history(db, base.id);
  expect(hist).toHaveLength(2);
  expect(hist[0].content).toBe("hello world");     // ← ของเดิมยังอยู่ (Nothing Deleted)
  expect(hist[1].content).toBe("hello universe");
  expect(hist[0].op).toBe("create");
  expect(hist[1].op).toBe("edit");

  // head = ล่าสุด · fts หา "universe" เจอ, "world" ไม่เจอ (head เปลี่ยนแล้ว)
  expect(search(db, "universe")).toHaveLength(1);
  expect(search(db, "world")).toHaveLength(0);
});

test("delete: tombstone — row + ประวัติคงอยู่ แต่ไม่โผล่ search", () => {
  const db = freshDb();
  upsertMessage(db, base);
  const r = tombstoneMessage(db, base.id);
  expect(r.op).toBe("delete");

  const head = db.query(`SELECT deleted FROM messages WHERE id=?`).get(base.id) as any;
  expect(head.deleted).toBe(1);                 // tombstone (ไม่ลบ row)
  expect(db.query(`SELECT COUNT(*) n FROM messages`).get() as any).toEqual({ n: 1 });
  expect(history(db, base.id).map((h) => h.op)).toEqual(["create", "delete"]); // ประวัติครบ
  expect(search(db, "hello")).toHaveLength(0);  // ไม่โผล่ search
});

test("edit แล้ว delete: เก็บครบทุก revision (create→edit→delete)", () => {
  const db = freshDb();
  upsertMessage(db, base);
  upsertMessage(db, { ...base, content: "v2" });
  tombstoneMessage(db, base.id);
  expect(history(db, base.id).map((h) => `${h.version}:${h.op}`)).toEqual(["1:create", "2:edit", "3:delete"]);
});

test("secret guard (Vessel review): redact token/key ก่อนเก็บ + ไม่โผล่ search", () => {
  const db = freshDb();
  upsertMessage(db, { ...base, id: "999", content: "my token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ok" });
  const head = db.query(`SELECT content FROM messages WHERE id=?`).get("999") as any;
  expect(head.content).toContain("[REDACTED]");
  expect(head.content).not.toContain("ghp_ABCDEFG");
  expect(redactSecrets("sk-abcdefghijklmnopqrstuvwxyz").redacted).toBe(1);
});

test("cursor persist (Atom/ChaiKlang review): resumable per channel+direction", () => {
  const db = freshDb();
  expect(getCursor(db, "C1", "backfill")).toBeNull();
  setCursor(db, "C1", "backfill", "edge100", 50);
  setCursor(db, "C1", "backfill", "edge200", 30);
  expect(getCursor(db, "C1", "backfill")).toBe("edge200");
  const tot = db.query(`SELECT total FROM cursor WHERE channel_id='C1' AND direction='backfill'`).get() as any;
  expect(tot.total).toBe(80); // สะสมข้าม batch
});

test("tombstone reconcile guard (regression): เฉพาะ full scan — กัน resume ลบทั้งห้อง", () => {
  // bug ที่เจอ: resume-from-cursor → fetch 0 → complete=true แต่ seen ว่าง → จะ tombstone ทั้งห้อง
  expect(shouldReconcileTombstones(true, true)).toBe(true);    // full scan + ถึงต้นห้อง → OK
  expect(shouldReconcileTombstones(false, true)).toBe(false);  // resume run → ห้าม (data-safe)
  expect(shouldReconcileTombstones(true, false)).toBe(false);  // ค้างกลางคัน → ห้าม
});

test("snowflake → created timestamp (id ฝัง ts ที่ >>22)", () => {
  // snowflake นี้ = 2022-01-... ขึ้นไป (หลัง DISCORD_EPOCH 2015) → ปีต้องสมเหตุผล
  const iso = snowflakeTs("1512079809021214730");
  expect(new Date(iso).getUTCFullYear()).toBeGreaterThanOrEqual(2025);
});
