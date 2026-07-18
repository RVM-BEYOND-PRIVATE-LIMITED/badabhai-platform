"""Issues #437 and #441 — cue tables must not FABRICATE payer-facing fields.

THE DEFECT CLASS (third and fourth instance; #436/#443 fixed the first two). A cue
table matched BARE SUBSTRINGS, so ordinary shop-floor speech — often the natural answer
to OUR OWN question — wrote a profile field the worker never spoke to:

    #437  _RELOCATE_CUES  = (... "shift", "ready", "chalega", "outside", "bahar")
          "night shift karta hu"              -> willing_to_relocate = True
          "outside diameter turning karta hu" -> willing_to_relocate = True
          "vmc chalega mujhe"                 -> willing_to_relocate = True

    #441A _CURRENT_LOC_CUES contains a bare "abhi", and "abhi" is a SUBSTRING OF THE
          NAME "Abhishek", so naming a colleague flipped B-4 attribution:
          asked=preferred_locations "Abhishek ne bola Chennai chahiye"
              -> current_location: Chennai      (where they LIVE, not where they'd WORK)

    #441B availability cues read the raw text with no negation check, so a worker
          explicitly DECLINING was recorded as ACCEPTING:
          "abhi available nahi hu" -> availability: immediate

WHY THESE ARE FABRICATIONS AND NOT COVERAGE GAPS. Both fields are LIVE and
payer-facing: `willing_to_relocate` reaches `location_preference` on the persisted
profile and `availability` is a reach scoring signal rendered on the resume. A field
the detector filled is never re-asked, so a fabricated value is never corrected — while
an unset one simply gets asked. Hence the fail direction asserted throughout this file:
**record NOTHING rather than a guess.**

Both directions are proven here. Over-correcting would be its own bug — a worker who
really did say "bahar jaane ko taiyaar hu" must still be recorded as willing to move.
"""

from __future__ import annotations

import pytest

from app.profiling import signals


def _relocate(text: str) -> bool | None:
    return signals.detect(text).relocation_willingness


def _availability(text: str, asked: str | None = None) -> object:
    return signals.detect_answered_topics(text, asked).get("availability")


# --- #437: shop vocabulary must not assert willingness to relocate ----------

# Every one of these was MEASURED returning True on the unfixed parser (16/16). They
# are not edge phrasing — they are what a CNC/VMC worker says answering our machine
# and experience questions.
_SHOP_FLOOR_NOT_RELOCATION = [
    pytest.param("night shift karta hu", id="night-shift-is-working-hours"),
    pytest.param("general shift karta hu", id="general-shift"),
    pytest.param("day shift me kaam karta hu", id="day-shift"),
    pytest.param("shift me 12 ghante kaam", id="shift-as-a-noun"),
    pytest.param("night shift me vmc chalata hu", id="shift-plus-machine-verb"),
    pytest.param("outside diameter turning karta hu", id="outside-diameter-is-turning"),
    pytest.param("od outside diameter turning", id="outside-diameter-abbreviated"),
    pytest.param("outside micrometer use karta hu", id="outside-micrometer"),
    pytest.param("bahar ka diameter check karta hu", id="bahar-means-outer"),
    pytest.param("bahar ka diameter 50 mm hai", id="bahar-ka-diameter-value"),
    pytest.param("vmc chalega mujhe", id="chalega-means-the-machine-runs"),
    pytest.param("machine chalega", id="chalega-bare-machine"),
    pytest.param("lathe chalega mujhse", id="chalega-lathe"),
    pytest.param("ready hu machine ke liye", id="ready-at-the-machine"),
    pytest.param("job ready hai", id="ready-part-job-is-the-workpiece"),
    pytest.param("part ready hai", id="ready-part"),
]


@pytest.mark.parametrize("text", _SHOP_FLOOR_NOT_RELOCATION)
def test_shop_vocabulary_records_no_relocation_willingness(text: str):
    """#437. Records NOTHING — not False. The worker said nothing about moving, so the
    field stays unset and the question can still be asked."""
    assert _relocate(text) is None


