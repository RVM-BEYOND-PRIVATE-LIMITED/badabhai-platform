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
        # INTERVIEW-1: the bounded RE-ask wording is worker-facing too.
        if topic.retry_question is not None:
            out[f"retry_question:{topic.id}"] = topic.retry_question
    out["ack"] = interview_engine._ACK
    out["wrap_up"] = interview_engine._WRAP_UP
    for i, f in enumerate(interview_engine.suggested_followups("cnc_vmc")):
        out[f"followup:{i}"] = f
    for field, q in _CLARIFY.items():
        out[f"clarify:{field}"] = q
    # The CLI's own worker-facing copy. CLI-1: the CLI no longer has a model-driven
    # path of its own — it drives THIS engine. Its only remaining own-words are the
    # intro banner: the "type anything to begin" kickoff nudge is GONE (the opener is
    # now interview_engine.first_question), so every question it shows — the opening
    # one included — comes from the question bank above.
    out["cli_intro"] = onboarding_chat._INTRO
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


def test_every_retry_question_is_one_ask_under_20_words_and_actually_different():
    # INTERVIEW-1: the re-ask must obey B-5 (exactly one "?") and the 20-word cap,
    # and must NOT be the same string — re-serving verbatim reads as broken.
    for topic in topics_for("cnc_vmc"):
        rq = topic.retry_question
        if rq is None:
            continue
        assert rq.count("?") == 1, f"{topic.id} retry bundles asks: {rq!r}"
        assert len(rq.split()) <= 20, f"{topic.id} retry is {len(rq.split())} words: {rq!r}"
        assert rq != topic.question, f"{topic.id} retry is a verbatim re-serve"


def test_every_re_askable_essential_topic_has_a_retry_question():
    # Only ESSENTIAL topics are ever re-asked, and each must have distinct wording.
    for topic_id in interview_engine.ESSENTIAL_TOPICS:
        topic = next(t for t in topics_for("cnc_vmc") if t.id == topic_id)
        assert topic.retry_question is not None, topic_id


# --- B-5: ONE question per turn ---------------------------------------------
# docs/registers/context-drift-2026-07-16.md row B-5 (owner ruling 2026-07-17):
# 4 bank questions bundled two asks, and the register notes the existing persona
# test "counts WORDS, not questions, so it passes". These close that gap: they
# count ASKS. Bundled asks are now sequential topics — a longer flow is expected
# and correct per the locked decision.


def _ask_count(text: str) -> int:
    """Number of asks in a served turn = number of '?' terminators. A question may
    LIST alternatives ("Fanuc, Siemens ya Haas?") — that is ONE ask, one '?'."""
    return text.count("?")


def test_every_bank_question_is_exactly_one_ask():
    for topic in topics_for("cnc_vmc"):
        n = _ask_count(topic.question)
        assert n == 1, f"{topic.id} bundles {n} asks: {topic.question!r}"


def test_no_bank_question_conflates_current_and_preferred_location():
    # B-4's half of the same ruling, asserted on the question layer: the two
    # location topics exist and neither asks both.
    ids = {t.id for t in topics_for("cnc_vmc")}
    assert {"current_location", "preferred_locations"} <= ids
    assert "location" not in ids  # the conflated topic is gone


def test_every_served_turn_asks_exactly_one_question():
    # The turn the WORKER actually receives (vocative/ack + question) must carry
    # exactly one ask — this is what the register's word-count test missed.
    _tid, opening = interview_engine.first_question("cnc_vmc")
    assert _ask_count(opening) == 1, opening

    state = None
    seen = 0
    # Drive the full interview with a non-answer so every topic is served in turn.
    for _ in range(len(topics_for("cnc_vmc")) + 1):
        reply, asked_id, state, _ready = interview_engine.next_turn(
            state, "theek hai ji", "cnc_vmc"
        )
        if asked_id is None:  # wrap-up: a statement, no ask
            assert _ask_count(reply) == 0, reply
            break
        assert _ask_count(reply) == 1, f"turn asked {_ask_count(reply)}: {reply!r}"
        seen += 1
    assert seen >= 4  # the essential topics were each served on their own turn


def test_clarify_reserve_turn_also_carries_exactly_one_ask():
    # The COST-4 clarify path re-serves the last question verbatim — still one ask.
    from app.contracts import ConversationState

    for topic in topics_for("cnc_vmc"):
        st = ConversationState(asked_question_ids=[topic.id], turn_count=1)
        out = interview_engine.clarify_turn(st, "matlab kya?", "cnc_vmc")
        assert out is not None, topic.id
        assert _ask_count(out[0]) == 1, f"{topic.id} re-serve: {out[0]!r}"


