"""TAX-WELD-1 — welding in the local gazetteer (ADR-0030). No network, no DB, no spend.

THE INCIDENT: a welder said "TIG aur MIG machine chala leta hun" / "Welder hun main"
and extraction produced ``role=None, trade=None, skill_ids=[]``. A welder was
unmatchable. Root cause: ``app/profiling/signals.py`` held a CNC/VMC-only gazetteer
whose only mention of welding was a comment saying welding is excluded by design.

WHAT THIS CHANGE IS — AND IS NOT:
- It is WIRING. All five ``skill_*`` ids asserted below ALREADY EXISTED, ``status:
  "active"``, in ``packages/taxonomy/src/skill-corpus.ts`` (ADR-0030 / TAX-2), and
  every keyword the gazetteer matches on is ALREADY a canonical ENGLISH/technical
  alias there (MIG welding / GMAW / MIG-MAG, TIG welding / GTAW, arc welding / SMAW /
  stick welding, gas cutting / oxy-fuel cutting, welder).
- ZERO new ``skill_id`` was minted.
- ZERO unratified Hinglish/vernacular alias ships active. The only Hindi phrase in
  this family that IS ratified — "welding ka kaam" → ``skill_welder_occupation``
  (``wedge-aliases.ts``, ``ratified: true``) — is covered by the plain "welding"
  keyword. Any further vernacular ("welding karta hun", "welding wala kaam", "gas
  wali welding") needs RVM ratification (ADR-0030 §7 gate (d)) and is NOT here.
- One NEW occupation id, ``role_welder`` / ``dom_welding``, was added to the CLOSED
  role whitelist (ADR-0028 §(d): a wider ENUMERATED set, never free text). Without it
  the acceptance criterion "non-null role + trade" is unreachable. Flagged for review.

The CNC/VMC no-regression guarantee is STRUCTURAL, not merely tested: the welding
entries sit LAST in ``signals._ROLES`` and first-keyword-wins, so welding can only
ever ADD a role where there was ``None`` — it can never displace a machining role.
"""

from __future__ import annotations

import pytest

from app.contracts import WorkerProfileDraft
from app.profiling import profile_extractor, signals

# The five pre-existing corpus ids this change is allowed to write. Anything outside
# this set appearing on a welding profile would be a MINTED id — a task violation.
ALLOWED_WELDING_SKILL_IDS = {
    "skill_mig_welding",
    "skill_tig_welding",
    "skill_arc_welding",
    "skill_gas_cutting",
    "skill_welder_occupation",
}


# --- acceptance: the exact phrases from the incident -------------------------------
@pytest.mark.parametrize(
    ("text", "expected_skill_ids"),
    [
        ("Welder hun main", {"skill_welder_occupation"}),
        ("TIG aur MIG machine chala leta hun", {"skill_tig_welding", "skill_mig_welding"}),
        ("TIG", {"skill_tig_welding"}),
        ("MIG", {"skill_mig_welding"}),
        ("welder hun, 5 saal ka experience hai", {"skill_welder_occupation"}),
    ],
)
def test_incident_phrases_now_yield_role_trade_and_skills(text, expected_skill_ids):
    _rich, legacy = profile_extractor.extract(text)
    assert legacy.canonical_role_id == "role_welder"
    assert legacy.canonical_trade_id == "dom_welding"
    assert expected_skill_ids.issubset(set(legacy.skills))


def test_only_pre_existing_corpus_skill_ids_are_ever_written():
    # Sweep every welding phrasing this gazetteer knows: no id outside the five
    # pre-existing corpus ids may appear. This is the "zero minted ids" guard.
    phrases = [
        "welder hun", "welding ka kaam", "mig welding", "tig welding", "MIG/MAG",
        "GMAW", "GTAW", "SMAW", "arc welding", "stick welding", "gas cutting",
        "oxy-fuel cutting", "spot welding karta hu", "tig aur mig dono",
    ]
    for text in phrases:
        sig = signals.detect(text)
        assert sig.skill_ids, f"no welding signal detected in {text!r}"
        assert set(sig.skill_ids).issubset(ALLOWED_WELDING_SKILL_IDS), text
        # And never a fabricated machine id (the taxonomy has no welding `mach_*`).
        assert sig.machine_ids == [], text


