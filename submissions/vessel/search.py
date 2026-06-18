#!/usr/bin/env python3
"""
Vessel Discord Search — FTS5 full-text search over backfilled messages.

Usage:
  python3 search.py "hermes"
  python3 search.py "workshop" --oracle nazt --limit 5
  python3 search.py "backfill" --bucket curriculum
  python3 search.py --stats
"""

import argparse
import os
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent))
from mirror_db import MirrorDB


def fmt_ts(ts: float) -> str:
    if not ts:
        return "?"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def main():
    parser = argparse.ArgumentParser(description="Vessel Discord FTS5 Search")
    parser.add_argument("query", nargs="?", help="Search query")
    parser.add_argument("--oracle", help="Filter by oracle name (e.g. nazt, tonk)")
    parser.add_argument("--bucket", help="Filter by bucket (curriculum/peer-wisdom/fleet-news/chatter)")
    parser.add_argument("--limit", type=int, default=10, help="Max results (default 10)")
    parser.add_argument("--stats", action="store_true", help="Show index stats")
    args = parser.parse_args()

    db_path = os.path.expanduser(
        os.environ.get("VESSEL_DB", os.path.join(os.getcwd(), "ψ/discord-index/messages.db"))
    )

    if not os.path.exists(db_path):
        print(f"❌ DB not found: {db_path}")
        print("   Run: python3 backfill.py --all")
        sys.exit(1)

    db = MirrorDB(db_path)

    if args.stats:
        stats = db.stats()
        print(f"\n📊 Vessel Discord Index")
        print(f"   Total messages  : {stats['total_messages']:,}")
        print(f"   Channels done   : {stats['channels_backfilled']}")
        print(f"\n   By bucket:")
        for b, c in sorted(stats["by_bucket"].items(), key=lambda x: -x[1]):
            bar = "█" * min(20, c // 10)
            print(f"     {b:20s}: {c:5d}  {bar}")
        print(f"\n   Top channels:")
        for ch, c in stats["top_channels"].items():
            print(f"     {ch:25s}: {c:5d}")
        db.close()
        return

    if not args.query:
        parser.print_help()
        db.close()
        return

    results = db.search(args.query, oracle=args.oracle, bucket=args.bucket, limit=args.limit)

    filters = []
    if args.oracle:
        filters.append(f"oracle={args.oracle}")
    if args.bucket:
        filters.append(f"bucket={args.bucket}")
    filter_str = f" [{', '.join(filters)}]" if filters else ""

    print(f"\n🔍 Results for \"{args.query}\"{filter_str} — {len(results)} hit(s)\n")
    print("─" * 72)

    for r in results:
        ts = fmt_ts(r.get("ts", 0))
        oracle = r.get("oracle_name") or r.get("username", "?")
        channel = r.get("channel_name", "?")
        bucket = r.get("bucket", "?")
        content = r.get("content", "").replace("\n", " ").strip()
        if len(content) > 120:
            content = content[:117] + "..."

        print(f"[{ts}] #{channel}  {oracle}  [{bucket}]")
        print(f"  {content}")
        print()

    print("─" * 72)
    db.close()


if __name__ == "__main__":
    main()
