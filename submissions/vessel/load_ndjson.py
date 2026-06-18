#!/usr/bin/env python3
"""Load NDJSON file of Discord messages into MirrorDB."""
import sys, json, os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from mirror_db import MirrorDB

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 load_ndjson.py <file.ndjson> <channel_name> [db_path]")
        print("  db_path defaults to $VESSEL_DB or ./ψ/discord-index/messages.db")
        sys.exit(1)

    ndjson_file = sys.argv[1]
    channel_name = sys.argv[2]

    db_path = (
        sys.argv[3] if len(sys.argv) > 3
        else os.environ.get("VESSEL_DB", os.path.join(os.getcwd(), "ψ/discord-index/messages.db"))
    )
    db_path = os.path.expanduser(db_path)
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    db = MirrorDB(db_path)

    inserted = 0
    total = 0
    last_id = None
    channel_id = None

    with open(ndjson_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)
            channel_id = msg.get("channel_id", "")
            total += 1
            new = db.upsert_message(msg, channel_id, channel_name)
            if new:
                inserted += 1
            if last_id is None:
                last_id = msg["id"]  # first = most recent (NDJSON newest-first from fetch)

    if last_id and channel_id:
        db.update_sync_state(channel_id, channel_name, last_id, total, complete=False)
        parity = db.parity_check(channel_id, total)
        print(f"✅ Loaded {channel_name}: {inserted} new / {total} total | parity ok={parity['ok']} mirror={parity['mirror_count']} db={parity['db_count']}")
    else:
        print("No messages loaded")

    db.close()

if __name__ == "__main__":
    main()
