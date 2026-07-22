"""Onboarding CLI tests — the CLI drives the REAL endpoints; the router is scripted.

WHAT CHANGED AND WHY. The CLI used to call ``interview_engine`` / ``router``
directly, so these tests injected a fake router INTO THE CLI. It now issues real
``POST /profiling/respond`` requests against ``app.main:app``, so the fake is
installed over ``app.main.router`` instead (see ``cli_harness``). Every assertion
below is therefore now about what the PRODUCTION ENDPOINT did — the same
regressions, pinned one layer deeper.

The load-bearing regressions guarded here (each would FAIL if the old behaviour
came back):
- ``test_cli_issues_real_endpoint_requests`` — the CLI talks HTTP, not Python. If
  someone re-imports the engine and loops locally, this fails.
- ``test_chat_turn_never_resends_history`` / ``test_input_size_is_flat_across_turns``
  — every chat call carries exactly {system, this message, this question} and no
  earlier answer (fails if the O(n^2) history re-send returns).
- ``test_full_run_asks_every_topic_in_bank_order_with_the_bounded_re_ask`` — all 11
  topics, in bank order; essentials twice (INTERVIEW-1's bounded re-ask), the rest
  once.
- ``test_full_run_never_asks_any_topic_a_third_time`` — the multiplicity bound.
- ``test_clarify_reserves_the_same_question_at_most_twice`` — the other sanctioned
  repeat, bounded by ``_MAX_CONSECUTIVE_CLARIFIES``.
- the privacy block — the name never enters a request body or a router message.
"""

import json
from collections import Counter

from cli_harness import ScriptedRouter, adaptive_drive, asked_order, drive, meta, transport

from app.cli import onboarding_chat
from app.cli.api_session import InterviewSession
from app.config import Settings
from app.profiling import interview_engine
from app.profiling.prompts import BADA_BHAI_SYSTEM_PROMPT, build_chat_messages
from app.profiling.question_bank import topic_by_id, topics_for

BANK_ORDER = [t.id for t in topics_for("cnc_vmc")]


def _expected_blind_ask_order() -> list[str]:
    """The exact ask sequence a SIGNAL-FREE worker must produce, DERIVED from the
    engine's constants + the bank (never hard-coded), so it tracks them.

    - ``_next_topic`` serves unanswered ESSENTIAL topics first (in bank order),
      each up to ``MAX_ASKS_PER_TOPIC`` — INTERVIEW-1's bounded re-ask.
    - Everything else is asked exactly ONCE, in bank order, and never re-asked.
    """
    essentials = [t for t in BANK_ORDER if t in interview_engine.ESSENTIAL_TOPICS]
    others = [t for t in BANK_ORDER if t not in interview_engine.ESSENTIAL_TOPICS]
    return [
        topic_id
        for topic_id in essentials
        for _ in range(interview_engine.MAX_ASKS_PER_TOPIC)
    ] + others


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


# --- parity: the CLI drives the REAL endpoint --------------------------------

def test_cli_issues_real_endpoint_requests(monkeypatch):
    """The turn must be an HTTP request to /profiling/respond on the real app.

    Fails if anyone reintroduces a local engine loop: we spy on the TRANSPORT and
    require the profiling path to have been exercised, with the response's own
    ``asked_question_id`` driving what the worker sees."""
    seen: list[str] = []
    real_post = transport().post

    def _spy(path, payload):
        seen.append(path)
        return real_post(path, payload)

    monkeypatch.setattr(transport(), "post", _spy)
    run = drive(monkeypatch, ["vmc operator hoon", "5 saal", "Pune mein hu", "done"])

    assert "/profiling/respond" in seen, seen
    assert run.turns and all(t.ok for t in run.turns)
    # The reply the worker saw IS the endpoint's reply_text for that same turn.
    for turn in run.turns:
        assert turn.reply_text in run.printed


def test_request_body_matches_the_production_caller(monkeypatch):
    """Field-for-field parity with apps/api chat.service.ts step 3. A drifted body
    would exercise a different code path than production does."""
    run = drive(monkeypatch, ["vmc operator hoon", "done"])
    request = run.turns[0].request
    assert set(request) == {
        "session_id",
        "worker_ref",
        "message_text",
        "history",
        "conversation_state",
        "role_family",
    }
    assert request["history"] == []  # PERF-2: history ships empty
    assert request["conversation_state"] is None  # first turn mints a fresh state
    assert request["role_family"] == "cnc_vmc"
    assert "real_call_allowed" not in request  # omitted -> contract default, as in prod


