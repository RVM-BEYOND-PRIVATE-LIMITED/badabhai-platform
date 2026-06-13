"""Tests for the canonicalization eval CLI (offline + --real client wiring).

No real LLM and no network: the --real client is pointed at a stub that mimics
``POST /profile/extract`` so we exercise the request/response wiring without a
live server. Fabricated data only.
"""

from __future__ import annotations

from app.profiling import canonicalization_gold as gold
from app.profiling import eval_canonicalization as cli


def test_heuristic_mode_exits_zero(capsys):
    """Default (offline heuristic) run clears the core+negative gate -> exit 0."""
    rc = cli.main([])
    out = capsys.readouterr().out
    assert rc == 0
    assert "heuristic" in out.lower()
    assert "core" in out and "negative" in out and "hard" in out
    assert "PASS" in out


def test_real_mode_scores_all_tiers_against_stub_endpoint(capsys, monkeypatch):
    """--real builds a client that POSTs each text and reads canonical_role_id.

    We stub the client so the wiring (POST body, response parsing, all-tier
    scoring, exit code) is covered without a live server or any LLM call. The
    stub echoes the heuristic, so overall < 90% -> exit 1 (same as mock staging).
    """

    def fake_extract_fn(base_url: str, timeout: float = 30.0) -> gold.ExtractFn:
        def extract_fn(text: str) -> object:
            # Mimic the endpoint: heuristic over the (locally) extracted text.
            _rich, legacy = gold.profile_extractor.extract(text)
            # Return a dict-shaped path through the real client's _RoleOnly.
            return cli._RoleOnly(legacy.canonical_role_id)

        return extract_fn

    monkeypatch.setattr(cli, "_make_real_extract_fn", fake_extract_fn)
    rc = cli.main(["--real", "--base-url", "http://localhost:9999"])
    out = capsys.readouterr().out
    assert "--real" in out
    assert "profile/extract" in out
    # Mock-equivalent heuristic can't clear the hard tier -> overall < 90% -> fail.
    assert rc == 1
    assert "FAIL" in out


def test_role_only_exposes_canonical_role_id():
    obj = cli._RoleOnly("role_vmc_operator")
    assert obj.canonical_role_id == "role_vmc_operator"


def test_per_field_offline_reports_fields_and_attribution(capsys):
    """--per-field (offline) scores every field, prints the aggregate + the
    TD3/extraction split, and exits 1 (heuristic can't clear the hard tier)."""
    rc = cli.main(["--per-field"])
    out = capsys.readouterr().out
    assert "Per-field" in out
    for field in ("trade", "role", "skills", "machines", "experience"):
        assert field in out
    assert "AGGREGATE" in out
    assert "Miss attribution" in out
    assert "over-masking (TD3)" in out
    # Heuristic misses the hard tier -> aggregate < 90% -> exit 1.
    assert rc == 1
    assert "FAIL" in out


def test_per_field_real_uses_both_endpoints_via_stubs(capsys, monkeypatch):
    """--per-field --real wires /profile/extract + /profiling/respond +
    /pseudonymize. We stub all three so the wiring is covered WITHOUT a live
    server or any LLM call (fabricated data only)."""

    def fake_field_extract(base_url, timeout=30.0, *, collector=None, min_interval=0.0):
        def extract_fn(text):
            _rich, legacy = gold.profile_extractor.extract(text)
            if collector is not None:
                collector.record(real_call=True, success=True)
            return legacy

        return extract_fn

    def fake_pseudo(base_url, timeout=30.0):
        from app.pseudonymize import pseudonymize

        return lambda text: pseudonymize(text).text

    monkeypatch.setattr(cli, "_make_real_field_extract_fn", fake_field_extract)
    monkeypatch.setattr(cli, "_make_real_pseudonymize_fn", fake_pseudo)
    monkeypatch.setattr(cli, "_smoke_profiling_respond", lambda base_url: True)

    rc = cli.main(["--per-field", "--real", "--base-url", "http://localhost:9999"])
    out = capsys.readouterr().out
    assert "--per-field --real" in out
    assert "profile/extract" in out and "profiling/respond" in out
    assert "Miss attribution" in out
    # Heuristic-equivalent stub can't clear the hard tier -> exit 1.
    assert rc == 1


