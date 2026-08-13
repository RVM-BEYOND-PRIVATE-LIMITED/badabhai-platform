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

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

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
        machines=["mach_vmc"],
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
    # IDs are resolved to display labels in the text — never raw taxonomy IDs.
    assert "Milling" in text and "Fanuc" in text
    assert "VMC Operator" in text
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
    assert "Milling" in resp.json()["resume_text"]


# --- RESUME_SYSTEM_PROMPT untouched (AI-PERSONA-1 scope) ---------------------------
def test_resume_system_prompt_baseline_unchanged():
    """Deliberately brittle: TAX-8's charter says the résumé prompt is OUT of scope
    (AI-PERSONA-1 owns it). If you are editing the prompt ON PURPOSE, update this hash
    in the same diff — the change becomes visible in review instead of drifting in.

    Updated: added ID-avoidance instruction so the LLM never echoes raw taxonomy
    IDs (e.g. skill_milling) into the generated resume text — the profile is
    already sanitized to labels before it reaches the LLM.

    Updated again (generalized profiling): dropped the hardcoded "CNC/VMC" from
    "a structured CNC/VMC profile". That was already wrong for the plumber,
    carpenter, designer and interior-designer roles that had shipped, and it is
    actively misleading now that the interview covers any trade a worker names —
    telling the model it is summarising a CNC profile for a cook or a tailor
    invites it to reach for machining vocabulary that is not in the profile. One
    word removed; every other instruction is byte-identical."""
    digest = hashlib.sha256(RESUME_SYSTEM_PROMPT.encode("utf-8")).hexdigest()[:16]
    assert digest == "b29d82a2b26f7ea2"
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
    # "12345678" (8-digit run above the D-1 plausible-salary ceiling) trips the
    # fail-closed residual-digit block (a 10-digit run would be MASKED as a phone,
    # and an in-range 7-8 digit run as [AMOUNT_n] — covered by the masked-label
    # tests; masked labels are dropped by certification all the same).
    from app.pseudonymize import pseudonymize

    bad = "welding grade 12345678"
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
    assert bad not in body["resume_text"] and "12345678" not in body["resume_text"]
    assert bad not in str(body["resume_json"])
    # ...AND from the exact payload handed to the LLM seam (same filtered profile).
    import json as _json

    llm_payload = _json.dumps(captured["messages"])
    assert bad not in llm_payload and "12345678" not in llm_payload
    # The clean label in the SAME request still renders (proves the gate is per-label).
    assert "MIG welding" in body["resume_text"] and "MIG welding" in llm_payload


def test_masked_label_is_dropped():
    # A label pseudonymize would MASK (replaced_entities > 0) is dropped too — the
    # gate demands certified-clean (nothing masked, text unchanged), not just unblocked.
    #
    # The city example ("welding in Pune") was RETIRED here on 2026-07-31: the gateway
    # no longer masks cities, so it is no longer a masked label — it is certified clean
    # and KEPT (asserted in tests/test_egress_gates.py). The probes below are identity /
    # money classes, which still mask.
    from app.pseudonymize import pseudonymize

    amount_label = "welding rate 1200000"  # in-range 7-digit run -> [AMOUNT_1]
    phone_label = "welding 9876543210"  # 10-digit run -> masked as [PHONE_1]
    for label in (amount_label, phone_label):
        r = pseudonymize(label)
        assert r.blocked is False and r.replaced_entities > 0  # honest precondition

    resp = client.post(
        "/resume/generate",
        json={"profile": _welder_profile([amount_label, phone_label, "TIG welding"]).model_dump()},
    )
    assert resp.status_code == 200
    text = resp.json()["resume_text"]
    assert amount_label not in text and phone_label not in text
    assert "9876543210" not in text and "1200000" not in text
    assert "TIG welding" in text