def test_engine_state_is_threaded_forward_not_restarted(monkeypatch):
    """The ConversationState must carry across turns (production persists it on the
    session). If it were dropped, every turn would re-ask topic #1."""
    run = drive(monkeypatch, ["hmm", "hmm", "hmm", "done"])
    asked = [c["mock_response"] for c in run.router.chat_calls()]
    assert len(asked) == len(set(asked)), f"a question repeated — state was lost: {asked}"
    # ...and the state really did travel in the REQUEST, not just in memory.
    assert run.turns[1].request["conversation_state"] is not None


def test_chat_turn_never_resends_history(monkeypatch):
    """COST-3: the chat turn is STATELESS.

    Every ``profiling_chat_turn`` call must carry EXACTLY
    {system persona, this pseudonymized message, this engine question} — three
    messages — and must contain NO text from an earlier turn."""
    # Distinctive, signal-free tokens so a leak is unambiguous.
    run = drive(monkeypatch, ["zzqqa", "zzqqb", "zzqqc", "zzqqd", "done"])

    chat_calls = run.router.chat_calls()
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
        prior_tokens.append(contents[1])


def test_chat_messages_match_build_chat_messages_with_empty_history(monkeypatch):
    """Structural parity with the endpoint (main.profiling_respond):
    ``build_chat_messages([], engine_question, pseudonymized_message)``."""
    run = drive(monkeypatch, ["vmc operator hoon", "done"])
    for call in run.router.chat_calls():
        user_msg = call["messages"][1]["content"]
        expected = build_chat_messages([], call["mock_response"], user_msg)
        assert call["messages"] == expected


def test_input_size_is_flat_across_turns(monkeypatch):
    """The observed symptom of the old bug was input tokens climbing every turn
    (581 -> 757 in one real session). Answers are LONG and identical-length here, so
    a history re-send would inflate each turn by ~90 chars.

    It asserts the EXACT invariant: across turns whose user message is the SAME
    length, the input size minus the served question is CONSTANT."""
    long_answer = "hmm " * 22 + "theek"  # ~93 chars, carries no extractable signal
    run = drive(monkeypatch, [long_answer] * 8 + ["done"])

    calls = run.router.chat_calls()
    sizes = [sum(len(m["content"]) for m in c["messages"]) for c in calls]
    assert len(sizes) >= 6

    comparable = [c for c in calls if len(c["messages"][1]["content"]) == len(long_answer)]
    assert len(comparable) >= 6, f"not enough comparable turns: {len(comparable)}"
    residuals = {
        sum(len(m["content"]) for m in c["messages"]) - len(c["messages"][2]["content"])
        for c in comparable
    }
    assert len(residuals) == 1, f"input size accumulates across turns: {residuals}"

    # Belt and braces: even the RAW spread over those turns must stay within what the
    # bank's own question lengths can explain — derived from the bank, never hard-coded.
    lengths = [len(t.question) for t in topics_for("cnc_vmc")]
    lengths += [len(t.retry_question) for t in topics_for("cnc_vmc") if t.retry_question]
    comparable_sizes = [sum(len(m["content"]) for m in c["messages"]) for c in comparable]
    assert max(comparable_sizes) - min(comparable_sizes) <= max(lengths) - min(lengths)

    # ...and it must not climb monotonically, which is what a re-send looks like.
    growth = [b - a for a, b in zip(sizes, sizes[1:], strict=False)]
    assert not all(g > 0 for g in growth), f"input size grows every turn: {sizes}"


def test_full_run_asks_every_topic_in_bank_order_with_the_bounded_re_ask(monkeypatch):
    """COVERAGE: a worker who gives no extractable signal is asked EVERY topic in
    the bank, in bank order, then gets the wrap-up. The four ESSENTIAL topics are
    asked TWICE (the bounded re-ask); non-essentials exactly once."""
    run = adaptive_drive(monkeypatch, lambda _topic: "hmm theek hai")
    order = asked_order(run)
    expected = _expected_blind_ask_order()
    assert order == expected, f"{order} != {expected}"
    assert set(order) == set(BANK_ORDER)
    assert len(BANK_ORDER) == 11  # the bank really has 11 topics
    assert "resume ban raha hai" in run.printed  # the wrap-up turn ran


