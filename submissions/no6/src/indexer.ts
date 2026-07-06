import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { parse } from "yaml";
import { getToken, getMessages, listActiveThreads, getArchivedPublicThreads, getArchivedPrivateThreads } from "../lib/discord";

const CONFIG_PATH = join(import.meta.dir, "discordgraph.yaml");

// Helper to load yaml config
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found at ${CONFIG_PATH}`);
  }
  return parse(readFileSync(CONFIG_PATH, "utf8"));
}

// Get SQLite Database connection
function getDb(config: any) {
  const dbPath = config.store.path;
  mkdirSync(dirname(dbPath), { recursive: true });
  return new Database(dbPath);
}

// Parse snowflake timestamp
const DISCORD_EPOCH = 1420070400000n;
function snowflakeTs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

// Tokenize text for local embeddings
const STOP_WORDS = new Set("the a an and or to of in is are be for with this that you your was were have has had from into about can could should would there here คือ แล้ว ครับ ค่ะ ได้ ไม่ มี เรา ผม มัน อ่ะ นะ ของ ที่ ใน เป็น ให้ กับ จาก จะ ก็ แต่".split(" "));
function tokenize(text: string): string[] {
  return text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_#@:-]+/gu) || [];
}

// FNV-1a Hash embedding vector (96 dimensions)
const DIMS = 96;
function embedText(text: string): number[] {
  const v = Array(DIMS).fill(0);
  for (const t of tokenize(text)) {
    if (STOP_WORDS.has(t)) continue;
    let h = 2166136261;
    for (const ch of t) {
      h ^= ch.codePointAt(0) || 0;
      h = Math.imul(h, 16777619);
    }
    const hashVal = h >>> 0;
    v[hashVal % DIMS] += (hashVal & 1) ? 1 : -1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => Number((x / norm).toFixed(6)));
}

function ftsQuery(query: string): string {
  const tokens = query.normalize("NFKC").match(/[\p{L}\p{N}_#]+/gu) || [];
  return tokens.length ? tokens.map(t => `"${t}"`).join(" ") : "";
}

function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    s += a[i] * b[i];
  }
  return s;
}

// 1. Deploy Command: executes schema.sql
function deploy(config: any) {
  const db = getDb(config);
  const schemaFile = config.schema.file;
  const schemaPath = join(dirname(CONFIG_PATH), schemaFile);
  if (!existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${schemaPath}`);
  }
  const sql = readFileSync(schemaPath, "utf8");
  db.exec(sql);
  console.log("✓ Schema deployed successfully to SQLite.");
  db.close();
}

