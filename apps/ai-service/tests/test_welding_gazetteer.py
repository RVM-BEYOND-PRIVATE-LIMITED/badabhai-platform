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

THE CNC/VMC NO-REGRESSION CLAIM — CORRECTED (review of PR #412).
An earlier version of this docstring said the guarantee was structural: the welding
entries sat LAST in ``signals._ROLES``, first-keyword-wins, so "welding can only ever
ADD a role where there was ``None`` — it can never displace a machining role."

That was TRUE but NOT SUFFICIENT, and stating it that way was overstated. ``_ROLES``
has no entry for ``cnc``, ``lathe``, ``milling`` or bare ``operator``, so a large
population of real machining workers ALREADY resolved to ``None`` — and "only fills a
``None``" therefore silently meant "captures those workers as welders":

    "cnc operator hun, welding bhi kar leta hun"       -> role_welder   (WRONG)
    "pehle welding karta tha, ab CNC lathe chalata hu" -> role_welder   (WRONG; past)

Filling a ``None`` WRONGLY is strictly WORSE than leaving it ``None``:
``packages/reach-engine/src/scoring.ts`` ``scoreRole`` returns 0.4 for a null
``roleId`` ("trade not stated yet") but 0.0 for a NON-MATCHING one ("different
trade"), at ``WEIGHTS.role = 0.35``. MEASURED by scoring one worker against a
VMC/turner job with ``roleId`` null vs ``role_welder``: an absolute drop of 0.1647
(= 0.4 x 0.35 / (1 - 0.15), the skills-factor renormalisation), so the penalty is
identical for any skill-less job; the relative cost depends on the baseline (24.5%
on a strong-match fixture, ~33% on a weaker one).

The precise claim, which the tests below enforce, is now:
    welding NEVER displaces an ASSIGNED role, AND it may only fill a ``None`` when the
    text carries NO machining signal and no blocker (negation / welding-adjacent
    non-welder). Both halves live in ONE place — ``signals._assign_welding_role`` —
    rather than being an emergent property of table ordering.

TD-07 T4 (2026-08-20) CLOSED ONE HALF OF THE ASYMMETRY BELOW. The MACHINING guard now
runs on the attribute bridge too, for the UNSPECIFIC entry only — see the T4 block at
the bottom of this file. The BLOCKER guard is still role-only, deliberately.

KNOWN, DELIBERATE LIMITATIONS (not fixed here):
- Blockers suppress the welder ROLE only; welding SKILL ids are still recorded. A
  worker who says "welding nahi karta" keeps ``skill_welder_occupation``. Skills are
  not the 35% role factor, and general negation parsing is a gazetteer-FAMILY property
  (every keyword table here is negation-blind), not a welding-specific defect. T4
  added the MACHINING guard to the attribute path and stopped there on purpose: that
  one was writing a SPECIFIC downstream id from an UNSPECIFIC signal, which is a
  different (and worse) failure than recording a skill a denial disclaimed.
- ``miss_attribution.py`` anchors are substring-matched, so ``mig``/``tig``/``arc``
  fire on "emigration"/"fatigue"/"March". That module is EVAL-ONLY and off the live
  path; logged by the reviewer, deliberately not touched here.
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
        "welder hun",
        "welding ka kaam",
        "mig welding",
        "tig welding",
        "MIG/MAG",
        "GMAW",
        "GTAW",
        "SMAW",
        "arc welding",
        "stick welding",
        "gas cutting",
        "oxy-fuel cutting",
        "spot welding karta hu",
        "tig aur mig dono",
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
        "fatigue testing ka kaam",  # contains "tig"
        "mitigation plan banata hu",  # contains "mig"/"tig"
        "emigration ke liye documents",  # contains "mig"
        "vintage machine chalata hu",  # contains "tag"-like noise, no welding
    ],
)
def test_short_welding_tokens_are_word_boundary_matched(text):
    sig = signals.detect(text)
    assert not set(sig.skill_ids) & ALLOWED_WELDING_SKILL_IDS, text
    assert sig.role_id != "role_welder", text


@pytest.mark.parametrize("text", ["spotwelding", "weldingwala", "subwelder"])
def test_role_and_skills_agree_on_glued_welding_tokens(text):
    """The ROLE path used to disagree with the SKILL path.

    `_WELDING_RE` is word-boundary matched, but the welding entries used to also live
    in `_ROLES`, whose loop is plain substring (`kw in lower`). So "spotwelding" set
    role_welder while producing NO skill id — an internally inconsistent profile, and
    a direct contradiction of the guard whose own comment says a bare `in` test "would
    corrupt profiles". All welding role logic now runs off `_WELDING_RE`, so the two
    paths cannot diverge: no skill id => no role."""
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


