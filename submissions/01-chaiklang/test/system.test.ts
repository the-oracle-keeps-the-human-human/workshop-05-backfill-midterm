// system.test.ts — proves the 6 Design-v2 behaviours end-to-end (offline, deterministic).
import { test, expect } from "bun:test";
import { openDb } from "../src/db";
import { ingestSnapshot, deltaParity, type Snapshot } from "../src/ingest";
import { buildIndex, search } from "../src/search";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const RUN1 = JSON.parse(readFileSync(new URL("../fixtures/run1.json", import.meta.url))) as Snapshot;
const RUN2 = JSON.parse(readFileSync(new URL("../fixtures/run2.json", import.meta.url))) as Snapshot;
let dbN = 0;
const freshDb = () => openDb(join(tmpdir(), `ck-test-${process.pid}-${dbN++}.sqlite`));

test("backfill ingests every message + delta parity passes", () => {
  const db = freshDb();
  const st = ingestSnapshot(db, RUN1, { source: "backfill", runId: "r1", completeChannelSnapshot: true });
  expect(st.inserted).toBe(5);
  for (const ch of RUN1.channels) expect(deltaParity(db, ch).ok).toBe(true);
  expect((db.query("SELECT count(*) c FROM messages").get() as any).c).toBe(5);
});

test("re-ingest is idempotent (no dupes, all unchanged)", () => {
  const db = freshDb();
  ingestSnapshot(db, RUN1, { source: "backfill", runId: "r1" });
  const st = ingestSnapshot(db, RUN1, { source: "backfill", runId: "r1b" });
  expect(st.inserted).toBe(0);
  expect(st.unchanged).toBe(5);
  expect((db.query("SELECT count(*) c FROM messages").get() as any).c).toBe(5);
});

test("incremental run2: insert new, edit keeps history, delete tombstones (Nothing is Deleted)", () => {
  const db = freshDb();
  ingestSnapshot(db, RUN1, { source: "backfill", runId: "r1", completeChannelSnapshot: true });
  const st = ingestSnapshot(db, RUN2, { source: "reconcile", runId: "r2", completeChannelSnapshot: true });
  expect(st.inserted).toBe(2);   // 1004 + 2003
  expect(st.edited).toBe(1);     // 1002 changed
  expect(st.deleted).toBe(1);    // 1003 removed → tombstone

  // edit history preserved
  const edited = db.query("SELECT version, content FROM messages WHERE id='1002'").get() as any;
  expect(edited.version).toBe(2);
  expect(edited.content).toContain("v2");
  const hist = db.query("SELECT content FROM edit_history WHERE message_id='1002'").get() as any;
  expect(hist.content).toContain("v1");   // original still recoverable

  // delete is a tombstone, NOT a row drop
  const gone = db.query("SELECT deleted_at, content FROM messages WHERE id='1003'").get() as any;
  expect(gone.deleted_at).not.toBeNull();
  expect(gone.content).toContain("oops"); // content still there
  expect((db.query("SELECT count(*) c FROM messages").get() as any).c).toBe(7); // 5+2 rows; nothing physically removed
  expect((db.query("SELECT count(*) c FROM messages WHERE deleted_at IS NULL").get() as any).c).toBe(6); // 6 live
});

test("two-headed cursor extends outward + resumable", () => {
  const db = freshDb();
  ingestSnapshot(db, RUN1, { source: "backfill", runId: "r1" });
  ingestSnapshot(db, RUN2, { source: "live", runId: "r2" });
  const cur = db.query("SELECT * FROM cursor WHERE channel_id='100'").get() as any;
  expect(cur.backfill_oldest_id).toBe("1001"); // oldest stays oldest
  expect(cur.live_newest_id).toBe("1004");     // newest advanced
});

test("hybrid search (RRF) finds by exact term AND excludes deleted", () => {
  const db = freshDb();
  ingestSnapshot(db, RUN1, { source: "backfill", runId: "r1", completeChannelSnapshot: true });
  ingestSnapshot(db, RUN2, { source: "reconcile", runId: "r2", completeChannelSnapshot: true });
  buildIndex(db);
  const hits = search(db, "reconciler edit-history", "hybrid", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].content).toContain("reconciler");
  // deleted message must not surface in search
  const all = search(db, "oops", "hybrid", 10);
  expect(all.find((h) => h.id === "1003")).toBeUndefined();
});

test("fts and vector modes both return results", () => {
  const db = freshDb();
  ingestSnapshot(db, RUN1, { source: "backfill", runId: "r1" });
  buildIndex(db);
  expect(search(db, "parity", "fts", 5).length).toBeGreaterThan(0);
  expect(search(db, "vector search embeddings", "vector", 5).length).toBeGreaterThan(0);
});
