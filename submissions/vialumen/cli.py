#!/usr/bin/env python3
"""backfill-mvp CLI.

  python3 cli.py backfill --fixture fixtures/cold.json --db .data/m.sqlite
  python3 cli.py sync     --fixture fixtures/delta.json --db .data/m.sqlite   # warm tail
  python3 cli.py parity   --fixture fixtures/cold.json --db .data/m.sqlite
  python3 cli.py reindex  --db .data/m.sqlite
  python3 cli.py search "query" --db .data/m.sqlite --mode hybrid
  python3 cli.py stats    --db .data/m.sqlite
"""
from __future__ import annotations
import argparse
import json
import sys

from bf.db import connect
from bf.fetcher import FixtureFetcher
from bf.sync import sync_all
from bf.parity import verify, gap_ranges
from bf.search import search, reindex_vectors


def _p(s):  # plain print
    print(s)


def cmd_backfill(a):
    conn = connect(a.db)
    res = sync_all(conn, FixtureFetcher(a.fixture), mode="cold")
    reindex_vectors(conn); conn.commit()
    for cid, c in res.items():
        _p(f"  cold {cid}: +{c['inserted']} edits={c['edits']} del={c['deletes']} (fetched {c['fetched']})")
    _p("✓ cold backfill done + vectors indexed")


def cmd_sync(a):
    conn = connect(a.db)
    res = sync_all(conn, FixtureFetcher(a.fixture), mode="warm")
    reindex_vectors(conn); conn.commit()
    for cid, c in res.items():
        _p(f"  warm {cid}: +{c['inserted']} edits={c['edits']} del={c['deletes']} (fetched {c['fetched']})")
    _p("✓ warm sync done")


def cmd_parity(a):
    conn = connect(a.db)
    rep = verify(conn, FixtureFetcher(a.fixture))
    for ch in rep["channels"]:
        flag = "OK " if ch["ok"] else "GAP"
        _p(f"  [{flag}] {ch['name']}: source={ch['source']} db={ch['db']} "
           f"missing={len(ch['missing'])} extra(tombstone)={len(ch['extra'])}")
        if ch["missing"]:
            _p(f"        re-fetch ranges: {gap_ranges(ch['missing'])}")
    _p(("✓ parity OK — every source message ingested" if rep["ok"]
        else f"✗ parity FAIL — {rep['missing_total']} missing (gate would block frontend build)"))
    sys.exit(0 if rep["ok"] else 1)


def cmd_reindex(a):
    conn = connect(a.db)
    n = reindex_vectors(conn); conn.commit()
    _p(f"✓ reindexed {n} vectors")


def cmd_search(a):
    conn = connect(a.db)
    rows = search(conn, a.query, mode=a.mode, limit=a.limit,
                  channel_id=a.channel, author_id=a.author)
    if not rows:
        _p("(no results)"); return
    for i, r in enumerate(rows, 1):
        tag = f" v{r['version']}" if r["version"] > 1 else ""
        _p(f"  {i}. [{r['author_name']}{tag}] {r['content'][:90]}")


def cmd_stats(a):
    conn = connect(a.db)
    q = lambda s: conn.execute(s).fetchone()[0]
    _p(json.dumps({
        "channels": q("SELECT COUNT(*) FROM channels"),
        "messages_live": q("SELECT COUNT(*) FROM messages WHERE deleted=0"),
        "messages_tombstoned": q("SELECT COUNT(*) FROM messages WHERE deleted=1"),
        "versions": q("SELECT COUNT(*) FROM message_versions"),
        "edited_messages": q("SELECT COUNT(*) FROM messages WHERE version>1"),
        "vectors": q("SELECT COUNT(*) FROM message_vectors"),
        "fts_rows": q("SELECT COUNT(*) FROM messages_fts"),
        "runs": q("SELECT COUNT(*) FROM run_log"),
    }, indent=2, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(prog="backfill-mvp")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("backfill", "sync", "parity"):
        s = sub.add_parser(name)
        s.add_argument("--fixture", required=True)
        s.add_argument("--db", default=".data/m.sqlite")
    sp = sub.add_parser("reindex"); sp.add_argument("--db", default=".data/m.sqlite")
    ss = sub.add_parser("search")
    ss.add_argument("query"); ss.add_argument("--db", default=".data/m.sqlite")
    ss.add_argument("--mode", default="hybrid", choices=["hybrid", "fts", "vector"])
    ss.add_argument("--limit", type=int, default=10)
    ss.add_argument("--channel", default=None); ss.add_argument("--author", default=None)
    st = sub.add_parser("stats"); st.add_argument("--db", default=".data/m.sqlite")
    a = ap.parse_args()
    {"backfill": cmd_backfill, "sync": cmd_sync, "parity": cmd_parity,
     "reindex": cmd_reindex, "search": cmd_search, "stats": cmd_stats}[a.cmd](a)


if __name__ == "__main__":
    main()