# --- THE REGRESSION THE REVIEW CAUGHT ----------------------------------------------
# Every case in the test ABOVE contains a `_ROLES` keyword, so all of them passed even
# while welding was capturing machining workers. The blind spot was exactly the region
# with NO `_ROLES` keyword — `cnc`, `lathe`, `milling`, bare `operator` — where the
# role is `None` and welding was free to fill it. These are the five texts the reviewer
# reproduced through the live path; every one returned `role_welder` before the fix.
#
# The assertion is `!= role_welder` (not `is None`) on purpose: it pins the PROPERTY
# (a machining worker is never classified a welder) rather than today's exact output,
# so a future `_ROLES` entry for `cnc`/`lathe` that makes these resolve CORRECTLY
# strengthens the result instead of failing the test.
@pytest.mark.parametrize(
    "text",
    [
        "cnc operator hun, welding bhi kar leta hun",
        "lathe pe kaam karta hu, welding bhi karta hu",
        "pehle welding karta tha, ab CNC lathe chalata hu",  # welding is PAST tense
        "welding shop mein CNC chalata hun",
        "milling machine chalata hu, welding bhi aati hai",
    ],
)
def test_machining_worker_with_no_roles_keyword_is_never_captured_as_a_welder(text):
    """Mutation proof: drop the `has_machining_signal(...)` guard from
    `signals._assign_welding_role` and all five of these fail with role_welder.

    Why a wrong role is worse than no role: reach-engine scoring gives a null roleId
    0.4 and a NON-MATCHING roleId 0.0, at a 35% weight."""
    sig = signals.detect(text)
    assert signals.has_machining_signal(text.lower(), sig), f"no machining signal: {text}"

    _rich, legacy = profile_extractor.extract(text)
    assert legacy.canonical_role_id != "role_welder", text
    assert legacy.canonical_trade_id != "dom_welding", text
    # A self-contradictory profile (welder role + a machining machine id) is impossible.
    assert not (legacy.canonical_role_id == "role_welder" and legacy.machines), text


# --- welding words present, but the worker is NOT a welder -------------------------
@pytest.mark.parametrize(
    "text",
    [
        "welding rod supply karta hu",  # storekeeper — "welding rod" is a consumable
        "welding machine repair karta hu",  # maintenance tech — services the machine
        "welding nahi karta, sirf helper hu",  # EXPLICIT DENIAL
    ],
)
def test_welding_adjacent_non_welders_do_not_get_the_welder_role(text):
    """Mutation proof: drop the `welding_role_blocked(...)` guard from
    `_assign_welding_role` and all three become role_welder.

    Scope is deliberate and narrow (see the module docstring): the ROLE is suppressed,
    the welding SKILL ids are still recorded. This is a phrase-level guard, not a
    general negation parser — negation-blindness is a gazetteer-FAMILY property."""
    assert signals.welding_role_blocked(text.lower()), f"not blocked: {text}"
    sig = signals.detect(text)
    assert sig.role_id != "role_welder", text
    assert sig.trade_id != "dom_welding", text


def test_explicit_denial_does_not_disturb_the_standing_negative_gold_case():
    # "sirf helper hu" is a negative-tier gold case; the denial guard must leave it None.
    _rich, legacy = profile_extractor.extract("welding nahi karta, sirf helper hu")
    assert legacy.canonical_role_id is None
    assert legacy.canonical_trade_id is None


def test_out_of_scope_trades_are_still_out_of_scope():
    # Widening to welding did not widen to everything — the negative tier keeps teeth.
    # ADAPTIVE-TRADE: carpenter was removed (it now has its own role id).
    for text in (
        "sirf helper hu",
        "fitter hu, assembly line pe",
        "electrician hu, wiring karta hu",
    ):
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


# --- TD-07 T4: the ATTRIBUTE bridge now carries the ROLE bridge's machining guard ---
#
# THE ASYMMETRY THIS CLOSES. Every test in the block above asserts on the ROLE. The
# attribute path was never asserted, and it did not have the guard: for all five texts
# below `_assign_welding_role` correctly refused `role_welder` while `_detect_welding`
# wrote `skill_welder_occupation` anyway — which `packages/taxonomy/src/match-skills.ts`
# bridges to the SPECIFIC `mskill_mig_welder`, and `MATCH_SKILL_RELATION_PAIRS` then
# carries to arc and TIG with the payer's related rows pre-ticked. So a CNC operator who
# mentioned welding once became a MIG welder in the match spine while the role logic was
# busy refusing to call them a welder at all.
#
# Owner decision 2026-08-20: T4 now, T1 (`mskill_welder_general`) at the first real
# welding row. Blast radius when this landed: 0 welding rows anywhere in production.
_MACHINING_PLUS_UNSPECIFIC_WELDING = [
    "cnc operator hun, welding bhi kar leta hun",
    "lathe pe kaam karta hu, welding bhi karta hu",
    "pehle welding karta tha, ab CNC lathe chalata hu",
    "welding shop mein CNC chalata hun",
    "milling machine chalata hu, welding bhi aati hai",
    "welder hun par ab vmc chalata hu",
]


