"""Skill-alias embedding tests (ADR-0030 / TAX-3) — mock path, zero spend.

Covers: pseudonymize-before-embed (spy), fail-closed on block, idempotent-on-null batch,
mock dimension == schema vector(768), and the real path being SG-4-gated (flag off → no
provider call).
"""

from __future__ import annotations

from app.ai import embeddings
from app.ai.embeddings import EMBEDDING_DIMENSION, embed_aliases, embed_text
from app.config import Settings
from app.pseudonymize import PseudonymizationResult


class MemStore:
    """In-memory AliasStore — rows[alias_id] = [text, vector|None]. `fetch_unembedded`
    returns only NULL-embedding rows (what makes the batch resumable/idempotent)."""

    def __init__(self, rows: dict[str, list]):
        self.rows = rows

    def fetch_unembedded(
        self, limit: int, exclude_ids: frozenset[str] = frozenset()
    ) -> list[tuple[str, str]]:
        # Mirrors the SQL seam: NULL embedding AND id not in the run's blocked set. Excluding
        # `exclude_ids` is what lets the window advance past blocked NULL rows (F1 fix).
        out = [
            (aid, v[0])
            for aid, v in self.rows.items()
            if v[1] is None and aid not in exclude_ids
        ]
        return out[:limit]

    def save_embedding(self, alias_id: str, vector: list[float]) -> None:
        self.rows[alias_id][1] = vector


def _pseudo(text: str = "", *, blocked: bool = False, reason: str | None = None):
    return PseudonymizationResult(
        text=text,
        blocked=blocked,
        blocked_reason=reason,
        replaced_entities=0,
        placeholder_tokens=[],
    )


def _mock_settings() -> Settings:
    # Real calls OFF (default) — every embed takes the deterministic mock path.
    return Settings()


def _real_settings() -> Settings:
    return Settings(ai_enable_real_calls=True, gemini_flash_api_key="test-key")


# --- (4) mock vector dimension == schema vector(768) + determinism -----------
def test_mock_embedding_is_768_dim_and_deterministic():
    a = embed_text("CNC milling", _mock_settings())
    b = embed_text("CNC milling", _mock_settings())
    assert a.is_mock is True and a.blocked is False
    assert a.vector is not None and len(a.vector) == EMBEDDING_DIMENSION == 768
    assert a.vector == b.vector  # same text -> same vector (idempotent, zero spend)
    assert embed_text("TIG welding", _mock_settings()).vector != a.vector


# --- (1) pseudonymize called before every embed (spy) ------------------------
def test_pseudonymize_runs_before_every_embed(monkeypatch):
    seen: list[str] = []
    real = embeddings.pseudonymize

    def spy(text, *args, **kwargs):
        seen.append(text)
        return real(text, *args, **kwargs)

    monkeypatch.setattr(embeddings, "pseudonymize", spy)
    embed_text("Fanuc controller", _mock_settings())
    assert seen == ["Fanuc controller"]  # pseudonymize saw the raw text first


# --- (2) fail-closed: pseudonymize block -> NO embed call --------------------
def test_blocked_phrase_is_not_embedded(monkeypatch):
    monkeypatch.setattr(
        embeddings,
        "pseudonymize",
        lambda *_a, **_k: _pseudo(blocked=True, reason="residual_digits"),
    )
    # Even in REAL mode, a blocked phrase must never reach the provider.
    real_calls: list[str] = []
    monkeypatch.setattr(embeddings, "_real_embedding", lambda t, s: real_calls.append(t) or [0.0])

    res = embed_text("ref 12345678", _real_settings())
    assert res.blocked is True and res.vector is None
    assert real_calls == []  # provider never called on a blocked phrase


# --- SG-2 masking half: the embedder receives the MASKED text, never raw ------
def test_mock_embedder_receives_pseudonymized_text_not_raw(monkeypatch):
    # An entity that MASKS but does NOT block (employer) must reach the embedder already
    # masked. A regression passing raw `text` would egress "Sharma Industries" to the
    # provider and every other test would stay green — this closes that gap.
    seen: list[str] = []
    monkeypatch.setattr(embeddings, "_mock_embedding", lambda t: seen.append(t) or [0.0] * 768)
    res = embed_text("operator at Sharma Industries Pvt Ltd", _mock_settings())
    assert res.blocked is False
    assert seen and "Sharma" not in seen[0] and "[EMPLOYER_1]" in seen[0]
    assert res.text == seen[0]  # the safe text on the result == exactly what was embedded