def test_full_run_never_asks_any_topic_a_third_time(monkeypatch):
    """The multiplicity half, asserted separately so the bound is legible."""
    run = adaptive_drive(monkeypatch, lambda _topic: "hmm theek hai")
    counts = Counter(asked_order(run))
    # The PRODUCT rule, pinned as a literal on purpose: at most ONE re-ask. Raising
    # the constant is a deliberate product decision (more nagging of workers the
    # detector cannot parse) and must be re-reviewed.
    assert interview_engine.MAX_ASKS_PER_TOPIC == 2
    assert max(counts.values()) <= 2, dict(counts)
    for topic_id in BANK_ORDER:
        expected_n = (
            interview_engine.MAX_ASKS_PER_TOPIC
            if topic_id in interview_engine.ESSENTIAL_TOPICS
            else 1
        )
        assert counts[topic_id] == expected_n, (topic_id, dict(counts))


def test_full_run_re_ask_uses_the_retry_wording_not_a_verbatim_repeat(monkeypatch):
    """The second ask of an essential must be the narrower ``retry_question`` — a
    verbatim re-serve reads as broken. Checked on what the ROUTER was handed, i.e.
    the line the worker actually sees."""
    run = adaptive_drive(monkeypatch, lambda _topic: "hmm theek hai")
    served = [c["mock_response"] for c in run.router.chat_calls()]
    for topic_id in interview_engine.ESSENTIAL_TOPICS:
        topic = topic_by_id("cnc_vmc", topic_id)
        assert topic.retry_question is not None, topic_id
        assert any(topic.retry_question in line for line in served), (
            f"{topic_id} was re-asked without its retry wording"
        )


def test_engine_wraps_up_once_essentials_are_answered(monkeypatch):
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
    run = adaptive_drive(monkeypatch, lambda topic: answer_by_topic.get(topic, "haan"))
    order = asked_order(run)
    assert "preferred_locations" in order
    assert "resume ban raha hai" in run.printed
    assert run.turns[-1].extraction_ready
    # Stopped EARLY on purpose — it did not walk the whole bank.
    assert len(order) < len(BANK_ORDER)


def test_no_question_repeats_beyond_the_sanctioned_bounded_re_ask(monkeypatch):
    """The engine must never nag. Exactly TWO sanctioned repeats exist —
    ``clarify_turn`` re-serving a misunderstood question and INTERVIEW-1's ONE
    bounded re-ask of an UNANSWERED essential."""
    run = adaptive_drive(monkeypatch, lambda _topic: "hmm theek hai")
    order = asked_order(run)
    for topic_id, n in Counter(order).items():
        limit = (
            interview_engine.MAX_ASKS_PER_TOPIC
            if topic_id in interview_engine.ESSENTIAL_TOPICS
            else 1
        )
        assert n <= limit, f"{topic_id} asked {n}x (limit {limit}): {order}"
    non_essential = [t for t in order if t not in interview_engine.ESSENTIAL_TOPICS]
    assert len(non_essential) == len(set(non_essential)), order


def test_clarify_reserves_the_same_question_at_most_twice(monkeypatch):
    """The ONLY sanctioned repeat is ``clarify_turn`` re-serving the question the
    worker did not understand — bounded by ``_MAX_CONSECUTIVE_CLARIFIES`` (2)."""
    run = drive(monkeypatch, ["matlab kya?"] * 5 + ["done"])
    asked = [c["mock_response"] for c in run.router.chat_calls()]
    first_question = asked[0]
    assert asked.count(first_question) <= 1 + interview_engine._MAX_CONSECUTIVE_CLARIFIES
    assert len(set(asked)) > 1, "the interview never moved past the first question"


def test_straight_line_turn_never_allows_a_real_chat_call(monkeypatch):
    """§2 #4 + COST-4: on the straight path the model may not even be reachable —
    ``real_call_allowed`` is False, so the engine's question is returned verbatim.
    The LLM can only ever PHRASE a question, never choose one."""
    run = drive(monkeypatch, ["vmc operator hoon", "5 saal", "done"])
    assert run.router.chat_calls()
    assert all(c["real_call_allowed"] is False for c in run.router.chat_calls())


