"""TAX-8 — off-wedge résumé guard (pytest -k resume). ADR-0030; verification, NOT a builder.

Locks the production guarantee that matters for the SKILL_CANONICALIZE_ENABLED flip:
**canonicalization can NEVER block, fail, or raise into résumé generation.** A worker whose
skills are UNRESOLVED / out of launch scope still gets a complete résumé.

WHAT IS TRUE TODAY (locked here, honestly):
- The résumé renders from ``DraftProfile`` — ``skills`` carries CLOSED-SET canonical ids
  (gazetteer/vector-assigned) or is empty. For a launch-role worker the ids render; for an
  off-wedge worker the skills line degrades to "(to be confirmed)" and the résumé is still
  complete. The ids double as the machine-readable metadata (``resume_json``).
- The résumé path is STRUCTURALLY independent of canonicalization: it never calls
  ``canonicalize_skill``/``canonicalize_labels`` (proved by making both raise).

FLAGGED, NOT DECIDED (OQ#3 — product call, docs/registers/open-questions.md Q14):
the worker's confirmed RAW phrases (rich ``WorkerProfileDraft.skills`` labels) never reach
the résumé — an off-wedge welder who confirmed "MIG welding" sees "(to be confirmed)".
Rendering rich labels would change the ResumeGenerationInput contract (Zod+Pydantic) and
the worker-facing artifact — a deliberate product/builder decision, out of TAX-8 scope.

``RESUME_SYSTEM_PROMPT`` is AI-PERSONA-1 scope — pinned untouched below.
"""

from __future__ import annotations

import hashlib

from fastapi.testclient import TestClient

from app.contracts import DraftProfile, Experience
from app.extraction import build_resume
from app.main import app
from app.profiling.prompts import RESUME_SYSTEM_PROMPT

client = TestClient(app)


def _launch_role_profile() -> DraftProfile:
    return DraftProfile(
        canonical_trade_id="trade_cnc_machining",
        canonical_role_id="role_vmc_operator",
        skills=["skill_milling", "skill_fanuc"],
        machines=["machine_vmc"],
        experience=Experience(total_years=5),
    )


def _off_wedge_profile() -> DraftProfile:
    # An adjacent-trade worker (e.g. welder): nothing canonicalized — ids all empty/None.
    # The raw phrases live only on the RICH draft, which the résumé path never receives.
    return DraftProfile(experience=Experience(total_years=8))


# --- (1) launch role: ids resolve and render --------------------------------------
def test_launch_role_resume_completes_with_canonical_ids():
    text, data = build_resume(_launch_role_profile())
    assert "WORKER PROFILE" in text
    assert "skill_milling" in text and "skill_fanuc" in text
    assert "role_vmc_operator" in text
    # The ids double as machine-readable metadata for downstream consumers.
    assert data["skills"] == ["skill_milling", "skill_fanuc"]


# --- (2)+(3) adjacent trade / novel skills: complete résumé, graceful degradation --
def test_off_wedge_resume_is_complete_never_blocked():
    text, data = build_resume(_off_wedge_profile())
    assert "WORKER PROFILE" in text
    assert "Skills: (to be confirmed)" in text  # honest degradation, not a crash/block
    assert "Experience: 8 years" in text  # the rest of the résumé fully renders
    assert data["skills"] == []


def test_off_wedge_resume_endpoint_returns_200_and_text():
    resp = client.post(
        "/resume/generate",
        json={"profile": _off_wedge_profile().model_dump()},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["resume_text"].strip()
    assert "(to be confirmed)" in body["resume_text"]


# --- canonicalization NEVER raises into résumé generation -------------------------
def test_resume_path_is_structurally_independent_of_canonicalization(monkeypatch):
    # Make BOTH canonicalize entry points explode. The résumé endpoint must not notice:
    # if any future edit routes résumé generation through canonicalization, this fails.
    from app.ai import canonicalize as canon

    def boom(*_a, **_k):
        raise AssertionError("canonicalization must never run on the résumé path (TAX-8)")

    monkeypatch.setattr(canon, "canonicalize_skill", boom)
    monkeypatch.setattr(canon, "canonicalize_labels", boom)
    # Also every module-level BINDING of the entry points (a bound name dodges a patch
    # on the source module): main.py's worker-extract wiring AND profile_extractor's
    # import — the plausible future route ("re-canonicalize before rendering") would go
    # through profile_extractor.canonicalize_labels (#227 review LOW).
    from app import main as app_main
    from app.profiling import profile_extractor

    monkeypatch.setattr(app_main, "canonicalize_labels", boom, raising=False)
    monkeypatch.setattr(profile_extractor, "canonicalize_labels", boom, raising=False)

    resp = client.post(
        "/resume/generate",
        json={"profile": _launch_role_profile().model_dump()},
    )
    assert resp.status_code == 200
    assert "skill_milling" in resp.json()["resume_text"]


# --- RESUME_SYSTEM_PROMPT untouched (AI-PERSONA-1 scope) ---------------------------
def test_resume_system_prompt_baseline_unchanged():
    """Deliberately brittle: TAX-8's charter says the résumé prompt is OUT of scope
    (AI-PERSONA-1 owns it). If you are editing the prompt ON PURPOSE, update this hash
    in the same diff — the change becomes visible in review instead of drifting in."""
    digest = hashlib.sha256(RESUME_SYSTEM_PROMPT.encode("utf-8")).hexdigest()[:16]
    assert digest == "0f08076b41734eea"
    assert len(RESUME_SYSTEM_PROMPT) > 50  # non-empty, real prompt
