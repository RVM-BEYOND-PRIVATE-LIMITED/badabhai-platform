"""Egress-gate tests for the four ai-service fixes in this change.

Each test corresponds to a MEASURED defect on main, not a hypothetical:

FIX 2 — ``/resume/generate`` reached the provider with NO pseudonymize call at all.
        Every profile field except three certified lists was serialized into the user
        message verbatim.
FIX 3 — ``/voice/transcribe`` handed the RAW transcript to the Sarvam translate
        provider. `translate.py` documented this; documented is not gated.
FIX 4 — one 20,000-character BENIGN message (``"reg-" * 5000``) spent ~1s inside
        ``pseudonymize`` — an O(n^2) scan in the credential-ID lookahead. The routes
        that call it are ``async def`` and call it inline, so that is an event-loop
        stall for every concurrent worker.
FIX 5 — ``certified_clean_skill_labels`` SILENTLY DELETED real skills and
        qualifications ("Stainless Steel", "Diploma Mechanical Engineering") because
        ``_COMPANY_SUFFIX`` overlaps ordinary trade vocabulary.
"""

import json
import time
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.profiling import signals
from app.pseudonymize import (
    DEFAULT_MAX_LENGTH,
    certified_clean_skill_labels,
    pseudonymize,
)

client = TestClient(app)


# ---------------------------------------------------------------------------
# FIX 2 — /resume/generate is pseudonymize-gated
# ---------------------------------------------------------------------------


def _resume_body(**profile_overrides) -> dict:
    profile = {
        "canonical_role_id": "role_vmc_operator",
        "skills": ["skill_fanuc"],
        "machines": ["mach_vmc"],
        "skill_labels": ["VMC Operation"],
    }
    profile.update(profile_overrides)
    return {"worker_ref": "opaque-worker-uuid", "profile": profile}


def test_resume_generate_pseudonymizes_the_llm_payload(monkeypatch):
    """The gap FIX 2 closes: a value stored in ANY profile field used to egress raw.

    `education_level` is a MODEL-AUTHORED free-text scalar certified by nothing, so it
    is the honest carrier for this probe.
    """
    from app import main as main_module

    seen: dict = {}

    async def _fake_run(task, *, messages, mock_response, real_call_allowed, user_ref=None, **kw):
        seen["messages"] = messages
        return mock_response, _meta()

    monkeypatch.setattr(main_module.router, "run", _fake_run)
    res = client.post(
        "/resume/generate",
        json=_resume_body(education_level="Diploma from Sharma Industries, call 9876543210"),
    )
    assert res.status_code == 200

    user_content = seen["messages"][1]["content"]
    # The raw phone never reaches the model...
    assert "9876543210" not in user_content
    # ...and neither does the employer string.
    assert "Sharma Industries" not in user_content
    assert "[PHONE_1]" in user_content or "[EMPLOYER_1]" in user_content


def test_resume_generate_masks_the_city_like_every_other_route_does(monkeypatch):
    from app import main as main_module

    seen: dict = {}

    async def _fake_run(task, *, messages, mock_response, real_call_allowed, user_ref=None, **kw):
        seen["messages"] = messages
        return mock_response, _meta()

    monkeypatch.setattr(main_module.router, "run", _fake_run)
    res = client.post(
        "/resume/generate",
        json=_resume_body(location_preference={"current_city": "Pune", "preferred_cities": []}),
    )
    assert res.status_code == 200
    user_content = seen["messages"][1]["content"]
    assert "Pune" not in user_content
    assert "[CITY_1]" in user_content


def test_resume_generate_fails_closed_without_calling_the_provider(monkeypatch):
    """A blocked gate must reach NO provider — and must still return a résumé."""
    from app import main as main_module

    calls: list = []

    async def _fake_run(task, *, messages, mock_response, real_call_allowed, user_ref=None, **kw):
        calls.append(messages)
        return mock_response, _meta()

    monkeypatch.setattr(main_module.router, "run", _fake_run)
    # A 9-digit zero-led run is neither phone-shaped nor an in-range amount, so it
    # survives to the residual-digit net -> blocked (the gateway's fail-closed leg).
    res = client.post("/resume/generate", json=_resume_body(education_field="batch 01234567"))
    assert res.status_code == 200
    assert calls == [], "the provider was called on a BLOCKED gate"

    body = res.json()
    # Output SHAPE unchanged, and the worker still gets their résumé.
    assert set(body) >= {"resume_text", "resume_json", "format", "is_mock"}
    assert body["format"] == "text"
    assert body["is_mock"] is True
    assert "WORKER PROFILE (DRAFT)" in body["resume_text"]
    assert body["resume_json"]["canonical_role_id"] == "role_vmc_operator"


