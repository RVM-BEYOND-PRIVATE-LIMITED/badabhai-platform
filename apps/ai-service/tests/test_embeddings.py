"""Skill-alias embedding tests (ADR-0030 / TAX-3) — mock path, zero spend.

Covers: pseudonymize-before-embed (spy), fail-closed on block, mock dimension == schema
vector(768), and the real path being SG-4-gated (flag off → no provider call). The batch
runner itself lives in packages/db (embed-skill-aliases.ts) and is tested there — this file
covers only the per-text primitives (embed_text) it calls.
"""

from __future__ import annotations

from app.ai import embeddings
from app.ai.embeddings import EMBEDDING_DIMENSION, embed_text
from app.config import Settings
from app.pseudonymize import PseudonymizationResult


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
    # The embedding task must be explicitly allowlisted (empty = NO tasks, fail-closed).
    return Settings(
        ai_enable_real_calls=True,
        gemini_flash_api_key="test-key",
        ai_real_call_tasks="skill_embedding",
    )


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
    assert res.model == "gemini-embedding-001"

