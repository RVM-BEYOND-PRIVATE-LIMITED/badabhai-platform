"""Probes for the deterministic-parser widening (role cues, preferred AREAS, anywhere).

Three gap classes from ``docs/ai/profiling-parser-coverage.md`` are closed here, and
every one of them is probed in BOTH directions: the positives it must now read, and
the negatives it must still refuse. The negatives are the point — the repo's history
on this parser (#436 / #437 / #441) is a run of over-matching cue tables that
FABRICATED values, and a fabricated value is never re-asked and ships on a resume.

What is deliberately NOT closed here is asserted too (
``test_bare_cnc_and_bare_operator_still_resolve_nothing``), because "we chose not to"
is only credible if it is locked.

No network, no LLM: the path under test is regex + gazetteer.
"""

from __future__ import annotations

import pytest

from app.profiling import canonical_roles, question_bank, signals

d = signals.detect_answered_topics


# --- the ruling: bare CNC / bare `operator` stay unresolvable ----------------


def test_bare_cnc_and_bare_operator_still_resolve_nothing() -> None:
    """The `question_bank.py` decision is UPHELD, and extended to `cnc`.

    Every SPECIALISED operator role in the closed set names a machine family
    (VMC / HMC / turner / grinding). "operator" gives the function without the
    family; "CNC" gives a family-of-families without saying which. Resolving either
    one TO A SPECIALISATION has to PICK a machine the worker never named.

    Locked as an EXACT dict, not `"role" not in ...`, so a future widening that
    resolves them has to come here and argue with this test.

    TD94 (owner ruling 2026-07-21, #460) came here and argued with exactly one line of
    it. The PAIR "cnc" + an operating claim now resolves — to a GENERIC
    `role_cnc_operator` that names no family, so it picks nothing — and those cases
    moved to tests/test_generic_cnc_operator_role.py. EVERY LINE BELOW IS UNCHANGED:
    neither half resolves on its own, in either script, which is what this test is
    for and what the mint was carefully shaped not to break.
    """
    assert d("CNC", "role") == {}
    assert d("cnc", "role") == {}
    assert d("operator", "role") == {"skills": ["machine operation"]}
    assert d("machine operator hu", "role") == {"skills": ["machine operation"]}
    # ...and the Devanagari widening does not smuggle it in through the other script.
    assert d("ऑपरेटर", "role") == {}
    # Nor does the Devanagari PAIR: TD94's cue table is Latin-only on purpose (there
    # is no Latin `cnc` KEYWORD for it to be a transliteration of), so this stays a
    # re-askable gap rather than an unratified vernacular alias (ADR-0030 §7 (d)).
    assert d("सीएनसी ऑपरेटर", "role") == {}


def test_the_role_id_allow_set_is_unchanged_by_the_widening() -> None:
    """No id is MINTED **by the widening**. The widening's own cue rows all point at
    ids that already existed, because it is derived from ``_ROLES`` +
    ``_EXTRA_ROLE_TRADES`` and it adds to neither.

    TD94 later minted `role_cnc_operator` — deliberately NOT through this table, but
    through ``_EXTRA_ROLE_TRADES`` plus a gated assigner, on the `role_welder`
    precedent. The per-row loop below is the assertion that actually carries this
    test's claim, and it is untouched by that: no `_ROLE_CUES` row may reference an id
    the closed set does not already hold.
    """
    assert set(canonical_roles.ROLE_IDS) == {
        "role_cam_programmer",
        "role_cnc_programmer",
        "role_cnc_setter_operator",
        "role_vmc_operator",
        "role_hmc_operator",
        "role_cnc_grinding_operator",
        "role_cnc_turner_operator",
        "role_welder",
        "role_cnc_operator",  # TD94 — minted outside this table (see docstring)
    }
    # The widening's OWN rows still mint nothing: every id a cue points at must
    # already be in the closed set, and none of them is the TD94 generic.
    assert {rid for _p, _l, rid, _t in signals._ROLE_CUES} == {
        "role_vmc_operator",
        "role_hmc_operator",
        "role_cnc_setter_operator",
        "role_cnc_programmer",
        "role_cnc_turner_operator",
    }
    for _pat, _label, role_id, trade_id in signals._ROLE_CUES:
        assert role_id in canonical_roles.ROLE_TRADE, f"{role_id} is not in the closed set"
        assert canonical_roles.ROLE_TRADE[role_id] == trade_id, (
            f"{role_id} cue carries a trade the taxonomy does not agree with"
        )
    role_keywords = [kw for kw, _l, _r, _t in signals._ROLES]
    assert "cnc" not in role_keywords and "operator" not in role_keywords