def test_resume_generate_output_shape_is_unchanged_on_the_happy_path():
    res = client.post("/resume/generate", json=_resume_body())
    assert res.status_code == 200
    body = res.json()
    assert set(body) >= {"resume_text", "resume_json", "format", "is_mock"}
    assert body["format"] == "text"
    # resume_json still carries the RAW machine-readable ids, not display labels.
    assert body["resume_json"]["skills"] == ["skill_fanuc"]
    assert body["resume_json"]["machines"] == ["mach_vmc"]


def test_resume_generate_still_sends_resolved_labels_not_raw_ids(monkeypatch):
    """The pre-existing id-resolution behaviour must survive the new gate."""
    from app import main as main_module

    seen: dict = {}

    async def _fake_run(task, *, messages, mock_response, real_call_allowed, user_ref=None, **kw):
        seen["messages"] = messages
        return mock_response, _meta()

    monkeypatch.setattr(main_module.router, "run", _fake_run)
    client.post("/resume/generate", json=_resume_body())
    user_content = seen["messages"][1]["content"]
    assert "skill_fanuc" not in user_content
    assert "mach_vmc" not in user_content
    # Still valid JSON after masking (nothing in the gate breaks the serialization).
    json.loads(user_content)


def _meta():
    from app.contracts import AICallMetadata

    return AICallMetadata(
        ai_call_id="00000000-0000-4000-8000-000000000000",
        task_type="resume_generation",
        model_name="mock",
        provider="mock",
        real_call=False,
        input_tokens=0,
        output_tokens=0,
        estimated_cost_inr=0.0,
        latency_ms=0,
        success=True,
        error_code=None,
        created_at=datetime.now(UTC).isoformat(),
    )


# ---------------------------------------------------------------------------
# FIX 3 — /voice/transcribe pseudonymizes before the translate provider
# ---------------------------------------------------------------------------


def test_voice_translate_leg_pseudonymizes_before_the_provider(monkeypatch):
    from app import main as main_module
    from app.stt import SttResult
    from app.translate import TranslateResult

    seen: dict = {}

    async def _fake_transcribe(**kwargs):
        return SttResult("mera naam Ramesh hai, number 9876543210, Pune se", 0.9, "hi", True)

    async def _fake_translate(*, text, source_language_code, real_call_allowed):
        seen["text"] = text
        return TranslateResult(english_text="translated", detected_source="hi-IN", is_mock=True)

    monkeypatch.setattr(main_module.stt_adapter, "transcribe", _fake_transcribe)
    monkeypatch.setattr(main_module.translate_adapter, "translate", _fake_translate)

    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "x", "translate_to_english": True},
    )
    assert res.status_code == 200
    # The provider saw the MASKED text...
    assert "9876543210" not in seen["text"]
    assert "Pune" not in seen["text"]
    assert "[PHONE_1]" in seen["text"]
    assert "[CITY_1]" in seen["text"]
    # ...while the worker still gets their own words back verbatim.
    assert res.json()["transcript_text"] == "mera naam Ramesh hai, number 9876543210, Pune se"


def test_voice_translate_leg_fails_closed_without_calling_the_provider(monkeypatch):
    from app import main as main_module
    from app.stt import SttResult

    calls: list = []

    async def _fake_transcribe(**kwargs):
        return SttResult("batch 01234567 wala", 0.9, "hi", True)

    async def _fake_translate(*, text, source_language_code, real_call_allowed):
        calls.append(text)
        raise AssertionError("translate must not be called on a blocked gate")

    monkeypatch.setattr(main_module.stt_adapter, "transcribe", _fake_transcribe)
    monkeypatch.setattr(main_module.translate_adapter, "translate", _fake_translate)

    res = client.post(
        "/voice/transcribe",
        json={"voice_note_id": "vn1", "storage_path": "x", "translate_to_english": True},
    )
    assert res.status_code == 200
    assert calls == []
    body = res.json()
    # OUTPUT SHAPE unchanged; english degrades to "", the adapter's own failure value.
    assert body["english_text"] == ""
    assert body["transcript_text"] == "batch 01234567 wala"


