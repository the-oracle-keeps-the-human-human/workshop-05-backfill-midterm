"""VectorBackend abstraction — swap the semantic engine without touching search.

The MVP ships a zero-dependency deterministic `HashEmbedding` so hybrid search is
demonstrable offline. It is a SCAFFOLD, not real meaning. Production swaps in real
embeddings (Ollama nomic-embed-text / text-embedding-3-small) behind the same ABC,
and the vector index behind another (sqlite-vec / LanceDB / Qdrant) — message_ids
come back, SQLite joins the content. Source of truth always stays in SQLite.
"""
from __future__ import annotations
import hashlib
import math
import re
from abc import ABC, abstractmethod

_TOK = re.compile(r"[a-z0-9ก-๙]+")


class Embedder(ABC):
    name: str
    dims: int

    @abstractmethod
    def embed(self, text: str) -> list[float]: ...


class HashEmbedding(Embedder):
    """Bag-of-tokens hashed into a fixed-dim L2-normalised vector. Deterministic,
    dependency-free. Good enough to prove the hybrid-fusion pipeline end to end."""

    name = "hash-debug"

    def __init__(self, dims: int = 64):
        self.dims = dims

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dims
        for tok in _TOK.findall((text or "").lower()):
            h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
            vec[h % self.dims] += 1.0
        n = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / n for v in vec]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))