def test_the_shipped_role_question_is_unaffected() -> None:
    """The report's conflation finding still holds exactly as written: two of the six
    options the first question offers remain unparseable. The widening did not quietly
    change which ones."""
    resolvable = {
        option: "role" in d(option, "role")
        for option in ("CNC", "VMC", "HMC", "operator", "setter", "programmer")
    }
    assert resolvable == {
        "CNC": False,
        "VMC": True,
        "HMC": True,
        "operator": False,
        "setter": True,
        "programmer": True,
    }
    role_topic = question_bank.topic_by_id("cnc_vmc", "role")
    assert role_topic is not None
    for option in ("VMC operator", "CNC turner", "setter", "programmer", "welder"):
        assert "role" in d(option, "role"), option


# --- role: what the widening DOES close -------------------------------------


@pytest.mark.parametrize(
    ("text", "role"),
    [
        # Spacing variant the substring table cannot see.
        ("V M C operator", "VMC Operator"),
        ("H M C operator", "HMC Operator"),
        # `setter` with one `t`.
        ("seter ka kaam", "CNC Setter-Operator"),
        ("setar hu", "CNC Setter-Operator"),
        # Devanagari forms of gazetteer entries that already exist in Latin.
        ("मैं वीएमसी ऑपरेटर हूँ", "VMC Operator"),
        ("एचएमसी", "HMC Operator"),
        ("प्रोग्रामर", "CNC Programmer"),
        ("सेटर हूँ", "CNC Setter-Operator"),
        ("टर्नर", "CNC Turner/Operator"),
    ],
)
def test_role_variants_that_now_resolve(text: str, role: str) -> None:
    """The surviving role widening: alternate SURFACE FORMS of `_ROLES` keywords."""
    assert d(text, "role").get("role") == role


# --- the deleted widening ---------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        # The <machine>+<function> inference itself, now DELETED.
        "lathe operator",
        "lathe operator hu",
        "lathe chalata hu",
        "lathe ka operator hu",
        "lathe m/c operator hu",
        "grinder operator",
        "angle grinder chalata hu",
        # ...and every hole three review rounds measured in the blocklist that tried
        # to make it safe. None of these can fire now, because nothing infers a role
        # from a machine plus a function word at all.
        "lathe operator ke saath kaam karta tha",
        "lathe operator mere saath kaam karta tha",
        "lathe operator hamare saath kaam karta hai",
        "papa lathe chalate hai",
        "pitaji lathe chalate hai",
        "chacha lathe chalate hai",
        "lathe operator ki requirement hai",
        "lathe operator ki zarurat hai",
        "lathe operator ki salary kitni hoti hai",
        "lathe operator ka kaam kaisa hota hai",
        "ek lathe operator ko jaanta hu",
        "lathe operator ke under kaam kiya",
        "pehle jahan tha wahan lathe operator tha",
        "lathe operator ka helper hu",
        "lathe operator banna chahta hu",
        "lathe chalane ki training li hai",
        "lathe / operator",
        "hamari company me lathe hai, operator ki jagah khali hai",
        "lathe operator ka kaam mujhe nahi aata",
        "TIG aur MIG welding karta hu, grinder bhi chalata hu",
        "welder hu, lathe chalata hu kabhi kabhi",
        # NOTE: "cnc lathe operator hu, welding bhi kar leta hu" LEFT this list on
        # TD94 and is asserted in test_the_deleted_inference_is_still_deleted_under_
        # td94 below. It is no longer a probe for THIS property — its role now comes
        # from the generic CNC gate, not from a lathe+function inference — and the
        # property it did probe (never `role_cnc_turner_operator`) is asserted there
        # directly, which is stronger than asserting "no role at all".
    ],
)
def test_the_machine_plus_function_inference_is_deleted(text: str) -> None:
    """The `<machine> + <function>` role inference was REMOVED, not patched.

    It read "lathe operator" as `role_cnc_turner_operator`. Deciding whether the
    speaker is CLAIMING that role — rather than asking about it, aspiring to it,
    training for it, working next to it, or describing a relative's job — is a
    judgement `_ROLES` never makes, and three rounds of adversarial review measured a
    fresh hole in every blocklist written to make it. The blocked class is GENERATIVE;
    a blocklist can only enumerate.

    It bought exactly ONE corpus fixture. `lathe operator` is an honest, re-askable GAP
    again, and role acceptance drops 57% -> 52% as a result. That is the correct trade:
    a gap re-asks the worker, a wrong role scores 0.0 in `scoreRole` where the null it
    replaced scores 0.4, on a topic that is never re-asked once closed.
    """
    assert "role" not in d(text, "role"), f"{text!r} still infers a role"