def test_real_embedder_receives_pseudonymized_text_not_raw(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(embeddings, "_real_embedding", lambda t, s: seen.append(t) or [0.1] * 768)
    res = embed_text("worked at Kumar Engineering Works", _real_settings())
    assert res.is_mock is False and res.blocked is False
    assert seen and "Kumar" not in seen[0] and "[EMPLOYER_1]" in seen[0]
    assert res.text == seen[0]


# --- (5) real path guarded by the flag (off -> no provider call) -------------
def test_real_path_is_gated_off_by_default(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(embeddings, "_real_embedding", lambda t, s: called.append(t) or [1.0] * 768)

    res = embed_text("milling", _mock_settings())  # real OFF (default)
    assert res.is_mock is True
    assert called == []  # the real provider is never called when the flag is off


def test_real_path_used_when_flag_on(monkeypatch):
    monkeypatch.setattr(embeddings, "_real_embedding", lambda t, s: [0.5] * EMBEDDING_DIMENSION)
    res = embed_text("milling", _real_settings())
    assert res.is_mock is False
    assert res.vector == [0.5] * EMBEDDING_DIMENSION
    assert res.model == "text-embedding-004"


# --- (3) batch: idempotent on NULL-only, resumable, fail-closed counted ------
def test_embed_aliases_is_idempotent_on_null_rows():
    store = MemStore(
        {
            "a1": ["CNC milling", None],
            "a2": ["TIG welding", None],
            "a3": ["Fanuc", None],
        }
    )
    report = embed_aliases(store, _mock_settings())
    assert report.embedded == 3 and report.blocked == 0 and report.is_mock is True
    assert all(len(store.rows[a][1]) == 768 for a in store.rows)

    # Re-run: every row now has an embedding -> fetch_unembedded returns [] -> no-op.
    again = embed_aliases(store, _mock_settings())
    assert again.embedded == 0 and again.blocked == 0


def test_embed_aliases_skips_blocked_rows_leaving_them_null(monkeypatch):
    def selective(text, *args, **kwargs):
        if "12345678" in text:
            return _pseudo(blocked=True, reason="residual_digits")
        return _pseudo(text=text)

    monkeypatch.setattr(embeddings, "pseudonymize", selective)
    store = MemStore({"ok": ["milling", None], "bad": ["ref 12345678", None]})
    report = embed_aliases(store, _mock_settings())
    assert report.embedded == 1 and report.blocked == 1
    assert report.blocked_alias_ids == ["bad"]
    assert store.rows["ok"][1] is not None  # embedded
    assert store.rows["bad"][1] is None  # left NULL for a later re-run


def test_embed_aliases_crosses_batches_without_double_counting_blocked(monkeypatch):
    # >1 batch (batch_size=2) with a blocked row wedged in the middle. A blocked row stays
    # NULL, so a naive `WHERE embedding IS NULL LIMIT n` re-returns it every batch — double-
    # counting it and starving rows behind it. The exclude-set seam must count it ONCE and
    # still drain every clean row (F1).
    def selective(text, *args, **kwargs):
        if "12345678" in text:
            return _pseudo(blocked=True, reason="residual_digits")
        return _pseudo(text=text)

    monkeypatch.setattr(embeddings, "pseudonymize", selective)
    store = MemStore(
        {
            "c1": ["milling", None],
            "c2": ["welding", None],
            "bad": ["ref 12345678", None],
            "c3": ["grinding", None],
            "c4": ["turning", None],
        }
    )
    report = embed_aliases(store, _mock_settings(), batch_size=2)
    assert report.embedded == 4  # every clean row drained across batches
    assert report.blocked == 1  # counted ONCE despite spanning batches
    assert report.blocked_alias_ids == ["bad"]  # no duplicate ids
    assert store.rows["bad"][1] is None  # left NULL for a later re-run
    assert all(store.rows[c][1] is not None for c in ["c1", "c2", "c3", "c4"])


def test_all_blocked_batch_terminates_not_infinite_loop(monkeypatch):
    # A full batch of blocked rows stays NULL; without a no-progress break the batch would
    # re-fetch the same rows forever. Assert it TERMINATES (no hang) and does not re-embed.
    monkeypatch.setattr(
        embeddings, "pseudonymize", lambda *_a, **_k: _pseudo(blocked=True, reason="x")
    )
    store = MemStore({"a": ["ref 111", None], "b": ["ref 222", None]})
    report = embed_aliases(store, _mock_settings(), batch_size=2)
    assert report.embedded == 0
    assert report.blocked == 2  # each blocked row counted ONCE (not looped)
    assert all(store.rows[a][1] is None for a in store.rows)
