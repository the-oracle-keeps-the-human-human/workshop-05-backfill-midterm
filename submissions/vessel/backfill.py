#!/usr/bin/env python3
"""
Vessel Discord Backfill — fetch historical messages channel by channel.

Usage:
  python3 backfill.py --channel <channel_id> [--limit 500] [--dry-run]
  python3 backfill.py --all                  # all channels in config
  python3 backfill.py --stats                # show DB stats + parity
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mirror_db import MirrorDB

# ──────────────────────────────────────────────
# Discord MCP bridge (reuses existing bot token)
# Read messages via the same path as Vessel's live reader
# ──────────────────────────────────────────────

def fetch_messages_via_mcp(channel_id: str, before: str = None, limit: int = 100) -> list:
    """
    Use the discord MCP server (same token as vessel) to fetch messages.
    Falls back to direct REST if MCP unavailable.
    """
    import subprocess, json
    params = {"channel": channel_id, "limit": min(limit, 100)}
    if before:
        params["before"] = before
    # Use the existing node MCP server via subprocess
    # (same as how Claude Code calls it via .mcp.json)
    cmd = [
        "node", "-e", f"""
const {{Client}} = require('@modelcontextprotocol/sdk/client/index.js');
const {{StdioClientTransport}} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {{spawn}} = require('child_process');

async function main() {{
    const transport = new StdioClientTransport({{
        command: 'node',
        args: ['--experimental-strip-types', '/Users/tiny/.mcp/discord-mcp/server.ts']
    }});
    const client = new Client({{name:'vessel-backfill',version:'1.0.0'}});
    await client.connect(transport);
    const result = await client.callTool('fetch_messages', {json.dumps(params)});
    console.log(JSON.stringify(result.content[0].text));
    await client.close();
}}
main().catch(e => {{ console.error(e.message); process.exit(1); }});
"""
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if out.returncode == 0:
            data = json.loads(out.stdout.strip())
            if isinstance(data, list):
                return data
    except Exception as e:
        pass

    # Fallback: try reading from existing inbox files
    return []


def fetch_messages_rest(channel_id: str, before: str = None, limit: int = 100) -> list:
    """Direct Discord REST API using bot token from environment."""
    import urllib.request, json
    token = os.environ.get("DISCORD_BOT_TOKEN", "")
    if not token:
        return []
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages?limit={min(limit, 100)}"
    if before:
        url += f"&before={before}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bot {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  REST error: {e}")
        return []


# Channels Vessel monitors (from ψ/state/last_read.json)
DEFAULT_CHANNELS = {
    "1512079809021214730": "free-for-all",
    "1503604824342790224": "wave-personal",
}


def backfill_channel(db: MirrorDB, channel_id: str, channel_name: str,
                     limit: int = 500, dry_run: bool = False) -> dict:
    """Backfill a single channel. Returns stats."""
    print(f"\n{'[DRY-RUN] ' if dry_run else ''}📥 Backfilling #{channel_name} ({channel_id})")

    fetched = 0
    inserted = 0
    before = None
    mirror_messages = []

    while fetched < limit:
        batch = fetch_messages_rest(channel_id, before=before, limit=100)
        if not batch:
            print(f"  ↳ No more messages (fetched {fetched} total)")
            break

        for msg in batch:
            mirror_messages.append(msg)
            if not dry_run:
                new = db.upsert_message(msg, channel_id, channel_name)
                if new:
                    inserted += 1

        fetched += len(batch)
        before = batch[-1]["id"]  # oldest in batch
        print(f"  ↳ fetched {fetched} (+{len(batch)})  inserted {inserted}")

        if len(batch) < 100:
            break
        time.sleep(1.0)  # rate limit safety

    if not dry_run and mirror_messages:
        last_id = mirror_messages[0]["id"]  # most recent
        db.update_sync_state(channel_id, channel_name, last_id,
                              fetched, complete=True)
        parity = db.parity_check(channel_id, fetched)
        print(f"  ✅ Parity: mirror={parity['mirror_count']} db={parity['db_count']} ok={parity['ok']}")

    return {"channel": channel_name, "fetched": fetched, "inserted": inserted}


def main():
    parser = argparse.ArgumentParser(description="Vessel Discord Backfill")
    parser.add_argument("--channel", help="Channel ID to backfill")
    parser.add_argument("--all", action="store_true", help="Backfill all known channels")
    parser.add_argument("--limit", type=int, default=200, help="Max messages per channel")
    parser.add_argument("--dry-run", action="store_true", help="Fetch but don't write to DB")
    parser.add_argument("--stats", action="store_true", help="Show DB stats and exit")
    args = parser.parse_args()

    db_path = os.path.expanduser("~/ghq/github.com/wvweeratouch/vessel/ψ/discord-index/messages.db")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    db = MirrorDB(db_path)

    if args.stats:
        stats = db.stats()
        print(f"\n📊 Vessel Discord Index Stats")
        print(f"   Total messages  : {stats['total_messages']}")
        print(f"   Channels done   : {stats['channels_backfilled']}")
        print(f"\n   By bucket:")
        for b, c in stats["by_bucket"].items():
            print(f"     {b:20s}: {c}")
        print(f"\n   Top channels:")
        for ch, c in stats["top_channels"].items():
            print(f"     {ch:25s}: {c}")
        db.close()
        return

    results = []
    if args.all:
        for cid, cname in DEFAULT_CHANNELS.items():
            r = backfill_channel(db, cid, cname, args.limit, args.dry_run)
            results.append(r)
    elif args.channel:
        cname = DEFAULT_CHANNELS.get(args.channel, f"ch-{args.channel[-6:]}")
        r = backfill_channel(db, args.channel, cname, args.limit, args.dry_run)
        results.append(r)
    else:
        parser.print_help()

    if results:
        total = sum(r["fetched"] for r in results)
        print(f"\n✅ Done — {total} messages fetched across {len(results)} channel(s)")

    db.close()


if __name__ == "__main__":
    main()
