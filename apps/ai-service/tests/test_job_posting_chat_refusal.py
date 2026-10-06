"""#1938: the job-posting interview's refusal — "nothing (more) to give here".

`answers.is_refusal` decides when a reply records NOTHING: a non-essential topic closes empty, and
a value the API's re-ask offered to keep (#1911 `KEEP_HINT`, #1921 `ADD_HINT`) stays as it was.
It used to be a short list of single words, so "no more", "no other", "that's it", "bas" and a
leading "no," / "nope," / "bas," / "ok," before a refusal were RECORDED: chips on the list topics,
the description on the keep re-ask, even the job title. So was a refusal whose clauses a phone
keyboard broke with a period ("No. Keep it."): it OVERWROTE the kept description (#1911).

It governs every topic that does not require a value, so it is widened with care and pinned both
ways here. Measured on 2026-10-03 over every string in main's tree at 333bf392 (211,581 distinct
strings: every tracked .py, .ts/.tsx/.js/.dart, .json/.jsonl, .csv/.yaml/.md file, the question
bank and the city gazetteer): 32 matched before, 106 after, 0 stopped matching. Each of the 74 new
matches is a refusal ("aur kuch nahi", "bas itna hi", the packs' "Koi nahi" / "Nahi hai", "No
change", and the worker skills gate's own `done` phrasings "ok bas", "Ok, that's all.", "bas
bas"), a code token that answers no bank question ("keep", "none"), a docstring line ("nothing;"),
or the lexicon fixture "ok na" (a bare tag, `off_topic` there: closing an optional topic empty
records nothing a payer said). No question-bank option and no job-posting chat answer fixture is
among them; the only job-posting strings are the two `job-posting-chat.screen.ts` comments that
described this gap ("no more", "that's it"), reworded with this change.

The re-ask paths (keep a description or a title, keep a list) are pinned against the engine in
`test_job_posting_chat_reask_contract.py`.
"""

from __future__ import annotations

import re
import time

import pytest
from fastapi.testclient import TestClient

from app.contracts import JobPostingChatState
from app.job_posting_chat import answers, question_bank
from app.main import app
from app.pseudonymize import DEFAULT_MAX_LENGTH, pseudonymize

client = TestClient(app)

_OPTIONAL = [t for t in question_bank.topic_ids() if t not in answers._VALUE_REQUIRED]
_ESSENTIAL = sorted(answers._VALUE_REQUIRED)


def test_the_topic_split_is_the_real_one_not_an_empty_one():
    assert set(_OPTIONAL) >= {"benefits", "requirements", "skills", "description", "pay_range"}
    assert _ESSENTIAL == ["city", "location_label", "role_title", "vacancy"]


# --- 1. What is now a refusal --------------------------------------------------------------------

# Each of these was recorded before #1938 (on the list topics as a chip). The first block is the
# issue's own list.
_NOW_REFUSALS = [
    "no more",
    "nothing more",
    "no other",
    "that's it",
    "bas",
    "no, nothing else",
    "nope, that's all",
    "no, keep it",
    # The rest of the same families.
    "no others",
    "nothing further",
    "nothing to add",
    "nothing else to add",
    "no thank you",
    "no change",
    "no changes",
    "thats it",
    "that is it",
    "that is all",
    "nah",
    "nahin",
    "nahi hai",
    "kuch nahin",
    "kuch nahi hai",
    "aur kuch nahi",
    "kuch aur nahi",
    "aur nahi",
    "koi nahi",
    "aur koi nahi",
    "bas itna",
    "bas itna hi",
    "bas yahi",
    "itna hi",
    "keep",
    "keep it",
    "keep that",
    "keep the earlier one",
    "keep earlier one",
    "keep the old one",
    "keep the previous one",
    "keep the same",
    "keep same",
    "keep as is",
    "keep it as is",
    "no no",
    "nahi, bas",
    "no, none",
    "nope nothing",
    "that's all, thanks",
    "no, that's it, thank you",
    # A different leading word: "bas," / "ok," / "okay," (#1938 review).
    "Bas, that's it",
    "Okay, keep it",
    "ok that's it",
    "Ok, no more",
    "okay nothing else",
    "ok bas",
    "bas bas",
    # A phone keyboard's double space types the period between the clauses.
    "No. Keep it.",
]


@pytest.mark.parametrize("reply", _NOW_REFUSALS)
def test_a_nothing_more_reply_closes_every_optional_topic_empty(reply: str):
    for topic in _OPTIONAL:
        assert answers.detect_answers(reply, topic) == {topic: None}, topic


@pytest.mark.parametrize("reply", _NOW_REFUSALS)
def test_a_nothing_more_reply_never_closes_an_essential(reply: str):
    """An essential answered "no" stays OPEN, so the bounded re-ask fires (see `_VALUE_REQUIRED`).
    Before #1938 "no, keep it" was recorded as the job title."""
    for topic in _ESSENTIAL:
        assert answers.detect_answers(reply, topic) == {}, topic


