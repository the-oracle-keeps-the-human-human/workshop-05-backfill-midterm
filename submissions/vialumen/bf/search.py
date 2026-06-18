"""Hybrid search: FTS5/BM25 (exact) + vector (semantic) fused with RRF.

RRF (Reciprocal Rank Fusion): score(d) = sum 1/(k + rank_i(d)) over each result
list. No score normalisation needed — robust when BM25 and cosine live on
different scales. Metadata filters are first-class and applied as pre-filters.
"""
from __future__ import annotations
import json
import sqlite3

from .embedding import Embedder, HashEmbedding, cosine

RRF_K = 60


def _filter_sql(filters: dict) -> tuple[str, list]:
    clauses, params = ["deleted=0"], []
    fmap = {
        "channel_id": "channel_id=?", "thread_id": "thread_id=?",
        "author_id": "author_id=?", "has_attachment": "has_attachment=?",
    }
    for key, sql in fmap.items():
        if filters.get(key) is not None:
            clauses.append(sql)
            params.append(filters[key])
    if filters.get("since"):
        clauses.append("ts>=?"); params.append(filters["since"])
    if filters.get("until"):
        clauses.append("ts<=?"); params.append(filters["until"])
    return " AND ".join(clauses), params


def _candidate_ids(conn, filters) -> set[str]:
    where, params = _filter_sql(filters)
    rows = conn.execute(f"SELECT id FROM messages WHERE {where}", params).fetchall()
    return {r["id"] for r in rows}


def fts_search(conn, query, allow: set[str], limit=50) -> list[str]:
    try:
        rows = conn.execute(
            "SELECT id, bm25(messages_fts) AS rank FROM messages_fts "
            "WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?",
            (query, limit * 4),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [r["id"] for r in rows if r["id"] in allow][:limit]


def vector_search(conn, query, embedder: Embedder, allow: set[str], limit=50) -> list[str]:
    q = embedder.embed(query)
    rows = conn.execute(
        "SELECT id, embedding FROM message_vectors WHERE model=?", (embedder.name,)
    ).fetchall()
    scored = [(r["id"], cosine(q, json.loads(r["embedding"])))
              for r in rows if r["id"] in allow]
    scored.sort(key=lambda x: x[1], reverse=True)
    return [i for i, _ in scored[:limit]]


def _rrf(*ranklists: list[str]) -> dict[str, float]:
    score: dict[str, float] = {}
    for rl in ranklists:
        for rank, mid in enumerate(rl):
            score[mid] = score.get(mid, 0.0) + 1.0 / (RRF_K + rank + 1)
    return score


def search(conn, query: str, *, mode="hybrid", limit=10, embedder: Embedder | None = None,
           **filters) -> list[dict]:
    embedder = embedder or HashEmbedding()
    allow = _candidate_ids(conn, filters)
    if not allow:
        return []
    fts = fts_search(conn, query, allow) if mode in ("hybrid", "fts") else []
    vec = vector_search(conn, query, embedder, allow) if mode in ("hybrid", "vector") else []
    if mode == "fts":
        ranked = list(fts)
    elif mode == "vector":
        ranked = list(vec)
    else:
        fused = _rrf(fts, vec)
        ranked = [m for m, _ in sorted(fused.items(), key=lambda x: x[1], reverse=True)]
    ranked = ranked[:limit]
    if not ranked:
        return []
    qmarks = ",".join("?" * len(ranked))
    rows = conn.execute(
        f"SELECT id,channel_id,thread_id,author_name,content,ts,version "
        f"FROM messages WHERE id IN ({qmarks})", ranked,
    ).fetchall()
    by_id = {r["id"]: dict(r) for r in rows}
    return [by_id[i] for i in ranked if i in by_id]


def reindex_vectors(conn, embedder: Embedder | None = None) -> int:
    """(Re)build vector slots for all live messages."""
    embedder = embedder or HashEmbedding()
    from .util import now_iso
    # prune vectors for tombstoned messages (keep the vector index in sync)
    conn.execute("DELETE FROM message_vectors WHERE id IN "
                 "(SELECT id FROM messages WHERE deleted=1)")
    rows = conn.execute("SELECT id, content FROM messages WHERE deleted=0").fetchall()
    n = 0
    for r in rows:
        emb = embedder.embed(r["content"])
        conn.execute(
            "INSERT INTO message_vectors(id,dims,model,backend,embedding,updated_at)"
            " VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET"
            " embedding=excluded.embedding, model=excluded.model, updated_at=excluded.updated_at",
            (r["id"], embedder.dims, embedder.name, embedder.name,
             json.dumps(emb), now_iso()),
        )
        n += 1
    return n