def test_voice_transcribe_mock_path_is_unchanged():
    """The default posture must be byte-identical to before the gate."""
    from app.stt import MOCK_TRANSCRIPT
    from app.translate import MOCK_ENGLISH

    res = client.post("/voice/transcribe", json={"voice_note_id": "vn1", "storage_path": "x"})
    assert res.status_code == 200
    body = res.json()
    assert body["transcript_text"] == MOCK_TRANSCRIPT
    assert body["english_text"] == MOCK_ENGLISH


# ---------------------------------------------------------------------------
# FIX 4 — the credential-ID lookahead is structurally bounded
# ---------------------------------------------------------------------------

# Generous ceiling: the measured pre-fix cost was ~1000ms and the post-fix cost
# ~17ms against a ~12ms control on the same 20k input. 250ms fails loudly on a
# reintroduced quadratic scan while leaving huge headroom for a slow CI box.
_REDOS_BUDGET_MS = 250


@pytest.mark.parametrize(
    "text",
    [
        "reg-" * 5000,  # the exact measured case
        "cert-" * 4000,
        "roll-" * 5000,
        "registration-" * 1538,
        "licence-" * 2500,
    ],
)
def test_pseudonymize_is_not_quadratic_on_separator_joined_cues(text):
    text = text[:DEFAULT_MAX_LENGTH]
    start = time.perf_counter()
    result = pseudonymize(text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
    # Behaviour is unchanged: no digits anywhere, so nothing masks and nothing blocks.
    assert result.blocked is False
    assert result.replaced_entities == 0


def test_pseudonymize_max_length_cap_still_fails_closed():
    """The bound is about work-per-character; the SIZE cap is untouched."""
    result = pseudonymize("a" * (DEFAULT_MAX_LENGTH + 1))
    assert result.blocked is True
    assert "exceeds" in (result.blocked_reason or "")
    assert result.text == ""


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("roll number R/2019/123456 hai", "roll number [ID_1] hai"),
        ("certificate no MH2019CN4471", "certificate no [ID_1]"),
        ("registration no: ABCD1234EF", "registration no: [ID_1]"),
        # Both load-bearing negatives from the original rule survive the bound.
        ("NCVT certificate hai", "NCVT certificate hai"),
        ("certificate number chahiye", "certificate number chahiye"),
    ],
)
def test_credential_id_masking_is_unchanged_by_the_bound(text, expected):
    assert pseudonymize(text).text == expected


def test_credential_id_capture_is_still_unbounded():
    """Only the LOOKAHEAD is bounded — a long id is still consumed WHOLE."""
    long_id = "R2019" + "A" * 200
    result = pseudonymize(f"roll number {long_id}")
    assert result.text == "roll number [ID_1]"


# ---------------------------------------------------------------------------
# FIX 5 — real skills and qualifications are no longer silently deleted
# ---------------------------------------------------------------------------


def test_the_measured_data_loss_is_fixed():
    """The exact measured regression, restated as a test.

    BEFORE this fix, on main:
        certified_clean_skill_labels(
            ["Stainless Steel", "Diploma Mechanical Engineering", "VMC Operation"]
        ) == ["VMC Operation"]
    """
    labels = ["Stainless Steel", "Diploma Mechanical Engineering", "VMC Operation"]
    assert certified_clean_skill_labels(labels) == labels


@pytest.mark.parametrize(
    "label",
    ["Stainless Steel", "Mild Steel", "Mechanical Engineering", "Diploma Mechanical Engineering"],
)
def test_trade_and_education_vocabulary_is_kept(label):
    # The gateway still MASKS these in general free text — unchanged, deliberately.
    assert pseudonymize(label).text == "[EMPLOYER_1]"
    # ...but the certification path recognises them as vocabulary and keeps them,
    # BYTE-IDENTICAL (never the masked text).
    assert certified_clean_skill_labels([label]) == [label]


@pytest.mark.parametrize(
    "label",
    [
        "Ramesh Steel Industries",
        "Jyoti CNC Industries",
        "Precision Engineering Works",
        "Bharat Forge Pvt Ltd",
        "Tata Motors",
        "Suresh Kumar Engineering",
        "Sharma Tools and Fabrication",
    ],
)
def test_employer_names_are_still_dropped(label):
    """The rescue must not become a hole.

    A company name always carries a token no trade table contains — a proper noun or a
    legal/organisational form — so the whole-label test refuses it.
    """
    assert certified_clean_skill_labels([label]) == []


