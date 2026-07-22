"""TD94 — a plain "CNC operator" must resolve to a canonical role.

The gap this closes, quoted from the tech-debt register row and re-measured here:
``'CNC operator hun'`` -> None, ``'cnc operator'`` -> None, ``'CNC machine operator
hun'`` -> None, ``'CNC chalata hun'`` -> None, against the control ``'VMC operator
hun'`` -> ``role_vmc_operator``. The most natural self-description in a product whose
scope is literally "CNC/VMC" resolved to nothing, and ``scoring.ts`` then mid-scored
those workers forever at 0.4 on a 35%-weighted factor they could never exact-match.

The owner ruled (2026-07-21, #460) option (a): MINT ``role_cnc_operator`` on the
``role_welder`` precedent — ``signals._EXTRA_ROLE_TRADES`` plus ONE gated assigner
(``signals._assign_generic_cnc_role``), never a bare ``cnc`` keyword in ``_ROLES``.

Everything in this file is a probe of ONE of three properties, because those three are
what make the mint safe rather than merely additive:

1. **it fires** on a bare CNC-operator claim, in the spellings the corpus carries;
2. **the specific ALWAYS wins** — a stated VMC / HMC / turner / setter / grinding /
   programmer is NEVER downgraded to the generic;
3. **it is no wider than ``_ROLES`` already is**, and neither half of the pair
   resolves on its own.

No network, no LLM: the path under test is regex + gazetteer inside the trusted
service. Every string is fabricated (CLAUDE.md §2 #2 — no worker PII in a public repo).
"""

from __future__ import annotations

import pytest

from app.profiling import canonical_roles, profile_extractor, signals

d = signals.detect_answered_topics


# --- 1. the register's four measured phrases now resolve ---------------------


@pytest.mark.parametrize(
    "text",
    [
        # The exact four the register measured as None on `main` (2026-07-18).
        "CNC operator hun",
        "cnc operator",
        "CNC machine operator hun",
        "CNC chalata hun",
        # ...and the corpus fixtures that were gaps for the same reason.
        "main CNC operator ka kaam karta hu",
        "CNC machine chalata hoon",
        "cnc oprator",  # the misspelling the corpus carries, register="misspelling"
        # Word order reversed — the pair is matched in both directions.
        "operator hu, cnc pe kaam",
        # Spelled-out acronym, the same widening shape as `V M C operator`.
        "c n c operator hu",
    ],
)
def test_a_bare_cnc_operator_claim_resolves_to_the_generic_role(text: str) -> None:
    sig = signals.detect(text)
    assert sig.role_id == "role_cnc_operator", f"{text!r} -> {sig.role_id}"
    assert sig.trade_id == "dom_cnc_machining"
    assert sig.primary_role == "CNC Operator"
    # ...and the interview engine sees it, which is the half that actually stops the
    # bounded re-ask burning on a question the worker already answered.
    assert d(text, "role")["role"] == "CNC Operator"


def test_the_register_control_case_is_unchanged() -> None:
    """`'VMC operator hun'` -> role_vmc_operator was the register's control. If this
    ever moves, the mint has started eating the specialisations."""
    assert signals.detect("VMC operator hun").role_id == "role_vmc_operator"


def test_it_reaches_the_persisted_profile_through_the_live_extract_path() -> None:
    """End-to-end through ``profile_extractor.extract`` — the same call the register
    measured — because the id is only worth anything if it lands on the profile the
    API persists, not merely on a ``Signals`` dataclass."""
    _rich, legacy = profile_extractor.extract("CNC operator hun, 5 saal ka experience")
    assert legacy.canonical_role_id == "role_cnc_operator"
    assert legacy.canonical_trade_id == "dom_cnc_machining"


# --- 2. the specific role ALWAYS wins ----------------------------------------