def test_the_deleted_inference_is_still_deleted_under_td94() -> None:
    """TD94 must not resurrect `<machine> + <function>` by the back door.

    "cnc lathe operator hu, welding bhi kar leta hu" used to be a row in the
    parametrized list above, asserting no role at all. It now resolves, and the
    distinction is the whole safety argument for the mint: the worker said CNC and
    said operator, so they get the GENERIC id — they did NOT get
    `role_cnc_turner_operator`, which is what the deleted inference read "lathe
    operator" as and which would score 0.0 against every non-turning job.

    The lathe-only phrasings stay gaps: with no `cnc` in the sentence there is no pair
    to match, so nothing fires at all.
    """
    got = d("cnc lathe operator hu, welding bhi kar leta hu", "role")
    assert got["role"] == "CNC Operator"
    assert signals.detect(
        "cnc lathe operator hu, welding bhi kar leta hu"
    ).role_id == "role_cnc_operator"
    # The two ids TD94 must never produce from this sentence: the specialisation the
    # deleted inference produced, and the welder the machining gate must keep out.
    for text in ("lathe operator", "lathe operator hu", "lathe chalata hu"):
        assert "role" not in d(text, "role"), f"{text!r} resurrected the inference"


def test_the_deletion_also_restores_the_welding_gate() -> None:
    """A consequence worth stating: with no cue firing before it,
    `_assign_welding_role` is reached exactly as it is on `main`."""
    assert d("welder hu", "role")["role"] == "Welder"
    assert d("welding ka kaam karta hu", "role")["role"] == "Welder"
    # ...and a machining role stated outright still wins over a welding mention.
    assert d("VMC operator hu, welding bhi kar leta hu", "role")["role"] == "VMC Operator"


# --- what the surviving variant rows may and may not do ---------------------


@pytest.mark.parametrize(
    "text",
    [
        # Near-misses that must not match the added patterns.
        "seater cover lagata hu",
        "v mc",
        "mera naam v m c nahi hai",
        # Denials: the variant rows read the same negation-masked text `_ROLES` reads.
        "वीएमसी नहीं चलाता",
        "setter nahi hu",
        # Out-of-family trades: still honestly unresolvable, no id exists for them.
        "helper hu, machine seekh raha hu",
        "fitter",
        "supervisor",
    ],
)
def test_role_variants_that_must_still_resolve_nothing(text: str) -> None:
    assert "role" not in d(text, "role"), f"{text!r} fabricated a role"


@pytest.mark.parametrize(
    ("latin", "variant"),
    [
        ("VMC operator ki job hai kya", "V M C operator ki job hai kya"),
        ("mere bhai VMC operator hai", "mere bhai V M C operator hai"),
        ("VMC operator ki salary kitni hai", "V M C operator ki salary kitni hai"),
        ("setter ki job hai kya", "seter ki job hai kya"),
        ("setter ka helper hu", "seter ka helper hu"),
        ("papa VMC chalate hai", "papa वीएमसी chalate hai"),
    ],
)
def test_a_variant_row_can_only_do_what_its_latin_twin_already_does(
    latin: str, variant: str
) -> None:
    """The safety argument for keeping the variant rows, MEASURED rather than asserted.

    A variant row is a surface-form alias; it inherits `_ROLES`'s semantics exactly,
    including `_ROLES`'s pre-existing limits. `_ROLES` resolves `role` from an
    interrogative ("VMC operator ki job hai kya"), from a relative's job and from a
    helper's — because it is a plain substring test on a shipped gazetteer. Each pair
    below must agree, which is the whole claim: this PR adds no new reading.

    Narrowing that limit means narrowing `_ROLES`, i.e. changing a SHIPPED behaviour
    for every worker, and it belongs in its own measured change — not smuggled in
    behind a spelling table.
    """
    assert d(latin, "role").get("role") == d(variant, "role").get("role")