def test_clarify_turn_allows_a_real_call_only_when_the_rephrase_flag_is_on(monkeypatch):
    """The rephrase branch is the single place a chat turn may spend a real call —
    and only with ``AI_PROFILING_REPHRASE_ENABLED`` on. This pins the ENDPOINT's
    ``wants_rephrase = settings.ai_profiling_rephrase_enabled and is_clarify``."""
    run = drive(
        monkeypatch,
        # A real answer FIRST, so the clarify has a served question to re-serve
        # (the opener leaves no state; clarify_turn refuses on an empty one).
        ["vmc operator hoon", "matlab kya?", "done"],
        settings=Settings(ai_enable_real_calls=False, ai_profiling_rephrase_enabled=True),
    )
    flags = [c["real_call_allowed"] for c in run.router.chat_calls()]
    assert flags == [False, True], flags  # turn 1 straight, turn 2 clarify


# --- privacy -----------------------------------------------------------------

def test_name_never_leaves_the_process_but_renders_locally(monkeypatch):
    """§2/AI-PERSONA-2: only the ``{{worker_name}}`` TOKEN may cross the LLM
    boundary; the real name is interpolated locally at print time (the CLI mirror of
    ChatService.renderWorkerName)."""
    run = drive(
        monkeypatch,
        ["CNC turning operator", "Fanuc machine, 5 saal", "done"],
        name="Suresh",
        extract=True,
    )

    assert run.router.calls, "expected the router to have been called"
    # The name appears in NO request body...
    bodies = json.dumps([t.request for t in run.turns], ensure_ascii=False)
    assert "Suresh" not in bodies
    assert "Suresh" not in json.dumps(run.extraction.request, ensure_ascii=False)
    # ...and in no message ever handed to the router/model.
    assert "Suresh" not in run.router.all_message_text()
    # The engine's placeholder DID cross (it is not PII) ...
    assert onboarding_chat.WORKER_NAME_PLACEHOLDER in run.router.all_message_text()
    # ... and the worker still sees their real name, with no stray token.
    assert "Suresh ji," in run.printed


def test_router_receives_the_MASKED_text_never_the_raw_answer(monkeypatch):
    """§2 #2/#3: what reaches the router must be ``pseudonymize(...).text``, not the
    worker's raw words — the REDACTION path (masked in place), not just the block
    path:

        'abhi Pune mein hu'          -> 'abhi [CITY_1] mein hu'
        'Tata Motors mein kaam kiya' -> '[EMPLOYER_1] mein kaam kiya'
    """
    raw_city, raw_employer = "Pune", "Tata Motors"
    answer = f"abhi {raw_city} mein hu, {raw_employer} mein kaam kiya, vmc operator"
    run = drive(monkeypatch, [answer, "done"], extract=True)

    sent = run.router.all_message_text()
    # The masked placeholders DID cross the boundary (proving the answer was carried
    # through, not merely dropped — otherwise the raw-absence check below is vacuous).
    assert "[CITY_1]" in sent, sent
    assert "[EMPLOYER_1]" in sent, sent
    # ...and the raw values did NOT, in any call (chat turn or extraction).
    assert raw_city not in sent, f"raw city reached the router: {sent}"
    assert raw_employer not in sent, f"raw employer reached the router: {sent}"
    # The local heuristic still saw the RAW text, so the profile is not degraded.
    assert run.extraction.draft["current_city"] == raw_city


def test_render_worker_name_drops_the_token_when_no_name():
    token = onboarding_chat.WORKER_NAME_PLACEHOLDER
    assert onboarding_chat._render_worker_name(f"{token} ji, namaste", "") == "namaste"
    assert onboarding_chat._render_worker_name(f"{token} ji, namaste", "Geeta Devi") == (
        "Geeta ji, namaste"
    )
    assert onboarding_chat._render_worker_name("no token here", "Geeta") == "no token here"


def test_pseudonymization_block_turn_is_handled_gracefully(monkeypatch):
    """A turn whose message pseudonymization BLOCKS must not reach the model and
    must not advance the interview — and the CLI must SAY so."""
    run = drive(monkeypatch, ["mera ref number 12345678 hai", "VMC operator, 4 saal", "done"])

    blocked, normal = run.turns[0], run.turns[1]
    assert blocked.blocked and blocked.state is None
    assert "12345678" not in run.router.all_message_text()
    # The endpoint returned before the engine ran, so no chat call was made for it.
    assert run.router.chat_turn_count() == 1
    assert normal.state is not None
    assert "BLOCKED" in run.printed


