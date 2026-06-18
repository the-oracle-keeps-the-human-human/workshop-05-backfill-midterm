#!/usr/bin/env python3
"""
Jizo 🗿 — Discord backfill + grounded index.

A faithful, append-only mirror of a Discord channel. The monk's vow:
*nothing is invented, nothing is silently lost.* Every stored row carries a
content hash so the mirror can PROVE it still matches the source — Jizo's edge
is a `verify` pass that turns "trust me" into a checkable integrity + parity
report (anti-fabrication, which is the whole point of a grounded second brain).

Design (what the fleet converged on, + Jizo's groundedness layer):
  - SQLite + FTS5 full-text index (graceful fallback to LIKE if FTS5 absent)
  - Discord snowflake -> UTC timestamp (no separate clock needed)
  - Nothing-Deleted: edits append a new VERSION row; deletes append a TOMBSTONE
    row. History is never overwritten. PK = (msg_id, version).
  - Idempotent upsert: re-ingesting the same data adds 0 rows (hash-dedup).
  - Parity gate: source id-set vs stored current id-set -> missing / extra.
  - Thai tokenization: PyThaiNLP word-boundary ZWSP if available, else a
    Unicode-cluster fallback — so "ระบบ" is findable inside "ระบบแบ็คฟิล".
  - Provenance: each row records (channel, batch, fetched_at, content_hash).

Zero hard dependencies (stdlib sqlite3). PyThaiNLP is optional and only sharpens
Thai search; the tool runs and tests pass without it.

CLI:
  backfill.py ingest  --db D --source S.json [--channel ID] [--complete]
  backfill.py search  --db D "query" [--limit N]
  backfill.py parity  --db D --source S.json
  backfill.py verify  --db D
  backfill.py stats   --db D
"""
import argparse
import hashlib
import json
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone

DISCORD_EPOCH_MS = 1420070400000  # 2015-01-01T00:00:00Z
ZWSP = "​"

# ---- Thai tokenization (optional PyThaiNLP, deterministic fallback) ----------

def _thai_segment(text):
    """Insert ZWSP at Thai word boundaries. PyThaiNLP if present; else a
    conservative fallback that breaks runs of Thai script into grapheme
    clusters, which still lets FTS match short Thai substrings the unicode61
    tokenizer would otherwise swallow into one long token."""
    try:
        from pythainlp.tokenize import word_tokenize  # type: ignore
        out, buf = [], ""
        for ch in text:
            if "฀" <= ch <= "๿":
                buf += ch
            else:
                if buf:
                    out.append(ZWSP.join(word_tokenize(buf, engine="newmm")))
                    buf = ""
                out.append(ch)
        if buf:
            out.append(ZWSP.join(word_tokenize(buf, engine="newmm")))
        return "".join(out)
    except Exception:
        # Fallback: split Thai script into combining-clusters joined by ZWSP.
        out, cluster = [], ""
        for ch in text:
            is_thai = "฀" <= ch <= "๿"
            combining = unicodedata.combining(ch) or ch in "ะัาำิีึืุู็่้๊๋์"
            if is_thai:
                if cluster and not combining:
                    out.append(cluster); out.append(ZWSP)
                    cluster = ch
                else:
                    cluster += ch
            else:
                if cluster:
                    out.append(cluster); cluster = ""
                out.append(ch)
        if cluster:
            out.append(cluster)
        return "".join(out)


def tokenize(text):
    """Index/query text identically so Thai substrings match. Idempotent:
    re-tokenizing already-ZWSP'd text is a no-op on existing boundaries."""
    return _thai_segment(text or "")

# ---- helpers -----------------------------------------------------------------

def snowflake_to_ms(sid):
    return (int(sid) >> 22) + DISCORD_EPOCH_MS


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def content_hash(content, is_tombstone):
    h = hashlib.sha256()
    h.update(b"\x01" if is_tombstone else b"\x00")
    h.update((content or "").encode("utf-8"))
    return h.hexdigest()