def test_devanagari_role_does_not_close_the_essential_machines_topic() -> None:
    """A deliberate ASYMMETRY with the Latin path, and the reason is finding 7.

    Latin "VMC operator" marks `role` AND `machines` — an ESSENTIAL topic closed by
    inference, which the coverage report calls its most serious open defect. The
    Devanagari cue is a ROLE cue only, so the machine question still gets asked.
    """
    assert d("मैं वीएमसी ऑपरेटर हूँ", "role") == {"role": "VMC Operator"}
    assert "machines" not in d("मैं वीएमसी ऑपरेटर हूँ", "role")
    # The Latin behaviour is unchanged — this test states the gap, it does not close it.
    assert "machines" in d("VMC operator", "role")


# --- preferred_locations: state / region ------------------------------------


@pytest.mark.parametrize(
    ("text", "value"),
    [
        ("Gujarat mein", ["Gujarat"]),
        ("Bihar", ["Bihar"]),
        ("Tamil Nadu me kaam chahiye", ["Tamil Nadu"]),
        ("South India", ["South India"]),
        ("NCR", ["NCR"]),
        ("north india", ["North India"]),
        ("sirf Gujarat", ["Gujarat"]),
        ("pura Gujarat chalega", ["Gujarat"]),
        # A city still wins over an area — it is the most specific thing on offer.
        ("Pune", ["Pune"]),
        ("delhi ncr", ["Delhi"]),
    ],
)
def test_state_and_region_answer_the_preferred_question(text: str, value) -> None:
    assert d(text, "preferred_locations").get("preferred_locations") == value


@pytest.mark.parametrize(
    "text",
    [
        # --- refusals, at every distance from the negator (PR #488, HIGH-1) ---
        "Bihar nahi jaunga",
        "Gujarat mein nahi jaunga",
        "Kerala mein bilkul bhi nahi jaunga",
        "West Bengal me kaam karne ki koi ichha nahi hai",
        "Bihar me kaam karne ka mann nahi hai",
        "Odisha ki taraf jaana mujhe pasand nahi",
        "Punjab wale bulate hai par mai nahi jaunga",
        "Kerala bahut door hai, nahi ja sakta",
        "Kerala nahi",
        # --- ORIGIN / PAST, not preference (PR #488, MEDIUM-3 + round-3 C) ---
        "Bihar se hu",
        "Bihar ka rahne wala hu",
        "Bihar me tha, ab Gujarat me kaam chahiye",
        "main Bihar ka hu",
        "ghar Bihar me hai",
        "gaon Bihar me hai",
        "Bihar mera home town hai",
        "Bihar me paida hua",
        # --- third party (round-3 D) ---
        "mere papa Kerala me rehte hain",
        "mera bhai Gujarat me kaam karta hai",
        # --- not an area at all ---
        "south side me rehta hu",
        "goal hai acha kaam",
        "ncrp",
        "abhi soch nahi paya",
        # --- the 2-letter abbreviations are not read here at all ---
        "set UP karta hu",
        "SET UP",
        "UP mein",
        "MP me",
        # --- a QUESTION is not an answer (found by re-probing the allow-list: both
        # `me` and `kaam` are filler, so this otherwise passed) ---
        "Gujarat me kaam?",
        "Bihar me job?",
    ],
)
def test_areas_that_must_not_become_a_preference(text: str) -> None:
    """None of these is blocked by a KEYWORD. They fail the positive requirement:
    every word outside an area name must be on `_AREA_FILLER_WORDS`, and `rehte`,
    `paida`, `ghar`, `bhai`, `tha`, `nahi`, `karta` are not."""
    assert "preferred_locations" not in d(text, "preferred_locations"), (
        f"{text!r} fabricated a preferred location"
    )


