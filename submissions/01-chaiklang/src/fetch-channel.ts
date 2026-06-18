// fetch-channel.ts — pull a real Discord channel into a Snapshot via REST.
// Token comes ONLY from process.env.DISCORD_BOT_TOKEN (or `pass`) — never hard-coded,
// never written to the snapshot. Output snapshot contains channel messages only.
//
//   DISCORD_BOT_TOKEN=… bun src/fetch-channel.ts <channelId> [limit] > real-snapshot.json
import type { Snapshot, RawMsg } from "./ingest";

function token(): string {
  const t = (process.env.DISCORD_BOT_TOKEN || "").trim();
  if (t) return t;
  try { const p = Bun.spawnSync(["pass", "show", "discord/atlas-oracle-token"]); const k = p.stdout.toString().trim(); if (k) return k; } catch {}
  throw new Error("no DISCORD_BOT_TOKEN (set env or `pass insert discord/atlas-oracle-token`)");
}

async function api(path: string) {
  const r = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token()}` } });
  if (r.status === 429) { const j: any = await r.json(); await Bun.sleep((j.retry_after || 1) * 1000); return api(path); }
  if (!r.ok) throw new Error(`Discord ${r.status} on ${path}`);
  return r.json();
}

async function fetchAll(channelId: string, limit: number): Promise<RawMsg[]> {
  const out: RawMsg[] = []; let before: string | undefined;
  while (out.length < limit) {
    const q = `?limit=${Math.min(100, limit - out.length)}${before ? `&before=${before}` : ""}`;
    const batch = (await api(`/channels/${channelId}/messages${q}`)) as RawMsg[];
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch); before = batch[batch.length - 1].id;
    if (batch.length < 100) break; await Bun.sleep(350);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

const channelId = process.argv[2];
const limit = Number(process.argv[3] || "200");
if (!channelId) { console.error("usage: bun src/fetch-channel.ts <channelId> [limit]"); process.exit(1); }
const ch: any = await api(`/channels/${channelId}`);
const messages = await fetchAll(channelId, limit);
const snap: Snapshot = {
  guild: { id: String(ch.guild_id || "dm"), name: "Discord" },
  channels: [{ id: String(ch.id), name: ch.name || channelId, kind: "room", position: ch.position ?? 0, type: ch.type ?? 0, messages }],
};
console.log(JSON.stringify(snap, null, 2));
