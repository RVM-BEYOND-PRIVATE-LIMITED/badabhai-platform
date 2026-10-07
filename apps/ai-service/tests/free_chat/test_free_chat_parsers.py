"""The free-chat parsers (ADR-0051 §3.4, §8): model output is untrusted; every miss is ONE value.

The classifier's miss is ``unclear`` / 0.0 / not blocked; the reply's miss is a refusal on
``unsafe_other``; the rolling summary's miss is a null summary, which keeps the previous one. Each
mock response must parse to exactly that value, so a development environment behaves the way a
broken model would.
"""

from __future__ import annotations

import json

import pytest

from app.free_chat import classify as classify_logic
from app.free_chat import reply as reply_logic
from app.free_chat import summary as summary_logic

# ── the classifier ──────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "content",
    [
        "",  # nothing
        "I think this is about jobs.",  # prose, no object
        "[]",  # not an object
        '"career"',  # a bare string
        "null",
        '{"category": "smalltalk", "confidence": 0.9}',  # outside the closed set
        '{"category": "faltu", "confidence": 0.9}',  # the COMPANION's label, not ours
        '{"category": "Career", "confidence": 0.9}',  # case matters: closed set
        '{"category": "career", "confidence": 1.5}',  # above 1
        '{"category": "career", "confidence": -0.1}',  # below 0
        '{"category": "career", "confidence": "high"}',  # not a number
        '{"category": "career", "confidence": NaN}',  # json.loads accepts NaN; the bound must not
        '{"category": "career"}',  # missing confidence
        '{"confidence": 0.9}',  # missing category
        '{"category": "career", "confidence": 0.9',  # truncated
    ],
)
def test_classify_junk_becomes_unclear(content: str) -> None:
    parsed = classify_logic.parse_classify_output(content)
    assert parsed == classify_logic.UNCLEAR
    assert (parsed.category, parsed.confidence, parsed.blocked) == ("unclear", 0.0, False)
    assert parsed.ai_metadata is None


def test_classify_reads_a_valid_answer_and_a_fence() -> None:
    parsed = classify_logic.parse_classify_output('{"category": "distress", "confidence": 0.97}')
    assert (parsed.category, parsed.confidence) == ("distress", 0.97)
    fenced = '```json\n{"category": "jobs", "confidence": 0.8}\n```'
    assert classify_logic.parse_classify_output(fenced).category == "jobs"


def test_only_category_and_confidence_are_the_models() -> None:
    """`blocked` is the gate's fact and `ai_metadata` the router's: a model that writes either is
    ignored, and a junk value there does not cost an otherwise valid category."""
    parsed = classify_logic.parse_classify_output(
        json.dumps(
            {
                "category": "resume",
                "confidence": 0.9,
                "blocked": True,
                "ai_metadata": {"real_call": True},
                "reason": "an answer",
            }
        )
    )
    assert (parsed.category, parsed.blocked, parsed.ai_metadata) == ("resume", False, None)
    junk = classify_logic.parse_classify_output(
        '{"category": "career", "confidence": 0.7, "blocked": "yes", "ai_metadata": 5}'
    )
    assert (junk.category, junk.blocked) == ("career", False)


def test_the_classify_mock_is_the_unclear_value() -> None:
    assert classify_logic.MOCK_RESPONSE == '{"category": "unclear", "confidence": 0.0}'
    assert classify_logic.parse_classify_output(classify_logic.MOCK_RESPONSE) == (
        classify_logic.UNCLEAR
    )


# ── the reply ────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "content",
    [
        "",
        "Sorry, I can't help with that.",  # prose
        "[]",
        '{"lines": ["Line one."]}',  # no discriminant
        '{"status": "maybe", "lines": ["x"]}',  # unknown discriminant
        '{"status": "refuse"}',  # missing topic
        '{"status": "refuse", "topic": "salary_promise"}',  # the COMPANION's topic, not ours
        '{"status": "refuse", "topic": "politics"}',  # outside the closed set
        '{"status": "answer"}',  # missing lines
        '{"status": "answer", "lines": []}',  # empty lines
        '{"status": "answer", "lines": ["a", "b", "c", "d", "e"]}',  # five lines
        '{"status": "answer", "lines": [""]}',  # an empty line
        '{"status": "answer", "lines": [7]}',  # not a string
        '{"status": "answer", "lines": ["ok"], "followup_chips": ["a", "b", "c", "d"]}',
        '{"status": "answer", "lines": ["ok"], "followup_chips": "chip"}',
        '{"status": "answer", "topic": "news"}',  # a refusal body under the answer tag
        '{"status": "answer", "lines": ["ok"]',  # truncated
    ],
)
def test_reply_junk_becomes_the_unsafe_other_refusal(content: str) -> None:
    parsed = reply_logic.parse_reply_output(content)
    assert parsed == reply_logic.REFUSED_FALLBACK
    assert (parsed.status, parsed.topic) == ("refuse", "unsafe_other")