@pytest.mark.parametrize(
    "text",
    [
        # The spellings the round-2 blocklist enumerated...
        "Bihar ke alawa kahin bhi",
        "Bihar chhod ke kahin bhi",
        "Kerala ke siwa kahin bhi",
        # ...and the eight it MISSED, measured in round 3. They pass now for a
        # structural reason, not because they were added: the allow-list rejects
        # `alaawa`/`chhodke`/`sivay` the same way it rejects any unknown word.
        "Bihar ke alaawa kahin bhi kaam kar sakta hu",
        "Bihar ke alaava kahin bhi kaam kar sakta hu",
        "Bihar ke alawaa kahin bhi",
        "Bihar chhodke kahin bhi kaam kar sakta hu",
        "Bihar chodke kahin bhi kaam kar sakta hu",
        "Bihar hatake kahin bhi kaam kar sakta hu",
        "Bihar ke sivay kahin bhi kaam kar sakta hu",
        "Bihar ke siwaay kahin bhi kaam kar sakta hu",
        # ...and spellings NOBODY has enumerated, which is the actual claim. If these
        # pass, the guard is generative; a blocklist could not do this.
        "Bihar ke alaawaa kahin bhi",
        "Bihar chhodkar kahin bhi",
        "Bihar ko chhod ke kahin bhi",
        "Bihar ke siwaaye kahin bhi",
        "Bihar nikaal ke kahin bhi",
        "Bihar ke atirikt kahin bhi",
    ],
)
def test_an_exclusion_is_not_a_preference_and_stays_flexible(text: str) -> None:
    """PR #488 review, HIGH-1 — the REGRESSION half, and the sharpest case in it.

    "anywhere EXCEPT Bihar" carries NO negator, so no negation machinery can see it.
    An earlier cut read it as `['Bihar']`: it both destroyed the correct answer
    (`flexible`, which is what main recorded) and stored the single state the worker
    ruled out, on a topic that is then never re-asked.

    Round 2 answered that with a list of exclusion markers, and round 3 measured EIGHT
    spellings that walked past it. The list is gone: nothing here matches an exclusion
    idiom at all. The message simply contains words that are not area names and not
    filler, so the area read is abandoned and the "anywhere" it also contains stands.
    """
    assert d(text, "preferred_locations") == {"preferred_locations": "flexible"}


@pytest.mark.parametrize(
    "text",
    [
        "kahin bhi ja sakta hu, abhi Gujarat me kaam kar raha hu",
        "company Gujarat me hai, main kahin bhi jaa sakta hu",
        "Maharashtra me salary kam hai, kahin bhi bhej do",
        "Punjab me kaam milega to theek, warna kahin bhi",
        "mera bhai Kerala me hai, main kahin bhi ja sakta hu",
        "Maharashtra mein kahin bhi",
        "Maharashtra ke andar kahin bhi, bahar nahi jaunga",
    ],
)
def test_anywhere_wins_over_an_incidental_state(text: str) -> None:
    """PR #488 round-3 (D): an earlier cut let a state mentioned in passing REPLACE a
    correct `flexible`. The worker said anywhere; the state is context — where they
    are, where the company is, where a relative lives.

    Asserted explicitly in `_preferred_areas` via `_has_anywhere_cue` rather than left
    to emerge from the filler list, so adding a word to that list cannot break it.

    The last row is the honest edge (round-3 E): "anywhere INSIDE Maharashtra, not
    outside" records `flexible`, i.e. anywhere in India. That is what `main` records
    too — this function neither causes it nor fixes it.
    """
    assert d(text, "preferred_locations") == {"preferred_locations": "flexible"}


def test_all_areas_are_recorded_not_just_the_first() -> None:
    """PR #488 review, MEDIUM-3. ``preferred_locations`` is a LIST, and collapsing it
    to the first match dropped a real second choice while closing the topic."""
    assert d("Gujarat ya Maharashtra dono chalega", "preferred_locations") == {
        "preferred_locations": ["Gujarat", "Maharashtra"]
    }
    assert d("Gujarat aur Rajasthan dono chalega", "preferred_locations") == {
        "preferred_locations": ["Gujarat", "Rajasthan"]
    }


