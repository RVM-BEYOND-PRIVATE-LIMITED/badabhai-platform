"""Permanent persona-neutrality regression net (AI-PERSONA-1).

The profiling bot must sound like an efficient senior, not a gushing one. This
locks the WORKER-FACING output strings — the interview questions, the
acknowledgement, the wrap-up, the follow-up nudges, the extractor clarifications,
and the CLI's own copy — against every banned vocative, gush token, and tum-form,
and caps each question at 20 words.

Two subtleties this test bakes in on purpose:

- The persona is NAMED "Bada Bhai", so the proper noun legitimately appears in
  worker-facing copy (the bot introduces itself). We strip the bigram "Bada Bhai"
  before scanning, so the brand name is exempt but a bare "bhai" VOCATIVE is not.
- The SYSTEM PROMPTS must literally list the banned words to forbid them, so they
  are checked differently: we assert they ENFORCE the rules (mandate "aap", cap
  the words, forbid praise/restating) rather than that they are free of the words
  they ban.
"""

from __future__ import annotations

import json
import re

from app.ai.model_config import get_route
from app.cli import onboarding_chat
from app.profiling import interview_engine, prompts
from app.profiling.profile_extractor import _CLARIFY
from app.profiling.question_bank import topics_for

# Banned in any worker-facing line (checked AFTER stripping the "Bada Bhai" brand).
_BANNED_VOCATIVE = ("bhai", "bhaiya", "beta", "behen", "yaar")
_BANNED_INFORMAL = ("tu", "tum")  # whole word only
_BANNED_GUSH = ("waah", "zabardast", "bahut acha", "bahut accha", "bilkul", "shabaash")
_BANNED_TUMFORM = ("karte ho", "karoge", "karna pasand karoge")

_BRAND = re.compile(r"bada\s+bhai", re.IGNORECASE)


def _strip_brand(text: str) -> str:
    """Remove the proper-noun 'Bada Bhai' so the brand name never trips the
    vocative scan (only a bare 'bhai' addressed AT the worker is banned)."""
    return _BRAND.sub("", text)


def _has_word(text: str, word: str) -> bool:
    return re.search(rf"\b{re.escape(word)}\b", text, re.IGNORECASE) is not None


def _worker_facing_strings() -> dict[str, str]:
    """Every string the WORKER reads as the bot's own words."""
    out: dict[str, str] = {}
    for topic in topics_for("cnc_vmc"):
        out[f"question:{topic.id}"] = topic.question
    out["ack"] = interview_engine._ACK
    out["wrap_up"] = interview_engine._WRAP_UP
    for i, f in enumerate(interview_engine.suggested_followups("cnc_vmc")):
        out[f"followup:{i}"] = f
    for field, q in _CLARIFY.items():
        out[f"clarify:{field}"] = q
    # The CLI's own worker-facing copy (a separate model-driven path).
    out["cli_intro"] = onboarding_chat._INTRO
    out["cli_mock_message"] = json.loads(onboarding_chat._CHAT_MOCK_JSON)["message"]
    return out


def test_no_worker_facing_string_contains_a_banned_token():
    for name, raw in _worker_facing_strings().items():
        scanned = _strip_brand(raw)
        low = scanned.lower()
        for w in _BANNED_VOCATIVE:
            assert not _has_word(scanned, w), f"{name}: banned vocative {w!r} in {raw!r}"
        for w in _BANNED_INFORMAL:
            assert not _has_word(scanned, w), f"{name}: informal {w!r} in {raw!r}"
        for g in _BANNED_GUSH:
            assert g not in low, f"{name}: gush {g!r} in {raw!r}"
        for tf in _BANNED_TUMFORM:
            assert tf not in low, f"{name}: tum-form {tf!r} in {raw!r}"


def test_every_interview_question_is_under_20_words():
    for topic in topics_for("cnc_vmc"):
        n = len(topic.question.split())
        assert n <= 20, f"{topic.id} question is {n} words: {topic.question!r}"


def test_clarify_and_followup_questions_are_under_20_words():
    for field, q in _CLARIFY.items():
        assert len(q.split()) <= 20, f"clarify {field}: {q!r}"
    for f in interview_engine.suggested_followups("cnc_vmc"):
        assert len(f.split()) <= 20, f"followup: {f!r}"


def test_ack_is_at_most_two_words():
    assert len(interview_engine._ACK.split()) <= 2, interview_engine._ACK


def test_system_prompts_enforce_the_neutrality_rules():
    # These are INSTRUCTIONS: they must name the banned words to forbid them, so
    # we assert they ENFORCE the persona rather than that they are token-free.
    for label, p in (
        ("engine", prompts.BADA_BHAI_SYSTEM_PROMPT.lower()),
        ("cli", onboarding_chat._CHAT_SYSTEM_PROMPT.lower()),
    ):
        assert "aap" in p, label
        assert "20 word" in p, label
        assert "gender" in p, label  # "Never assume gender"
        assert "bhai" in p, label  # names the banned vocatives in a NEVER clause
        assert "waah" in p, label  # names the banned gush tokens
        assert "praise" in p or "gush" in p, label


def test_chat_turn_instruction_is_capped_and_forbids_praise():
    msgs = prompts.build_chat_messages([], "Kitne saal ka experience hai?", "vmc operator")
    instr = msgs[-1]["content"].lower()
    assert "20 word" in instr
    assert "no praise" in instr
    assert "restate" in instr
    assert "waah" in instr


def test_name_is_rendered_only_at_open_and_close_and_inert_by_default():
    # Name given -> "{name} ji, " prefixes the OPENING and the CLOSE only.
    _tid, opening = interview_engine.first_question("cnc_vmc", worker_name="Nitin")
    assert opening.startswith("Nitin ji, ")

    full = (
        "vmc operator, 4 saal, setting aur drawing reading karta hu, "
        "faridabad me hu pune chalega"
    )
    close_named, asked, _st, ready = interview_engine.next_turn(
        None, full, "cnc_vmc", worker_name="Nitin"
    )
    assert ready is True and asked is None
    assert close_named.startswith("Nitin ji, ")

    # Default (no name) — TODAY'S production caller (main.py) — renders no vocative
    # anywhere. This is the G1 guarantee: no real name is ever composed into the
    # reply, so none can reach an LLM, an event, or a log.
    _tid2, opening_anon = interview_engine.first_question("cnc_vmc")
    close_anon, _a, _s, _r = interview_engine.next_turn(None, full, "cnc_vmc")
    assert "ji," not in opening_anon
    assert "ji," not in close_anon

    # A mid-interview ack turn NEVER carries the name, even when one is passed.
    mid, mid_asked, _s3, mid_ready = interview_engine.next_turn(
        None, "vmc chalata hu", "cnc_vmc", worker_name="Nitin"
    )
    assert mid_ready is False and mid_asked is not None
    assert "Nitin" not in mid
    assert mid.startswith("Theek hai.")


def test_profiling_chat_turn_output_is_capped_for_cost():
    route = get_route("profiling_chat_turn")
    assert route.max_output_tokens == 48
    assert route.temperature == 0.3