# --- the standard English/technical aliases resolve to their OWN process id --------
@pytest.mark.parametrize(
    ("text", "skill_id"),
    [
        ("GMAW karta hu", "skill_mig_welding"),
        ("MIG/MAG welding", "skill_mig_welding"),
        ("GTAW ka kaam", "skill_tig_welding"),
        ("SMAW", "skill_arc_welding"),
        ("stick welding karta hu", "skill_arc_welding"),
        ("arc welding", "skill_arc_welding"),
        ("gas cutting ka kaam", "skill_gas_cutting"),
        ("oxy-fuel cutting", "skill_gas_cutting"),
    ],
)
def test_ratified_english_aliases_map_to_their_process_id(text, skill_id):
    assert skill_id in signals.detect(text).skill_ids


def test_gas_cutting_alone_does_not_imply_the_welder_role():
    # skill_gas_cutting lives in the `fabrication` domain, not `welding`. A gas cutter
    # is a cutter; asserting they are a welder would be a fabricated classification.
    sig = signals.detect("gas cutting ka kaam karta hu")
    assert sig.skill_ids == ["skill_gas_cutting"]
    assert sig.role_id is None


# --- word boundaries: the short tokens must not corrupt unrelated text -------------
@pytest.mark.parametrize(
    "text",
    [
        "fatigue testing ka kaam",          # contains "tig"
        "mitigation plan banata hu",        # contains "mig"/"tig"
        "emigration ke liye documents",     # contains "mig"
        "vintage machine chalata hu",       # contains "tag"-like noise, no welding
    ],
)
def test_short_welding_tokens_are_word_boundary_matched(text):
    sig = signals.detect(text)
    assert not set(sig.skill_ids) & ALLOWED_WELDING_SKILL_IDS, text
    assert sig.role_id != "role_welder", text


# --- CNC/VMC precedence: welding can only ADD a role, never displace one -----------
@pytest.mark.parametrize(
    ("text", "expected_role"),
    [
        ("vmc chalata hu aur welding bhi karta hu", "role_vmc_operator"),
        ("cnc programmer hu, welding ka thoda kaam bhi", "role_cnc_programmer"),
        ("setter hu, mig welding bhi aati hai", "role_cnc_setter_operator"),
        ("grinding operator hu, tig welding bhi karta hu", "role_cnc_grinding_operator"),
        ("turner hu lathe pe, gas cutting bhi", "role_cnc_turner_operator"),
    ],
)
def test_machining_role_always_wins_over_welding(text, expected_role):
    _rich, legacy = profile_extractor.extract(text)
    assert legacy.canonical_role_id == expected_role


def test_out_of_scope_trades_are_still_out_of_scope():
    # Widening to welding did not widen to everything — the negative tier keeps teeth.
    for text in ("sirf helper hu", "fitter hu, assembly line pe",
                 "electrician hu, wiring karta hu", "carpenter hu, lakdi ka kaam"):
        _rich, legacy = profile_extractor.extract(text)
        assert legacy.canonical_role_id is None, text
        assert legacy.canonical_trade_id is None, text


# --- the model-emitted-label arm of the same seam ----------------------------------
def test_model_welding_labels_map_through_the_rich_to_legacy_seam():
    rich = WorkerProfileDraft(
        primary_role="MIG/TIG Welder",
        skills=["MIG welding", "TIG welding", "gas cutting"],
    )
    legacy = profile_extractor.map_rich_to_legacy(rich)
    assert legacy.canonical_role_id == "role_welder"
    assert legacy.canonical_trade_id == "dom_welding"
    assert set(legacy.skills).issubset(ALLOWED_WELDING_SKILL_IDS)
    assert {"skill_mig_welding", "skill_tig_welding", "skill_gas_cutting"} <= set(legacy.skills)


def test_llm_can_never_inject_a_welding_id_it_invented():
    # SG-3 / invariant #4 unchanged: the closed-set boundary still rejects free text,
    # including plausible-looking welding ids that are not in the taxonomy.
    from app.profiling.canonical_roles import normalize_role_id

    assert normalize_role_id("role_welder") == "role_welder"
    for bogus in ("mig_tig_welder", "role_mig_welder", "role_spot_welder", "welder", ""):
        assert normalize_role_id(bogus) is None