// 2. Backfill Command: fetches historical messages & threads, grouping into virtual blocks
async function backfill(config: any, limit: number) {
  const token = getToken();
  if (!token) {
    throw new Error("✗ Discord Bot Token not found. Set DISCORD_BOT_TOKEN or config .env");
  }

  const db = getDb(config);
  const server = config.dataSources[0].server;
  const channels = config.dataSources[0].channels;

  console.log(`🚀 Starting Discord Backfill for server: ${server.name} (${server.id})`);
  console.log(`Target limit: ${limit} messages per channel.`);

  for (const ch of channels) {
    try {
      console.log(`\nIndexing channel: #${ch.name} (${ch.id})`);
      
      // Check cursor
      let cursorRow: any = db.query("SELECT last_message_id FROM cursors WHERE channel_id = ?").get(ch.id);
      let beforeId = cursorRow ? cursorRow.last_message_id : undefined;

      // Fetch messages in batches of 100
      let fetchedCount = 0;
      let before: string | undefined = beforeId;

      while (fetchedCount < limit) {
        const batchLimit = Math.min(100, limit - fetchedCount);
        console.log(`  Fetching batch before message ID: ${before || "latest"}...`);
        const messages = await getMessages(token, ch.id, batchLimit, before);

        if (!Array.isArray(messages) || messages.length === 0) {
          console.log("  No more messages found.");
          break;
        }

        // Group into a virtual "Block"
        // Get previous block hash
        const prevBlock: any = db.query("SELECT hash FROM blocks ORDER BY number DESC LIMIT 1").get();
        const parentHash = prevBlock ? prevBlock.hash : "0000000000000000000000000000000000000000000000000000000000000000";

        const batchMsgs = messages.sort((a: any, b: any) => a.id.localeCompare(b.id));
        const oldestMsg = batchMsgs[0];
        const newestMsg = batchMsgs[batchMsgs.length - 1];

        const startTs = snowflakeTs(oldestMsg.id);
        const endTs = snowflakeTs(newestMsg.id);
        const duration = endTs - startTs;
        const msgIds = batchMsgs.map((m: any) => m.id);

        // Compute cryptographic block hash
        const blockData = parentHash + startTs + endTs + batchMsgs.length + msgIds.join(",");
        const blockHash = Bun.SHA256.hash(blockData, "hex");

        // Insert Block
        const blockInsert = db.prepare(`
          INSERT INTO blocks (timestamp, end_ts, duration_ms, activity, event_count, parent_hash, hash, channels)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        blockInsert.run(startTs, endTs, duration, "normal", batchMsgs.length, parentHash, blockHash, JSON.stringify([ch.name]));
        
        const newBlock: any = db.query("SELECT number FROM blocks WHERE hash = ?").get(blockHash);
        const blockNum = newBlock.number;

        console.log(`  Created virtual block #${blockNum} with hash: ${blockHash.slice(0, 12)}...`);

        // Insert Messages & related records in a Transaction
        const insertMessage = db.prepare(`
          INSERT OR REPLACE INTO messages 
          (id, block_num, server_id, channel_id, channel_name, thread_id, author_id, author_name, author_bot, content, msg_type, timestamp, reply_to, has_attachments, has_code)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const insertAuthor = db.prepare(`
          INSERT OR REPLACE INTO authors (id, username, display_name, is_bot, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
        `);

        const insertReaction = db.prepare(`
          INSERT OR REPLACE INTO reactions (id, message_id, emoji, count)
          VALUES (?, ?, ?, ?)
        `);

        const insertCodeBlock = db.prepare(`
          INSERT OR REPLACE INTO code_blocks (id, message_id, language, content, line_count)
          VALUES (?, ?, ?, ?, ?)
        `);

        db.transaction(() => {
          for (const m of batchMsgs) {
            const ts = snowflakeTs(m.id);
            const hasAttachments = m.attachments && m.attachments.length > 0 ? 1 : 0;
            
            // Simple code block detection (contains triple backticks)
            const codeRegex = /```(\w*)\n([\s\S]*?)```/g;
            let match;
            let hasCode = 0;
            while ((match = codeRegex.exec(m.content)) !== null) {
              hasCode = 1;
              const lang = match[1] || "text";
              const codeContent = match[2];
              const lines = codeContent.split("\n").length;
              const codeId = Bun.SHA256.hash(m.id + lang + codeContent, "hex");
              insertCodeBlock.run(codeId, m.id, lang, codeContent, lines);
            }

            // Save message
            insertMessage.run(
              m.id,
              blockNum,
              server.id,
              ch.id,
              ch.name,
              null, // thread_id
              m.author.id,
              m.author.global_name || m.author.username,
              m.author.bot ? 1 : 0,
              m.content || "",
              "CHAT",
              ts,
              m.referenced_message?.id || null,
              hasAttachments,
              hasCode
            );

            // Save author
            insertAuthor.run(
              m.author.id,
              m.author.username,
              m.author.global_name || m.author.username || null,
              m.author.bot ? 1 : 0,
              ts,
              ts
            );

            // Save reactions
            if (m.reactions) {
              for (const r of m.reactions) {
                const emojiStr = r.emoji.name;
                const reactId = Bun.SHA256.hash(m.id + emojiStr, "hex");
                insertReaction.run(reactId, m.id, emojiStr, r.count);
              }
            }

            // Index text to messages_fts (FTS5)
            db.prepare(`
              INSERT INTO messages_fts (rowid, content, author_name, channel_name)
              VALUES ((SELECT rowid FROM messages WHERE id = ?), ?, ?, ?)
            `).run(m.id, m.content || "", m.author.global_name || m.author.username || "", ch.name);

            // Store vector embedding (message_vectors table)
            db.prepare(`
              INSERT OR REPLACE INTO message_vectors (message_id, dims, embedding_json, text, updated_at)
              VALUES (?, ?, ?, ?, datetime('now'))
            `).run(
              m.id,
              DIMS,
              JSON.stringify(embedText([m.author.global_name || m.author.username, ch.name, m.content].filter(Boolean).join(" "))),
              m.content || ""
            );
          }
        })();

        // Update Cursor
        db.prepare(`
          INSERT OR REPLACE INTO cursors (channel_id, last_message_id, last_timestamp, total_indexed)
          VALUES (?, ?, ?, (SELECT COALESCE(total_indexed, 0) FROM cursors WHERE channel_id = ?) + ?)
        `).run(ch.id, batchMsgs[0].id, snowflakeTs(batchMsgs[0].id), ch.id, batchMsgs.length);

        fetchedCount += batchMsgs.length;
        before = batchMsgs[0].id; // Paginate before oldest in batch

        console.log(`  Indexed ${batchMsgs.length} messages in this batch.`);
        await new Promise(r => setTimeout(r, 250)); // rate-limit sleep
      }

      console.log(`✓ Completed channel #${ch.name}. Indexed ${fetchedCount} messages.`);
    } catch (err: any) {
      console.warn(`⚠️ Warning: Failed to index channel #${ch.name} (${ch.id}): ${err.message}`);
    }
  }

  // Update channels count
  db.exec(`
    INSERT OR REPLACE INTO channels (id, name, server_id, message_count, last_indexed)
    SELECT channel_id, channel_name, server_id, count(*), max(timestamp)
    FROM messages GROUP BY channel_id
  `);

  console.log("\n✓ Backfill job completed successfully.");
  db.close();
}

// 3. Status Command: displays database metrics
function status(config: any) {
  const db = getDb(config);
  
  try {
    const blocksCount = (db.query("SELECT count(*) as c FROM blocks").get() as any).c;
    const messagesCount = (db.query("SELECT count(*) as c FROM messages").get() as any).c;
    const authorsCount = (db.query("SELECT count(*) as c FROM authors").get() as any).c;
    const channelsCount = (db.query("SELECT count(*) as c FROM channels").get() as any).c;
    const cursorsCount = (db.query("SELECT count(*) as c FROM cursors").get() as any).c;
    const codeBlocksCount = (db.query("SELECT count(*) as c FROM code_blocks").get() as any).c;
    const vectorsCount = (db.query("SELECT count(*) as c FROM message_vectors").get() as any).c;

    console.log("=== DISCORD INDEXER STATUS ===");
    console.log(`Database Path:   ${config.store.path}`);
    console.log(`Virtual Blocks:  ${blocksCount}`);
    console.log(`Messages:        ${messagesCount}`);
    console.log(`Embeddings:      ${vectorsCount} (${DIMS}-dims)`);
    console.log(`Authors/Users:   ${authorsCount}`);
    console.log(`Channels:        ${channelsCount}`);
    console.log(`Code Blocks:     ${codeBlocksCount}`);
    console.log(`Cursors:         ${cursorsCount}`);
    console.log("==============================");

    // List cursors
    const cursorsList = db.query("SELECT channel_id, total_indexed FROM cursors").all() as any[];
    if (cursorsList.length > 0) {
      console.log("\nIndexed Channels:");
      for (const cur of cursorsList) {
        const chan: any = db.query("SELECT name FROM channels WHERE id = ?").get(cur.channel_id);
        console.log(`  - #${chan ? chan.name : cur.channel_id}: ${cur.total_indexed} messages`);
      }
    }
  } catch (err: any) {
    console.error("✗ Failed to get status. Make sure schema is deployed: bun run src/indexer.ts deploy");
  } finally {
    db.close();
  }
}

// 4. Query Command: performs hybrid (BM25 + Semantic Vector) search
function query(config: any, searchText: string) {
  const db = getDb(config);
  
  try {
    console.log(`=== HYBRID SEARCH: "${searchText}" ===\n`);
    const qVec = embedText(searchText);
    const byId = new Map<string, any>();

    // 1. Lexical search using FTS5 (BM25 rank)
    const ftsRows = db.query(`
      SELECT m.id, m.author_name, m.channel_name, m.content, m.timestamp, bm25(messages_fts) as rank 
      FROM messages_fts 
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? 
      ORDER BY bm25(messages_fts) 
      LIMIT 20
    `).all(ftsQuery(searchText));

    for (const r of ftsRows as any[]) {
      // Normalize ftsScore between 0 and 1
      const ftsScore = 1 / (1 + Math.abs(r.rank));
      byId.set(r.id, {
        id: r.id,
        author: r.author_name,
        channel: r.channel_name,
        content: r.content,
        timestamp: r.timestamp,
        ftsScore,
        vectorScore: 0
      });
    }

    // 2. Semantic search using local hashed vectors
    const vectorRows = db.query(`
      SELECT message_id, embedding_json FROM message_vectors
    `).all();

    for (const v of vectorRows as any[]) {
      const score = dotProduct(qVec, JSON.parse(v.embedding_json));
      if (score <= 0.1) continue; // Ignore low similarity
      
      const prev = byId.get(v.message_id);
      if (prev) {
        prev.vectorScore = score;
      } else {
        const msg: any = db.query("SELECT author_name, channel_name, content, timestamp FROM messages WHERE id = ?").get(v.message_id);
        if (msg) {
          byId.set(v.message_id, {
            id: v.message_id,
            author: msg.author_name,
            channel: msg.channel_name,
            content: msg.content,
            timestamp: msg.timestamp,
            ftsScore: 0,
            vectorScore: score
          });
        }
      }
    }

    // 3. Fusion scoring: 0.65 * ftsScore + 0.35 * vectorScore
    const results = [...byId.values()]
      .map(r => ({
        ...r,
        score: r.ftsScore * 0.65 + r.vectorScore * 0.35
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    if (results.length === 0) {
      console.log("No matching messages found.");
    } else {
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const dateStr = new Date(r.timestamp).toISOString();
        console.log(`${i+1}. [Score: ${r.score.toFixed(4)}] #${r.channel} | ${r.author} (${dateStr}):`);
        console.log(`   ${r.content}`);
        console.log(`   (FTS: ${r.ftsScore.toFixed(4)} | Vec: ${r.vectorScore.toFixed(4)})\n`);
      }
    }

  } catch (err: any) {
    console.error("✗ Failed to execute query. Make sure data is backfilled.");
    console.error(err.message);
  } finally {
    db.close();
  }
}

// CLI Command Router
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log("Discord Graph-Node Indexer CLI");
    console.log("Usage:");
    console.log("  bun run src/indexer.ts deploy             — Initialize schema");
    console.log("  bun run src/indexer.ts backfill [limit]  — Execute historical backfill (default 100)");
    console.log("  bun run src/indexer.ts status             — Check indexer metrics");
    console.log("  bun run src/indexer.ts query \"query\"     — Perform Hybrid Search");
    process.exit(0);
  }

  const config = loadConfig();

  try {
    switch (command) {
      case "deploy":
        deploy(config);
        break;
      case "backfill":
        const limit = parseInt(args[1] || "100", 10);
        await backfill(config, limit);
        break;
      case "status":
        status(config);
        break;
      case "query":
        const qText = args.slice(1).join(" ");
        if (!qText) {
          console.error("Error: Missing query string.");
          process.exit(1);
        }
        query(config, qText);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (e: any) {
    console.error(`✗ Error: ${e.message}`);
    process.exit(1);
  }
}

main();