@pytest.mark.parametrize(
    "reply",
    [
        "No more.",
        "NOTHING MORE!",
        "no  more",
        " \tthat's it\n",
        "that’s it",  # a phone keyboard's apostrophe
        "That’s all.",
        "‘bas’",
        '"no"',  # the hint's word, quotes and all
        "no , keep it",
        "no,keep it",
        "No, thanks",
        "Bas.",
        "Bas",  # a phone keyboard capitalises the first letter
        # A clause break is the comma it stands for, and a run of them is one.
        "No. Keep it.",
        "No; keep it",
        "No... that's it",
        "No… keep it",  # a phone keyboard's ellipsis
        "No! Keep it!",
        "no,, keep it",
        "That's all. Thanks.",
    ],
)
def test_spacing_case_quotes_and_end_punctuation_do_not_matter(reply: str):
    assert answers.is_refusal(reply)
    assert answers.detect_answers(reply, "benefits") == {"benefits": None}


# --- 2. What is still an answer ------------------------------------------------------------------


# Real answers that START like a refusal. The refusal is the WHOLE message, so each is parsed as
# the answer it is; the value pinned is what the topic's parser records, exactly as before #1938.
@pytest.mark.parametrize(
    ("text", "topic", "recorded"),
    [
        ("no other benefits than PF", "benefits", ["no other benefits than PF"]),
        ("nothing more than 10th pass", "requirements", ["nothing more than 10th pass"]),
        ("bas PF", "benefits", ["bas PF"]),  # "just PF"
        ("bus", "benefits", ["bus"]),
        ("Bus facility", "benefits", ["Bus facility"]),
        ("Basic welding", "skills", ["Basic welding"]),
        ("baseline", "skills", ["baseline"]),
        ("Bass", "skills", ["Bass"]),
        # In capitals "BAS" is a building automation system, a skill an HVAC employer lists.
        ("BAS", "skills", ["BAS"]),
        ("BAS, BMS", "skills", ["BAS", "BMS"]),
        ("keep the shop clean", "requirements", ["keep the shop clean"]),
        ("Keep records of output", "description", "Keep records of output"),
        ("no more overtime, 8 hour shift", "description", "no more overtime, 8 hour shift"),
        (
            "that's it for the shop floor, we make gears",
            "description",
            "that's it for the shop floor, we make gears",
        ),
        ("no experience needed", "experience", {"min": 0, "max": None}),
        ("nahi, night shift", "shift", "night"),
        # A clause break is read as a comma by the refusal check only; the parsers see the text.
        ("No. Only PF.", "benefits", ["No. Only PF"]),
        ("Ok. Day shift.", "shift", "day"),
        ("Okay keep the shop clean", "requirements", ["Okay keep the shop clean"]),
        ("2.5 lakh", "pay_range", {"pay_min": 250000, "pay_max": None}),
    ],
)
def test_a_real_answer_that_starts_like_a_refusal_is_recorded(
    text: str, topic: str, recorded: object
):
    assert not answers.is_refusal(text)
    assert answers.detect_answers(text, topic)[topic] == recorded


@pytest.mark.parametrize(
    ("text", "topic"),
    [
        # A ceiling, not a refusal. What the parser makes of it is its own business: the point
        # is that the topic is NOT closed empty.
        ("no more than 5 years", "experience"),
        ("no more than 2 years experience", "experience"),
        ("no more than 20000", "pay_range"),
        ("none, freshers ok", "experience"),
        ("no, only PF", "benefits"),
        ("no sir, immediately", "needed_by"),
        ("Bas, PF only", "benefits"),
        ("Ok, PF and ESI", "benefits"),
        ("ok, no more than 2 years", "experience"),
    ],
)
def test_a_ceiling_or_a_leading_no_before_an_answer_is_never_a_refusal(text: str, topic: str):
    assert not answers.is_refusal(text)
    assert answers.detect_answers(text, topic) != {topic: None}


@pytest.mark.parametrize("text", ["ok", "Okay.", "OK", "ok!", "okay okay"])
def test_a_bare_ok_agrees_it_does_not_refuse(text: str):
    """An "ok" is only ever a LEADING word: alone it agrees with the question, never "nothing"."""
    assert not answers.is_refusal(text)


@pytest.mark.parametrize("text", ["no more?", "that's it?", "nothing else?", "ok, that's it?"])
def test_a_question_back_is_never_a_refusal(text: str):
    """The end punctuation is stripped, but never a "?": "no more?" asks, it does not answer."""
    assert not answers.is_refusal(text)
    assert answers.detect_answers(text, "benefits") != {"benefits": None}


def test_no_bank_option_is_a_refusal():
    for topic in question_bank.topics_for():
        for option in topic.options:
            assert not answers.is_refusal(option), option


# --- 3. The masked "Nope," -----------------------------------------------------------------------


def test_the_gateway_masks_the_nope_of_a_refusal_as_a_leading_name():
    """Why the refusal reads the payer's own words: the engine records the MASKED text when the
    gateway masked identity, and it masks a capitalised "Nope," / "Nah," as a name."""
    result = pseudonymize("Nope, that's all")
    draft = answers.safe_draft_text("Nope, that's all", result.text, result.placeholder_tokens)
    assert draft == "[PERSON_1], that's all"
    assert not answers.is_refusal(draft)


