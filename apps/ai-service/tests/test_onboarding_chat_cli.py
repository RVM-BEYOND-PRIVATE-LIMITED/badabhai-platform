"""Onboarding CLI tests — drive the ENGINE-driven loop with scripted stdin and a
stubbed router; NO network.

CLI-1. The CLI used to run its OWN model-driven loop that shipped nowhere: the
model picked every question, and the whole pseudonymized history was re-sent every
turn (the O(n^2) input-token growth COST-3 had already removed from the production
path). It now mirrors ``chat.service.ts -> POST /profiling/respond`` exactly:
``interview_engine.clarify_turn``/``next_turn`` choose the topic, the
``ConversationState`` is threaded forward, and ``build_chat_messages([], ...)``
keeps the turn STATELESS.

The load-bearing regressions guarded here (each would FAIL if the old behaviour
came back):
- ``test_cli_drives_the_real_interview_engine`` — the engine is actually called and
  its chosen question is what the worker sees (fails if the engine is bypassed).
- ``test_chat_turn_never_resends_history`` / ``test_input_size_is_flat_across_turns``
  — every chat call carries exactly {system, this message, this question} and no
  earlier answer (fails if the history re-send returns).
- ``test_full_run_asks_every_topic_in_bank_order_with_the_bounded_re_ask`` — all 11
  topics, in bank order; essentials twice (INTERVIEW-1's bounded re-ask, since a
  signal-free answer genuinely leaves them unanswered), everything else once.
- ``test_full_run_never_asks_any_topic_a_third_time`` — the multiplicity bound.
- ``test_clarify_reserves_the_same_question_at_most_twice`` — the other sanctioned
  repeat, bounded by ``_MAX_CONSECUTIVE_CLARIFIES``.
"""

import asyncio
import json
from collections import Counter

from app.cli import onboarding_chat
from app.config import Settings
from app.contracts import AICallMetadata
from app.profiling import interview_engine
from app.profiling.prompts import BADA_BHAI_SYSTEM_PROMPT, build_chat_messages
from app.profiling.question_bank import topic_by_id, topics_for

BANK_ORDER = [t.id for t in topics_for("cnc_vmc")]


def _expected_blind_ask_order() -> list[str]:
    """The exact ask sequence a SIGNAL-FREE worker must produce, DERIVED from the
    engine's constants + the bank (never hard-coded), so it tracks them the way the
    engine's own headroom pin does.

    Two rules produce it, both of them the engine's documented contract:

    - ``_next_topic`` serves unanswered ESSENTIAL topics first (in bank order),
      each up to ``MAX_ASKS_PER_TOPIC`` — INTERVIEW-1's bounded re-ask. With no
      extractable signal they are never marked answered, so each takes its full
      budget before the next topic is served.
    - Everything else is asked exactly ONCE, in bank order, and never re-asked.
    """
    essentials = [t for t in BANK_ORDER if t in interview_engine.ESSENTIAL_TOPICS]
    others = [t for t in BANK_ORDER if t not in interview_engine.ESSENTIAL_TOPICS]
    return [
        topic_id
        for topic_id in essentials
        for _ in range(interview_engine.MAX_ASKS_PER_TOPIC)
    ] + others


def _meta(
    task_type: str,
    *,
    real_call: bool = False,
    provider: str = "google",
    error_code: str | None = None,
) -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="test",
        task_type=task_type,
        model_name="gemini-2.5-flash" if provider == "google" else "claude-haiku-4-5",
        provider=provider,
        real_call=real_call,
        input_tokens=1,
        output_tokens=1,
        estimated_cost_inr=0.0,
        latency_ms=1,
        success=True,
        error_code=error_code,
        created_at="2026-06-13T00:00:00Z",
    )


# --- _startup_status banner: the up-front readiness diagnosis ----------------
# Explicit Settings(...) kwargs override conftest's os.environ blanks (pydantic
# precedence: init kwargs > env > .env), so these pin the exact gate state.

def test_startup_status_off_when_master_flag_false():
    banner = onboarding_chat._startup_status(Settings(ai_enable_real_calls=False))
    assert "OFF" in banner
    assert "AI_ENABLE_REAL_CALLS" in banner


def test_startup_status_off_when_no_gemini_key_warns_about_shell_override():
    # Master flag on but no key -> OFF; the banner must call out the sneaky
    # shell-env-overrides-.env failure mode that caused the silent all-mock run.
    banner = onboarding_chat._startup_status(
        Settings(ai_enable_real_calls=True, gemini_flash_api_key="")
    )
    assert "OFF" in banner
    assert "GEMINI_FLASH_API_KEY" in banner
    assert "OVERRIDES" in banner  # the shell-env-precedence warning