# --- Fallback detection (Fix A): mock-fallback contamination ----------------
def _patch_respond_and_pseudo(monkeypatch):
    """Stub the smoke + pseudonymize endpoints so only extract behavior matters."""
    def fake_pseudo(base_url, timeout=30.0):
        from app.pseudonymize import pseudonymize

        return lambda text: pseudonymize(text).text

    monkeypatch.setattr(cli, "_make_real_pseudonymize_fn", fake_pseudo)
    monkeypatch.setattr(cli, "_smoke_profiling_respond", lambda base_url: True)


def test_per_field_real_invalid_when_cases_fall_back_to_mock(capsys, monkeypatch):
    """If ANY scored case reports ai_metadata real_call=true AND success=false
    (a 429 -> mock fallback), the run is INVALID: loud banner, non-zero exit, and
    NO PASS/FAIL aggregate line — a throttled run can't be read as a real result."""
    _patch_respond_and_pseudo(monkeypatch)

    def fake_extract(base_url, timeout=30.0, *, collector=None, min_interval=0.0):
        # Score every case as if real, but mark ~1/3 as mock-fallbacks.
        calls = {"n": 0}

        def extract_fn(text):
            _rich, legacy = gold.profile_extractor.extract(text)
            if collector is not None:
                fell_back = (calls["n"] % 3 == 0)  # real_call but success=false
                collector.record(real_call=True, success=not fell_back)
            calls["n"] += 1
            return legacy

        return extract_fn

    monkeypatch.setattr(cli, "_make_real_field_extract_fn", fake_extract)
    rc = cli.main(["--per-field", "--real", "--base-url", "http://localhost:9999"])
    out = capsys.readouterr().out

    assert rc == 1
    assert "INVALID REAL RUN" in out
    assert "fell back to mock" in out
    # The aggregate PASS/FAIL line must NOT be emitted for a contaminated run.
    assert "PASS: aggregate" not in out
    assert "FAIL: aggregate" not in out


def test_per_field_real_all_success_scores_and_gates_normally(capsys, monkeypatch):
    """An all-success real-shaped run (every case real_call=true, success=true)
    scores + gates exactly like before, and prints the real-call summary."""
    _patch_respond_and_pseudo(monkeypatch)

    def fake_extract(base_url, timeout=30.0, *, collector=None, min_interval=0.0):
        def extract_fn(text):
            _rich, legacy = gold.profile_extractor.extract(text)
            if collector is not None:
                collector.record(real_call=True, success=True)
            return legacy

        return extract_fn

    monkeypatch.setattr(cli, "_make_real_field_extract_fn", fake_extract)
    rc = cli.main(["--per-field", "--real", "--base-url", "http://localhost:9999"])
    out = capsys.readouterr().out

    assert "INVALID REAL RUN" not in out
    assert "real calls:" in out and "succeeded" in out
    assert "AGGREGATE" in out
    # Heuristic-equivalent stub can't clear the hard tier -> normal FAIL aggregate.
    assert rc == 1
    assert "FAIL: aggregate" in out


def test_min_interval_flag_paces_real_calls(monkeypatch):
    """--min-interval sleeps between real calls so a free tier doesn't mass-429.
    We assert the extract_fn actually sleeps (no real network / no LLM)."""
    sleeps: list[float] = []
    monkeypatch.setattr(cli.time, "sleep", lambda s: sleeps.append(s))

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "profile": {"canonical_role_id": "role_vmc_operator"},
                "ai_metadata": {"real_call": True, "success": True},
            }

    class _Client:
        def __init__(self, *a, **k):
            pass

        def post(self, *a, **k):
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "Client", _Client)
    collector = cli.RealCallCollector()
    extract_fn = cli._make_real_field_extract_fn(
        "http://localhost:9999", collector=collector, min_interval=5.0,
    )
    extract_fn("vmc chalata hu")  # first call: no prior timestamp -> no sleep
    extract_fn("vmc chalata hu")  # second call: should pace
    assert sleeps, "expected at least one paced sleep between cases"
    assert collector.total == 2 and not collector.contaminated


def test_collector_flags_only_real_attempt_failures():
    """RealCallCollector: real_call=true + success=false is a fallback; mock
    (real_call=false) and real success are NOT contamination."""
    c = cli.RealCallCollector()
    c.record(real_call=True, success=True)    # real ok
    c.record(real_call=False, success=True)   # never attempted real (mock mode)
    c.record(real_call=True, success=False)   # real attempted, failed -> fallback
    assert c.total == 3
    assert len(c.fell_back) == 1
    assert len(c.real_success) == 1
    assert c.contaminated