@pytest.mark.parametrize("text", _MACHINING_PLUS_UNSPECIFIC_WELDING)
def test_machining_worker_gets_no_unspecific_welding_attribute(text):
    """Mutation proof: delete the `machining and skill_id in ...` continue from
    `signals._detect_welding` and every one of these fails with
    `skill_welder_occupation` — the id that becomes `mskill_mig_welder` downstream."""
    sig = signals.detect(text)
    assert signals.has_machining_signal(text.lower(), sig), f"no machining signal: {text}"
    assert "skill_welder_occupation" not in sig.skill_ids, text
    # The LABEL rides on the same tuple, so suppressing the id must suppress the text
    # that would otherwise show up on the profile as a claimed skill.
    assert "welding" not in sig.skills, text


@pytest.mark.parametrize(
    ("text", "kept"),
    [
        ("cnc operator hun, tig welding bhi karta hu", "skill_tig_welding"),
        ("lathe chalata hu, mig welding bhi aati hai", "skill_mig_welding"),
        ("vmc operator hu, arc welding bhi karta hu", "skill_arc_welding"),
        ("cnc machine pe kaam, gas cutting bhi", "skill_gas_cutting"),
    ],
)
def test_a_named_welding_process_survives_the_machining_guard(text, kept):
    """The guard suppresses an INFERENCE, never a CLAIM.

    A named process is something the worker said; only the bare "welder"/"welding"
    surface form is the unspecific signal that was being resolved to a specific id.
    Gating the whole table instead would cost real recall on real statements and buy
    no correctness — which is why `_UNSPECIFIC_WELDING_SKILL_IDS` exists."""
    sig = signals.detect(text)
    assert signals.has_machining_signal(text.lower(), sig), f"no machining signal: {text}"
    assert kept in sig.skill_ids, text
    assert "skill_welder_occupation" not in sig.skill_ids, text


@pytest.mark.parametrize(
    "text",
    [
        "welder hun main",
        "welding ka kaam karta hu",
        "welder hun, 5 saal ka experience hai",
        "welding aur gas cutting dono karta hu",
    ],
)
def test_a_real_welder_still_gets_the_unspecific_attribute(text):
    """The guard must not cost the population it was never about.

    No machining evidence => nothing changes, including the role, so T4 cannot be a
    recall regression for the welding cohort it is meant to protect."""
    sig = signals.detect(text)
    assert not signals.has_machining_signal(text.lower(), sig), f"machining signal: {text}"
    assert "skill_welder_occupation" in sig.skill_ids, text


def test_t4_is_scoped_to_the_unspecific_attribute_only():
    # A structural guard on the guard: if a named process ever joins the unspecific set,
    # the test above would still pass on its own texts while real claims silently stopped
    # being recorded. Pin the membership itself.
    assert signals._UNSPECIFIC_WELDING_SKILL_IDS == {"skill_welder_occupation"}
    assert signals._UNSPECIFIC_WELDING_SKILL_IDS < set(ALLOWED_WELDING_SKILL_IDS)
    named = ALLOWED_WELDING_SKILL_IDS - signals._UNSPECIFIC_WELDING_SKILL_IDS
    assert named == {
        "skill_mig_welding",
        "skill_tig_welding",
        "skill_arc_welding",
        "skill_gas_cutting",
    }


def test_t4_does_not_change_the_role_bridge():
    """The two guards read the same evidence, so adding one must not shift the other.

    `_assign_welding_role` already returns early on `has_machining_signal`, so it never
    reached the `_WELDING_DOMAIN_SKILL_IDS` test on these texts. Asserted because the
    suppressed id IS a member of that set — a reader could reasonably fear T4 changed
    role assignment by removing it."""
    for text in _MACHINING_PLUS_UNSPECIFIC_WELDING:
        _rich, legacy = profile_extractor.extract(text)
        assert legacy.canonical_role_id != "role_welder", text
        assert legacy.canonical_trade_id != "dom_welding", text
    # ...and on the other side of the guard the role is unchanged too.
    _rich, legacy = profile_extractor.extract("welder hun main")
    assert legacy.canonical_role_id == "role_welder"
    assert legacy.canonical_trade_id == "dom_welding"


def test_t4_does_not_fix_the_finding_it_is_scoped_under():
    """Stated as a test so nobody reads T4 as closing TD-07.

    A TIG-only worker is STILL additionally written as MIG (the bare "welding" pattern
    fires on "tig welding"), and a self-described welder still lands on a specific
    process downstream. Both need T1's `mskill_welder_general`. When T1 lands this test
    is expected to fail — that is the signal to delete it, not to weaken T1."""
    sig = signals.detect("tig welding karta hu 5 saal")
    assert "skill_tig_welding" in sig.skill_ids
    assert "skill_welder_occupation" in sig.skill_ids  # -> mskill_mig_welder downstream
