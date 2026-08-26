// sing-backfill — parity gate. Borrowed from Kikyo (the best idea), extended to
// INCREMENTAL: verify the JSON mirror set == DB set by exact message-id, and refuse
// downstream (index/frontend) if it doesn't match. "verify, don't claim" in code.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { openDb } from "./db.ts";

export interface ParityResult {
  ok: boolean;
  mirrorCount: number;
  dbCount: number;            // non-deleted rows
  missingInDb: string[];      // in mirror, not in DB
  extraInDb: string[];        // in DB, not in mirror (excluding tombstoned)
}

// read every messages.json under the mirror dir → the set of message ids that SHOULD be in DB
export function mirrorMessageIds(mirrorDir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(mirrorDir)) return ids;
  for (const ch of readdirSync(mirrorDir, { withFileTypes: true })) {
    if (!ch.isDirectory()) continue;
    const f = join(mirrorDir, ch.name, "messages.json");
    if (!existsSync(f)) continue;
    const arr = JSON.parse(readFileSync(f, "utf8"));
    for (const m of Array.isArray(arr) ? arr : []) if (m.id) ids.add(String(m.id));
  }
  return ids;
}

export function verifyParity(dbPath: string, mirrorDir: string): ParityResult {
  const db = openDb(dbPath);
  const mirror = mirrorMessageIds(mirrorDir);
  const dbIds = new Set((db.query("SELECT id FROM messages WHERE deleted_at IS NULL").all() as any[]).map(r => String(r.id)));
  db.close();

  const missingInDb = [...mirror].filter(id => !dbIds.has(id)).sort();
  const extraInDb = [...dbIds].filter(id => !mirror.has(id)).sort();
  return {
    ok: missingInDb.length === 0 && extraInDb.length === 0,
    mirrorCount: mirror.size,
    dbCount: dbIds.size,
    missingInDb,
    extraInDb,
  };
}
