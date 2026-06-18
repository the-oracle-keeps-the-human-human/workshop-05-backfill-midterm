"""End-to-end test. Run directly (`python3 tests/test_demo.py`) or via pytest.

Exercises: cold backfill, parity gate, idempotent re-run, warm tail (new/edit/
delete), edit versioning, tombstone, vector prune, hybrid/fts/vector search,
gap detection.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bf.db import connect
from bf.fetcher import FixtureFetcher
from bf.sync import sync_all
from bf.parity import verify, gap_ranges
from bf.search import search, reindex_vectors

FIX = os.path.join(os.path.dirname(__file__), "..", "fixtures")
COLD = os.path.join(FIX, "cold.json")
DELTA = os.path.join(FIX, "delta.json")


def fresh_db():
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    os.remove(path)
    return path


def test_full_lifecycle():
    db = fresh_db()
    conn = connect(db)

    # 1) cold backfill
    sync_all(conn, FixtureFetcher(COLD), mode="cold")
    reindex_vectors(conn); conn.commit()
    live = conn.execute("SELECT COUNT(*) FROM messages WHERE deleted=0").fetchone()[0]
    assert live == 6, live

    # 2) parity gate passes against the cold source
    rep = verify(conn, FixtureFetcher(COLD))
    assert rep["ok"] and rep["missing_total"] == 0

    # 3) idempotent: re-running cold changes nothing
    sync_all(conn, FixtureFetcher(COLD), mode="cold")
    assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 6

    # 4) warm tail: +1 new, 1 edit, 1 delete
    sync_all(conn, FixtureFetcher(DELTA), mode="warm")
    reindex_vectors(conn); conn.commit()

    live = conn.execute("SELECT COUNT(*) FROM messages WHERE deleted=0").fetchone()[0]
    tomb = conn.execute("SELECT COUNT(*) FROM messages WHERE deleted=1").fetchone()[0]
    assert live == 6 and tomb == 1, (live, tomb)

    # edit -> version 2 recorded (Nothing is Deleted)
    v = conn.execute("SELECT COUNT(*) FROM message_versions WHERE id='1500000000000010003'").fetchone()[0]
    assert v == 2, v

    # delete -> tombstone, not row removal
    d = conn.execute("SELECT deleted FROM messages WHERE id='1500000000000010002'").fetchone()[0]
    assert d == 1

    # vector index pruned of tombstoned message
    vec = conn.execute("SELECT COUNT(*) FROM message_vectors").fetchone()[0]
    assert vec == 6, vec

    # FTS excludes deleted
    fts = conn.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0]
    assert fts == 6, fts

    # 5) search: new message reachable, tombstoned not
    hits = search(conn, "semantic embeddings", mode="hybrid")
    assert any("embeddings" in h["content"] for h in hits)
    assert all("will be deleted later" not in h["content"] for h in hits)

    # fts exact-term still works
    assert search(conn, "parity", mode="fts")

    # 6) parity after warm: missing=0, the deleted one shows as tombstone-extra
    rep2 = verify(conn, FixtureFetcher(DELTA))
    assert rep2["ok"] and rep2["missing_total"] == 0
    gen = [c for c in rep2["channels"] if c["name"] == "general"][0]
    assert gen["extra"] == ["1500000000000010002"]

    # 7) gap detection helper collapses ranges
    assert gap_ranges(["10", "11", "12", "20"]) == [("10", "12"), ("20", "20")]

    os.remove(db)
    print("✓ test_full_lifecycle PASSED")


if __name__ == "__main__":
    test_full_lifecycle()
