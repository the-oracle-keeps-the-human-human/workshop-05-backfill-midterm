// sing-backfill — ingest sources. Pluggable so the SAME pipeline runs against:
//  (a) REST backfill (production: gh-style before-cursor paging, honor 429)
//  (b) a fixture file of real messages (testable here, seeded from Discord MCP fetch)
// Both yield the same normalized shape → mirror JSON → DB.
import type { MsgInput } from "./db.ts";

export interface RawMsg {
  id: string;
  author?: { id?: string; username?: string; global_name?: string; bot?: boolean };
  content?: string;
  timestamp?: string;
  edited_timestamp?: string;
}

export function normalize(raw: RawMsg, channelId: string, channelName: string, source: MsgInput["source"]): MsgInput {
  return {
    id: String(raw.id),
    channel_id: channelId,
    channel_name: channelName,
    author_id: raw.author?.id ? String(raw.author.id) : undefined,
    author_name: raw.author?.global_name || raw.author?.username || undefined,
    is_bot: !!raw.author?.bot,
    content: raw.content ?? "",
    created_at: raw.timestamp,
    edited_at: raw.edited_timestamp || undefined,
    source,
    raw,
  };
}

// ── (a) production REST backfill: before-cursor paging, 100/batch, honor rate limits ──
// token from env DISCORD_BOT_TOKEN (never hardcode). Returns raw messages oldest→newest.
export async function restBackfill(token: string, channelId: string, opts: { limit?: number; after?: string } = {}): Promise<RawMsg[]> {
  const API = "https://discord.com/api/v10";
  const all: RawMsg[] = [];
  const cap = opts.limit ?? 10000;
  let before: string | undefined;
  while (all.length < cap) {
    const qs = new URLSearchParams({ limit: String(Math.min(100, cap - all.length)) });
    if (before) qs.set("before", before);
    if (opts.after) qs.set("after", opts.after);
    const res = await fetch(`${API}/channels/${channelId}/messages?${qs}`, { headers: { Authorization: `Bot ${token}` } });
    if (res.status === 429) { const ra = Number(res.headers.get("retry-after") || "1"); await Bun.sleep(ra * 1000); continue; }
    if (!res.ok) throw new Error(`discord ${res.status}`);
    const batch = (await res.json()) as RawMsg[];
    if (!batch.length) break;
    all.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
    await Bun.sleep(350); // polite pacing
  }
  return all.sort((a, b) => a.id.localeCompare(b.id));
}

// ── (b) fixture source: a JSON array of real messages captured via Discord MCP ──
export function fixtureSource(messages: RawMsg[]): RawMsg[] {
  return [...messages].sort((a, b) => a.id.localeCompare(b.id));
}
