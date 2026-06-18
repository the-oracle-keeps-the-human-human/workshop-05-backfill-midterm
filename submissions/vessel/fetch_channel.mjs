#!/usr/bin/env node
/**
 * Vessel Discord Channel Fetcher
 * Uses discord.js (same as MCP plugin) to paginate channel history.
 * Output: NDJSON to stdout — one message per line.
 *
 * Usage:
 *   node fetch_channel.mjs <channel_id> [--limit 500] [--before <msg_id>]
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load discord.js from the plugin's node_modules (same bot, same version)
const PLUGIN_DIR = join(process.env.HOME, '.claude/plugins/cache/claude-plugins-official/discord/0.0.4');
const require = createRequire(join(PLUGIN_DIR, 'package.json'));
const { Client, GatewayIntentBits } = require('discord.js');

// Load token from same place as MCP plugin
const ENV_FILE = join(process.env.HOME, '.claude/channels/discord-vessel/.env');
let token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^DISCORD_BOT_TOKEN=(.+)$/);
      if (m) { token = m[1].trim(); break; }
    }
  } catch {}
}
if (!token) {
  process.stderr.write('DISCORD_BOT_TOKEN not found\n');
  process.exit(1);
}

const args = process.argv.slice(2);
const channelId = args[0];
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 200;
const beforeIdx = args.indexOf('--before');
let before = beforeIdx >= 0 ? args[beforeIdx + 1] : null;

if (!channelId) {
  process.stderr.write('Usage: node fetch_channel.mjs <channel_id> [--limit N] [--before msg_id]\n');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once('ready', async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      process.stderr.write(`Channel ${channelId} not found\n`);
      process.exit(1);
    }

    let fetched = 0;
    let cursor = before;

    while (fetched < limit) {
      const batchSize = Math.min(100, limit - fetched);
      const opts = { limit: batchSize };
      if (cursor) opts.before = cursor;

      const msgs = await channel.messages.fetch(opts);
      if (msgs.size === 0) break;

      const arr = [...msgs.values()];
      for (const m of arr) {
        const obj = {
          id: m.id,
          channel_id: channelId,
          content: m.content,
          timestamp: m.createdAt.toISOString(),
          author: { id: m.author.id, username: m.author.username },
          attachments: [...m.attachments.values()].map(a => ({
            id: a.id, filename: a.name, size: a.size, content_type: a.contentType
          })),
          referenced_message: m.reference?.messageId ?? null,
        };
        process.stdout.write(JSON.stringify(obj) + '\n');
      }

      fetched += arr.length;
      cursor = arr[arr.length - 1].id; // oldest message in batch
      process.stderr.write(`fetched ${fetched}\n`);

      if (arr.length < batchSize) break;
      await new Promise(r => setTimeout(r, 1000)); // rate limit
    }
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n${e.stack}\n`);
  } finally {
    client.destroy();
  }
});

client.login(token);