# The other half of the proof: the fix must not have bought this by refusing to detect
# relocation at all. Each of these IS a statement of willingness to change place.
_GENUINE_RELOCATION = [
    pytest.param("bahar jaane ko taiyaar hu", id="bahar-plus-go-verb"),
    pytest.param("bahar ja sakta hu", id="bahar-ja-sakta"),
    pytest.param("pune se bahar ja sakta hu", id="bahar-with-origin-city"),
    pytest.param("kahin bhi ja sakta hu", id="kahin-bhi-plus-go"),
    pytest.param("kahin bhi chalega", id="kahin-bhi-plus-acceptance"),
    pytest.param("kahi bhi", id="kahi-bhi-bare-generality"),
    pytest.param("anywhere ja sakta hu", id="anywhere-plus-go"),
    pytest.param("anywhere in India", id="anywhere-bare-generality"),
    pytest.param("koi bhi city chalega", id="koi-bhi-city"),
    pytest.param("koi bhi jagah", id="koi-bhi-jagah"),
    pytest.param("Maharashtra mein kahin bhi", id="state-plus-anywhere"),
    pytest.param("dusre sheher ja sakta hu", id="another-city-plus-go"),
    pytest.param("relocate kar sakta hu", id="explicit-english"),
    pytest.param("ready hu relocate karne ke liye", id="ready-attached-to-a-move"),
    pytest.param("shift hone ko taiyaar hu", id="shift-as-place-change-verb"),
]


@pytest.mark.parametrize("text", _GENUINE_RELOCATION)
def test_genuine_relocation_willingness_is_still_detected(text: str):
    """#437, the anti-over-correction direction. Losing these would be a different bug
    of the same family: a worker who volunteered flexibility is a better match, and we
    would simply have stopped hearing them."""
    assert _relocate(text) is True


def test_relocation_distinguishes_the_two_senses_of_the_same_word():
    """The whole point, in one pair per colliding word: it is the VERB beside the token
    that decides, not the token."""
    assert _relocate("bahar ka diameter check karta hu") is None
    assert _relocate("bahar jaane ko taiyaar hu") is True

    assert _relocate("night shift karta hu") is None
    assert _relocate("shift hone ko taiyaar hu") is True

    assert _relocate("vmc chalega mujhe") is None
    assert _relocate("kahin bhi chalega") is True

    assert _relocate("ready hu machine ke liye") is None
    assert _relocate("ready hu relocate karne ke liye") is True


@pytest.mark.parametrize(
    "text",
    [
        "bahar nahi jaunga",
        "relocate nahi kar sakta",
        "kahin bhi nahi ja sakta",
        "dusre sheher nahi jaunga",
    ],
)
def test_refusing_to_relocate_does_not_assert_willingness(text: str):
    """A denial must never record its own opposite — the P1-2 rule, now applied to
    relocation as well."""
    assert _relocate(text) is not True


def test_relocation_is_not_asserted_by_a_shop_answer_at_the_topic_level():
    """End-to-end through the topic mapper, not just the signal.

    `relocation_willingness` is what marks `preferred_locations` "flexible" when the
    preferred question was asked. A shop answer must therefore not silently CLOSE that
    ask — closing it is how a fabricated value escapes ever being corrected.
    """
    answered = signals.detect_answered_topics(
        "night shift karta hu", "preferred_locations"
    )
    assert "preferred_locations" not in answered
    # ...while a real flexibility answer still closes it.
    assert (
        signals.detect_answered_topics("kahin bhi chalega", "preferred_locations")[
            "preferred_locations"
        ]
        == "flexible"
    )


# --- #441 A: a NAME must not be read as the adverb inside it ----------------


def test_a_colleagues_name_does_not_flip_location_attribution():
    """#441 A, the reported case. "Abhishek" contains "abhi", and the bare substring
    made that name read as "right now" — recording Chennai as where the worker LIVES
    when they were answering where they want to WORK."""
    assert signals.detect_answered_topics(
        "Abhishek ne bola Chennai chahiye", "preferred_locations"
    ) == {"preferred_locations": ["Chennai"]}


def test_the_name_control_from_the_issue_behaves_identically():
    """The issue's own control, which isolated the NAME as the sole cause: swapping in
    a name with no "abhi" inside it parsed correctly. After the fix the two must be
    INDISTINGUISHABLE — that equivalence, not either result alone, is the assertion."""
    abhishek = signals.detect_answered_topics(
        "Abhishek ne bola Chennai chahiye", "preferred_locations"
    )
    rakesh = signals.detect_answered_topics(
        "Rakesh ne bola Chennai chahiye", "preferred_locations"
    )
    assert abhishek == rakesh == {"preferred_locations": ["Chennai"]}


def test_the_name_no_longer_splits_a_two_city_answer():
    """The issue's third measured case: the name pulled the FIRST city into
    current_location and left only the second as a preference."""
    abhishek = signals.detect_answered_topics(
        "Abhishek ke saath tha, Chennai ya Bangalore", "preferred_locations"
    )
    rakesh = signals.detect_answered_topics(
        "Rakesh ke saath tha, Chennai ya Bangalore", "preferred_locations"
    )
    assert abhishek == rakesh
    assert abhishek == {"preferred_locations": ["Chennai", "Bangalore"]}


