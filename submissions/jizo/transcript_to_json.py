#!/usr/bin/env python3
"""Adapter: a real Discord fetch transcript ('[ts] author: content (id: N)')
-> messages JSON for backfill.py. Production would read Discord REST / MCP
fetch directly; for this proof we ingest the REAL fetched transcript verbatim
(P'Nat's rule: real data, never invented)."""
import json
import re
import sys

LINE = re.compile(r"^\[(?P<ts>[^\]]+)\]\s+(?P<author>.+?):\s+(?P<content>.*?)\s+\(id:\s*(?P<id>\d+)\)\s*$")


def parse(path):
    out = []
    for line in open(path, encoding="utf-8"):
        m = LINE.match(line.rstrip("\n"))
        if not m:
            continue
        out.append({
            "id": m.group("id"),
            "author": m.group("author"),
            "content": m.group("content").replace(" ⏎ ", "\n").replace("⏎", "\n"),
            "timestamp": m.group("ts"),
        })
    return out


if __name__ == "__main__":
    msgs = parse(sys.argv[1])
    json.dump(msgs, sys.stdout, ensure_ascii=False, indent=0)
    print(f"\n# parsed {len(msgs)} real messages", file=sys.stderr)
