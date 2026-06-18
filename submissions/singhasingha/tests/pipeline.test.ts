import { test, expect } from "bun:test";
import { openDb, upsertMessage, tombstone, snowflakeTs, getCursor, setCursor } from "../src/db.ts";
import { verifyParity } from "../src/parity.ts";
import { buildIndex, search } from "../src/search.ts";
import { backfill } from "../src/backfill.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function tmp() { return mkdtempSync(join(tmpdir(), "singbf-")); }
const msg = (id: string, content: string, extra: any = {}) =>
  ({ id, timestamp: new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString(), author: { id: "u1", username: "tester" }, content, ...extra });

test("snowflake → timestamp decode", () => {
  expect(snowflakeTs("1517297050926977180")).toMatch(/^2026-/);
});

test("idempotent upsert: re-insert same id = 'same', no dup", () => {
  const db = openDb(join(tmp(), "t.sqlite"));
  expect(upsertMessage(db, { id: "1", channel_id: "c", content: "x", source: "backfill", raw: {} })).toBe("insert");
  expect(upsertMessage(db, { id: "1", channel_id: "c", content: "x", source: "backfill", raw: {} })).toBe("same");
  expect((db.query("SELECT count(*) c FROM messages").get() as any).c).toBe(1);
  db.close();
});

test("edit-versioning: content change keeps full history (Nothing is Deleted)", () => {
  const db = openDb(join(tmp(), "t.sqlite"));
  upsertMessage(db, { id: "1", channel_id: "c", content: "v1", source: "live", raw: {} });
  upsertMessage(db, { id: "1", channel_id: "c", content: "v2", source: "live", raw: {} });
  const cur = db.query("SELECT content, version FROM messages WHERE id='1'").get() as any;
  const hist = db.query("SELECT version FROM edit_history WHERE message_id='1'").all() as any[];
  expect(cur.content).toBe("v2"); expect(cur.version).toBe(2); expect(hist.length).toBe(2);
  db.close();
});

test("tombstone: delete preserves the row", () => {
  const db = openDb(join(tmp(), "t.sqlite"));
  upsertMessage(db, { id: "1", channel_id: "c", content: "x", source: "live", raw: {} });
  tombstone(db, "1");
  const r = db.query("SELECT deleted_at, content FROM messages WHERE id='1'").get() as any;
  expect(r.deleted_at).not.toBeNull(); expect(r.content).toBe("x");
  db.close();
});

test("cursor persistence (incremental watermarks)", () => {
  const db = openDb(join(tmp(), "t.sqlite"));
  setCursor(db, { channel_id: "c", backfill_oldest_id: "1", backfill_done: 1, live_newest_id: "9", last_swept_at: "now" });
  const c = getCursor(db, "c");
  expect(c.live_newest_id).toBe("9"); expect(c.backfill_done).toBe(1);
  db.close();
});

test("parity gate PASSES when mirror == db", async () => {
  const dir = tmp(); const dbPath = join(dir, "t.sqlite"); const mirror = join(dir, "mirror");
  const res = await backfill({
    dbPath, mirrorDir: mirror, channelId: "c", channelName: "test",
    source: { kind: "fixture", messages: [msg("100", "hello"), msg("200", "world")] },
  });
  expect(res.parity.ok).toBe(true);
  expect(res.inserted).toBe(2);
  expect(res.indexed?.messages).toBe(2);
});

test("parity gate FAILS + refuses index when db has extra rows not in mirror", async () => {
  const dir = tmp(); const dbPath = join(dir, "t.sqlite"); const mirror = join(dir, "mirror");
  // build a mirror with 1 message
  mkdirSync(join(mirror, "test__c"), { recursive: true });
  writeFileSync(join(mirror, "test__c", "messages.json"), JSON.stringify([{ id: "100" }]));
  // but DB has 2 (inject an extra not in mirror)
  const db = openDb(dbPath);
  upsertMessage(db, { id: "100", channel_id: "c", content: "a", source: "backfill", raw: {} });
  upsertMessage(db, { id: "999", channel_id: "c", content: "ghost", source: "backfill", raw: {} });
  db.close();
  const parity = verifyParity(dbPath, mirror);
  expect(parity.ok).toBe(false);
  expect(parity.extraInDb).toContain("999");
});

test("hybrid search finds inserted content; tombstoned excluded", async () => {
  const dir = tmp(); const dbPath = join(dir, "t.sqlite"); const mirror = join(dir, "mirror");
  await backfill({
    dbPath, mirrorDir: mirror, channelId: "c", channelName: "test",
    source: { kind: "fixture", messages: [msg("100", "unique parity gate keyword"), msg("200", "other stuff")] },
  });
  const hits = search(dbPath, "parity keyword", "hybrid", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].id).toBe("100");
  // tombstone it, rebuild index → gone from search
  const db = openDb(dbPath); tombstone(db, "100"); db.close();
  buildIndex(dbPath);
  expect(search(dbPath, "parity keyword", "fts", 5).find(h => h.id === "100")).toBeUndefined();
});

test("Thai tokenization: word inside a compound is findable (ZWSP fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "singbf-th-")); const dbPath = join(dir, "t.sqlite"); const mirror = join(dir, "mirror");
  await backfill({
    dbPath, mirrorDir: mirror, channelId: "c", channelName: "test",
    source: { kind: "fixture", messages: [msg("100", "ระบบแบ็คฟิลของสิงห์ทำงานได้จริง"), msg("200", "unrelated english text")] },
  });
  // "ระบบ" is embedded with no spaces — unicode61 alone would miss it; ZWSP segmentation finds it
  const hits = search(dbPath, "ระบบ", "fts", 5);
  expect(hits.find(h => h.id === "100")).toBeDefined();
});