@pytest.mark.parametrize(
    "topic", ["legal_medical_financial", "news", "off_limits", "distress", "unsafe_other"]
)
def test_every_closed_refusal_topic_is_kept(topic: str) -> None:
    parsed = reply_logic.parse_reply_output(json.dumps({"status": "refuse", "topic": topic}))
    assert (parsed.status, parsed.topic) == ("refuse", topic)


def test_a_valid_answer_is_kept_verbatim_and_a_fence_is_not_a_failure() -> None:
    answer = {
        "status": "answer",
        "lines": ["Namaste, aaj ka din kaisa raha?", "Kaam par dhyan rakhiye."],
        "followup_chips": ["Safety tips", "Naya hunar"],
    }
    parsed = reply_logic.parse_reply_output("```json\n" + json.dumps(answer) + "\n```")
    assert parsed.model_dump(exclude={"ai_metadata"}) == answer
    no_chips = reply_logic.parse_reply_output('{"status": "answer", "lines": ["Theek hai."]}')
    assert no_chips.followup_chips == []


def test_a_models_ai_metadata_never_costs_a_valid_answer() -> None:
    parsed = reply_logic.parse_reply_output(
        '{"status": "answer", "lines": ["Theek hai."], "ai_metadata": "junk"}'
    )
    assert parsed.status == "answer"
    assert parsed.ai_metadata is None


def test_the_reply_parse_is_permissive_on_content() -> None:
    """Content is the API validator's job: a "!" or a banned word reaches it to be judged (and
    served as the fallback there), rather than being rejected here with a worse diagnosis."""
    parsed = reply_logic.parse_reply_output(
        '{"status": "answer", "lines": ["Bahut achha bhai, job pakka milegi!"]}'
    )
    assert parsed.status == "answer"


def test_the_reply_mock_is_the_unsafe_other_refusal() -> None:
    assert reply_logic.MOCK_RESPONSE == '{"status": "refuse", "topic": "unsafe_other"}'
    assert reply_logic.parse_reply_output(reply_logic.MOCK_RESPONSE) == (
        reply_logic.REFUSED_FALLBACK
    )


# ── the rolling summary (Release 2, §8) ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "content",
    [
        "",  # nothing
        "- welder hai\n- course poocha",  # prose notes, no object
        "[]",  # not an object
        '"- welder hai"',  # a bare string
        "null",
        "{}",  # no summary key
        '{"notes": "- welder hai"}',  # the wrong key
        '{"summary": null}',  # the model kept nothing
        '{"summary": 7}',  # not a string
        '{"summary": ["- welder hai"]}',  # a list of notes, not one string
        '{"summary": {"text": "- welder hai"}}',
        '{"summary": ""}',  # empty
        '{"summary": "  \\n\\t "}',  # whitespace only
        '{"summary": "null"}',  # a null WORD instead of JSON null
        '{"summary": " None "}',
        '{"summary": "N/A"}',
        json.dumps({"summary": "x" * 2001}),  # past the transport cap
        '{"summary": "- welder hai"',  # truncated (max_output_tokens)
    ],
)
def test_summary_junk_becomes_a_null_summary(content: str) -> None:
    parsed = summary_logic.parse_summary_output(content)
    assert parsed == summary_logic.NO_SUMMARY
    assert (parsed.summary, parsed.ai_metadata) == (None, None)


def test_a_valid_summary_is_kept_with_its_lines_and_a_fence_is_not_a_failure() -> None:
    notes = "- welder hai, 3 saal\n- course ke baare mein poocha"
    parsed = summary_logic.parse_summary_output(json.dumps({"summary": notes}))
    assert parsed.summary == notes
    fenced = "```json\n" + json.dumps({"summary": f"\n  {notes}  \n"}) + "\n```"
    # Stripped at the ends only; the inner lines are the model's.
    assert summary_logic.parse_summary_output(fenced).summary == notes


def test_an_over_long_summary_is_passed_on_for_the_api_to_reject() -> None:
    """1200 is the API's storage cap and a refusal there is the event outcome `rejected`; refusing
    it here would report it as `unavailable` and hide why."""
    parsed = summary_logic.parse_summary_output(json.dumps({"summary": "x" * 1500}))
    assert parsed.summary == "x" * 1500


def test_only_the_summary_is_the_models() -> None:
    parsed = summary_logic.parse_summary_output(
        json.dumps({"summary": "- welder hai", "ai_metadata": {"real_call": True}, "extra": 1})
    )
    assert (parsed.summary, parsed.ai_metadata) == ("- welder hai", None)


def test_the_summary_mock_is_the_null_summary() -> None:
    assert summary_logic.MOCK_RESPONSE == '{"summary": null}'
    assert summary_logic.parse_summary_output(summary_logic.MOCK_RESPONSE) == (
        summary_logic.NO_SUMMARY
    )