def test_startup_status_on_with_anthropic_fallback():
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            anthropic_api_key="a",
            ai_real_call_tasks="profiling_chat_turn,profile_extraction",
        )
    )
    assert "ON" in banner
    assert "(google)" in banner
    assert "claude-haiku-4-5 (anthropic)" in banner
    assert "WARNING" not in banner


def test_startup_status_on_without_anthropic_key_shows_no_fallback():
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            anthropic_api_key="",
            ai_real_call_tasks="",
        )
    )
    assert "ON" in banner
    assert "fallback: none" in banner


def test_startup_status_haiku_primary_gemini_fallback_labels():
    # Provider labels are DERIVED from the model ids, so a swapped config (Haiku
    # primary, Gemini fallback) is labelled correctly — not hardcoded.
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            anthropic_api_key="a",
            default_cheap_model="claude-haiku-4-5",
            default_capable_model="claude-haiku-4-5",
            default_fallback_model="gemini-2.5-flash-lite",
            ai_real_call_tasks="profiling_chat_turn,profile_extraction",
        )
    )
    assert "primary : claude-haiku-4-5 (anthropic)" in banner
    assert "fallback: gemini-2.5-flash-lite (google)" in banner


def test_startup_status_on_but_chat_not_allowlisted_warns():
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            ai_real_call_tasks="profile_extraction",  # chat NOT allowlisted
        )
    )
    assert "ON" in banner
    assert "WARNING" in banner
    assert "profiling_chat_turn" in banner


def test_startup_status_explains_templated_chat_when_rephrase_off():
    """COST-4 default: with the rephrase flag off the chat turns are templated by
    the engine. That is NOT a warning — but it must be stated, or an operator seeing
    "Real LLM calls: ON" will wrongly expect the chat itself to be model-written."""
    banner = onboarding_chat._startup_status(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            ai_real_call_tasks="",
            ai_profiling_rephrase_enabled=False,
        )
    )
    assert "AI_PROFILING_REPHRASE_ENABLED" in banner
    assert "templated by the interview engine" in banner


class _ScriptedRouter:
    """Stand-in for AIRouter mirroring its MOCK path: it returns the caller's
    ``mock_response`` verbatim (which, on the engine-driven CLI, IS the engine's
    chosen question) and records every message it was handed.

    ``extraction_content`` optionally overrides the ``profile_extraction`` reply
    (e.g. one carrying a canonical_role_id)."""

    def __init__(self, *, real_call=False, provider="google", extraction_content=None):
        self.calls: list[dict] = []
        self._real_call = real_call
        self._provider = provider
        self._extraction_content = extraction_content

    async def run(self, task_type, *, messages, mock_response, real_call_allowed=True):
        self.calls.append(
            {
                "task_type": task_type,
                "messages": messages,
                "mock_response": mock_response,
                "real_call_allowed": real_call_allowed,
            }
        )
        content = mock_response
        if task_type == "profile_extraction" and self._extraction_content is not None:
            content = self._extraction_content
        return content, _meta(task_type, real_call=self._real_call, provider=self._provider)

    def all_message_text(self) -> str:
        """Concatenate every message content ever handed to the router."""
        parts: list[str] = []
        for call in self.calls:
            for msg in call["messages"]:
                parts.append(msg.get("content", ""))
        return "\n".join(parts)

    def chat_calls(self) -> list[dict]:
        return [c for c in self.calls if c["task_type"] == "profiling_chat_turn"]

    def chat_turn_count(self) -> int:
        return len(self.chat_calls())


def _scripted_input(answers):
    it = iter(answers)

    def _input(_prompt=""):
        return next(it)

    return _input


def _run(coro):
    return asyncio.run(coro)


def _silent(*_a, **_k):
    return None


def _settings():
    """Mock-mode settings, rephrase off (the shipped defaults)."""
    return Settings(ai_enable_real_calls=False, ai_profiling_rephrase_enabled=False)


def _drive(router, answers, print_fn=_silent):
    return _run(
        onboarding_chat._run_chat(
            router,
            input_fn=_scripted_input(answers),
            print_fn=print_fn,
            settings=_settings(),
        )
    )


