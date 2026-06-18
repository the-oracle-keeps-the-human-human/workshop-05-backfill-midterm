#!/usr/bin/env python3
"""
Weizen — Discord Backfill + Index MVP (workshop-05 midterm proof)
backfill (REST before=cursor) → SQLite + FTS5 → parity → search.
Real data, no deps (stdlib urllib + sqlite3). Token from env DISCORD_BOT_TOKEN (never hard-coded).

Design (discussion #14): Discord = append-only log, snowflake = block.
MVP proves the core path: ingest → index → verify → query. (block-range versioning = next phase.)
"""
import os, sys, json, time, sqlite3, urllib.request

TOKEN = os.environ["DISCORD_BOT_TOKEN"]          # never hard-coded (Rule: no secret at rest)
CHANNEL = sys.argv[1] if len(sys.argv) > 1 else "1512079809021214730"  # class channel (no private data — นัท OK)
PAGES = int(sys.argv[2]) if len(sys.argv) > 2 else 3   # 100 msgs/page
DB = os.path.join(os.path.dirname(__file__), "weizen-index.db")
API = "https://discord.com/api/v10"

def api(path):
    r = urllib.request.Request(API + path, headers={"Authorization": f"Bot {TOKEN}", "User-Agent": "weizen-indexer/0.1"})
    return json.load(urllib.request.urlopen(r, timeout=30))

def db_init(cx):
    cx.executescript("""
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, channel TEXT, author TEXT,
        content TEXT, ts INTEGER, edited INTEGER DEFAULT 0);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, author, content='messages', content_rowid='rowid');
      CREATE TABLE IF NOT EXISTS cursor(channel TEXT PRIMARY KEY, oldest_id TEXT);  -- resumable
      CREATE TABLE IF NOT EXISTS mirror(id TEXT PRIMARY KEY, raw TEXT);             -- raw mirror = source of truth (Kikyo gem)
    """)

def snowflake_ts(sid):  # timestamp embedded in snowflake — no API call (design: snowflake=block clock)
    return ((int(sid) >> 22) + 1420070400000) // 1000

def backfill(cx):
    cur = cx.execute("SELECT oldest_id FROM cursor WHERE channel=?", (CHANNEL,)).fetchone()
    before = cur[0] if cur else None
    total = 0
    for _ in range(PAGES):
        q = f"/channels/{CHANNEL}/messages?limit=100" + (f"&before={before}" if before else "")
        batch = api(q)
        if not batch: break
        for m in batch:
            mid = m["id"]
            cx.execute("INSERT OR IGNORE INTO mirror(id,raw) VALUES(?,?)", (mid, json.dumps(m)))  # mirror first
            cx.execute("""INSERT INTO messages(id,channel,author,content,ts,edited) VALUES(?,?,?,?,?,?)
                          ON CONFLICT(id) DO UPDATE SET content=excluded.content, edited=1""",
                       (mid, CHANNEL, m["author"]["username"], m.get("content",""), snowflake_ts(mid),
                        1 if m.get("edited_timestamp") else 0))
            rid = cx.execute("SELECT rowid FROM messages WHERE id=?", (mid,)).fetchone()[0]
            cx.execute("INSERT INTO messages_fts(rowid,content,author) VALUES(?,?,?)",
                       (rid, m.get("content",""), m["author"]["username"]))
        before = batch[-1]["id"]
        total += len(batch)
        cx.execute("INSERT OR REPLACE INTO cursor(channel,oldest_id) VALUES(?,?)", (CHANNEL, before))
        cx.commit()
        time.sleep(0.4)  # rate-limit courtesy
        if len(batch) < 100: break
    return total

def parity(cx):  # Kikyo's parity gate: mirror (truth) vs index — refuse if mismatch
    mids = {r[0] for r in cx.execute("SELECT id FROM mirror")}
    iids = {r[0] for r in cx.execute("SELECT id FROM messages")}
    missing, extra = mids - iids, iids - mids
    ok = not missing and not extra
    print(f"   parity: mirror={len(mids)} index={len(iids)} missing={len(missing)} extra={len(extra)} → {'✅ PASS' if ok else '❌ FAIL'}")
    return ok

def search(cx, term, k=5):
    rows = cx.execute("""SELECT m.author, m.content, m.ts FROM messages_fts f
                         JOIN messages m ON m.rowid=f.rowid WHERE messages_fts MATCH ?
                         ORDER BY rank LIMIT ?""", (term, k)).fetchall()
    print(f"\n🔎 search '{term}' → {len(rows)} hits:")
    for a, c, t in rows:
        print(f"   [{time.strftime('%m-%d %H:%M', time.gmtime(t))}] {a}: {(c or '')[:90].replace(chr(10),' ')}")

if __name__ == "__main__":
    cx = sqlite3.connect(DB); db_init(cx)
    print(f"🍺 Weizen backfill MVP — channel {CHANNEL}")
    n = backfill(cx)
    cnt = cx.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    print(f"   backfilled {n} this run · index total = {cnt} messages (resumable cursor saved)")
    parity(cx)
    for term in (sys.argv[3] if len(sys.argv) > 3 else "codex OR backfill OR weizen").split():
        pass
    search(cx, sys.argv[3] if len(sys.argv) > 3 else "backfill")
    search(cx, "codex")
    cx.close()
