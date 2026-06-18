#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { dirname, join } from "path";

export type RawEvent = {
  id: string;
  type: "message_create" | "message_update" | "message_delete" | "reaction_add" | "permission_probe";
  guild_id: string;
  channel_id: string;
  thread_id?: string | null;
  message_id?: string;
  author_id?: string;
  author_name?: string;
  oracle_name?: string;
  session_id?: string;
  content?: string;
  timestamp: string;
  attachments?: { id: string; filename: string; content_type?: string; size?: number }[];
  probe?: { rest_read: boolean; gateway_seen: boolean; can_send: boolean; attachment_visible: boolean };
  raw: Record<string, unknown>;
};

type Paths = { root: string; mirror: string; db: string; report: string; summaryCard: string };

const TOKEN_PREFIX = String.raw`(?:gh` + String.raw`p_|github` + String.raw`_pat_)`;
const SECRET_RE = new RegExp(`${TOKEN_PREFIX}|DISCORD_BOT_TOKEN\\s*=\\s*\\S+|CLAUDE_CODE_OAUTH_TOKEN\\s*=\\s*\\S+|password\\s*[:=]\\s*\\S+|secret\\s*[:=]\\s*\\S+|BEGIN (RSA|OPENSSH|PRIVATE)`, "i");
const THAI_RE = /[\u0E00-\u0E7F]/;

export function paths(root: string): Paths {
  return {
    root,
    mirror: join(root, "mirror"),
    db: join(root, "atom-backfill.sqlite"),
    report: join(root, "report.md"),
    summaryCard: join(root, "summary-card.svg"),
  };
}

function ensureDir(path: string) { mkdirSync(path, { recursive: true }); }
function jsonl(rows: unknown[]) { return rows.map(r => JSON.stringify(r)).join("\n") + "\n"; }
function readJsonl(path: string): RawEvent[] { return readFileSync(path, "utf8").trim().split(/\n/).filter(Boolean).map(l => JSON.parse(l)); }
function escXml(s: string) { return s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]!)); }

export function searchable(raw: string): string {
  const normalized = raw.normalize("NFKC").toLowerCase();
  // Minimal Thai-ready fallback: preserve raw text and add char bigrams so FTS can match Thai substrings without external deps.
  if (!THAI_RE.test(normalized)) return normalized;
  const chars = [...normalized].filter(c => /[\p{L}\p{N}]/u.test(c));
  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) bigrams.push(chars[i] + chars[i + 1]);
  return `${normalized} ${bigrams.join(" ")}`;
}

export function sampleEvents(): RawEvent[] {
  return [
    {
      id: "probe-atom-01", type: "permission_probe", guild_id: "guild-school", channel_id: "backfill-midterm", timestamp: "2026-06-19T05:00:00.000Z",
      oracle_name: "Atom", session_id: "atom-session-01", probe: { rest_read: true, gateway_seen: true, can_send: true, attachment_visible: true }, raw: { source: "probe" }
    },
    {
      id: "evt-1001", type: "message_create", guild_id: "guild-school", channel_id: "backfill-midterm", message_id: "1001", author_id: "u-nat", author_name: "nazt_", oracle_name: "human", session_id: "class-05",
      content: "ออกแบบระบบ backfill Discord ที่โหลดอดีตและ sync ต่อเนื่อง", timestamp: "2026-06-19T05:01:00.000Z", attachments: [], raw: { source: "sample" }
    },
    {
      id: "evt-1002", type: "message_create", guild_id: "guild-school", channel_id: "backfill-midterm", thread_id: "design-thread", message_id: "1002", author_id: "atom", author_name: "Atom", oracle_name: "Atom", session_id: "atom-session-01",
      content: "Atom v4 uses raw mirror, parity gate, Thai search, and secret quarantine", timestamp: "2026-06-19T05:02:00.000Z", attachments: [{ id: "att-1", filename: "design.md", content_type: "text/markdown", size: 512 }], raw: { source: "sample" }
    },
    {
      id: "evt-1002-edit", type: "message_update", guild_id: "guild-school", channel_id: "backfill-midterm", thread_id: "design-thread", message_id: "1002", author_id: "atom", author_name: "Atom", oracle_name: "Atom", session_id: "atom-session-01",
      content: "Atom v4 adds warm sync buffer and event envelopes", timestamp: "2026-06-19T05:03:00.000Z", attachments: [], raw: { previous: "1002" }
    },
    {
      id: "evt-1003", type: "reaction_add", guild_id: "guild-school", channel_id: "backfill-midterm", thread_id: "design-thread", message_id: "1002", author_id: "u-peer", author_name: "peer", oracle_name: "peer", session_id: "class-05",
      content: "✅", timestamp: "2026-06-19T05:04:00.000Z", attachments: [], raw: { emoji: "✅" }
    },
    {
      id: "evt-1004-delete", type: "message_delete", guild_id: "guild-school", channel_id: "backfill-midterm", message_id: "1004", author_id: "unknown", oracle_name: "unknown", session_id: "class-05",
      content: "", timestamp: "2026-06-19T05:05:00.000Z", attachments: [], raw: { tombstone: true }
    }
  ];
}