def _adaptive_drive(router, answer_for, *, name="Suresh", max_turns=40):
    """Drive the CLI answering whatever the ENGINE just asked.

    ``answer_for(topic_id)`` supplies the reply. Returns
    ``(resume, calls, asked_order, printed)`` where ``asked_order`` is the sequence
    of topic ids the engine actually chose (read off the printed per-turn header,
    i.e. the same thing an operator sees)."""
    asked_order: list[str] = []
    printed: list[str] = []
    last: dict[str, str | None] = {"topic": None}
    pending = {"name": True, "kickoff": True}

    def _print(*a, **_k):
        text = " ".join(str(x) for x in a)
        printed.append(text)
        if "topic_id=" in text:
            topic = text.split("topic_id=")[1].split()[0]
            last["topic"] = None if topic == "-" else topic
            if last["topic"]:
                asked_order.append(last["topic"])

    calls_made = {"n": 0}

    def _input(_prompt=""):
        calls_made["n"] += 1
        if calls_made["n"] > max_turns:
            return "done"
        if pending["name"]:
            pending["name"] = False
            return name
        if pending["kickoff"]:
            pending["kickoff"] = False
            return "shuru"
        return answer_for(last["topic"])

    resume, calls = _run(
        onboarding_chat._run_chat(
            router, input_fn=_input, print_fn=_print, settings=_settings()
        )
    )
    return resume, calls, asked_order, "\n".join(printed)


# --- CLI-1: the CLI drives the REAL production engine ------------------------

def test_cli_drives_the_real_interview_engine(monkeypatch):
    """The interview must come from ``interview_engine``, not from the model.

    Fails if anyone reintroduces a model-driven loop: we spy on the real
    ``next_turn``, require it to have run, and require the line shown to the worker
    to be EXACTLY the question the engine returned."""
    seen: list[tuple[str | None, str]] = []
    real_next_turn = interview_engine.next_turn

    def _spy(state, message, role_family="cnc_vmc", *a, **k):
        out = real_next_turn(state, message, role_family, *a, **k)
        seen.append((out[1], out[0]))
        return out

    monkeypatch.setattr(onboarding_chat.interview_engine, "next_turn", _spy)

    router = _ScriptedRouter()
    answers = ["Suresh", "shuru", "vmc operator hoon", "5 saal", "Pune mein hu", "done"]
    _drive(router, answers)

    assert seen, "interview_engine.next_turn was never called — the engine is bypassed"
    # Every chat call was handed the ENGINE's question as its mock_response, and the
    # engine's question is what the router (mock path) returned to the worker.
    engine_questions = [q for _topic, q in seen]
    handed = [c["mock_response"] for c in router.chat_calls()]
    assert handed == engine_questions[: len(handed)]
    # ...and that same question is embedded in the prompt the LLM would phrase.
    for call, question in zip(router.chat_calls(), engine_questions, strict=False):
        assert question in call["messages"][-1]["content"]


def test_engine_state_is_threaded_forward_not_restarted():
    """The ConversationState must carry across turns (production persists it on the
    session). If it were dropped, every turn would re-ask topic #1."""
    router = _ScriptedRouter()
    answers = ["Suresh", "shuru", "hmm", "hmm", "hmm", "done"]
    _drive(router, answers)
    asked = [c["mock_response"] for c in router.chat_calls()]
    assert len(asked) == len(set(asked)), f"a question repeated — state was lost: {asked}"


def test_chat_turn_never_resends_history():
    """COST-3 / the CLI-1 headline bug: the chat turn is STATELESS.

    Every ``profiling_chat_turn`` call must carry EXACTLY
    {system persona, this pseudonymized message, this engine question} — three
    messages — and must contain NO text from an earlier turn. Reintroducing the
    ``for item in history: messages.append(...)`` re-send fails this test."""
    router = _ScriptedRouter()
    # Distinctive, signal-free tokens so a leak is unambiguous.
    answers = ["Suresh", "shuru", "zzqqa", "zzqqb", "zzqqc", "zzqqd", "done"]
    _drive(router, answers)

    chat_calls = router.chat_calls()
    assert len(chat_calls) >= 4

    prior_tokens: list[str] = []
    for call in chat_calls:
        contents = [m["content"] for m in call["messages"]]
        assert len(call["messages"]) == 3, (
            f"expected a 3-message stateless turn, got {len(call['messages'])} — "
            "history re-send regression"
        )
        assert contents[0] == BADA_BHAI_SYSTEM_PROMPT
        joined = "\n".join(contents)
        for token in prior_tokens:
            assert token not in joined, f"prior turn text {token!r} was re-sent"
        # Whatever this turn's user message is becomes "prior" for the next call.
        prior_tokens.append(contents[1])


def test_chat_messages_match_build_chat_messages_with_empty_history():
    """Structural parity with the production endpoint (main.profiling_respond):
    ``build_chat_messages([], engine_question, pseudonymized_message)``."""
    router = _ScriptedRouter()
    _drive(router, ["Suresh", "shuru", "vmc operator hoon", "done"])
    for call in router.chat_calls():
        user_msg = call["messages"][1]["content"]
        expected = build_chat_messages([], call["mock_response"], user_msg)
        assert call["messages"] == expected