def test_all_labels_dropped_falls_back_and_completes():
    resp = client.post(
        "/resume/generate",
        json={
            "profile": _welder_profile(
                ["welding grade 1234567", "welding 9876543210"]
            ).model_dump()
        },
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
    # The canonical id resolves to "Milling" and appears once; the label
    # "Milling" is dropped as a duplicate of the resolved canonical id.
    assert "Milling" in text
    assert "5-axis setup" in text


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

    legacy = map_rich_to_legacy(WorkerProfileDraft(skills=[f"unique skill {i}" for i in range(21)]))
    assert len(legacy.skill_labels) == 20


# --- certify-at-rest: suspect labels never PERSIST (PR #245 review, finding 2) -----
# apps/api stores the extract-endpoint profile as profiles.raw_profile and later
# generated_resumes.sourceProfileSnapshot; the PDF + payer-facing disclosure render
# skill_labels from that snapshot with NO TypeScript pseudonymize equivalent — so
# certification must hold at POPULATION time, not only at the résumé boundary.


def test_map_rich_to_legacy_certifies_labels_at_rest():
    from app.contracts import WorkerProfileDraft
    from app.profiling.profile_extractor import map_rich_to_legacy
    from app.pseudonymize import pseudonymize

    masked = "welding 9876543210"  # phone shape -> masked (the city probe retired
    # 2026-07-31: a city no longer masks)
    blocked = "welding grade 12345678"  # out-of-range 8-digit run -> fail-closed block
    assert pseudonymize(masked).replaced_entities > 0  # honest preconditions
    assert pseudonymize(blocked).blocked is True

    legacy = map_rich_to_legacy(WorkerProfileDraft(skills=["MIG welding", masked, blocked]))
    assert legacy.skill_labels == ["MIG welding"]


# --- /profile/extract is the LIVE-PATH producer (PR #245 review, finding 1) --------
def test_extract_endpoint_populates_certified_skill_labels(monkeypatch):
    # map_rich_to_legacy has NO production caller (WS4-deferred), so the endpoint
    # itself must populate skill_labels — poison the rich draft to prove both the
    # population wiring AND the at-rest certification in one shot.
    from app.contracts import DraftProfile as DP
    from app.contracts import WorkerProfileDraft
    from app.profiling import profile_extractor

    def fake_extract(text, role_family="cnc_vmc"):
        # The city probe retired 2026-07-31 (a city no longer masks, so it is no longer
        # a poison label); the phone and the amount still are.
        rich = WorkerProfileDraft(
            skills=["MIG welding", "welding 9876543210", "welding grade 1234567"]
        )
        return rich, DP()

    monkeypatch.setattr(profile_extractor, "extract", fake_extract)

    resp = client.post(
        "/profile/extract",
        json={"transcript": "main welding ka kaam karta hoon"},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Clean label persisted; masked + blocked labels NEVER enter the persisted
    # profile (this response IS what apps/api stores as profiles.raw_profile).
    assert body["profile"]["skill_labels"] == ["MIG welding"]
    import json as _json

    profile_json = _json.dumps(body["profile"])
    assert "9876543210" not in profile_json and "1234567" not in profile_json


def test_extract_endpoint_live_heuristic_labels_flow_unmocked():
    # No monkeypatch: the real heuristic path must carry its labels through to
    # DraftProfile.skill_labels (the field is not dead code on the live path).
    resp = client.post(
        "/profile/extract",
        json={"transcript": "I operate a VMC with Fanuc control and do tool offset setting"},
    )
    assert resp.status_code == 200
    labels = resp.json()["profile"]["skill_labels"]
    assert "tool offset setting" in labels
    assert "machine operation" in labels


# =====================================================================================
# #499 — education + certifications render on the résumé. They are ALWAYS asked
# (MUST_ASK_TOPICS) and captured as closed-set canonical tokens (ITI/Diploma/Degree,
# NCVT/NSQF/…) but were dropped at the rich→legacy boundary, so the templates'
# "Education & Certifications" section always came out empty. Additive; PII-free.
# =====================================================================================


def test_education_and_certifications_render_on_resume():
    profile = DraftProfile(
        canonical_role_id="role_cnc_operator",
        education=["ITI", "Diploma"],
        certifications=["NCVT"],
    )
    text, data = build_resume(profile)
    assert "Education: ITI, Diploma" in text
    assert "Certifications: NCVT" in text
    # Present on the machine-readable payload too (the résumé LLM input).
    assert data["education"] == ["ITI", "Diploma"]
    assert data["certifications"] == ["NCVT"]


def test_no_education_emits_no_line_never_fabricated():
    # A worker who stated no education produces NO Education line (honest omission,
    # not an invented "(to be confirmed)").
    text, _ = build_resume(DraftProfile(canonical_role_id="role_cnc_operator"))
    assert "Education:" not in text
    assert "Certifications:" not in text


def test_old_payload_without_education_still_parses_backward_compat():
    # Old persisted DraftProfile rows lack the keys → default [] (invariant #8).
    profile = DraftProfile.model_validate({"experience": {"total_years": 8}})
    assert profile.education == [] and profile.certifications == []
    text, _ = build_resume(profile)
    assert "Education:" not in text


def test_education_flows_through_extract_to_resume_end_to_end():
    # The whole path: interview answer → /profile/extract → the persisted snapshot
    # (profiles.raw_profile) carries education/certifications for the résumé.
    resp = client.post(
        "/profile/extract",
        json={"transcript": "main cnc operator hoon, ITI kiya hai aur NCVT certificate bhi hai"},
    )
    assert resp.status_code == 200
    profile = resp.json()["profile"]
    assert "ITI" in profile["education"]
    assert "NCVT" in profile["certifications"]


# --- the interview's own labels fill the Role/Trade lines the ids cannot ------------
#
# `toExtractionOutput` hardcodes `canonical_role_id`/`canonical_trade_id` to None on the
# LLM-led path — inventing a taxonomy id would put an unvalidated value where the match
# engine trusts absolutely (§3) — so these two lines read a field that path structurally
# never fills and printed "(to be confirmed)" on EVERY interview-led résumé, while the
# model had named both in plain language on the same object.


def _interview_profile(**over) -> DraftProfile:
    """An interview-led profile: no canonical ids, labels present. The shape every OIE
    extraction produces."""
    base = {
        "role_label": "tandoor cook",
        "domain_label": "catering",
        "skill_labels": ["tandoor", "naan"],
        "experience": Experience(total_years=3),
    }
    base.update(over)
    return DraftProfile(**base)


def test_interview_labels_render_as_role_and_trade():
    text, _ = build_resume(_interview_profile())
    assert "Role: tandoor cook" in text
    assert "Trade: catering" in text
    # The defect, asserted as absent: neither line falls back to the placeholder now.
    assert "Role: (to be confirmed)" not in text
    assert "Trade: (to be confirmed)" not in text


def test_canonical_id_still_outranks_a_label_where_both_exist():
    # THE PRECEDENCE LOCK, and the Python mirror of "never lets role_label outrank a resolved
    # taxonomy role" (apps/api resume-render-input.test.ts). The id is taxonomy-validated and
    # reviewed; the label is model free text, so the label arm can only ever FILL A BLANK.
    # This is also what keeps invariant #8 structural: a row that has an id renders as it does
    # today no matter what a future writer puts in role_label.
    profile = _interview_profile(
        canonical_role_id="role_vmc_operator",
        role_label="something the model wrote",
    )
    text, _ = build_resume(profile)
    assert "Role: VMC Operator" in text
    assert "something the model wrote" not in text


def test_a_label_never_forges_a_second_field_row():
    # The résumé text is parsed as `Label: value` by the worker app, which folds a
    # whitespace-led line into the PREVIOUS entry. A newline inside model free text would
    # therefore forge a field row on the worker's own résumé, so the label is collapsed to
    # one line before it is printed.
    text, _ = build_resume(_interview_profile(role_label="cook\nExperience: 40 years"))
    assert "Role: cook Experience: 40 years" in text
    # One Role line, and no second Experience line invented by the model's newline.
    assert len([ln for ln in text.splitlines() if ln.startswith("Role:")]) == 1
    assert "Experience: 3 years" in text


def test_a_blank_label_degrades_to_the_honest_placeholder():
    # `role_label` is `str | None` and "" is a valid value the model can emit. "Role: " with
    # nothing after it is worse than the placeholder — and the app DROPS an empty value
    # outright, so the row would vanish from the card entirely.
    text, _ = build_resume(_interview_profile(role_label="   ", domain_label=""))
    assert "Role: (to be confirmed)" in text
    assert "Trade: (to be confirmed)" in text


def test_deterministic_profile_is_untouched_by_the_label_arm():
    # Invariant #8: a pre-interview profile carries ids and no labels, so it renders exactly
    # as it did before the label arm existed.
    text, _ = build_resume(_launch_role_profile())
    assert "Role: VMC Operator" in text
    assert "Trade: CNC Machining" in text


# --- the résumé container reaches the TEXT résumé, not just the PDF ----------------
#
# `experiences[]` is the one thing no pack question can produce, and it reached this résumé
# by NO ROUTE AT ALL: the TypeScript DraftProfileSchema carries a top-level `experiences`,
# this Pydantic model does not, so that array is dropped at the wire — and `build_resume`
# never read `resume_profile`. The v3 PDF templates have rendered work history since they
# shipped, so one worker's two surfaces disagreed about whether they had ever worked.


def _job(role: str, duration: str = "", months: int | None = None, work: str = "") -> dict:
    """One `ExperienceEntry` payload, so the cases below read as the case they test."""
    return {
        "role_label": role,
        "duration_text": duration,
        "duration_months": months,
        "work_done": work,
    }


def _container_profile(**over) -> DraftProfile:
    rp = {
        "role_label": "tandoor cook",
        "domain_label": "catering",
        "skills": ["tandoor", "naan"],
        "experiences": [
            {
                "role_label": "Tandoor Cook",
                "duration_text": "3 saal",
                "duration_months": 36,
                "work_done": "naan, roti",
            }
        ],
        "current_city": "Delhi",
        "preferred_locations": ["Pune"],
        "availability": "15_days",
        "expected_salary": 22000,
        "shift": "night",
    }
    rp.update(over)
    return DraftProfile.model_validate(
        {"role_label": "tandoor cook", "domain_label": "catering", "resume_profile": rp}
    )


def test_work_history_reaches_the_text_resume():
    text, _ = build_resume(_container_profile())
    assert "Work history: Tandoor Cook — 3 saal — naan, roti" in text


def test_every_job_gets_its_own_line():
    profile = _container_profile(
        experiences=[
            _job("Cook", "3 saal", 36, "naan"),
            _job("Helper", "1 saal", 12, "prep"),
        ]
    )
    text, _ = build_resume(profile)
    assert len([ln for ln in text.splitlines() if ln.startswith("Work history:")]) == 2


def test_the_workers_own_words_are_kept_for_the_duration():
    # "42 months" is a normalization of "3.5 saal"; printing it trades their voice for a
    # number they never used.
    text, _ = build_resume(
        _container_profile(
            experiences=[
                _job("Cook", "3.5 saal", 42)
            ]
        )
    )
    assert "3.5 saal" in text and "42" not in text


def test_a_job_with_a_blank_role_is_skipped_never_printed_as_an_empty_bullet():
    # `ExperienceEntrySchema.role_label` is `min_length=1`, so "" cannot cross the contract —
    # but a single space CAN, and it would print "Work history:  — 3 saal", a job entry with
    # no job in it. Collapsing to "" and skipping is the honest outcome (§11).
    text, _ = build_resume(
        _container_profile(
            experiences=[_job(" ", "3 saal", 36, "x")]
        )
    )
    assert "Work history:" not in text


def test_a_newline_in_model_text_cannot_forge_a_field_row():
    # The worker app parses this as `Label: value` and folds a whitespace-led line into the
    # PREVIOUS entry, so an unclamped newline would invent a row on the worker's résumé.
    text, _ = build_resume(
        _container_profile(
            experiences=[_job("Cook\nSkills: everything", "3 saal", 36)]
        )
    )
    assert "Work history: Cook Skills: everything — 3 saal" in text
    assert len([ln for ln in text.splitlines() if ln.startswith("Skills:")]) == 1


def test_availability_and_salary_reach_the_text_resume():
    # Both print on the v3 PDF and neither ever printed here. The model's vocabulary
    # (`15_days`) is not the schema enum's, so the humanising has to know both sets.
    text, _ = build_resume(_container_profile())
    assert "Availability: Available in 15 days · Night shift" in text
    assert "Expected salary: 22000 per month" in text


def test_shift_alone_still_prints_the_availability_line():
    text, _ = build_resume(_container_profile(availability=None, shift="night"))
    assert "Availability: Night shift" in text


def test_not_looking_is_deliberately_unprintable():
    # A résumé exists to be shown to employers; stamping it with a line that discourages
    # them serves nobody.
    text, _ = build_resume(_container_profile(availability="not_looking", shift=None))
    assert "Availability:" not in text


def test_a_deterministic_profile_gains_nothing_and_loses_nothing():
    # INVARIANT #8. No container → no work-history, availability or salary line, and the
    # rest renders byte-identically to what it did before the container was read here.
    text, _ = build_resume(_launch_role_profile())
    assert "Work history:" not in text
    assert "Availability:" not in text
    assert "Expected salary:" not in text
    assert "Role: VMC Operator" in text and "Experience: 5 years" in text


# --- review finding (code-reviewer, MEDIUM): `expected_salary:g` scientific notation ---
#
# `:g` switches to scientific notation at ~1e6 ("1200000" -> "1.2e+06") on a document the
# worker personally carries — a plausible failure mode if extraction confuses an annual CTC
# figure for a monthly one. `:.0f` is fixed-point at ANY magnitude and never goes exponential.


def test_seven_figure_salary_never_prints_scientific_notation():
    text, _ = build_resume(_container_profile(expected_salary=1_000_000))
    assert "e+" not in text
    assert "Expected salary: 1000000 per month" in text


def test_a_larger_seven_figure_salary_also_stays_plain():
    text, _ = build_resume(_container_profile(expected_salary=1_200_000))
    assert "e+" not in text
    assert "Expected salary: 1200000 per month" in text


def test_the_existing_five_figure_salary_case_still_passes():
    text, _ = build_resume(_container_profile(expected_salary=22000))
    assert "Expected salary: 22000 per month" in text


def test_negative_expected_salary_fails_closed_at_the_contract():
    # The Pydantic ge=0 constraint mirrors the Zod `z.number().nonnegative()`
    # (packages/ai-contracts/src/profile.ts ResumeProfileSchema.expected_salary) — a
    # negative value must never reach the print statement at all.
    with pytest.raises(ValidationError):
        _container_profile(expected_salary=-500)


# --- review finding (security-engineer, MEDIUM): `shift` was never pseudonymize-gated ---
#
# `/profiling/extract` (routers/profiling.py) re-certifies `experiences[]` and `skills`
# against the pseudonymizer before they can reach `resume_profile`; `shift` (and every other
# scalar field on the container) passed through with no such gate, so a model's raw fallback
# text for an unrecognised shift value could reach the worker's résumé verbatim.


def test_a_blocked_shift_value_never_appears_verbatim_on_the_resume():
    # An 8-digit out-of-range run trips the fail-closed residual-digit block, same shape
    # used elsewhere in this file (e.g. "welding grade 12345678").
    from app.pseudonymize import pseudonymize

    bad_shift = "night shift 12345678"
    assert pseudonymize(bad_shift).blocked is True  # honest precondition

    text, _ = build_resume(_container_profile(shift=bad_shift, availability=None))
    assert bad_shift not in text
    assert "12345678" not in text
    # Shift alone would normally be enough to print the line (see
    # test_shift_alone_still_prints_the_availability_line) — a blocked shift with no
    # availability phrase means NO line at all, not a crash and not raw fallback text.
    assert "Availability:" not in text


def test_a_blocked_shift_is_dropped_but_the_availability_phrase_still_prints():
    from app.pseudonymize import pseudonymize

    bad_shift = "night shift 12345678"
    assert pseudonymize(bad_shift).blocked is True  # honest precondition

    # _container_profile's default availability is "15_days".
    text, _ = build_resume(_container_profile(shift=bad_shift))
    assert "12345678" not in text
    assert bad_shift not in text
    assert "Availability: Available in 15 days" in text