@pytest.mark.parametrize(
    ("text", "expected_role_id"),
    [
        # Every specialisation, each stated ALONGSIDE the words that would otherwise
        # trigger the generic. None of them may be downgraded.
        ("cnc vmc operator hu", "role_vmc_operator"),
        ("cnc hmc operator hu", "role_hmc_operator"),
        ("cnc turner operator hu", "role_cnc_turner_operator"),
        ("cnc lathe operator hu, turning ka kaam", "role_cnc_turner_operator"),
        ("cnc setter operator hu", "role_cnc_setter_operator"),
        ("cnc grinding operator hu", "role_cnc_grinding_operator"),
        ("cnc programmer hu, program banata hu", "role_cnc_programmer"),
        ("cam programmer hu, cnc ke liye tool path banata hu", "role_cam_programmer"),
        # The variant table (`_ROLE_CUES`) runs before the generic too, so a
        # misspelling or a spaced acronym also keeps its specialisation.
        ("cnc seter ka kaam karta hu", "role_cnc_setter_operator"),
        ("c n c aur v m c operator hu", "role_vmc_operator"),
        ("मैं सीएनसी वीएमसी ऑपरेटर हूँ", "role_vmc_operator"),
    ],
)
def test_a_stated_specialisation_is_never_downgraded_to_the_generic(
    text: str, expected_role_id: str
) -> None:
    assert signals.detect(text).role_id == expected_role_id


def test_the_generic_only_ever_fills_a_none() -> None:
    """The mechanism behind property 2, asserted directly rather than inferred from
    the cases above: the assigner returns immediately when a role is already set, so
    it is structurally incapable of displacing one."""
    sig = signals.Signals(
        primary_role="VMC Operator",
        role_id="role_vmc_operator",
        trade_id="dom_vmc_machining",
    )
    signals._assign_generic_cnc_role("cnc operator hu", sig)
    assert (sig.role_id, sig.trade_id) == ("role_vmc_operator", "dom_vmc_machining")


# --- 3. neither half of the pair resolves, and the pair is no wider than _ROLES ---


@pytest.mark.parametrize(
    "text",
    [
        # Either half alone — the standing ruling, unchanged by the mint.
        "CNC",
        "cnc",
        "operator",
        "machine operator hu",
        "cnc machine",
        "cnc line pe hu",
        # A DENIAL. The pair is read off the same negation-masked text `_ROLES` reads.
        "cnc nahi chalata",
        "cnc operator nahi hu",
        "mujhe cnc operate karna nahi aata",
        # Not a present claim: an infinitive is how a TRAINING answer is phrased, and
        # the future tense is an aspiration. Both are deliberately unmatched.
        "cnc chalane ki training li hai",
        "cnc chalana seekh raha hu",
        "cnc chalaunga aage jaake",
        # The MACHINE is running, not the worker operating it.
        "cnc running me hai",
        # Devanagari is deliberately out of scope (there is no Latin `cnc` KEYWORD for
        # it to be a transliteration of — see the note on `_GENERIC_CNC_ROLE_RE`).
        "सीएनसी ऑपरेटर",
        "सीएनसी चलाता हूँ",
        # Out of clause range / a different sentence: the window is clause-bounded, so
        # two unrelated statements do not compose into a claim.
        "cnc machine acchi hai. mera dost operator hai",
    ],
)
def test_the_generic_does_not_fire(text: str) -> None:
    assert signals.detect(text).role_id is None, f"{text!r} fabricated a role"
    assert "role" not in d(text, "role")


@pytest.mark.parametrize(
    "sentence_template",
    [
        # Third parties, interrogatives, aspirations, adjacency — the exact family the
        # deleted `<machine> + <function>` inference needed a (leaking) blocklist for.
        "{kw} operator ki salary kitni hoti hai",
        "mere bhai {kw} operator hai",
        "ek {kw} operator ko jaanta hu",
        "{kw} operator banna chahta hu",
        "hamari company me {kw} operator ki jagah khali hai",
    ],
)
def test_the_generic_is_no_more_permissive_than_the_vmc_keyword(
    sentence_template: str,
) -> None:
    """THE LIMIT, PINNED IN BOTH DIRECTIONS.

    This is the honest part of TD94 and it is asserted rather than buried in a
    comment: the generic pair makes NO judgement about who is being described, so it
    fires on a question, a relative's job, an aspiration and a vacancy.

    So does ``_ROLES``, today, on `main`, for the identical sentence with "vmc" in it
    — that is what the second half of each assertion measures. The limit is
    ``_ROLES``'s, it is shipped behaviour, and this test's job is to prove the mint
    did not make it WORSE. If someone narrows one side, this fails until they narrow
    the other, which is the only way the two stay consistent.

    (Fixing it properly means deciding "is the speaker CLAIMING this role?", which the
    ``_ROLE_CUES`` note records three rounds of adversarial review failing to do with
    a blocklist. It is a separate change against a shipped behaviour, not this lane.)
    """
    generic = d(sentence_template.format(kw="cnc"), "role").get("role")
    specific = d(sentence_template.format(kw="vmc"), "role").get("role")
    assert (generic is None) == (specific is None), (
        f"the generic pair and the `vmc` keyword disagree on "
        f"{sentence_template!r}: {generic!r} vs {specific!r}"
    )