def test_input_size_is_flat_across_turns():
    """The observed symptom of the old bug was input tokens climbing every turn
    (581 -> 757 in one real session). Answers are LONG and identical-length here, so
    a history re-send would inflate each turn by ~90 chars — far beyond the small
    variation the engine's own question lengths can explain."""
    router = _ScriptedRouter()
    long_answer = "hmm " * 22 + "theek"  # ~93 chars, carries no extractable signal
    answers = ["Suresh", "shuru"] + [long_answer] * 8 + ["done"]
    _drive(router, answers)

    sizes = [
        sum(len(m["content"]) for m in c["messages"]) for c in router.chat_calls()
    ]
    assert len(sizes) >= 6
    # Only the engine's question length varies; nothing accumulates. The longest
    # bank question is ~80 chars, so a spread of one answer-length (93) can only be
    # explained by accumulation.
    spread = max(sizes) - min(sizes)
    assert spread < len(long_answer), f"input size accumulates across turns: {sizes}"
    # ...and it must not climb monotonically, which is what a re-send looks like.
    growth = [b - a for a, b in zip(sizes, sizes[1:], strict=False)]
    assert not all(g > 0 for g in growth), f"input size grows every turn: {sizes}"


def test_full_run_asks_every_topic_in_bank_order_with_the_bounded_re_ask():
    """COVERAGE (the property this test has always owned): a worker who gives no
    extractable signal is asked EVERY topic in the bank, in bank order, then gets
    the wrap-up. Still fails if a topic is SKIPPED or served OUT OF ORDER.

    What changed with INTERVIEW-1: the four ESSENTIAL topics are now asked TWICE
    (the bounded re-ask), because signal-free answers genuinely leave them
    unanswered — previously an essential was closed the moment it was asked and the
    profile shipped incomplete in silence. Non-essentials are still asked exactly
    once. The expectation is derived from ESSENTIAL_TOPICS + MAX_ASKS_PER_TOPIC, so
    a third ask, a skip, or a reordering all fail this assertion.

    (With informative answers the engine wraps up EARLIER by design — see
    ``test_engine_wraps_up_once_essentials_are_answered``.)"""
    router = _ScriptedRouter()
    _resume, _calls, asked_order, printed = _adaptive_drive(
        router, lambda _topic: "hmm theek hai"
    )
    expected = _expected_blind_ask_order()
    assert asked_order == expected, f"{asked_order} != {expected}"
    # Coverage is explicit and order-independent too: nothing may be dropped.
    assert set(asked_order) == set(BANK_ORDER)
    assert len(BANK_ORDER) == 11  # the bank really has 11 topics
    assert "resume ban raha hai" in printed  # the wrap-up turn ran


def test_full_run_never_asks_any_topic_a_third_time():
    """The multiplicity half, asserted separately so the bound is legible: each
    ESSENTIAL topic is asked exactly MAX_ASKS_PER_TOPIC times and every other topic
    exactly once — no topic may EVER exceed the bound, whatever the detector does."""
    router = _ScriptedRouter()
    _resume, _calls, asked_order, _printed = _adaptive_drive(
        router, lambda _topic: "hmm theek hai"
    )
    counts = Counter(asked_order)
    # The PRODUCT rule, pinned as a literal on purpose: at most ONE re-ask, i.e.
    # never a third ask. The order expectation above is derived from the constant so
    # it tracks the bank, but that means RAISING the constant would silently move it
    # — this line is what stops that. Changing it is a deliberate product decision
    # (more nagging of workers the detector cannot parse) and must be re-reviewed.
    assert interview_engine.MAX_ASKS_PER_TOPIC == 2
    assert max(counts.values()) <= 2, dict(counts)
    assert max(counts.values()) <= interview_engine.MAX_ASKS_PER_TOPIC
    for topic_id in BANK_ORDER:
        expected_n = (
            interview_engine.MAX_ASKS_PER_TOPIC
            if topic_id in interview_engine.ESSENTIAL_TOPICS
            else 1
        )
        assert counts[topic_id] == expected_n, (topic_id, dict(counts))