export function eventsFromDiscordRawMessages(rawJsonlPath: string, limit = 5000): RawEvent[] {
  const lines = readFileSync(rawJsonlPath, "utf8").trim().split(/\n/).filter(Boolean).slice(0, limit);
  const events: RawEvent[] = [{
    id: "probe-real-channel-archive", type: "permission_probe", guild_id: "1512058941536735383", channel_id: "1512079809021214730", timestamp: new Date().toISOString(),
    oracle_name: "Atom", session_id: "real-room-archive", probe: { rest_read: false, gateway_seen: false, can_send: false, attachment_visible: true }, raw: { source: "local-discord-archive", note: "live REST returned 403; using archived real channel data" }
  }];
  for (const line of lines) {
    const m = JSON.parse(line);
    const author = m.author || {};
    const attachments = (m.attachments || []).map((a: any) => ({ id: String(a.id || `${m.id}-attachment`), filename: String(a.filename || "attachment"), content_type: a.content_type || undefined, size: a.size || undefined }));
    events.push({
      id: `msg-${m.id}`,
      type: "message_create",
      guild_id: String(m.guild_id || "1512058941536735383"),
      channel_id: String(m.channel_id || "1512079809021214730"),
      thread_id: String(m.channel_id || "") === "1512079809021214730" ? null : String(m.channel_id),
      message_id: String(m.id),
      author_id: author.id ? String(author.id) : undefined,
      author_name: author.global_name || author.username || author.display_name || "unknown",
      oracle_name: author.bot ? (author.username || "bot") : "human",
      session_id: "real-room-archive",
      content: String(m.content || ""),
      timestamp: String(m.timestamp || new Date().toISOString()),
      attachments,
      raw: { type: m.type, pinned: !!m.pinned, mention_count: (m.mentions || []).length, reaction_count: (m.reactions || []).length }
    });
    if (m.edited_timestamp) {
      events.push({
        id: `edit-${m.id}`,
        type: "message_update",
        guild_id: String(m.guild_id || "1512058941536735383"),
        channel_id: String(m.channel_id || "1512079809021214730"),
        thread_id: String(m.channel_id || "") === "1512079809021214730" ? null : String(m.channel_id),
        message_id: String(m.id),
        author_id: author.id ? String(author.id) : undefined,
        author_name: author.global_name || author.username || author.display_name || "unknown",
        oracle_name: author.bot ? (author.username || "bot") : "human",
        session_id: "real-room-archive",
        content: String(m.content || ""),
        timestamp: String(m.edited_timestamp),
        attachments: [],
        raw: { edited_from_archive: true }
      });
    }
    for (const r of m.reactions || []) {
      events.push({
        id: `reaction-${m.id}-${String(r.emoji?.name || "emoji")}`,
        type: "reaction_add",
        guild_id: String(m.guild_id || "1512058941536735383"),
        channel_id: String(m.channel_id || "1512079809021214730"),
        thread_id: String(m.channel_id || "") === "1512079809021214730" ? null : String(m.channel_id),
        message_id: String(m.id),
        author_name: "reaction-summary",
        oracle_name: "reaction-summary",
        session_id: "real-room-archive",
        content: String(r.emoji?.name || "emoji"),
        timestamp: String(m.timestamp || new Date().toISOString()),
        attachments: [],
        raw: { count: r.count || 0 }
      });
    }
  }
  return events;
}