def test_pseudonymize_itself_is_unchanged_for_general_free_text():
    """FIX 5 touches the CERTIFICATION path only; employer masking is not weakened."""
    text = "Sharma Industries me kaam kiya, stainless steel ka"
    assert "[EMPLOYER_1]" in pseudonymize(text).text
    assert "Sharma Industries" not in pseudonymize(text).text


@pytest.mark.parametrize(
    "label",
    [
        "roll R/2019/123456",  # ID mask -> not employer-only -> dropped
        "call 9876543210",  # PHONE mask
        "Pune",  # CITY mask
        "Bihar",  # STATE mask
    ],
)
def test_non_employer_masks_still_drop_the_label(label):
    """The rescue is scoped to [EMPLOYER_n] ONLY — every other mask is real PII."""
    assert certified_clean_skill_labels([label]) == []


def test_blocked_labels_are_still_dropped():
    assert certified_clean_skill_labels(["batch 01234567"]) == []
    assert certified_clean_skill_labels(["x" * (DEFAULT_MAX_LENGTH + 1)]) == []


def test_certification_still_drops_a_label_it_cannot_recognise():
    """Fail-closed default: unknown + masked = dropped, exactly as before."""
    assert certified_clean_skill_labels(["Zylorix Precision"]) == []


# --- the vocabulary itself ---------------------------------------------------


def test_vocabulary_is_derived_from_the_detector_tables_not_hand_written():
    """Spot-check that a term from EACH source table is present.

    If someone replaces the derivation with a literal list, one of these will drift.
    """
    for term, table in [
        ("vmc", "_MACHINES"),
        ("fanuc", "_CONTROLLERS"),
        ("setter", "_ROLES"),
        ("offset", "_SKILLS"),
        ("micrometer", "_INSPECTION"),
        ("stainless", "_MATERIALS"),
        ("welding", "_WELDING"),
        ("drainage", "_PLUMBING"),
        ("joinery", "_CARPENTRY"),
        ("mechanical", "_DESIGN (mechanical design)"),
        ("sketchup", "_INTERIOR_DESIGN"),
    ]:
        assert term in signals.VOCABULARY_TOKENS, f"{term} missing (from {table})"


def test_vocabulary_carries_no_regex_escape_artifacts():
    """The >=3-char floor on regex-sourced tables provably excludes `\\s`/`\\b`/`\\d`.

    Every 1-2 character token must come from a PLAIN-string table (ms/ss/cnc/vmc/3d),
    never from a pattern escape.
    """
    short = {tok for tok in signals.VOCABULARY_TOKENS if len(tok) <= 2}
    # These are real, from the plain-string tables and acronym set.
    assert {"ms", "ss", "gd"} <= short
    # ...and no bare regex-class letters leaked in.
    assert "\\" not in "".join(signals.VOCABULARY_TOKENS)


def test_vocabulary_contains_no_company_legal_forms():
    """The whole discriminator: a legal/organisational form is never vocabulary."""
    legal_forms = (
        "industries",
        "pvt",
        "ltd",
        "limited",
        "enterprises",
        "works",
        "solutions",
        "corporation",
        "company",
        "motors",
    )
    for form in legal_forms:
        assert form not in signals.VOCABULARY_TOKENS, form


def test_is_curated_vocabulary_label_fails_closed_on_junk():
    assert signals.is_curated_vocabulary_label("") is False
    assert signals.is_curated_vocabulary_label("---") is False
    assert signals.is_curated_vocabulary_label(None) is False  # type: ignore[arg-type]


def test_education_and_certification_constants_match_what_the_detector_emits():
    """Binds the lifted constants to `detect()` by MEASUREMENT, not by faith."""
    probes = [
        "ITI kiya hai",
        "diploma hai mera",
        "b.tech degree hai",
        "rvm cad course kiya",
        "nsdc se training",
        "ncvt certificate hai",
        "scvt wala hai",
        "nsqf level 4",
        "apprentice tha 2 saal",
    ]
    seen_edu: set[str] = set()
    seen_cert: set[str] = set()
    for probe in probes:
        sig = signals.detect(probe)
        seen_edu.update(sig.education)
        seen_cert.update(sig.certifications)

    assert seen_edu, "no education value was detected — the probes went stale"
    assert seen_cert, "no certification value was detected — the probes went stale"
    assert seen_edu <= set(signals._EDUCATION_LABELS)
    assert seen_cert <= set(signals._CERTIFICATION_LABELS)