def test_full_run_re_ask_uses_the_retry_wording_not_a_verbatim_repeat():
    """The second ask of an essential must be the narrower ``retry_question`` — a
    verbatim re-serve reads as broken. Checked on what the ROUTER was handed, i.e.
    the line the worker actually sees."""
    router = _ScriptedRouter()
    _adaptive_drive(router, lambda _topic: "hmm theek hai")
    served = [c["mock_response"] for c in router.chat_calls()]
    for topic_id in interview_engine.ESSENTIAL_TOPICS:
        topic = topic_by_id("cnc_vmc", topic_id)
        assert topic.retry_question is not None, topic_id
        assert any(topic.retry_question in line for line in served), (
            f"{topic_id} was re-asked without its retry wording"
        )


def test_engine_wraps_up_once_essentials_are_answered():
    """The ENGINE owns the stop condition: ESSENTIAL_TOPICS answered + MUST_ASK
    asked -> extraction_ready -> the loop ends. Not a model flag, not a CLI cue."""
    answer_by_topic = {
        "role": "vmc operator hoon",
        "machines": "vmc aur cnc lathe",
        "experience": "5 saal ka experience hai",
        "skills": "setting aur tool offset aata hai",
        "current_location": "abhi Pune mein hu",
        "preferred_locations": "Nashik chalega",
    }
    router = _ScriptedRouter()
    _resume, _calls, asked_order, printed = _adaptive_drive(
        router, lambda topic: answer_by_topic.get(topic, "haan")
    )
    assert set(interview_engine.ESSENTIAL_TOPICS).issubset(
        set(asked_order) | {"machines", "skills"}
    )
    assert "preferred_locations" in asked_order
    assert "resume ban raha hai" in printed
    # Stopped EARLY on purpose — it did not walk the whole bank.
    assert len(asked_order) < len(BANK_ORDER)


def test_no_question_repeats_beyond_the_sanctioned_bounded_re_ask():
    """The engine must never nag. There are now exactly TWO sanctioned repeats —
    ``clarify_turn`` re-serving a question the worker did not understand (covered
    below) and INTERVIEW-1's ONE bounded re-ask of an UNANSWERED essential. Anything
    else is a regression, so this pins the exact permitted multiplicity per topic
    rather than blanket uniqueness."""
    router = _ScriptedRouter()
    _resume, _calls, asked_order, _printed = _adaptive_drive(
        router, lambda _topic: "hmm theek hai"
    )
    for topic_id, n in Counter(asked_order).items():
        limit = (
            interview_engine.MAX_ASKS_PER_TOPIC
            if topic_id in interview_engine.ESSENTIAL_TOPICS
            else 1
        )
        assert n <= limit, f"{topic_id} asked {n}x (limit {limit}): {asked_order}"
    # A NON-essential is never repeated at all — the ask-once rule is absolute.
    non_essential = [t for t in asked_order if t not in interview_engine.ESSENTIAL_TOPICS]
    assert len(non_essential) == len(set(non_essential)), asked_order


def test_clarify_reserves_the_same_question_at_most_twice():
    """The ONLY sanctioned repeat is ``clarify_turn`` re-serving the question the
    worker did not understand — bounded by ``_MAX_CONSECUTIVE_CLARIFIES`` (2), after
    which the interview must move on rather than loop."""
    router = _ScriptedRouter()
    answers = ["Suresh", "shuru"] + ["matlab kya?"] * 5 + ["done"]
    _drive(router, answers)

    asked = [c["mock_response"] for c in router.chat_calls()]
    first_question = asked[0]
    # turn 1 asks it; the clarifies re-serve it at most _MAX_CONSECUTIVE_CLARIFIES
    # more times, then the engine advances.
    assert asked.count(first_question) <= 1 + interview_engine._MAX_CONSECUTIVE_CLARIFIES
    assert len(set(asked)) > 1, "the interview never moved past the first question"


def test_straight_line_turn_never_allows_a_real_chat_call():
    """§2 #4 + COST-4: on the straight path the model may not even be reachable —
    ``real_call_allowed`` is False, so the engine's question is returned verbatim.
    The LLM can only ever PHRASE a question, never choose one."""
    router = _ScriptedRouter()
    _drive(router, ["Suresh", "shuru", "vmc operator hoon", "5 saal", "done"])
    assert router.chat_calls()
    assert all(c["real_call_allowed"] is False for c in router.chat_calls())


def test_clarify_turn_allows_a_real_call_only_when_the_rephrase_flag_is_on():
    """The rephrase branch is the single place a chat turn may spend a real call —
    and only with ``AI_PROFILING_REPHRASE_ENABLED`` on. Mirrors the endpoint's
    ``wants_rephrase = settings.ai_profiling_rephrase_enabled and is_clarify``."""
    router = _ScriptedRouter()
    _run(
        onboarding_chat._run_chat(
            router,
            input_fn=_scripted_input(["Suresh", "shuru", "matlab kya?", "done"]),
            print_fn=_silent,
            settings=Settings(
                ai_enable_real_calls=False, ai_profiling_rephrase_enabled=True
            ),
        )
    )
    flags = [c["real_call_allowed"] for c in router.chat_calls()]
    assert flags == [False, True], flags  # turn 1 straight, turn 2 clarify


