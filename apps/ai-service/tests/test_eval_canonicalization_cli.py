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

    def fake_field_extract(base_url, timeout=30.0):
        def extract_fn(text):
            _rich, legacy = gold.profile_extractor.extract(text)
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