# --- the closed set + the two live routes ------------------------------------


def test_the_id_is_in_the_closed_set_and_the_id_space_only_grew() -> None:
    """ADR-0028: the id space is CLOSED and IMMUTABLE. Additive only — every
    pre-existing id keeps its exact spelling AND its position in the ordered tuple
    the model is shown."""
    assert canonical_roles.ROLE_TRADE["role_cnc_operator"] == "dom_cnc_machining"
    assert canonical_roles.normalize_role_id("role_cnc_operator") == "role_cnc_operator"
    assert canonical_roles.ROLE_IDS[:8] == (
        "role_cam_programmer",
        "role_cnc_programmer",
        "role_cnc_setter_operator",
        "role_vmc_operator",
        "role_hmc_operator",
        "role_cnc_grinding_operator",
        "role_cnc_turner_operator",
        "role_welder",
    )
    assert canonical_roles.ROLE_IDS[8:] == ("role_cnc_operator",)


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        # The MODEL-emitted label route (`map_rich_to_legacy`). Before TD94 every one
        # of these mapped to None: no `_ROLES` keyword matches them, and the machining
        # gate then swallowed anything CNC-shaped on its way to the welding table.
        ("CNC Operator", ("role_cnc_operator", "dom_cnc_machining")),
        ("CNC Machine Operator", ("role_cnc_operator", "dom_cnc_machining")),
        ("cnc_machine_operator", ("role_cnc_operator", "dom_cnc_machining")),
        ("CNC Lathe Operator", ("role_cnc_operator", "dom_cnc_machining")),
        # ...and the specialisations still win on this route too.
        ("VMC Operator", ("role_vmc_operator", "dom_vmc_machining")),
        ("CNC Turner/Operator", ("role_cnc_turner_operator", "dom_cnc_machining")),
        ("CNC Setter-Operator", ("role_cnc_setter_operator", "dom_cnc_machining")),
        # Unchanged: welding still maps, out-of-scope trades still do not.
        ("mig_tig_welder", ("role_welder", "dom_welding")),
        ("Machine Operator", None),
        ("Fitter", None),
    ],
)
def test_the_model_label_route_agrees_with_the_raw_text_route(
    label: str, expected: tuple[str, str] | None
) -> None:
    """One rule, both live routes — the property the welding fix established and the
    reason `role_id_for_label` was widened alongside the raw-text gate. A model that
    correctly reads a worker as "CNC Operator" must not have that dropped on the floor
    while the deterministic detector resolves the very same words."""
    assert signals.role_id_for_label(label) == expected


def test_welding_precedence_is_unchanged_by_the_mint() -> None:
    """TAX-WELD-1's invariant — a machining worker is never classified a welder — is
    untouched, and now lands on a real id instead of a null.

    Both texts already had a machining signal (`cnc` is in `_MACHINING_CONTEXT`), so
    `_assign_welding_role` was already barred from filling the None. What changed is
    only what fills it: the role the worker actually stated.
    """
    for text in (
        "cnc operator hun, welding bhi kar leta hun",
        "welding karta hu par mainly cnc operator hu",
    ):
        sig = signals.detect(text)
        assert sig.role_id == "role_cnc_operator", text
        # The welding SKILL ids are still recorded — the gate only ever withheld a
        # welder ROLE, never the skills.
        assert "skill_welder_occupation" in sig.skill_ids, text
    # A genuine welder with no machining word anywhere is still a welder.
    assert signals.detect("welder hun main").role_id == "role_welder"