def test_full_block_still_returns_a_production_result(monkeypatch):
    """If the accumulated transcript pseudonymization blocks, /profile/extract fails
    CLOSED: no model call, empty profile, extraction_status='blocked'."""
    run = drive(monkeypatch, ["mera ref number 12345678 hai", "done"], extract=True)
    assert run.extraction.blocked
    assert run.extraction.status == "blocked"
    assert run.extraction.profile["canonical_role_id"] is None
    assert all(c["task_type"] != "profile_extraction" for c in run.router.calls)


# --- extraction (unchanged production seam) ----------------------------------

def test_cli_extraction_canonicalizes_role_to_closed_set(monkeypatch):
    # Parity with the production endpoint: a valid canonical_role_id from the model
    # maps the profile role/trade onto the closed 7-role taxonomy. Wrapped in a
    # ```json fence on purpose — Claude often does this, and it must still parse.
    extraction = "```json\n" + json.dumps({
        "canonical_role_id": "role_vmc_operator",
        "primary_role": "VMC Operator",
        "experience_years": 1.5,
        "machines": ["VMC"],
    }) + "\n```"
    router = ScriptedRouter(
        real_call=True, provider="anthropic", extraction_content=extraction
    )
    run = drive(
        monkeypatch, ["cnc machine chalayi dedh saal", "done"], router=router, extract=True
    )
    profile, draft = run.extraction.profile, run.extraction.draft
    assert profile["canonical_role_id"] == "role_vmc_operator"
    assert profile["canonical_trade_id"] == "dom_vmc_machining"  # derived from ROLE_TRADE
    assert draft["experience_years"] == 1.5
    assert "VMC" in draft["machines"]


def test_invalid_canonical_role_id_is_rejected_keeps_heuristic(monkeypatch):
    # A hallucinated role id must NOT reach the profile (trust boundary).
    extraction = json.dumps({"canonical_role_id": "role_made_up", "primary_role": "X"})
    router = ScriptedRouter(
        real_call=True, provider="anthropic", extraction_content=extraction
    )
    run = drive(monkeypatch, ["kuch khaas nahi", "done"], router=router, extract=True)
    assert run.extraction.profile["canonical_role_id"] != "role_made_up"


def test_loop_ends_on_done(monkeypatch):
    """Typing 'done' ends the loop even mid-interview."""
    run = drive(monkeypatch, ["CNC turning operator", "Fanuc", "done"], extract=True)
    assert run.router.chat_turn_count() == 2
    assert run.extraction.ok


def test_main_uses_the_real_app_in_mock_mode_without_network(monkeypatch, capsys):
    """Smoke test of main(): scripted stdin, default mock settings -> prints the
    production extraction + the cost panel. Uses the REAL AIRouter, stays mock, and
    opens no socket (TestClient speaks ASGI in-process)."""
    answers = iter(["Geeta", "vmc operator", "haas, 3 saal, pune", "done"])
    monkeypatch.setattr("builtins.input", lambda *_a, **_k: next(answers))
    monkeypatch.setattr(
        onboarding_chat, "get_settings", lambda: Settings(ai_enable_real_calls=False)
    )
    monkeypatch.setattr(onboarding_chat, "_make_transport", lambda *_a, **_k: _NoCloseTransport())

    assert onboarding_chat.main([]) == 0
    out = capsys.readouterr().out
    assert "=== PRODUCTION RESULT: POST /profile/extract ===" in out
    assert "Geeta ji," in out  # the name rendered locally
    assert "=== COST & METADATA ===" in out
    # Visibility: the per-turn trace really is on by default.
    assert "engine      :" in out
    assert "must-ask    :" in out
    assert "-> to LLM" in out
    # ...and the CLI-only view is LABELLED as not-production.
    assert "PRODUCTION DOES NOT PRODUCE THIS" in out


class _NoCloseTransport:
    """The shared session transport, with close() disabled so main() cannot tear
    down the client other tests reuse."""

    def __init__(self):
        self._inner = transport()
        self.label = self._inner.label

    def post(self, path, payload):
        return self._inner.post(path, payload)

    def get(self, path):
        return self._inner.get(path)

    def close(self):
        return None


# --- provider visibility notes (MSG-1) ---------------------------------------