def test_state_and_region_never_mark_current_location() -> None:
    """The B-4 decision is untouched: a state-only answer to "abhi kis sheher mein
    hain?" still marks nothing, so the engine goes on to ask for the CITY."""
    for text in ("Bihar", "Gujarat mein", "South India", "NCR", "Maharashtra"):
        assert d(text, "current_location") == {}, text
    # ...and an area never leaks into a topic that was not asked.
    for text in ("Gujarat mein", "South India", "NCR"):
        for topic in ("role", "machines", "experience", "salary_current", "availability"):
            assert "preferred_locations" not in d(text, topic), (text, topic)


def test_the_area_requirement_is_strict_and_its_cost_is_measured() -> None:
    """What the positive requirement COSTS, stated rather than claimed — the contract
    of this file is "measured, not asserted" (PR #488, LOW-4).

    Requiring the whole message to be area names plus filler means any genuine but
    DISCURSIVE preference records nothing and is asked again. Three real ones:"""
    assert d("Maharashtra se bahar nahi jaunga", "preferred_locations") == {}
    assert d("Gujarat me kaam kiya tha, wahi chahiye", "preferred_locations") == {}
    assert d("Gujarat me kaam karna pasand karunga", "preferred_locations") == {}
    # Accepted deliberately: a gap re-asks the worker; a wrong preference feeds the
    # reach feed a place they ruled out and is never re-asked.
    #
    # The CITY path is untouched by this change and keeps its own, older open gap —
    # narrowing it is the separate "negation on VALUE cues" item.
    assert d("Pune se bahar nahi jaunga", "preferred_locations") == {
        "preferred_locations": ["Pune"]
    }


def test_an_empty_area_read_falls_through_to_flexible_not_to_nothing() -> None:
    """PR #488 round-3 (E). An earlier docstring claimed the vetoed messages "record
    nothing". That was FALSE: `_preferred_areas` returning `[]` only abandons the AREA
    read, and `detect_answered_topics` falls through to the flexibility arm.

    Both outcomes are correct, but they are different outcomes and the distinction is
    now stated in the code:
    """
    # ...with an "anywhere" idiom -> flexible (the answer the worker actually gave).
    assert d("Bihar ke alawa kahin bhi", "preferred_locations") == {
        "preferred_locations": "flexible"
    }
    # ...without one -> genuinely nothing, and the topic is asked again.
    assert d("Bihar me tha", "preferred_locations") == {}
    assert d("mere papa Kerala me rehte hain", "preferred_locations") == {}


# --- the "anywhere" spelling family -----------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "kahin bhi",
        "kahi bhi",       # already resolved before this change; regression guard
        "kahee bhi",
        "kaheen bhi",
        "kahi bi",        # nasal AND aspirate dropped
        "kahin bi chalega",
        "koi bhi jagah",
        "koi bi sheher",
        "anywhere in India",
        "कहीं भी",
        "जहाँ भी काम मिले",
        "जहां भी",
    ],
)
def test_anywhere_family_answers_the_preferred_question(text: str) -> None:
    assert d(text, "preferred_locations").get("preferred_locations") == "flexible", text


@pytest.mark.parametrize(
    "text",
    [
        # #437's fabrication set: none of these is a relocation statement.
        "night shift karta hu",
        "outside diameter turning karta hu",
        "vmc chalega mujhe",
        "ready hu machine ke liye",
        # ...and the flexibility read is context-gated, so it cannot close the topic
        # from some other question's answer.
        "kabhi kabhi",
    ],
)
def test_anywhere_family_does_not_over_match(text: str) -> None:
    assert "preferred_locations" not in d(text, "preferred_locations"), text


def test_devanagari_boundaries_are_used_because_ascii_word_boundary_is_broken() -> None:
    """The measurement behind :func:`signals._dev`.

    Python's ``\\b`` is ``\\w``-backed and Devanagari matras are not word characters,
    so ``\\bवीएमसी\\b`` never matches — a pattern written that way would be silently
    dead. ``_dev`` boundaries work AND still refuse a substring match.
    """
    import re

    assert re.search(r"\bवीएमसी\b", "मैं वीएमसी ऑपरेटर हूँ") is None  # the broken form
    assert re.search(signals._dev("वीएमसी"), "मैं वीएमसी ऑपरेटर हूँ") is not None
    assert re.search(signals._dev("वीएमसी"), "वीएमसीएक्स") is None  # no substring match
