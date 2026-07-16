"""TAX-8 — off-wedge résumé guard (pytest -k resume). ADR-0030; verification, NOT a builder.

Locks the production guarantee that matters for the SKILL_CANONICALIZE_ENABLED flip:
**canonicalization can NEVER block, fail, or raise into résumé generation.** A worker whose
skills are UNRESOLVED / out of launch scope still gets a complete résumé.

WHAT IS TRUE TODAY (locked here, honestly):
- The résumé renders from ``DraftProfile`` — ``skills`` carries CLOSED-SET canonical ids
  (gazetteer/vector-assigned) or is empty, and (Q14, decided 2026-07-16) ``skill_labels``
  carries the worker-confirmed RAW labels. For a launch-role worker the ids render; an
  off-wedge worker with confirmed labels sees the labels; with neither, the skills line
  degrades to "(to be confirmed)" and the résumé is still complete. The ids double as the
  machine-readable metadata (``resume_json``).
- The résumé path is STRUCTURALLY independent of canonicalization: it never calls
  ``canonicalize_skill``/``canonicalize_labels`` (proved by making both raise).

Q14 DECIDED (2026-07-16, owner — was OQ#3, docs/registers/open-questions.md Q14):
render the confirmed RAW labels, via the additive ``DraftProfile.skill_labels`` field
(Zod+Pydantic). SG-2 rides the résumé boundary: every label must be CERTIFIED CLEAN by
``pseudonymize`` (not blocked, nothing masked, text unchanged) or it is DROPPED — from the
artifact AND the LLM payload alike (they share ONE filtered profile). Locked below:
labels render; suspect labels drop silently; the résumé ALWAYS completes.

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
    # An adjacent-trade worker (e.g. welder): nothing canonicalized — ids all empty/None
    # AND no confirmed labels (skill_labels default []). Q14 carries confirmed raw labels
    # onto DraftProfile.skill_labels; this fixture is the no-labels degradation case.
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


# =====================================================================================
# Q14 (ADR-0030 OQ#3, decided 2026-07-16): worker-confirmed RAW skill labels render on
# the résumé, pseudonymize-gated (SG-2) at the résumé boundary. Additive to the TAX-8
# locks above — none of them were deleted or weakened.
# =====================================================================================


def _welder_profile(labels: list[str]) -> DraftProfile:
    # Off-wedge welder: NOTHING canonicalized, but the worker confirmed raw labels.
    return DraftProfile(experience=Experience(total_years=8), skill_labels=labels)


# --- acceptance: the off-wedge welder finally sees their confirmed skills ----------
def test_offwedge_confirmed_labels_render_on_resume():
    text, data = build_resume(_welder_profile(["MIG welding", "TIG welding"]))
    assert "MIG welding" in text and "TIG welding" in text
    assert "Skills: (to be confirmed)" not in text
    assert data["skill_labels"] == ["MIG welding", "TIG welding"]
    assert data["skills"] == []  # matchable ids untouched — labels are display-only


def test_offwedge_labels_render_through_endpoint():
    resp = client.post(
        "/resume/generate",
        json={"profile": _welder_profile(["MIG welding"]).model_dump()},
    )
    assert resp.status_code == 200
    assert "MIG welding" in resp.json()["resume_text"]


def test_old_payload_without_skill_labels_still_parses_and_degrades():
    # Backward compatibility: old persisted DraftProfile rows lack skill_labels.
    profile = DraftProfile.model_validate({"experience": {"total_years": 8}})
    assert profile.skill_labels == []
    text, _ = build_resume(profile)
    assert "Skills: (to be confirmed)" in text  # byte-for-byte today's behavior


# --- SG-2: the pseudonymize gate at the résumé boundary ----------------------------
def test_blocked_label_is_dropped_from_artifact_and_llm_payload(monkeypatch):
    # "1234567" (7-digit run) trips the fail-closed residual-digit block (a 10-digit
    # run would be MASKED as a phone instead — covered by the masked-label test).
    from app.pseudonymize import pseudonymize

    bad = "welding grade 1234567"
    assert pseudonymize(bad).blocked is True  # honest precondition

    from app import main as app_main

    captured: dict = {}
    original_run = app_main.router.run

    async def spy_run(task_type, **kwargs):
        captured["messages"] = kwargs["messages"]
        return await original_run(task_type, **kwargs)

    monkeypatch.setattr(app_main.router, "run", spy_run)

    resp = client.post(
        "/resume/generate",
        json={"profile": _welder_profile(["MIG welding", bad]).model_dump()},
    )
    assert resp.status_code == 200  # résumé ALWAYS completes
    body = resp.json()
    # Dropped from the worker-facing artifact...
    assert bad not in body["resume_text"] and "1234567" not in body["resume_text"]
    assert bad not in str(body["resume_json"])
    # ...AND from the exact payload handed to the LLM seam (same filtered profile).
    import json as _json

    llm_payload = _json.dumps(captured["messages"])
    assert bad not in llm_payload and "1234567" not in llm_payload
    # The clean label in the SAME request still renders (proves the gate is per-label).
    assert "MIG welding" in body["resume_text"] and "MIG welding" in llm_payload


def test_masked_label_is_dropped():
    # A label pseudonymize would MASK (replaced_entities > 0) is dropped too — the
    # gate demands certified-clean (nothing masked, text unchanged), not just unblocked.
    from app.pseudonymize import pseudonymize

    city_label = "welding in Pune"  # known-city gazetteer hit -> [CITY_1]
    phone_label = "welding 9876543210"  # 10-digit run -> masked as [PHONE_1]
    for label in (city_label, phone_label):
        r = pseudonymize(label)
        assert r.blocked is False and r.replaced_entities > 0  # honest precondition

    resp = client.post(
        "/resume/generate",
        json={"profile": _welder_profile([city_label, phone_label, "TIG welding"]).model_dump()},
    )
    assert resp.status_code == 200
    text = resp.json()["resume_text"]
    assert city_label not in text and phone_label not in text
    assert "9876543210" not in text
    assert "TIG welding" in text


def test_all_labels_dropped_falls_back_and_completes():
    resp = client.post(
        "/resume/generate",
        json={"profile": _welder_profile(["welding grade 1234567", "shop in Pune"]).model_dump()},
    )
    assert resp.status_code == 200  # never crash, never block the résumé
    body = resp.json()
    assert "Skills: (to be confirmed)" in body["resume_text"]  # honest degradation
    assert body["resume_json"]["skill_labels"] == []
    assert "Experience: 8 years" in body["resume_text"]  # rest still renders


# --- render dedupe: a label never duplicates its canonical id ----------------------
def test_label_duplicating_a_canonical_id_is_not_rendered_twice():
    profile = DraftProfile(
        skills=["skill_milling"],
        skill_labels=["Milling", "5-axis setup"],
    )
    text, _ = build_resume(profile)
    assert "skill_milling" in text
    assert "5-axis setup" in text
    assert "Milling" not in text  # label normalizes to the id ("skill_" stripped)


# --- extraction hygiene clamp (defense in depth; the hard gate is SG-2 above) ------
def test_extraction_clamps_labels_count_length_dedupe_and_control_chars():
    from app.contracts import WorkerProfileDraft
    from app.profiling.profile_extractor import map_rich_to_legacy

    labels = [f"skill variant {i}" for i in range(21)]  # 21 -> capped at 20
    labels[3] = "x" * 81  # over-length -> dropped
    labels[4] = "MIG welding"
    labels[5] = "mig WELDING"  # case-insensitive dupe of [4] -> dropped
    labels[6] = "\x01tig\x02 welding\x1f"  # control chars stripped (escapes only)
    labels[7] = "   "  # empties dropped

    legacy = map_rich_to_legacy(WorkerProfileDraft(skills=labels))
    out = legacy.skill_labels
    assert len(out) <= 20
    assert all(len(label) <= 80 for label in out)
    assert "MIG welding" in out and "mig WELDING" not in out
    assert "tig welding" in out  # control chars stripped, text kept
    assert all(label.strip() for label in out)


def test_extraction_clamp_caps_at_twenty():
    from app.contracts import WorkerProfileDraft
    from app.profiling.profile_extractor import map_rich_to_legacy

    legacy = map_rich_to_legacy(
        WorkerProfileDraft(skills=[f"unique skill {i}" for i in range(21)])
    )
    assert len(legacy.skill_labels) == 20