# --- privacy -----------------------------------------------------------------

def test_name_never_passed_into_any_router_call_but_renders_locally():
    """§2/AI-PERSONA-2: only the ``{{worker_name}}`` TOKEN may cross the LLM
    boundary; the real name is interpolated locally at print time (the CLI mirror of
    ChatService.renderWorkerName)."""
    printed: list[str] = []
    router = _ScriptedRouter()
    answers = ["Suresh", "shuru", "CNC turning operator", "Fanuc machine, 5 saal", "done"]
    resume, _calls = _drive(
        router, answers, print_fn=lambda *a, **_k: printed.append(" ".join(map(str, a)))
    )

    assert resume["name"] == "Suresh"
    assert router.calls, "expected the router to have been called"
    # The name string must appear in NO message ever sent to the router/model.
    assert "Suresh" not in router.all_message_text()
    # The engine's placeholder DID cross (it is not PII) ...
    assert onboarding_chat.WORKER_NAME_PLACEHOLDER in router.all_message_text()
    # ... and the worker still sees their real name, with no stray token.
    joined = "\n".join(printed)
    assert "Suresh ji," in joined
    assert onboarding_chat.WORKER_NAME_PLACEHOLDER not in joined


def test_router_receives_the_MASKED_text_never_the_raw_answer():
    """§2 #2/#3: what reaches the router must be ``pseudonymize(...).text``, not the
    worker's raw words.

    The suite covered the BLOCK path (an answer that fails closed never reaches the
    model) but not the REDACTION path — the far commoner case, where pseudonymize
    does not block and instead MASKS in place:

        'abhi Pune mein hu'          -> 'abhi [CITY_1] mein hu'
        'Tata Motors mein kaam kiya' -> '[EMPLOYER_1] mein kaam kiya'

    Without this, swapping ``safe.text`` for ``answer`` in the chat turn ships raw
    worker text to the LLM with a green suite. Scoped to router MESSAGES on purpose:
    the engine and the heuristic extractor legitimately read the raw text
    in-process (no network) — the boundary is the router call, not the function."""
    router = _ScriptedRouter()
    raw_city, raw_employer = "Pune", "Tata Motors"
    answer = f"abhi {raw_city} mein hu, {raw_employer} mein kaam kiya, vmc operator"

    resume, _calls = _drive(router, ["Suresh", "shuru", answer, "done"])

    sent = router.all_message_text()
    # The masked placeholders DID cross the boundary (proving the answer was carried
    # through, not merely dropped — otherwise the raw-absence check below is vacuous).
    assert "[CITY_1]" in sent, sent
    assert "[EMPLOYER_1]" in sent, sent
    # ...and the raw values did NOT, in any call (chat turn or extraction).
    assert raw_city not in sent, f"raw city reached the router: {sent}"
    assert raw_employer not in sent, f"raw employer reached the router: {sent}"
    # The local heuristic still saw the RAW text, so the profile is not degraded.
    assert resume["current_city"] == raw_city


def test_render_worker_name_drops_the_token_when_no_name():
    token = onboarding_chat.WORKER_NAME_PLACEHOLDER
    assert onboarding_chat._render_worker_name(f"{token} ji, namaste", "") == "namaste"
    assert onboarding_chat._render_worker_name(f"{token} ji, namaste", "Geeta Devi") == (
        "Geeta ji, namaste"
    )
    assert onboarding_chat._render_worker_name("no token here", "Geeta") == "no token here"


def test_pseudonymization_block_turn_is_handled_gracefully(monkeypatch):
    """A turn whose answer pseudonymization BLOCKS must NOT reach the model OR the
    engine: we re-prompt, consume no chat turn, and do not advance the interview."""
    router = _ScriptedRouter()
    real_pseudonymize = onboarding_chat.pseudonymize

    class _Blocked:
        text = ""
        blocked = True
        blocked_reason = "residual numeric sequence detected"

    def _selective(text, *args, **kwargs):
        if "99999" in text:
            return _Blocked()
        return real_pseudonymize(text, *args, **kwargs)

    monkeypatch.setattr(onboarding_chat, "pseudonymize", _selective)

    answers = [
        "Mahesh",                          # NAME
        "shuru",                           # kickoff -> turn 1
        "call me on 9999900000",           # BLOCKED -> re-prompt, no model call
        "VMC operator, Pune, 4 saal",      # clean
        "done",
    ]
    resume, calls = _drive(router, answers)

    assert router.chat_turn_count() == 2  # the blocked answer consumed no turn
    assert "9999900000" not in router.all_message_text()
    assert resume["name"] == "Mahesh"
    assert any(c.task_type == "profile_extraction" for c in calls)