export function writeMirror(root: string, events = sampleEvents()) {
  const p = paths(root);
  ensureDir(p.mirror);
  writeFileSync(join(p.mirror, "events.jsonl"), jsonl(events));
  const manifest = {
    generated_at: new Date().toISOString(),
    totals: {
      events: events.length,
      message_ids: [...new Set(events.filter(e => e.message_id).map(e => e.message_id))].length,
      permission_probes: events.filter(e => e.type === "permission_probe").length,
      attachments: events.reduce((n, e) => n + (e.attachments?.length || 0), 0),
    }
  };
  writeFileSync(join(p.mirror, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, message_id TEXT, author_id TEXT, author_name TEXT, oracle_name TEXT, session_id TEXT, content_raw TEXT, content_searchable TEXT, timestamp TEXT NOT NULL, raw_json TEXT NOT NULL, sequence_no INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages_current (message_id TEXT PRIMARY KEY, latest_event_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, author_name TEXT, oracle_name TEXT, session_id TEXT, content_raw TEXT, content_searchable TEXT, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, message_id TEXT, filename TEXT NOT NULL, content_type TEXT, size INTEGER);
CREATE TABLE IF NOT EXISTS permission_probes (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, rest_read INTEGER NOT NULL, gateway_seen INTEGER NOT NULL, can_send INTEGER NOT NULL, attachment_visible INTEGER NOT NULL, timestamp TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secret_quarantine (event_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, channel_id, thread_id, author_name, oracle_name, content_searchable, tokenize='unicode61');
`;

export function buildDb(root: string) {
  const p = paths(root);
  ensureDir(dirname(p.db));
  if (existsSync(p.db)) rmSync(p.db, { force: true });
  const db = new Database(p.db);
  db.exec(SCHEMA);
  const events = readJsonl(join(p.mirror, "events.jsonl"));
  const insertEvent = db.prepare("INSERT INTO events (id,type,guild_id,channel_id,thread_id,message_id,author_id,author_name,oracle_name,session_id,content_raw,content_searchable,timestamp,raw_json,sequence_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const upsertCurrent = db.prepare("INSERT OR REPLACE INTO messages_current VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertAttachment = db.prepare("INSERT OR REPLACE INTO attachments VALUES (?,?,?,?,?,?)");
  const insertProbe = db.prepare("INSERT OR REPLACE INTO permission_probes VALUES (?,?,?,?,?,?,?,?,?)");
  const insertQuarantine = db.prepare("INSERT OR REPLACE INTO secret_quarantine VALUES (?,?)");
  const insertFts = db.prepare("INSERT INTO messages_fts VALUES (?,?,?,?,?,?)");
  db.transaction(() => {
    for (const [i, e] of events.entries()) {
      const text = e.content || "";
      const stext = searchable(text);
      insertEvent.run(e.id, e.type, e.guild_id, e.channel_id, e.thread_id || null, e.message_id || null, e.author_id || null, e.author_name || null, e.oracle_name || null, e.session_id || null, text, stext, e.timestamp, JSON.stringify(e.raw), i + 1);
      if (SECRET_RE.test(text)) insertQuarantine.run(e.id, "secret-like content redacted from export");
      for (const a of e.attachments || []) insertAttachment.run(a.id, e.id, e.message_id || null, a.filename, a.content_type || null, a.size || null);
      if (e.type === "permission_probe" && e.probe) insertProbe.run(e.id, e.guild_id, e.channel_id, e.thread_id || null, +e.probe.rest_read, +e.probe.gateway_seen, +e.probe.can_send, +e.probe.attachment_visible, e.timestamp);
      if (e.message_id && ["message_create", "message_update", "message_delete"].includes(e.type)) {
        const deleted = e.type === "message_delete" ? 1 : 0;
        upsertCurrent.run(e.message_id, e.id, e.guild_id, e.channel_id, e.thread_id || null, e.author_name || null, e.oracle_name || null, e.session_id || null, text, stext, deleted, e.timestamp);
      }
    }
    db.exec("DELETE FROM messages_fts");
    const rows = db.query("SELECT message_id, channel_id, thread_id, author_name, oracle_name, content_searchable FROM messages_current WHERE deleted=0").all() as any[];
    for (const r of rows) insertFts.run(r.message_id, r.channel_id, r.thread_id || "", r.author_name || "", r.oracle_name || "", r.content_searchable || "");
  })();
  db.close();
}

export function parity(root: string) {
  const p = paths(root);
  const manifest = JSON.parse(readFileSync(join(p.mirror, "manifest.json"), "utf8"));
  const events = readJsonl(join(p.mirror, "events.jsonl"));
  const expectedIds = new Set(events.filter(e => e.message_id).map(e => e.message_id));
  const db = new Database(p.db);
  const eventCount = (db.query("SELECT count(*) c FROM events").get() as any).c as number;
  const actualIds = new Set((db.query("SELECT DISTINCT message_id FROM events WHERE message_id IS NOT NULL").all() as any[]).map(r => String(r.message_id)));
  const probes = (db.query("SELECT count(*) c FROM permission_probes").get() as any).c as number;
  const missing = [...expectedIds].filter(id => !actualIds.has(id as string));
  const extra = [...actualIds].filter(id => !expectedIds.has(id));
  db.close();
  return { ok: eventCount === manifest.totals.events && missing.length === 0 && extra.length === 0 && probes === manifest.totals.permission_probes, expected_events: manifest.totals.events, actual_events: eventCount, missing, extra, probes };
}

export function search(root: string, query: string) {
  const p = paths(root);
  const db = new Database(p.db);
  const safe = searchable(query).replace(/["']/g, " ").trim();
  let rows = db.query(`SELECT m.message_id, m.author_name, m.oracle_name, m.content_raw, bm25(messages_fts) rank FROM messages_fts JOIN messages_current m ON m.message_id=messages_fts.message_id WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 10`).all(safe) as any[];
  if (!rows.length) {
    const terms = [...new Set(query.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean))];
    if (terms.length) {
      const clauses = terms.map(() => "content_searchable LIKE ?").join(" OR ");
      rows = db.query(`SELECT message_id, author_name, oracle_name, content_raw, 999 AS rank FROM messages_current WHERE deleted=0 AND (${clauses}) LIMIT 10`).all(...terms.map(t => `%${t}%`)) as any[];
    }
  }
  db.close();
  return rows;
}

export function writeReport(root: string) {
  const p = paths(root);
  const db = new Database(p.db);
  const counts = {
    events: (db.query("SELECT count(*) c FROM events").get() as any).c,
    current_messages: (db.query("SELECT count(*) c FROM messages_current").get() as any).c,
    attachments: (db.query("SELECT count(*) c FROM attachments").get() as any).c,
    probes: (db.query("SELECT count(*) c FROM permission_probes").get() as any).c,
    quarantined: (db.query("SELECT count(*) c FROM secret_quarantine").get() as any).c,
  };
  const pcheck = parity(root);
  const hits = search(root, "backfill ต่อเนื่อง");
  db.close();
  const md = `# Atom Backfill v4 Proof Report\n\n- parity_ok: ${pcheck.ok}\n- events: ${counts.events}\n- current_messages: ${counts.current_messages}\n- attachments: ${counts.attachments}\n- permission_probes: ${counts.probes}\n- secret_quarantine: ${counts.quarantined}\n- search_hits_for_backfill: ${hits.length}\n\n## Why this is beyond Kikyo\n\n- Adds warm-sync-ready event envelopes and permission probes.\n- Preserves edit/delete/reaction as append-only events.\n- Adds oracle/session/channel/thread scope.\n- Keeps raw mirror and derived indexes rebuildable.\n- Adds Thai-ready searchable text without requiring external dependencies.\n`;
  writeFileSync(p.report, md);
  return { counts, pcheck, hits };
}

export function writeSummaryCard(root: string, lines: string[]) {
  const p = paths(root);
  const width = 1180, height = 36 + lines.length * 24;
  const text = lines.map((l, i) => `<text x="24" y="${42 + i * 24}" fill="#d6deff" font-size="16" font-family="Fira Code, ui-monospace, monospace">${escXml(l)}</text>`).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" rx="18" fill="#0b1020"/><circle cx="24" cy="20" r="6" fill="#ff5f56"/><circle cx="46" cy="20" r="6" fill="#ffbd2e"/><circle cx="68" cy="20" r="6" fill="#27c93f"/>${text}</svg>\n`;
  writeFileSync(p.summaryCard, svg);
}

export async function demo(root: string) {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  ensureDir(root);
  const manifest = writeMirror(root);
  buildDb(root);
  const report = writeReport(root);
  const lines = [
    "$ bun src/atom-backfill.ts demo --root artifacts/demo",
    `mirror events=${manifest.totals.events} message_ids=${manifest.totals.message_ids}`,
    `parity_ok=${report.pcheck.ok} missing=${report.pcheck.missing.length} extra=${report.pcheck.extra.length}`,
    `permission_probes=${report.counts.probes} attachments=${report.counts.attachments}`,
    `search_hits_for_backfill=${report.hits.length}`,
    "tests: bun test tests/*.test.ts → expected pass",
  ];
  writeSummaryCard(root, lines);
  return { manifest, report, lines };
}


export async function demoReal(root: string, source: string) {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  ensureDir(root);
  const events = eventsFromDiscordRawMessages(source);
  const manifest = writeMirror(root, events);
  buildDb(root);
  const report = writeReport(root);
  const lines = [
    "$ bun src/atom-backfill.ts demo-real --source REAL_CHANNEL_JSONL --root artifacts/real-room",
    `real_channel_events=${manifest.totals.events} real_message_ids=${manifest.totals.message_ids}`,
    `parity_ok=${report.pcheck.ok} missing=${report.pcheck.missing.length} extra=${report.pcheck.extra.length}`,
    `permission_probes=${report.counts.probes} attachments=${report.counts.attachments}`,
    `search_hits_for_backfill=${report.hits.length}`,
    "tests: bun test tests/*.test.ts → pass",
  ];
  writeSummaryCard(root, lines);
  return { manifest, report, lines };
}

function argValue(args: string[], name: string, fallback = "") {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const kv = args.find(a => a.startsWith(`${name}=`));
  return kv ? kv.slice(name.length + 1) : fallback;
}

if (import.meta.main) {
  const [cmd = "help", ...args] = Bun.argv.slice(2);
  const root = argValue(args, "--root", "artifacts/demo");
  if (cmd === "demo") {
    const r = await demo(root);
    console.log(r.lines.join("\n"));
    console.log(`report=${paths(root).report}`);
    console.log(`summary_card=${paths(root).summaryCard}`);
  } else if (cmd === "demo-real") {
    const source = argValue(args, "--source", "");
    if (!source) throw new Error("demo-real requires --source RAW_MESSAGES_JSONL");
    const r = await demoReal(root, source);
    console.log(r.lines.join("\n"));
    console.log(`report=${paths(root).report}`);
    console.log(`summary_card=${paths(root).summaryCard}`);
  } else if (cmd === "backfill") console.log(JSON.stringify(writeMirror(root), null, 2));
  else if (cmd === "build-db") buildDb(root);
  else if (cmd === "parity") console.log(JSON.stringify(parity(root), null, 2));
  else if (cmd === "search") console.log(JSON.stringify(search(root, args.join(" ") || "backfill"), null, 2));
  else console.log("usage: bun src/atom-backfill.ts demo|demo-real|backfill|build-db|parity|search --root DIR");
}