@pytest.mark.parametrize(
    "name",
    ["Abhishek", "Abhinav", "Abhijeet", "Abhay", "Abhilash"],
)
def test_no_abhi_prefixed_name_supplies_the_adverb(name: str):
    """Guard beyond the reported name: the boundary must hold for the whole family of
    "Abhi..." names, all common in the target population."""
    answered = signals.detect_answered_topics(
        f"{name} ne bola Chennai chahiye", "preferred_locations"
    )
    assert answered == {"preferred_locations": ["Chennai"]}


def test_the_real_adverb_still_marks_a_current_location():
    """Anti-over-correction for #441 A: "abhi" as an actual word must still attribute
    the city to where the worker IS, which is the behaviour #431 established."""
    assert signals.detect_answered_topics("abhi Pune me hu", "preferred_locations") == {
        "current_location": "Pune"
    }
    assert signals.detect_answered_topics(
        "abhi Chennai me hu, Bangalore chahiye", "preferred_locations"
    ) == {"current_location": "Chennai", "preferred_locations": ["Bangalore"]}


def test_kabhi_bhi_is_not_read_as_the_current_location_adverb():
    """The same boundary also stops "abhi" being found inside "kabhi" — "kabhi bhi"
    means "whenever", a flexibility answer, the OPPOSITE of a current-location claim."""
    assert signals.detect_answered_topics(
        "kabhi bhi, Chennai chahiye", "preferred_locations"
    ) == {"preferred_locations": ["Chennai"]}


# --- #441 B: a refusal must not be recorded as an acceptance ----------------
#
# The six cases #443 pinned as strict xfails now pass and live in
# test_availability_overmatch.py. These cover the rest of the family and both the
# backward-masked and the PRE-POSED negator word orders.


@pytest.mark.parametrize(
    "text",
    [
        "immediately join nahi kar sakta",
        "abhi kaam ke liye free nahi hu",
        "main abhi ready nahi hu",
        "turant nahi join kar sakta",
        "abhi nahi aa sakta",
        "berozgar nahi hu",
    ],
)
def test_more_negated_availability_records_nothing(text: str):
    """#441 B. Includes the PRE-POSED negator order ("nahi aa sakta"), which the
    backward-only negation mask cannot reach on its own."""
    assert signals.detect(text).availability == "unknown"
    assert _availability(text, "availability") is None


@pytest.mark.parametrize(
    "text",
    ["15 din nahi lagenge", "notice period nahi hai", "koi notice nahi hai"],
)
def test_negated_notice_period_records_nothing(text: str):
    """The notice half of the same veto: denying a notice period is not stating one."""
    assert signals.detect(text).availability == "unknown"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("abhi free hu kaam ke liye", "immediate"),
        ("turant join kar sakta hu", "immediate"),
        ("immediately join kar sakta hu", "immediate"),
        ("main available hu", "immediate"),
        ("berozgar hu", "immediate"),
        ("ready to join", "immediate"),
        ("job chhod di", "immediate"),
        ("15 din lagenge", "notice_period"),
        ("30 din baad join karunga", "notice_period"),
        ("notice period hai", "notice_period"),
    ],
)
def test_genuine_availability_survives_the_negation_veto(text: str, expected: str):
    """Anti-over-correction for #441 B."""
    assert signals.detect(text).availability == expected


@pytest.mark.parametrize(
    "text",
    ["kaam nahi kar raha", "kuch nahi kar raha", "job nahi kar raha hu"],
)
def test_cues_whose_negator_is_the_signal_are_not_vetoed(text: str):
    """The trap in fixing #441 B, and why availability cannot simply be fed the
    negation-masked text.

    "kaam nahi kar raha" MEANS "I am not working" — i.e. available. Its negator is the
    signal, and `_apply_negation` masks backward from that negator, blanking the very
    "kaam" the cue needs. Feeding availability the masked text would have closed the
    fabrication by deleting these real answers. Hence the veto uses the mask to DISCARD
    matches rather than as the input, and these cues are exempt from it by construction.
    """
    assert signals.detect(text).availability == "immediate"


def test_a_negation_in_an_earlier_clause_does_not_suppress_a_real_answer():
    """The veto is clause-clamped and windowed, so an unrelated denial elsewhere in the
    message cannot swallow a genuine availability statement."""
    assert signals.detect("kaam nahi mil raha, turant join kar sakta hu").availability == (
        "immediate"
    )
    assert signals.detect("paisa nahi mila, abhi free hu").availability == "immediate"
    # NOTE: "machine nahi chalti, abhi free hu" reads as unknown, but that is #443's
    # object blocker seeing "machine" in the window before the cue — verified present
    # on the unfixed parser too, so it is NOT this veto and not asserted here.