def test_followups_and_clarifications_are_one_ask_each():
    for f in interview_engine.suggested_followups("cnc_vmc"):
        assert _ask_count(f) == 1, f
    for field, q in _CLARIFY.items():
        assert _ask_count(q) == 1, f"clarify {field}: {q!r}"


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
    # CLI-1: there is only ONE chat system prompt now. The CLI used to carry a
    # second, divergent copy for its own model-driven loop; it now calls
    # build_chat_messages, so BADA_BHAI_SYSTEM_PROMPT is the single source.
    for label, p in (("engine", prompts.BADA_BHAI_SYSTEM_PROMPT.lower()),):
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


_PLACEHOLDER = interview_engine.WORKER_NAME_PLACEHOLDER  # "{{worker_name}}"

_FULL_ANSWER = (
    "vmc operator, 4 saal, setting aur drawing reading karta hu, "
    "faridabad me hu pune chalega"
)

_UNSET = object()


def _drive_to_close(worker_name=_UNSET):
    """Run the interview to its CLOSE turn and return ``(close_message, ready)``.

    Since #424 a single essentials-answering message no longer wraps up: salary_current
    / salary_expected / availability are MUST_ASK, so the close is reached only after
    they have been RAISED. Non-answers are used deliberately — the ASK satisfies the
    gate, and this keeps the test about the VOCATIVE, not about detection.
    """
    kwargs = {} if worker_name is _UNSET else {"worker_name": worker_name}
    reply, asked, state, ready = interview_engine.next_turn(
        None, _FULL_ANSWER, "cnc_vmc", **kwargs
    )
    for _ in range(20):
        if asked is None:
            return reply, ready
        reply, asked, state, ready = interview_engine.next_turn(
            state, "theek hai ji", "cnc_vmc", **kwargs
        )
    raise AssertionError("interview never reached the close turn")


def test_default_emits_placeholder_token_at_open_and_close_never_a_real_name():
    # AI-PERSONA-2 (SG-1): the ai-service NEVER emits a real name — only the
    # {{worker_name}} TOKEN, at the OPEN (turn 1 / first_question) and CLOSE only.
    # The real name is interpolated downstream in NestJS, post-emit.
    _tid, opening = interview_engine.first_question("cnc_vmc")
    assert opening.startswith(f"{_PLACEHOLDER} ji, ")

    open_turn, asked_open, _st, ready_open = interview_engine.next_turn(None, "namaste", "cnc_vmc")
    assert ready_open is False and asked_open is not None
    assert open_turn.startswith(f"{_PLACEHOLDER} ji, ")  # turn 1 = open slot

    close, ready_close = _drive_to_close()
    assert ready_close is True
    assert close.startswith(f"{_PLACEHOLDER} ji, ")

    # A MID-interview ack turn (turn >= 2) carries NO vocative — ack only.
    _r1, _a1, st1, _rd1 = interview_engine.next_turn(None, "namaste", "cnc_vmc")  # turn 1
    mid, mid_asked, _st3, mid_ready = interview_engine.next_turn(
        st1, "cnc turner hoon", "cnc_vmc"
    )  # turn 2
    assert mid_ready is False and mid_asked is not None
    assert _PLACEHOLDER not in mid and "ji," not in mid
    assert mid.startswith("Theek hai.")


def test_worker_name_none_opts_out_of_the_vocative_cleanly():
    # Explicit opt-out: no vocative, and no stray token left behind.
    _tid, opening = interview_engine.first_question("cnc_vmc", worker_name=None)
    assert "ji," not in opening and _PLACEHOLDER not in opening

    close, ready = _drive_to_close(worker_name=None)
    assert ready is True
    assert "ji," not in close and _PLACEHOLDER not in close


def test_explicit_name_still_renders_but_no_production_caller_passes_one():
    # The param still accepts a literal name (used only by tests); production
    # callers rely on the placeholder default, so no real name is ever emitted.
    _tid, opening = interview_engine.first_question("cnc_vmc", worker_name="Nitin")
    assert opening.startswith("Nitin ji, ")


def test_profiling_chat_turn_output_is_capped_for_cost():
    route = get_route("profiling_chat_turn")
    assert route.max_output_tokens == 48
    assert route.temperature == 0.3