def test_full_block_returns_resume_without_extraction(monkeypatch):
    """If the accumulated transcript pseudonymization blocks, NO profile_extraction
    call is made and we still return a resume with the name (fail-closed)."""
    router = _ScriptedRouter()

    class _Blocked:
        text = ""
        blocked = True
        blocked_reason = "residual numeric sequence detected"

    monkeypatch.setattr(onboarding_chat, "pseudonymize", lambda *_a, **_k: _Blocked())

    resume, calls = _drive(router, ["Mahesh", "shuru", "operator", "done"])

    assert resume["name"] == "Mahesh"
    assert all(c["task_type"] != "profile_extraction" for c in router.calls)
    assert all(c.task_type != "profile_extraction" for c in calls)


# --- extraction (unchanged production seam) ----------------------------------

def test_cli_extraction_canonicalizes_role_to_closed_set():
    # Parity with the production endpoint: a valid canonical_role_id from the model
    # maps the resume role/trade onto the closed 7-role taxonomy, even when the
    # keyword heuristic found nothing (bare "cnc"). Wrapped in a ```json fence on
    # purpose — Claude often does this, and the CLI must still parse it.
    extraction = "```json\n" + json.dumps({
        "canonical_role_id": "role_vmc_operator",
        "primary_role": "VMC Operator",
        "experience_years": 1.5,
        "machines": ["VMC"],
    }) + "\n```"
    router = _ScriptedRouter(
        real_call=True, provider="anthropic", extraction_content=extraction
    )
    resume, _calls = _drive(
        router, ["Suresh", "shuru", "cnc machine chalayi dedh saal", "done"]
    )
    assert resume["role"] == "role_vmc_operator"
    assert resume["trade"] == "dom_vmc_machining"  # derived from ROLE_TRADE
    assert resume["experience_years"] == 1.5
    assert "VMC" in resume["machines"]
    assert "skill_ids" in resume  # taxonomy skill ids surfaced


def test_invalid_canonical_role_id_is_rejected_keeps_heuristic():
    # A hallucinated role id must NOT reach the resume (trust boundary).
    extraction = json.dumps({"canonical_role_id": "role_made_up", "primary_role": "X"})
    router = _ScriptedRouter(
        real_call=True, provider="anthropic", extraction_content=extraction
    )
    resume, _calls = _drive(router, ["Suresh", "shuru", "kuch khaas nahi", "done"])
    assert resume["role"] != "role_made_up"  # rejected; heuristic (likely null) stands


def test_loop_ends_on_done():
    """Typing 'done' ends the loop even mid-interview."""
    router = _ScriptedRouter()
    resume, calls = _drive(router, ["Suresh", "shuru", "CNC turning operator", "done"])
    assert router.chat_turn_count() == 2
    assert resume["name"] == "Suresh"
    assert any(c.task_type == "profile_extraction" for c in calls)


def test_main_uses_real_router_in_mock_mode_without_network(monkeypatch, capsys):
    """Smoke test of main(): scripted stdin, default mock settings -> prints a
    resume JSON banner + the cost panel. Uses the REAL AIRouter but stays mock."""
    answers = ["Geeta", "shuru", "vmc operator", "haas, 3 saal, pune", "done"]
    monkeypatch.setattr("builtins.input", _scripted_input(answers))
    monkeypatch.setattr(
        onboarding_chat, "get_settings", lambda: Settings(ai_enable_real_calls=False)
    )

    onboarding_chat.main()
    out = capsys.readouterr().out
    assert "=== RESUME (JSON) ===" in out
    assert "Geeta" in out
    assert "=== COST & METADATA ===" in out
    # CLI-1 visibility: the engine's topic + coverage are printed every turn.
    assert "topic_id=" in out
    assert "answered=" in out and "asked=" in out and "remaining=" in out


# --- provider visibility notes (MSG-1) ---------------------------------------

def test_offline_fallback_note_printed_when_not_real():
    """VISIBILITY: when a chat turn is served by the offline mock (real_call False),
    the worker is told via an inline note. The panel stays authoritative.

    MSG-1: this turn carries NO error_code — it is the ordinary mock-mode path
    (AI_ENABLE_REAL_CALLS=false), which is not a failure at all. The note must say
    so and must NOT claim "model unavailable"."""
    printed: list[str] = []
    router = _ScriptedRouter(real_call=False)
    _drive(
        router,
        ["Geeta", "shuru", "vmc operator, pune, 3 saal", "done"],
        print_fn=lambda *a, **_k: printed.append(" ".join(str(x) for x in a)),
    )
    joined = "\n".join(printed)
    assert "offline fallback (mock)" in joined
    assert "real calls off" in joined
    assert "model unavailable" not in joined


