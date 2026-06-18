import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildDb, demo, eventsFromDiscordRawMessages, parity, sampleEvents, search, searchable, writeMirror } from "../src/atom-backfill";
import { Database } from "bun:sqlite";

describe("Atom Backfill v4 proof", () => {
  test("mirror imports into SQLite and passes parity", () => {
    const root = mkdtempSync(join(tmpdir(), "atom-backfill-"));
    try {
      writeMirror(root, sampleEvents());
      buildDb(root);
      const p = parity(root);
      expect(p.ok).toBe(true);
      expect(p.expected_events).toBe(6);
      expect(p.missing).toEqual([]);
      expect(p.extra).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Nothing is Deleted keeps updates and tombstones as events", () => {
    const root = mkdtempSync(join(tmpdir(), "atom-backfill-"));
    try {
      writeMirror(root, sampleEvents());
      buildDb(root);
      const db = new Database(join(root, "atom-backfill.sqlite"));
      expect((db.query("SELECT count(*) c FROM events WHERE message_id='1002'").get() as any).c).toBe(3);
      expect((db.query("SELECT deleted FROM messages_current WHERE message_id='1004'").get() as any).deleted).toBe(1);
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Thai-ready search finds backfill content", () => {
    const root = mkdtempSync(join(tmpdir(), "atom-backfill-"));
    try {
      writeMirror(root, sampleEvents());
      buildDb(root);
      const rows = search(root, "backfill ต่อเนื่อง");
      expect(rows.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("converts real Discord raw JSONL shape into events", () => {
    const root = mkdtempSync(join(tmpdir(), "atom-backfill-"));
    try {
      const raw = join(root, "raw.jsonl");
      Bun.write(raw, JSON.stringify({ id: "m-real", channel_id: "1512079809021214730", content: "ห้องนี้ทำ data จริงได้", timestamp: "2026-06-19T00:00:00.000Z", author: { id: "u", username: "nazt_" }, attachments: [], reactions: [{ emoji: { name: "✅" }, count: 1 }] }) + "\n");
      const events = eventsFromDiscordRawMessages(raw);
      expect(events.some(e => e.type === "message_create" && e.message_id === "m-real")).toBe(true);
      expect(events.some(e => e.type === "reaction_add")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("demo writes report and screenshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "atom-backfill-"));
    try {
      const r = await demo(root);
      expect(r.report.pcheck.ok).toBe(true);
      expect(r.report.counts.probes).toBe(1);
      expect(r.lines.join("\n")).toContain("parity_ok=true");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("searchable keeps Thai raw text and adds tokens", () => {
    const s = searchable("โหลดข้อมูลต่อเนื่อง");
    expect(s).toContain("โหลดข้อมูลต่อเนื่อง");
    expect(s.length).toBeGreaterThan("โหลดข้อมูลต่อเนื่อง".length);
  });
});
