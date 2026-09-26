"""#1728 at the ROUTE level: a leading trade word is not a person's name, on both sides.

`tests/test_pseudonymize.py` pins the gateway rule itself. This file pins what the rule was
for, through the two routes that paid for its absence (measured on main before the fix):

- PAYER, POST /job-posting-chat/respond. "Welding, grinding" masked to "[PERSON_1], grinding";
  `safe_draft_text` then stored the MASKED text because a PERSON token is identity-class, and
  the skills list became ["PERSON_1", "grinding"] — the payer's trade replaced by a token
  remnant (the phrase cleaner trims the brackets) on the draft that gets published, silently:
  no retype prompt fired, because the bracketless remnant no longer reads as a placeholder.
- WORKER, POST /profiling/turn. The model was sent "[PERSON_1], 5 saal" for "Welding, 5 saal",
  i.e. it never saw the trade the worker named.

And what the rule must NOT do (PR #1729 review round 1): open the CLEAN-OR-WITHHOLD gates. Those
consumers pass a string RAW when the gateway masked nothing, so before the carve-out the
incidental [PERSON_1] made them withhold "Welding, Anil Kumar" whole. The last section pins that
they still do, through the real consumers: `certified_clean_skill_labels`, the /resume/generate
text and payload, and the work-history polish route's `<role>`.

Each permit is paired with a refusal through the same route, so a capture that could not see a
PERSON token would fail the control instead of passing the permit vacuously.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.contracts import AICallMetadata, JobPostingChatState

client = TestClient(main_module.app)


def _no_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _boom(*_a, **_k):  # pragma: no cover - the assertion is that it never runs
        raise AssertionError("the job-posting chat route must not call the AI router")

    monkeypatch.setattr(main_module.router, "run", _boom)


def _answer_skills(message: str) -> dict:
    state = JobPostingChatState(asked_question_ids=["skills"], ask_counts={"skills": 1})
    res = client.post(
        "/job-posting-chat/respond",
        json={
            "session_id": "s1",
            "message_text": message,
            "conversation_state": state.model_dump(),
        },
    )
    assert res.status_code == 200
    return res.json()


def test_a_payer_skills_answer_opening_with_a_trade_word_is_recorded_verbatim(
    monkeypatch: pytest.MonkeyPatch,
):
    _no_llm(monkeypatch)
    body = _answer_skills("Welding, grinding")
    assert body["blocked"] is False
    assert body["draft"]["skills"] == ["Welding", "grinding"]
    assert not any(
        tok.startswith("[PERSON_")
        for tok in body["pseudonymization_metadata"]["placeholder_tokens"]
    )
    # NO TOKEN REMNANT ANYWHERE ON THE DRAFT. This replaced a "no retype prompt" assertion
    # that was VACUOUS: on main no retype prompt fired for this answer either (the phrase
    # cleaner strips the token's brackets, so the placeholder scan never matches), and it
    # passed with the carve-out removed. What main actually did was store a bracketless
    # "PERSON_1" in place of the trade, silently — which is what this line can see.
    assert "PERSON_1" not in json.dumps(body["draft"])


def test_a_payer_answer_opening_with_a_NAME_is_still_masked(monkeypatch: pytest.MonkeyPatch):
    # The control: the same route, the same topic, a person's name in the same position.
    #
    # Deliberately NOT asserting whether a retype prompt is raised. That is decided by the
    # job-posting chat's phrase cleaner (job_posting_chat/answers.py), which is owned
    # elsewhere and is being changed separately: while it trims wrapping punctuation, a token
    # at a phrase edge is stored as "PERSON_1" (brackets gone), the placeholder scan cannot
    # match it and no prompt fires; once it stops trimming the brackets, one will. This
    # control pins only what the GATEWAY decides — the name never reaches the draft — and
    # `"PERSON_1" in skills[0]` holds with or without the brackets.
    _no_llm(monkeypatch)
    body = _answer_skills("Ramesh, grinding")
    assert body["pseudonymization_metadata"]["placeholder_tokens"] == ["[PERSON_1]"]
    skills = body["draft"]["skills"]
    assert len(skills) == 2 and "PERSON_1" in skills[0] and skills[1] == "grinding"
    assert "Ramesh" not in json.dumps(body)


def _meta() -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="call-1",
        task_type="profiling_chat_turn",
        model_name="test-model",
        provider="test-provider",
        real_call=False,
        created_at="2026-09-25T00:00:00Z",
    )


def _worker_turn_sent(monkeypatch: pytest.MonkeyPatch, message: str) -> str:
    """The user message the /profiling/turn route hands the router for ``message``."""
    captured: dict[str, list[dict[str, str]]] = {}

    async def _capture(*_a, **kwargs):
        captured["messages"] = kwargs["messages"]
        return "{}", _meta()

    monkeypatch.setattr(main_module.router, "run", _capture)
    res = client.post("/profiling/turn", json={"worker_ref": "w1", "message_text": message})
    assert res.status_code == 200
    assert res.json()["blocked"] is False
    return captured["messages"][-1]["content"]


def test_the_worker_turn_route_sends_a_leading_trade_word_to_the_model_unmasked(
    monkeypatch: pytest.MonkeyPatch,
):
    sent = _worker_turn_sent(monkeypatch, "Welding, 5 saal")
    assert "The worker just said: Welding, 5 saal" in sent
    assert "[PERSON_" not in sent


def test_the_worker_turn_route_still_masks_a_leading_NAME(monkeypatch: pytest.MonkeyPatch):
    sent = _worker_turn_sent(monkeypatch, "Ramesh, 5 saal")
    assert "The worker just said: [PERSON_1], 5 saal" in sent
    assert "Ramesh" not in sent


# --- the clean-or-withhold gates (PR #1729 review round 1) -------------------
#
# The ruling covers NOT MASKING THE LEADING TRADE WORD in `pseudonymize()` output. It does not
# cover a consumer that passes a string RAW when the gateway masked nothing releasing the rest
# of a string it used to withhold. MEASURED on this branch before `is_certified_clean`:
#
#     certified_clean_skill_labels(["Welding, Ramesh Kumar", "Turner, Suresh",
#                                   "Diploma, Anil Sharma"])        -> all three (main: [])
#     polish role_label "Operator, Ramesh sir ke under"             -> sent verbatim (main: worker)
#
# A label whose leading word the vocabulary carve-out released is clean only when the WHOLE
# label is vocabulary (the FIX-5 whole-label rule, never a token-by-token exemption).
#
# Every WITHHELD probe first asserts the gateway itself leaves the string untouched, so the
# gate is the only thing that can withhold the name; every KEPT probe is the permit that stops
# a gate which drops everything from passing.

_WITHHELD = [
    "Welding, Anil Kumar",
    "Welding, Ramesh Kumar",
    "Diploma, Anil Sharma",
    "Turner, Suresh",
    "Operator, Ramesh sir ke under",
    "Apprenticeship, Ramesh Kumar",
]
_KEPT = ["Welding, grinding", "Fanuc, tool offset", "Diploma, ITI", "Apprenticeship, NCVT"]


def _released_only_by_the_carve_out(label: str) -> None:
    """Precondition: the gateway leaves ``label`` byte-identical and the leading word is a 4+
    letter vocabulary token — i.e. nothing but the gate can withhold what follows it."""
    from app.profiling import signals
    from app.pseudonymize import pseudonymize

    leading = label.split(",", 1)[0]
    assert len(leading) >= 4 and leading.lower() in signals.VOCABULARY_TOKENS
    result = pseudonymize(label)
    assert (result.blocked, result.replaced_entities, result.text) == (False, 0, label)


@pytest.mark.parametrize("label", _WITHHELD)
def test_the_certifier_still_withholds_a_name_behind_a_leading_trade_word(label: str):
    from app.pseudonymize import certified_clean_skill_labels

    _released_only_by_the_carve_out(label)
    assert certified_clean_skill_labels([label]) == []


@pytest.mark.parametrize("label", _KEPT)
def test_the_certifier_keeps_a_label_that_is_vocabulary_WHOLE(label: str):
    from app.pseudonymize import certified_clean_skill_labels

    _released_only_by_the_carve_out(label)
    assert certified_clean_skill_labels([label]) == [label]


def test_is_certified_clean_is_the_one_predicate_both_gates_read():
    # The shared predicate itself, over the same probes: the certifier's first branch and the
    # polish role gate both call it, so this is the decision the two tests above and the two
    # polish tests below observe from outside.
    from app.pseudonymize import is_certified_clean

    assert [label for label in _WITHHELD if is_certified_clean(label)] == []
    assert [label for label in _KEPT if not is_certified_clean(label)] == []
    # Every other verdict is the gateway's own: masked (a name, a phone), blocked (a residual
    # digit run), and untouched.
    assert is_certified_clean("Ramesh, welding") is False
    assert is_certified_clean("welder 98765 43210") is False
    assert is_certified_clean("welder 12345678901234567") is False
    assert is_certified_clean("CNC Turner") is True


def test_a_label_the_carve_out_never_touched_is_certified_exactly_as_before():
    # The gate only tightens where the vocabulary carve-out was the reason nothing masked. A
    # label with no leading "<Word>," at all — the common shape — is untouched by it.
    from app.pseudonymize import certified_clean_skill_labels

    labels = ["VMC Operation", "CNC Turner", "TIG welding", "Stainless Steel"]
    assert certified_clean_skill_labels(labels) == labels


def _resume_lines(monkeypatch: pytest.MonkeyPatch, profile: dict) -> tuple[list[str], str]:
    """(résumé text lines, the user message the route hands the model)."""
    seen: dict = {}

    async def _capture(*_a, **kwargs):
        seen["messages"] = kwargs["messages"]
        return kwargs["mock_response"], _meta()

    monkeypatch.setattr(main_module.router, "run", _capture)
    res = client.post("/resume/generate", json={"worker_ref": "w1", "profile": profile})
    assert res.status_code == 200
    return res.json()["resume_text"].splitlines(), seen["messages"][-1]["content"]


def test_the_resume_does_not_print_a_name_behind_a_leading_trade_word(
    monkeypatch: pytest.MonkeyPatch,
):
    for label in ("Welding, Anil Kumar", "Diploma, Anil Sharma", "Apprenticeship, Ramesh Kumar"):
        _released_only_by_the_carve_out(label)
    lines, sent = _resume_lines(
        monkeypatch,
        {
            "skill_labels": ["Welding, Anil Kumar", "Welding, grinding"],
            "education": ["Diploma, Anil Sharma", "Diploma, ITI"],
            "certifications": ["Apprenticeship, Ramesh Kumar", "Apprenticeship, NCVT"],
        },
    )
    # The whole-vocabulary label of each list prints; the one carrying a name does not.
    assert "Skills: Welding, grinding" in lines
    assert "Education: Diploma, ITI" in lines
    assert "Certifications: Apprenticeship, NCVT" in lines
    for name in ("Anil", "Ramesh", "Sharma", "Kumar"):
        assert name not in "\n".join(lines)
        assert name not in sent


def _polish_role_sent(monkeypatch: pytest.MonkeyPatch, role_label: str) -> str:
    """The `<role>` the work-history polish route hands the model for ``role_label``."""
    seen: dict = {}

    async def _capture(*_a, **kwargs):
        seen["messages"] = kwargs["messages"]
        return json.dumps({"work_done": None}), _meta()

    monkeypatch.setattr(main_module.router, "run", _capture)
    body = {"worker_ref": "w1", "work_done": "lathe pe shaft banata tha", "role_label": role_label}
    res = client.post("/profiling/work-history/polish", json=body)
    assert res.status_code == 200
    user_turn = seen["messages"][-1]["content"]
    return user_turn.split("<role>", 1)[1].split("</role>", 1)[0]


@pytest.mark.parametrize(
    "role_label", ["Operator, Ramesh sir ke under", "Welder, Suresh thekedar ke under"]
)
def test_the_polish_route_withholds_a_role_label_carrying_a_name_behind_a_trade_word(
    monkeypatch: pytest.MonkeyPatch, role_label: str
):
    _released_only_by_the_carve_out(role_label)
    assert _polish_role_sent(monkeypatch, role_label) == "worker"


def test_the_polish_route_passes_a_role_label_that_is_vocabulary_whole(
    monkeypatch: pytest.MonkeyPatch,
):
    _released_only_by_the_carve_out("Welding, grinding")
    assert _polish_role_sent(monkeypatch, "Welding, grinding") == "Welding, grinding"


# --- review round 2: every script, and a gate that cannot fail open -------------------------
# The whole-label test used to tokenise with [a-z0-9]+, so a NON-LATIN name was invisible to it:
# "Welding, रमेश कुमार" read as ["welding"] and passed as all-vocabulary. Every script a
# Hindi-first product's keyboards and ASR emit must fail the label closed.
_WITHHELD_ANY_SCRIPT = [
    "Welding, रमेश कुमार",  # Devanagari
    "Diploma, अनिल शर्मा",
    "Welding, ரமேஷ்",  # Tamil
    "Welding, রমেশ",  # Bengali
    "Welding, رمیش",  # Urdu
    "Welding, Ｒａｍｅｓｈ",  # fullwidth Latin
    "Welding, 𝐑𝐚𝐦𝐞𝐬𝐡",  # mathematical bold
    "Welding, grinding\nरमेश",
    "Operator, रमेश सर के अंडर",
    # Not word characters at all, so no tokeniser sees them (review round 3): the label must be
    # printable ASCII end to end.
    "Welding, Ⓡⓐⓜⓔⓢⓗ",  # circled
    "Welding, 🅁🄰🄼🄴🅂🄷",  # squared
    "Welding, 🇷🇦🇲🇪🇸🇭",  # regional indicators
    "Welding, ⠗⠁⠍⠑⠎⠓",  # Braille
    "Welding, grinding\U000e0052\U000e0061\U000e006d",  # invisible TAG characters
    "Welding, grin\u200bding",  # zero-width space
]


@pytest.mark.parametrize("label", _WITHHELD_ANY_SCRIPT)
def test_the_gates_withhold_a_name_in_ANY_script_behind_a_leading_trade_word(label: str):
    from app.pseudonymize import certified_clean_skill_labels, is_certified_clean

    _released_only_by_the_carve_out(label)
    assert is_certified_clean(label) is False
    assert certified_clean_skill_labels([label]) == []


def test_the_employer_rescue_also_sees_every_script():
    # The same tokeniser backs the FIX-5 EMPLOYER rescue, which had the same blind spot on main:
    # an ASCII vocabulary label followed by a non-Latin name was rescued whole.
    from app.pseudonymize import certified_clean_skill_labels

    assert certified_clean_skill_labels(["Stainless Steel, रमेश कुमार"]) == []
    assert certified_clean_skill_labels(["Stainless Steel"]) == ["Stainless Steel"]


def test_the_polish_route_withholds_a_non_latin_name_behind_a_trade_word(
    monkeypatch: pytest.MonkeyPatch,
):
    label = "Operator, रमेश सर के अंडर"
    _released_only_by_the_carve_out(label)
    assert _polish_role_sent(monkeypatch, label) == "worker"


def test_the_gate_withholds_when_the_vocabulary_fails_AFTER_the_gateway_released_the_word(
    monkeypatch: pytest.MonkeyPatch,
):
    """FAIL CLOSED, not open. The gateway's lookup succeeds (the leading word is released) and the
    gate's own lookup then raises: the gate must withhold. It used to ask the vocabulary a second
    time whether the word had been released, read the failure as "no", and pass the label raw."""
    from app.profiling import signals
    from app.pseudonymize import certified_clean_skill_labels, is_certified_clean, pseudonymize

    real = signals.is_curated_vocabulary_label
    calls = {"n": 0}

    def truthful_once_then_broken(label: str) -> bool:
        calls["n"] += 1
        if calls["n"] == 1:
            return real(label)
        raise RuntimeError("vocabulary unavailable")

    for label in ("Welding, Anil Kumar", "Operator, Ramesh sir ke under"):
        calls["n"] = 0
        monkeypatch.setattr(signals, "is_curated_vocabulary_label", truthful_once_then_broken)
        assert pseudonymize(label).text == label  # the first (gateway) lookup released the word
        assert is_certified_clean(label) is False
        calls["n"] = 0
        assert certified_clean_skill_labels([label]) == []


def test_gate_6_of_profile_parse_rejects_a_name_behind_a_leading_trade_word():
    """/profile/parse's persistence wall compares the certified text with the value. Through
    `certify_value` a value the gateway leaves untouched only because of the carve-out is
    reported ALTERED (rejected) unless the whole value is vocabulary."""
    from app.profiling.parse_gates import check_pii
    from app.routers.profile import _certify

    for value in (
        ["Welding, Ramesh Kumar"],
        ["Welding, रमेश कुमार"],
        ["Operator, Ramesh sir ke under"],
    ):
        assert check_pii(value, _certify) == "pii_altered"
    assert check_pii(["Welding, grinding"], _certify) is None
    assert check_pii(["CNC Turner", "VMC Operation"], _certify) is None
    # The gateway's own verdicts are unchanged.
    assert check_pii(["Ramesh, welding"], _certify) == "pii_altered"
    assert check_pii(["welder 12345678901234567"], _certify) == "pii_blocked"


def test_certify_value_hands_back_the_gateway_text_everywhere_else():
    from app.pseudonymize import certify_value, pseudonymize

    for text in ("Welding, grinding", "CNC Turner", "Ramesh, welding", "call 98765 43210"):
        result = pseudonymize(text)
        assert certify_value(text) == (result.blocked, result.text)
    blocked, certified = certify_value("Welding, Ramesh Kumar")
    assert blocked is False and certified != "Welding, Ramesh Kumar"


def test_a_city_or_greeting_led_label_of_closed_vocabulary_is_still_certified():
    # A city-led label whose rest is closed vocabulary passes (#1730 tightens only what follows a
    # released word), and a stoplisted greeting is not a carve-out: certified exactly as on main.
    from app.pseudonymize import certified_clean_skill_labels

    labels = ["Pune, welding", "Hello, welding"]
    assert certified_clean_skill_labels(labels) == labels


def test_a_stoplisted_greeting_opener_is_certified_exactly_as_on_main():
    # STATED RESIDUAL, pinned so it is never changed silently: the stoplist predates both
    # carve-outs, and demanding a vocabulary rest after "Yes," would reject real parse values.
    from app.pseudonymize import is_certified_clean

    assert is_certified_clean("Yes, will relocate") is True  # a rest that is not vocabulary


# --- #1730: a leading CITY does not vouch for the rest of a label either ----------------------
# The 2026-07-31 ruling stops the gateway masking a leading city, exactly as #1728 did for a trade
# word — and on main a "clean or withhold" gate then passed "Pune, Ramesh Kumar" whole, where
# before the ruling the incidental [PERSON_1] withheld it.
_CITY_LED_WITHHELD = [
    "Pune, Ramesh Kumar",
    "Faridabad, Anil Sharma",
    "Bombay, Ramesh",  # an alias releases the word too
    "Pune, Ramesh sir ke under",
    "Mumbai, रमेश कुमार",
    "Mumbai, Pune रमेश",  # a city name does not launder a non-Latin name beside it
    "Pune, Mumbai Ⓡⓐⓜⓔⓢⓗ",  # nor a name in enclosed letters
    "Pune, Welding Ramesh",  # vocabulary does not launder a name beside it
    "Pune, Chakan",  # a locality in no closed list — the stated cost
    "Pune, Maharashtra Ramesh",  # a state does not launder a name beside it
    "Pune, ya Ramesh",  # nor a connecting word
    "Pune, mh Ramesh",  # a lowercase "mh" is not an abbreviation (they are case-sensitive)
]
_CITY_LED_KEPT = [
    "Pune, welding",
    "Pune, Mumbai",
    "Pune, Navi Mumbai",
    "Pune, CNC operator",
    "Welding, Pune",
    "Pune, welding, Mumbai",
    # PR #1734 security review: a state or the country after a city is coarser geography, and a
    # location list is written with a few connecting words — none of them is a name.
    "Pune, Maharashtra",
    "Faridabad, Haryana",
    "Lucknow, UP",  # an UPPERCASE listed abbreviation
    "Pune, India",
    "Pune, anywhere",
    "Pune, ya Mumbai",
    "Pune, or Mumbai",
    "Pune, and Mumbai",
    "Pune, Mumbai etc",
    "Pune, nearby",
    # An empty or punctuation-only rest holds nothing to withhold.
    "Pune,",
    "Welding,",
]


def _city_released(label: str) -> None:
    """Precondition: the gateway leaves ``label`` untouched and its leading word is a gazetteer
    city — so only the gate can withhold what follows."""
    from app.pseudonymize import CITY_ALIASES, KNOWN_CITIES, pseudonymize

    leading = label.split(",", 1)[0].lower()
    assert leading in KNOWN_CITIES or leading in CITY_ALIASES or leading == "welding"
    result = pseudonymize(label)
    assert (result.blocked, result.replaced_entities, result.text) == (False, 0, label)


@pytest.mark.parametrize("label", _CITY_LED_WITHHELD)
def test_the_gates_withhold_a_name_behind_a_leading_city(label: str):
    from app.pseudonymize import certified_clean_skill_labels, is_certified_clean

    _city_released(label)
    assert is_certified_clean(label) is False
    assert certified_clean_skill_labels([label]) == []


@pytest.mark.parametrize("label", _CITY_LED_KEPT)
def test_a_city_led_label_of_closed_vocabulary_passes(label: str):
    from app.pseudonymize import certified_clean_skill_labels, is_certified_clean

    _city_released(label)
    assert is_certified_clean(label) is True
    assert certified_clean_skill_labels([label]) == [label]


def test_the_polish_route_withholds_a_name_behind_a_leading_city(monkeypatch: pytest.MonkeyPatch):
    _city_released("Pune, Ramesh sir ke under")
    assert _polish_role_sent(monkeypatch, "Pune, Ramesh sir ke under") == "worker"
    assert _polish_role_sent(monkeypatch, "Pune, CNC operator") == "Pune, CNC operator"


def test_the_resume_does_not_print_a_name_behind_a_leading_city(monkeypatch: pytest.MonkeyPatch):
    lines, sent = _resume_lines(
        monkeypatch, {"skill_labels": ["Pune, Ramesh Kumar", "Pune, welding"]}
    )
    assert "Skills: Pune, welding" in lines
    assert "Ramesh" not in "\n".join(lines)
    assert "Ramesh" not in sent


def test_gate_6_of_profile_parse_rejects_a_name_behind_a_leading_city():
    from app.profiling.parse_gates import check_pii
    from app.routers.profile import _certify

    assert check_pii(["Pune, Ramesh Kumar"], _certify) == "pii_altered"
    assert check_pii(["Pune, Mumbai"], _certify) is None
    assert check_pii("Pune", _certify) is None
    # A real preferred_locations / current_city value is not rejected (review finding 1 and 2).
    assert check_pii(["Pune, anywhere", "Faridabad, Haryana"], _certify) is None
    assert check_pii("Pune, Maharashtra", _certify) is None


def test_the_city_rest_check_fails_closed_when_the_vocabulary_cannot_be_consulted(
    monkeypatch: pytest.MonkeyPatch,
):
    from app.profiling import signals
    from app.pseudonymize import is_certified_clean

    def broken(_label: str) -> bool:
        raise RuntimeError("vocabulary unavailable")

    monkeypatch.setattr(signals, "is_curated_vocabulary_label", broken)
    assert is_certified_clean("Pune, welding") is False  # needs the vocabulary: withheld
    assert is_certified_clean("Pune, Mumbai") is True  # cities only: no vocabulary call
    assert is_certified_clean("Pune, Maharashtra") is True  # a state: no vocabulary call


def test_the_state_strip_fails_closed_when_it_cannot_be_consulted(monkeypatch: pytest.MonkeyPatch):
    from app.profiling import signals
    from app.pseudonymize import is_certified_clean

    def broken(_text: str) -> str:
        raise RuntimeError("state tables unavailable")

    monkeypatch.setattr(signals, "without_region_or_state_names", broken)
    assert is_certified_clean("Pune, Maharashtra") is False  # nothing stripped: withheld
    assert is_certified_clean("Pune, Mumbai") is True