def test_mock_note_names_the_real_reason_per_error_code():
    """MSG-1: every fallback cause used to collapse into "model unavailable". Each
    now surfaces its OWN cause. The unreachable-ledger case is the one that cost real
    debugging time: it is a CONFIG error, must name AI_SPEND_REDIS_URL, and must NOT
    be described as a spend cap."""
    note = onboarding_chat._provider_note(
        _meta("profiling_chat_turn", real_call=False, error_code="spend_store_unavailable")
    )
    assert "AI_SPEND_REDIS_URL" in note
    assert "spend ledger unreachable" in note
    assert "NOT a spend cap" in note
    assert "model unavailable" not in note

    capped = onboarding_chat._provider_note(
        _meta("profiling_chat_turn", real_call=False, error_code="daily_cap_exceeded")
    )
    assert "daily spend cap reached" in capped
    assert "AI_SPEND_REDIS_URL" not in capped
    assert capped != note  # the two causes are distinguishable, not collapsed

    user_capped = onboarding_chat._provider_note(
        _meta("profiling_chat_turn", real_call=False, error_code="user_daily_cap_exceeded")
    )
    assert "per-user daily spend cap reached" in user_capped
    assert user_capped != capped  # per-user cap != process daily cap

    killed = onboarding_chat._provider_note(
        _meta("profiling_chat_turn", real_call=False, error_code="kill_switch_engaged")
    )
    assert "kill switch" in killed

    ceiling = onboarding_chat._provider_note(
        _meta("profiling_chat_turn", real_call=False, error_code="cost_ceiling_exceeded")
    )
    assert "per-call cost ceiling exceeded" in ceiling

    assert len({note, capped, user_capped, killed, ceiling}) == 5


def test_mock_note_never_leaks_a_config_value():
    """§2: the note NAMES the variable, never prints its value (a Redis URL can
    carry credentials). The note is built from closed-set codes only."""
    note = onboarding_chat._provider_note(
        _meta("profiling_chat_turn", real_call=False, error_code="spend_store_unavailable")
    )
    assert "redis://" not in note
    assert "AI_SPEND_REDIS_URL" in note


def test_provider_note_names_claude_haiku_when_anthropic_serves():
    """VISIBILITY: a turn served by Claude Haiku (provider anthropic) surfaces a
    clear note. Worded neutrally (not 'fallback'), since Haiku may be the primary."""
    printed: list[str] = []
    router = _ScriptedRouter(real_call=True, provider="anthropic")
    _drive(
        router,
        ["Geeta", "shuru", "vmc operator, pune, 3 saal", "done"],
        print_fn=lambda *a, **_k: printed.append(" ".join(str(x) for x in a)),
    )
    joined = "\n".join(printed)
    assert "served by Claude Haiku" in joined
    assert "fallback" not in joined  # Haiku is not labelled a fallback anymore


# --- cost panel ---------------------------------------------------------------

def test_cost_panel_renders_summary_and_per_call_rows_without_pii():
    """The panel shows a cost line and at least one per-call row, and contains
    NONE of the worker name or transcript text (it sees only AICallMetadata)."""
    router = _ScriptedRouter()
    name = "Lakshmi"
    transcript_token = "Mazak"  # a distinctive word from an answer below
    answers = [
        name,                                  # NAME (must never reach the panel)
        "shuru",
        "VMC operator hoon",                   # role
        f"Haas aur {transcript_token}, 6 saal, Pune",  # machines (transcript token)
        "done",
    ]
    resume, calls = _drive(router, answers)

    assert resume["name"] == name
    assert calls, "expected at least one collected router call"

    panel = onboarding_chat.render_cost_metadata(calls)

    assert panel.splitlines()[0] == "=== COST & METADATA ==="
    assert "Rs " in panel
    assert "PER-CALL" in panel
    assert "1. " in panel

    # PRIVACY: neither the name nor any transcript token leaks into the panel.
    assert name not in panel
    assert transcript_token not in panel


def test_cost_panel_empty_calls_shows_no_model_calls_note():
    panel = onboarding_chat.render_cost_metadata([])
    assert panel.splitlines()[0] == "=== COST & METADATA ==="
    assert "(no model calls were made)" in panel
    assert "PER-CALL" not in panel