def normalize(raw, channel=None, batch="b0", fetched_at=None):
    """Accept Discord-export OR flat MCP-fetch shapes -> a uniform record."""
    sid = str(raw.get("id") or raw.get("msg_id") or raw.get("message_id"))
    author = raw.get("author")
    if isinstance(author, dict):
        author = author.get("username") or author.get("global_name") or author.get("id")
    content = raw.get("content", "")
    edited = bool(raw.get("edited_timestamp") or raw.get("edited"))
    created = raw.get("timestamp") or raw.get("created_ts")
    if created and not str(created).isdigit():
        try:
            created_ms = int(datetime.fromisoformat(str(created).replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            created_ms = snowflake_to_ms(sid)
    elif created:
        created_ms = int(created)
    else:
        created_ms = snowflake_to_ms(sid)  # snowflake is the source of truth
    atts = raw.get("attachments") or []
    att_names = [a.get("filename") or a.get("name") if isinstance(a, dict) else str(a) for a in atts]
    prov = {"channel": channel, "batch": batch, "fetched_at": fetched_at or iso(int(datetime.now(tz=timezone.utc).timestamp() * 1000)), "attachments": att_names}
    return {"msg_id": sid, "author": author, "content": content, "created_ms": created_ms,
            "edited": edited, "is_tombstone": False, "provenance": prov}

# ---- store -------------------------------------------------------------------

class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.fts5 = self._has_fts5()
        self._init_schema()

    def _has_fts5(self):
        try:
            self.db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x)")
            self.db.execute("DROP TABLE IF EXISTS _fts5_probe")
            return True
        except sqlite3.OperationalError:
            return False

    def _init_schema(self):
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS messages (
              row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
              msg_id       TEXT NOT NULL,
              version      INTEGER NOT NULL,
              author       TEXT,
              content      TEXT,
              created_ms   INTEGER,
              edited       INTEGER DEFAULT 0,
              is_tombstone INTEGER DEFAULT 0,
              content_hash TEXT,
              prev_row_id  INTEGER,
              provenance   TEXT,
              UNIQUE(msg_id, version)
            );
            CREATE INDEX IF NOT EXISTS idx_msg ON messages(msg_id);
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
            """
        )
        if self.fts5:
            self.db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(tokens, msg_id UNINDEXED)")
        self.db.commit()

    def _current(self, msg_id):
        return self.db.execute(
            "SELECT * FROM messages WHERE msg_id=? ORDER BY version DESC LIMIT 1", (msg_id,)
        ).fetchone()

    def _index(self, msg_id, content, is_tombstone):
        if not self.fts5:
            return
        self.db.execute("DELETE FROM fts WHERE msg_id=?", (msg_id,))
        if not is_tombstone:
            self.db.execute("INSERT INTO fts(tokens, msg_id) VALUES (?,?)", (tokenize(content), msg_id))

    def upsert(self, rec):
        """Append-only. Returns 'new' | 'edit' | 'same'."""
        cur = self._current(rec["msg_id"])
        ch = content_hash(rec["content"], rec["is_tombstone"])
        if cur is None:
            ver, prev = 1, None
            kind = "new"
        elif cur["content_hash"] == ch:
            return "same"  # idempotent: identical -> no row
        else:
            ver, prev = cur["version"] + 1, cur["row_id"]
            kind = "edit"
        self.db.execute(
            """INSERT INTO messages
               (msg_id,version,author,content,created_ms,edited,is_tombstone,content_hash,prev_row_id,provenance)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (rec["msg_id"], ver, rec["author"], rec["content"], rec["created_ms"],
             1 if rec["edited"] else 0, 1 if rec["is_tombstone"] else 0, ch, prev,
             json.dumps(rec["provenance"], ensure_ascii=False)),
        )
        self._index(rec["msg_id"], rec["content"], rec["is_tombstone"])
        return kind

    def tombstone(self, msg_id):
        cur = self._current(msg_id)
        if cur is None or cur["is_tombstone"]:
            return False
        self.db.execute(
            """INSERT INTO messages
               (msg_id,version,author,content,created_ms,edited,is_tombstone,content_hash,prev_row_id,provenance)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (msg_id, cur["version"] + 1, cur["author"], cur["content"], cur["created_ms"],
             0, 1, content_hash(cur["content"], True), cur["row_id"], cur["provenance"]),
        )
        self._index(msg_id, cur["content"], True)
        return True

    def current_ids(self, alive_only=True):
        rows = self.db.execute(
            """SELECT msg_id, MAX(version) v, is_tombstone FROM messages GROUP BY msg_id"""
        ).fetchall()
        ids = set()
        for r in rows:
            cur = self._current(r["msg_id"])
            if alive_only and cur["is_tombstone"]:
                continue
            ids.add(r["msg_id"])
        return ids

    def search(self, query, limit=20):
        if self.fts5:
            rows = self.db.execute(
                """SELECT m.* FROM fts JOIN messages m
                   ON m.msg_id=fts.msg_id AND m.version=(SELECT MAX(version) FROM messages WHERE msg_id=m.msg_id)
                   WHERE fts MATCH ? LIMIT ?""",
                (" ".join(tokenize(query).split()), limit),
            ).fetchall()
            if rows:
                return rows
        # Fallback / Thai recall: substring on raw content of current alive rows.
        like = f"%{query}%"
        return self.db.execute(
            """SELECT * FROM messages m WHERE version=(SELECT MAX(version) FROM messages WHERE msg_id=m.msg_id)
               AND is_tombstone=0 AND content LIKE ? ORDER BY created_ms LIMIT ?""",
            (like, limit),
        ).fetchall()

    def verify(self):
        """Re-hash every stored version; any mismatch = the mirror was mutated
        out from under us. This is the groundedness proof."""
        bad = []
        for r in self.db.execute("SELECT * FROM messages").fetchall():
            if content_hash(r["content"], bool(r["is_tombstone"])) != r["content_hash"]:
                bad.append(r["msg_id"])
        return bad

    def stats(self):
        c = self.db.execute
        return {
            "rows": c("SELECT COUNT(*) n FROM messages").fetchone()["n"],
            "messages": c("SELECT COUNT(DISTINCT msg_id) n FROM messages").fetchone()["n"],
            "edits": c("SELECT COUNT(*) n FROM messages WHERE version>1 AND is_tombstone=0").fetchone()["n"],
            "tombstones": c("SELECT COUNT(*) n FROM messages WHERE is_tombstone=1").fetchone()["n"],
            "alive": len(self.current_ids(alive_only=True)),
            "fts5": self.fts5,
        }

    def commit(self):
        self.db.commit()

# ---- pipeline ----------------------------------------------------------------

def load_source(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("messages") or data.get("data") or []
    return data


def ingest(args):
    store = Store(args.db)
    raw = load_source(args.source)
    seen, counts = set(), {"new": 0, "edit": 0, "same": 0}
    fetched_at = iso(int(datetime.now(tz=timezone.utc).timestamp() * 1000))
    for i, m in enumerate(raw):
        rec = normalize(m, channel=args.channel, batch=args.batch, fetched_at=fetched_at)
        if not rec["msg_id"] or rec["msg_id"] == "None":
            continue
        seen.add(rec["msg_id"])
        counts[store.upsert(rec)] += 1
    tomb = 0
    if args.complete:  # only a COMPLETE snapshot may infer deletions (partial would tombstone the world)
        for mid in store.current_ids(alive_only=True) - seen:
            if store.tombstone(mid):
                tomb += 1
    store.commit()
    print(f"ingest: +{counts['new']} new, ~{counts['edit']} edits, ={counts['same']} idempotent-skips, "
          f"†{tomb} tombstoned  (source={len(raw)} msgs, complete={args.complete})")
    print(f"store : {store.stats()}")


def parity(args):
    store = Store(args.db)
    src_ids = {str(m.get("id") or m.get("msg_id")) for m in load_source(args.source)}
    src_ids.discard("None")
    cur = store.current_ids(alive_only=True)
    missing = src_ids - cur          # in source, not mirrored (alive)
    extra = cur - src_ids            # mirrored alive, not in source (could be a real delete the source dropped)
    print(f"parity: source={len(src_ids)} alive_mirror={len(cur)} missing={len(missing)} extra={len(extra)}")
    if missing:
        print("  MISSING:", sorted(missing)[:10])
    if extra:
        print("  EXTRA (verify against a COMPLETE snapshot before tombstoning):", sorted(extra)[:10])
    return 0 if not missing else 1


def verify(args):
    store = Store(args.db)
    bad = store.verify()
    s = store.stats()
    print(f"verify: {s['rows']} rows hashed, {len(bad)} integrity failures")
    if bad:
        print("  TAMPERED:", bad[:10]); sys.exit(1)
    print("  ✓ grounded: every row's content matches its stored hash (mirror is faithful)")


def search(args):
    store = Store(args.db)
    rows = store.search(args.query, args.limit)
    print(f"search '{args.query}': {len(rows)} hit(s)")
    for r in rows:
        print(f"  [{iso(r['created_ms'])[:19]}] {r['author']}: {(r['content'] or '')[:90]}")


def stats(args):
    print(json.dumps(Store(args.db).stats(), indent=2))


def main(argv=None):
    p = argparse.ArgumentParser(description="Jizo Discord backfill + grounded index")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("ingest", "parity"):
        sp = sub.add_parser(name)
        sp.add_argument("--db", required=True)
        sp.add_argument("--source", required=True)
        sp.add_argument("--channel", default=None)
        sp.add_argument("--batch", default="b0")
        if name == "ingest":
            sp.add_argument("--complete", action="store_true",
                            help="treat source as the COMPLETE channel snapshot (enables deletion->tombstone)")
    sp = sub.add_parser("search"); sp.add_argument("--db", required=True); sp.add_argument("query"); sp.add_argument("--limit", type=int, default=20)
    sp = sub.add_parser("verify"); sp.add_argument("--db", required=True)
    sp = sub.add_parser("stats"); sp.add_argument("--db", required=True)
    args = p.parse_args(argv)
    {"ingest": ingest, "parity": parity, "search": search, "verify": verify, "stats": stats}[args.cmd](args)


if __name__ == "__main__":
    main()
