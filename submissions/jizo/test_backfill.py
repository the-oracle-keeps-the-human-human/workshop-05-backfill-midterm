#!/usr/bin/env python3
"""Tests for Jizo's backfill+index. Stdlib only. Run: python3 -m unittest -v test_backfill"""
import os
import sqlite3
import tempfile
import unittest

import backfill as bf


def rec(mid, author, content, edited=False, tomb=False):
    r = bf.normalize({"id": mid, "author": author, "content": content, "edited": edited}, channel="c1")
    r["is_tombstone"] = tomb
    return r


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "t.sqlite")

    def store(self):
        return bf.Store(self.db)

    def test_snowflake_to_ts(self):
        # Discord snowflakes decode to ms since 2015; ordering must be preserved.
        a = bf.snowflake_to_ms("1517308563754586193")
        b = bf.snowflake_to_ms("1517311595821269032")
        self.assertGreater(a, bf.DISCORD_EPOCH_MS)
        self.assertLess(a, b)

    def test_ingest_and_idempotent(self):
        s = self.store()
        for m in (rec("100", "yim", "hello"), rec("101", "jizo", "world")):
            s.upsert(m)
        s.commit()
        self.assertEqual(s.stats()["messages"], 2)
        # Re-ingest identical -> all 'same', zero new rows.
        s2 = self.store()
        kinds = [s2.upsert(m) for m in (rec("100", "yim", "hello"), rec("101", "jizo", "world"))]
        s2.commit()
        self.assertEqual(kinds, ["same", "same"])
        self.assertEqual(s2.stats()["rows"], 2)

    def test_edit_keeps_history(self):
        s = self.store()
        self.assertEqual(s.upsert(rec("200", "yim", "draft")), "new")
        self.assertEqual(s.upsert(rec("200", "yim", "final")), "edit")
        s.commit()
        rows = s.db.execute("SELECT version,content FROM messages WHERE msg_id='200' ORDER BY version").fetchall()
        self.assertEqual([r["content"] for r in rows], ["draft", "final"])  # v1 preserved
        self.assertEqual(s.stats()["alive"], 1)

    def test_delete_tombstone_via_complete_snapshot(self):
        s = self.store()
        s.upsert(rec("300", "yim", "keep"))
        s.upsert(rec("301", "yim", "willdelete"))
        s.commit()
        # A COMPLETE snapshot that omits 301 -> 301 is tombstoned, history intact.
        alive_before = s.current_ids()
        self.assertEqual(alive_before, {"300", "301"})
        self.assertTrue(s.tombstone("301"))
        s.commit()
        self.assertEqual(s.current_ids(), {"300"})           # alive set shrank
        self.assertEqual(s.stats()["messages"], 2)            # but msg row still exists
        self.assertEqual(s.stats()["tombstones"], 1)
        # Tombstoning twice is a no-op (idempotent delete).
        self.assertFalse(s.tombstone("301"))

    def test_thai_substring_recall(self):
        s = self.store()
        s.upsert(rec("400", "yim", "ออกแบบระบบแบ็คฟิลให้ครบ"))
        s.upsert(rec("401", "yim", "unrelated english text"))
        s.commit()
        hits = s.search("ระบบ")
        ids = {r["msg_id"] for r in hits}
        self.assertIn("400", ids)         # found 'ระบบ' embedded in 'ระบบแบ็คฟิล'
        self.assertNotIn("401", ids)

    def test_parity_clean(self):
        s = self.store()
        for mid in ("500", "501", "502"):
            s.upsert(rec(mid, "yim", f"m{mid}"))
        s.commit()
        self.assertEqual(s.current_ids(), {"500", "501", "502"})

    def test_verify_detects_tamper(self):
        s = self.store()
        s.upsert(rec("600", "yim", "grounded truth"))
        s.commit()
        self.assertEqual(s.verify(), [])                      # clean mirror
        # Mutate content behind the index's back -> hash no longer matches.
        raw = sqlite3.connect(self.db)
        raw.execute("UPDATE messages SET content='fabricated' WHERE msg_id='600'")
        raw.commit(); raw.close()
        self.assertEqual(self.store().verify(), ["600"])      # tamper caught


if __name__ == "__main__":
    unittest.main()