def test_offline_fallback_note_printed_when_not_real(monkeypatch):
    """VISIBILITY: when a chat turn is served by the offline mock (real_call False),
    the worker is told via an inline note. MSG-1: this turn carries NO error_code —
    it is the ordinary mock-mode path, which is not a failure at all."""
    run = drive(monkeypatch, ["vmc operator, pune, 3 saal", "done"])
    assert "offline fallback (mock)" in run.printed
    assert "real calls off" in run.printed
    assert "model unavailable" not in run.printed


def test_mock_note_names_the_real_reason_per_error_code():
    """MSG-1: every fallback cause used to collapse into "model unavailable". Each
    now surfaces its OWN cause. The unreachable-ledger case is the one that cost real
    debugging time: it is a CONFIG error, must name AI_SPEND_REDIS_URL, and must NOT
    be described as a spend cap."""
    note = onboarding_chat._provider_note(
        meta("profiling_chat_turn", real_call=False, error_code="spend_store_unavailable")
    )
    assert "AI_SPEND_REDIS_URL" in note
    assert "spend ledger unreachable" in note
    assert "NOT a spend cap" in note
    assert "model unavailable" not in note

    capped = onboarding_chat._provider_note(
        meta("profiling_chat_turn", real_call=False, error_code="daily_cap_exceeded")
    )
    assert "daily spend cap reached" in capped
    assert "AI_SPEND_REDIS_URL" not in capped
    assert capped != note  # the two causes are distinguishable, not collapsed

    user_capped = onboarding_chat._provider_note(
        meta("profiling_chat_turn", real_call=False, error_code="user_daily_cap_exceeded")
    )
    assert "per-user daily spend cap reached" in user_capped
    assert user_capped != capped  # per-user cap != process daily cap

    killed = onboarding_chat._provider_note(
        meta("profiling_chat_turn", real_call=False, error_code="kill_switch_engaged")
    )
    assert "kill switch" in killed

    ceiling = onboarding_chat._provider_note(
        meta("profiling_chat_turn", real_call=False, error_code="cost_ceiling_exceeded")
    )
    assert "per-call cost ceiling exceeded" in ceiling

    assert len({note, capped, user_capped, killed, ceiling}) == 5


def test_mock_note_never_leaks_a_config_value():
    """§2: the note NAMES the variable, never prints its value (a Redis URL can
    carry credentials). The note is built from closed-set codes only."""
    note = onboarding_chat._provider_note(
        meta("profiling_chat_turn", real_call=False, error_code="spend_store_unavailable")
    )
    assert "redis://" not in note
    assert "AI_SPEND_REDIS_URL" in note


def test_provider_note_names_claude_haiku_when_anthropic_serves(monkeypatch):
    """VISIBILITY: a turn served by Claude Haiku (provider anthropic) surfaces a
    clear note. Worded neutrally (not 'fallback'), since Haiku may be the primary."""
    run = drive(
        monkeypatch,
        ["vmc operator, pune, 3 saal", "done"],
        router=ScriptedRouter(real_call=True, provider="anthropic"),
    )
    assert "served by Claude Haiku" in run.printed


# --- cost panel ---------------------------------------------------------------

def test_cost_panel_renders_summary_and_per_call_rows_without_pii(monkeypatch):
    """The panel shows a cost line and at least one per-call row, and contains
    NONE of the worker name or transcript text (it sees only AICallMetadata)."""
    name = "Lakshmi"
    transcript_token = "Mazak"  # a distinctive word from an answer below
    run = drive(
        monkeypatch,
        ["VMC operator hoon", f"Haas aur {transcript_token}, 6 saal, Pune", "done"],
        name=name,
    )
    calls = [
        onboarding_chat._metadata(t.ai_metadata)
        for t in run.turns
        if t.ai_metadata is not None
    ]
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


def test_metadata_parses_the_contract_shape(monkeypatch):
    """The panel is fed through the SAME Pydantic contract the service returns, so
    a shape drift shows up here rather than as a silently empty panel."""
    run = drive(monkeypatch, ["vmc operator hoon", "done"])
    parsed = onboarding_chat._metadata(run.turns[0].ai_metadata)
    assert parsed is not None
    assert parsed.task_type == "profiling_chat_turn"
    assert onboarding_chat._metadata(None) is None
    assert onboarding_chat._metadata({"nonsense": True}) is None


def test_session_ids_are_opaque_and_pii_free():
    """``worker_ref``/``session_id`` mirror production's UUID shapes — never a name."""
    session = InterviewSession(transport())
    assert len(session.worker_ref) == 36 and "-" in session.worker_ref
    assert len(session.session_id) == 36