def test_the_refusal_reads_the_raw_message_when_the_draft_text_is_masked():
    masked = "[PERSON_1], that's all"
    assert answers.detect_answers(masked, "benefits") == {"benefits": ["[PERSON_1]", "that's all"]}
    found = answers.detect_answers(masked, "benefits", raw_message="Nope, that's all")
    assert found == {"benefits": None}


def test_the_raw_message_never_reaches_a_recorded_value():
    """Only the refusal check reads ``raw_message``. Every value is still parsed from the masked
    text, so a name the gateway masked can never reach the draft through it."""
    found = answers.detect_answers("[PERSON_1], PF", "benefits", raw_message="Ramesh, PF")
    assert found == {"benefits": ["[PERSON_1]", "PF"]}
    found = answers.detect_answers(
        "[PERSON_1], Chakan", "description", raw_message="Ramesh, Chakan"
    )
    assert found == {"description": "[PERSON_1], Chakan"}


def test_the_gateway_masks_the_bas_of_a_refusal_as_a_leading_name():
    """The same for "Bas,": a leading word other than "no" (#1938 review)."""
    result = pseudonymize("Bas, that's it")
    draft = answers.safe_draft_text("Bas, that's it", result.text, result.placeholder_tokens)
    assert draft == "[PERSON_1], that's it"
    assert answers.detect_answers(draft, "benefits", raw_message="Bas, that's it") == {
        "benefits": None
    }


@pytest.mark.parametrize("message", ["Nope, that's all", "Bas, that's it"])
def test_the_route_closes_a_list_on_a_masked_refusal_and_drafts_no_token(message: str):
    state = JobPostingChatState(
        answered_topics=["role_title", "location_label", "city", "vacancy"],
        asked_question_ids=["location_label", "vacancy", "skills", "benefits"],
        ask_counts={"location_label": 1, "vacancy": 1, "skills": 1, "benefits": 1},
        collected={"role_title": "CNC Operator"},
        turn_count=5,
    )
    res = client.post(
        "/job-posting-chat/respond",
        json={
            "session_id": "s1",
            "message_text": message,
            "conversation_state": state.model_dump(),
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["draft"]["benefits"] == []
    assert "benefits" in body["updated_state"]["answered_topics"]
    assert "PERSON" not in str(body["draft"])


# --- 4. Linear by construction -------------------------------------------------------------------

# A generous ceiling, the `test_pseudonymize_title_employer_bound` precedent: a loaded machine has
# measured a bounded input at hundreds of ms there. Measured here on 2026-10-03 (worst of 5 runs):
# `is_refusal` at most 3.0 ms on these inputs and `detect_answers` at most 35 ms, both ~10x per 10x
# input up to 2M chars. The structural test is the real guard; this is the backstop.
_REDOS_BUDGET_MS = 750


def test_the_refusal_grammar_quantifies_no_run():
    """Nothing in the pattern repeats: no `*`, no `+`, no `{m,n}`. Its input has one space between
    words and every comma spaced (`_refusal_form`), so every space in it is ONE literal space —
    never the adjacent whitespace quantifiers of R53."""
    assert not re.search(r"[*+{]", answers._REFUSAL_RE.pattern)
    assert answers._refusal_form("  no ,keep\t\n it  ") == "no , keep it"
    # Every clause break, and every run of them, is ONE spaced comma.
    assert answers._refusal_form("No. Keep it.") == "No , Keep it"
    assert answers._refusal_form("no .,; …! keep  it!!") == "no , keep it"


@pytest.mark.parametrize(
    "text",
    [
        # Each ends in a word that is not a refusal, so the whole run is read and then refused.
        "no" + " " * 19_000 + "x",
        "no" + "," * 19_000 + "x",
        "no" + " ," * 9_000 + " x",
        "no " * 6_000 + "x",
        "nope, " * 3_000 + "x",
        "keep " * 3_600 + "x",
        '"' * 9_000 + "no x" + '"' * 9_000,
        "no" + "." * 19_000 + "x",
        "no" + ". " * 9_000 + "x",
        "no" + "…" * 19_000 + "x",
        "no" + " \t.,;!…\n" * 2_000 + "x",
        "bas, " * 3_600 + "x",
        "ok " * 6_000 + "x",
    ],
    ids=[
        "spaces",
        "commas",
        "comma-space",
        "no-no",
        "nope-comma",
        "keep",
        "quotes",
        "dots",
        "dot-space",
        "ellipses",
        "mixed-breaks",
        "bas-comma",
        "ok-ok",
    ],
)
def test_the_refusal_check_is_not_quadratic(text: str):
    assert len(text) <= DEFAULT_MAX_LENGTH  # the gateway would block a longer turn
    start = time.perf_counter()
    refused = answers.is_refusal(text)
    found = answers.detect_answers(text, "description", raw_message=text)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < _REDOS_BUDGET_MS, f"{elapsed_ms:.0f}ms on {len(text)} chars"
    assert not refused
    assert found != {"description": None}
