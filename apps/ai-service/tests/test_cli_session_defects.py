"""Regression suite for four defects observed in a REAL owner-run CLI session.

All fixtures here are SYNTHETIC (no transcript, name or number from the real run
is reproduced). Each test FAILED before the fix that ships alongside it.

D1 — DETERMINISTICALLY-COLLECTED VALUES WERE DISCARDED.
    ``_run_chat`` built the resume from ``profile_extractor.extract(transcript)``
    ALONE. The interview engine's ``ConversationState.collected`` — the values the
    worker gave as the answer to a SPECIFIC question, attributed by
    ``last_asked`` — was never merged in. Observed: the worker answered the
    expected-salary question with a bare amount, the engine recorded
    ``collected["salary_expected"]``, and the resume still shipped
    ``expected_salary: null`` because the context-free re-derivation over the
    joined transcript had already spent its ``current_salary`` slot.

D2 — A WASTED TURN AT THE START. The CLI printed a "type anything to begin"
    nudge and then BLOCKED on input before the engine's first real question, so
    the worker's first message answered nothing.

D3 — RAW NAME CAPTURE. "myself ravi" was stored verbatim, and the bot then
    addressed the worker as "myself ji".

D4 — SILENT "llm attempt failed". The router logged a message naming neither the
    provider, the model, nor the reason.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from app.ai import cost_tracker
from app.ai import router as router_module
from app.ai.errors import REASON_HTTP_429, REASON_NO_TEXT_CONTENT, LlmTransportError
from app.ai.router import AIRouter
from app.cli import onboarding_chat
from app.config import Settings
from app.contracts import AICallMetadata, WorkerProfileDraft
from app.profiling import interview_engine, profile_extractor
from app.profiling.question_bank import topic_by_id

# --- shared harness ----------------------------------------------------------


def _run(coro):
    return asyncio.run(coro)


def _meta(task_type: str) -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="test",
        task_type=task_type,
        model_name="gemini-2.5-flash",
        provider="google",
        real_call=False,
        input_tokens=1,
        output_tokens=1,
        estimated_cost_inr=0.0,
        latency_ms=1,
        success=True,
        created_at="2026-07-21T00:00:00Z",
    )


class _MockRouter:
    """Mirrors AIRouter's MOCK path: returns ``mock_response`` verbatim and keeps
    every message it was handed (so PII/leak assertions have something to read)."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def run(self, task_type, *, messages, mock_response, real_call_allowed=True):
        self.calls.append({"task_type": task_type, "messages": messages,
                           "mock_response": mock_response})
        return mock_response, _meta(task_type)

    def all_message_text(self) -> str:
        return "\n".join(
            m.get("content", "") for c in self.calls for m in c["messages"]
        )


class _Session:
    """Records the INTERLEAVED transcript of what was printed and what was read.

    D2 is a question about ORDERING — "was the worker asked something real before
    they had to type?" — which a flat list of printed lines cannot answer."""

    def __init__(self, answers: list[str]) -> None:
        self._answers = iter(answers)
        self.log: list[tuple[str, str]] = []

    def print_fn(self, *args, **_kwargs) -> None:
        self.log.append(("out", " ".join(str(a) for a in args)))

    def input_fn(self, _prompt: str = "") -> str:
        value = next(self._answers)
        self.log.append(("in", value))
        return value

    def printed_between_reads(self, first: int, second: int) -> str:
        """Everything printed between read #``first`` and read #``second`` (1-based)."""
        reads = 0
        out: list[str] = []
        for kind, text in self.log:
            if kind == "in":
                reads += 1
                continue
            if first <= reads < second:
                out.append(text)
        return "\n".join(out)

    def printed(self) -> str:
        return "\n".join(t for k, t in self.log if k == "out")


def _settings() -> Settings:
    """The shipped defaults: mock mode, COST-4 rephrase off."""
    return Settings(ai_enable_real_calls=False, ai_profiling_rephrase_enabled=False)


def _drive(session: _Session, router: _MockRouter):
    return _run(
        onboarding_chat._run_chat(
            router,
            input_fn=session.input_fn,
            print_fn=session.print_fn,
            settings=_settings(),
        )
    )


def _adaptive(router: _MockRouter, answer_by_topic: dict[str, str], *, name="Suresh",
              default="haan", max_reads=40):
    """Drive the CLI answering whatever the ENGINE just asked.

    The topic in play is read off the printed per-turn header (what an operator
    sees), SEEDED with the engine's own opening topic so the very first worker
    message is attributed to the question it actually answers."""
    topic = {"id": interview_engine.first_question("cnc_vmc")[0]}
    reads = {"n": 0}
    printed: list[str] = []

    def _print(*args, **_kwargs):
        text = " ".join(str(a) for a in args)
        printed.append(text)
        if "topic_id=" in text:
            served = text.split("topic_id=")[1].split()[0]
            topic["id"] = None if served == "-" else served

    def _input(_prompt=""):
        reads["n"] += 1
        if reads["n"] > max_reads:
            return "done"
        if reads["n"] == 1:
            return name
        return answer_by_topic.get(topic["id"], default)

    resume, calls = _run(
        onboarding_chat._run_chat(
            router, input_fn=_input, print_fn=_print, settings=_settings()
        )
    )
    return resume, calls, "\n".join(printed)


# SYNTHETIC answers, one per interview topic. The salary pair is the shape that
# produced the observed loss: a plain current amount, then a plain expected amount
# with NO "expect/chahiye" cue on it, so the context-free re-derivation over the
# joined transcript cannot tell the two apart.
_ANSWERS_BY_TOPIC = {
    "role": "vmc operator hoon",
    "machines": "vmc aur cnc lathe",
    "experience": "5 saal",
    "skills": "setting aata hai",
    "current_location": "pune mein hu",
    "preferred_locations": "nashik chalega",
    "controllers": "fanuc",
    "salary_current": "35000",
    "salary_expected": "50000",
    "availability": "15 din lagenge",
    "education": "iti kiya hai",
}


# --- D1: the engine's collected answers must reach the resume ----------------

def test_the_transcript_alone_really_does_lose_the_expected_salary():
    """PINS THE PREMISE, so the fix below can never be called a no-op.

    Extraction over the joined transcript is context-free: ``_detect_salary``
    assigns the first cue-less amount to ``current_salary`` and then has nowhere
    to put the second one. The engine, which knew the expected-salary question was
    on screen, recorded it correctly. If this ever stops being true the D1 fix has
    lost its reason to exist and should be re-justified, not silently kept."""
    transcript = "\n".join(_ANSWERS_BY_TOPIC.values())
    rich, _legacy = profile_extractor.extract(transcript, "cnc_vmc")
    assert rich.current_salary == 35000
    assert rich.expected_salary is None  # the value the worker gave is gone

    state = None
    for answer in _ANSWERS_BY_TOPIC.values():
        _q, _asked, state, _ready = interview_engine.next_turn(state, answer, "cnc_vmc")
    assert state.collected["salary_expected"] == 50000  # the engine had it all along


def test_engine_collected_values_reach_the_resume():
    """D1 headline: a value the deterministic parser captured for free must not be
    thrown away because the LLM/heuristic could not re-derive it."""
    router = _MockRouter()
    resume, _calls, _printed = _adaptive(router, _ANSWERS_BY_TOPIC)
    assert resume["expected_salary"] == 50000
    assert resume["current_salary"] == 35000


def test_collected_never_crosses_the_model_boundary():
    """§2/#3: the merge is a LOCAL, post-AI step. No collected value may appear in
    anything handed to the router — the raw city is the sharpest probe, because it
    is masked to ``[CITY_1]`` on every path that CAN leave the service."""
    router = _MockRouter()
    resume, _calls, _printed = _adaptive(router, _ANSWERS_BY_TOPIC)
    sent = router.all_message_text()
    assert resume["current_city"] == "Pune"
    assert "Pune" not in sent
    assert "[CITY_1]" in sent  # ...and the masked form DID cross (not merely dropped)


# --- D1: the precedence rule, unit-level -------------------------------------

def _draft(**kwargs) -> WorkerProfileDraft:
    return WorkerProfileDraft(**kwargs)


def test_collected_wins_a_scalar_disagreement():
    """The engine's value was given as the answer to THAT question; extraction is a
    context-free re-derivation over the whole transcript. On a straight
    disagreement the question-attributed value wins."""
    out = profile_extractor.merge_collected(
        _draft(current_salary=35000, expected_salary=None),
        {"salary_expected": 50000, "salary_current": 40000},
    )
    assert out.expected_salary == 50000  # collected filled an empty field
    assert out.current_salary == 40000   # ...and overrode a disagreeing one


def test_extraction_only_values_are_never_deleted():
    """The other direction: extraction sees the WHOLE transcript, including things
    no question ever asked about. A silent ``collected`` must never blank them."""
    out = profile_extractor.merge_collected(
        _draft(current_city="Pune", experience_years=5.0, availability="notice_period"),
        {"salary_expected": 50000},
    )
    assert out.current_city == "Pune"
    assert out.experience_years == 5.0
    assert out.availability == "notice_period"


def test_list_fields_are_unioned_never_replaced():
    """A list is not a CORRECTION of another list, so there is nothing to "win":
    ``collected`` holds what one message contained, extraction what the whole
    transcript did. Replacing would delete the machine the worker mentioned later."""
    out = profile_extractor.merge_collected(
        _draft(machines=["VMC", "CNC Lathe"], skills=["machine operation"]),
        {"machines": ["VMC", "HMC"], "skills": ["basic setting"]},
    )
    assert out.machines == ["VMC", "CNC Lathe", "HMC"]
    assert out.skills == ["machine operation", "basic setting"]


def test_list_union_dedupes_case_insensitively():
    out = profile_extractor.merge_collected(
        _draft(controllers=["Fanuc"]), {"controllers": ["fanuc", "Siemens"]}
    )
    assert out.controllers == ["Fanuc", "Siemens"]


def test_experience_level_stays_consistent_with_a_collected_year_count():
    out = profile_extractor.merge_collected(
        _draft(experience_years=None, experience_level="unknown"), {"experience": 9}
    )
    assert out.experience_years == 9.0
    assert out.experience_level == "senior"


def test_malformed_and_sentinel_collected_values_are_skipped():
    """Same posture as ``merge_model_draft``: a value that is not well-formed for
    its target field is SKIPPED, never coerced.

    ``preferred_locations`` is the live case — the engine records the string
    ``"flexible"`` there to mark "kahin bhi chalega" as an ANSWER. It is a marker,
    not a place, and writing it into the resume's city list would invent a city
    called "flexible"."""
    base = _draft(preferred_locations=["Nashik"], current_city="Pune",
                  availability="immediate", experience_years=5.0)
    out = profile_extractor.merge_collected(
        base,
        {
            "preferred_locations": "flexible",   # sentinel, not a list of places
            "current_location": "",              # empty string
            "availability": "maybe_later",       # not in the enum
            "experience": True,                  # bool is not a year count
            "salary_expected": "50000",          # str is not an amount
            "role": None,                        # denial => nothing collected
        },
    )
    assert out.preferred_locations == ["Nashik"]
    assert out.current_city == "Pune"
    assert out.availability == "immediate"
    assert out.experience_years == 5.0
    assert out.expected_salary is None
    assert out.primary_role is None


def test_merge_collected_is_a_no_op_without_state():
    base = _draft(current_city="Pune")
    assert profile_extractor.merge_collected(base, None).model_dump() == base.model_dump()
    assert profile_extractor.merge_collected(base, {}).model_dump() == base.model_dump()
    # ...and it never mutates its input.
    profile_extractor.merge_collected(base, {"current_location": "Delhi"})
    assert base.current_city == "Pune"


def test_merge_refreshes_the_completeness_report():
    """The merge is the LAST step before the resume, so a stale ``missing_fields``
    would claim we still have to ask for a value we now hold."""
    base, _legacy = profile_extractor.extract("vmc operator hoon", "cnc_vmc")
    assert "expected_salary" in base.missing_fields
    out = profile_extractor.merge_collected(base, {"salary_expected": 50000})
    assert "expected_salary" not in out.missing_fields


# --- D2: no dead turn before the first real question -------------------------

def test_the_first_thing_the_worker_is_asked_is_the_engines_first_question():
    """D2: after the name, the worker must face a REAL question — not a nudge to
    type something so the loop can start. Asserted on the interleaving, because
    the defect is about WHEN the CLI blocked on input, not about wording."""
    session = _Session(["Ravi", "vmc operator hoon", "done"])
    _drive(session, _MockRouter())

    topic_id, question = interview_engine.first_question("cnc_vmc", worker_name=None)
    assert topic_id == "role"
    opener = session.printed_between_reads(1, 2)
    assert question in opener, opener


def test_no_kickoff_nudge_is_ever_shown():
    """The specific dead turn: 'write anything — e.g. shuru — to begin'."""
    session = _Session(["Ravi", "vmc operator hoon", "done"])
    _drive(session, _MockRouter())
    printed = session.printed().lower()
    assert "shuru" not in printed
    assert "kuch bhi likhein" not in printed


def test_the_first_worker_message_advances_the_interview():
    """The turn that used to be spent on 'shuru' now carries an ANSWER: the engine
    records the role and serves the NEXT topic, so no turn is wasted."""
    router = _MockRouter()
    # Answers `role` only (a setter names no machine), so the engine's next served
    # topic is unambiguously `machines`.
    session = _Session(["Ravi", "setter hoon", "done"])
    _drive(session, router)
    chat = [c for c in router.calls if c["task_type"] == "profiling_chat_turn"]
    assert chat, "no chat turn ran"
    machines_q = topic_by_id("cnc_vmc", "machines").question
    assert machines_q in chat[0]["mock_response"], chat[0]["mock_response"]


def test_a_signal_free_first_answer_re_serves_the_opening_question():
    """PINS THE KNOWN, ACCEPTED CONSEQUENCE of serving the opener client-side.

    The first worker message reaches the engine with ``state=None``, so if it
    carries no extractable signal the engine serves the `role` question as its
    FIRST ask — i.e. the worker sees it twice. That is EXACTLY what production does
    today (apps/worker-app prints its canned `role` opener and then posts the first
    message with no state), which is why the CLI mirrors it rather than inventing
    a divergent pre-seeded state.

    It is pinned rather than hidden so the cost is inspectable, and bounded: the
    repeat is capped at ONE — the engine's own re-ask bound then takes over."""
    router = _MockRouter()
    session = _Session(["Ravi", "hmm", "hmm", "done"])
    _drive(session, router)
    role_q = topic_by_id("cnc_vmc", "role").question
    served = [c["mock_response"] for c in router.calls
              if c["task_type"] == "profiling_chat_turn"]
    assert role_q in served[0]
    # ...and the engine's ONE bounded re-ask then uses the retry wording, so the
    # worker is never shown the identical string a third time.
    assert role_q not in served[1]
    assert topic_by_id("cnc_vmc", "role").retry_question in served[1]


# --- D3: name capture strips lead-ins ----------------------------------------

@pytest.mark.parametrize(
    ("typed", "expected"),
    [
        ("myself ravi", "ravi"),
        ("Myself Ravi", "Ravi"),
        ("my name is Ravi", "Ravi"),
        ("my name's Ravi", "Ravi"),
        ("i am Ravi", "Ravi"),
        ("I'm Ravi", "Ravi"),
        ("im ravi", "ravi"),
        ("this is Ravi", "Ravi"),
        ("mera naam Ravi hai", "Ravi"),
        ("mera nam Ravi", "Ravi"),
        ("naam Ravi hai", "Ravi"),
        ("main Ravi hoon", "Ravi"),
        ("mai Ravi hu", "Ravi"),
        ("Ravi ji", "Ravi"),
        ("  Ravi  ", "Ravi"),
    ],
)
def test_common_lead_ins_are_stripped(typed, expected):
    assert onboarding_chat._clean_name(typed) == expected


@pytest.mark.parametrize(
    "name",
    [
        "Ravi",
        "Ravi Kumar",
        "Mainak",       # starts with "main"
        "Mainuddin",
        "Mainul",
        "Imran",        # starts with "im"
        "Iman",
        "Imtiyaz",
        "Jitendra",     # starts with "ji"
        "Jiten",
        "Naamdev",      # starts with "naam"
        "Naman",        # starts with "nam"
        "Nameeta",      # starts with "name"
        "Namrata",
        "Hairaj",       # starts with "hai"
        "Haider",
        "Hemlata",      # starts with "he"
        "Meraj",        # starts with "mera"
        "Mystery",      # starts with "my"
        "Thisara",      # starts with "this"
        "Thakur",
        "Humera",       # starts with "hum"
        "Ravi Sahu",    # ENDS in "hu" — no word boundary, so the trailer cannot bite
        "Sadhu Yadav",
    ],
)
def test_a_real_name_is_never_mangled(name):
    assert onboarding_chat._clean_name(name) == name


@pytest.mark.parametrize("typed", ["myself", "main", "mera naam", "ji", "hai", ""])
def test_a_lead_in_with_nothing_left_falls_back_to_the_raw_input(typed):
    """CONSERVATIVE by design: when stripping would leave nothing, prefer the raw
    input over an aggressive strip that mangles a real name."""
    assert onboarding_chat._clean_name(typed) == typed.strip()


def test_the_bot_addresses_the_worker_by_the_cleaned_name():
    """End to end: the observed symptom was the bot saying "myself ji"."""
    session = _Session(["myself ravi", "vmc operator hoon", "done"])
    resume, _calls = _drive(session, _MockRouter())
    printed = session.printed()
    assert resume["name"] == "ravi"
    assert "ravi ji," in printed
    assert "myself ji," not in printed


def test_the_cleaned_name_still_never_reaches_the_model():
    """§2/AI-PERSONA-2 is UNCHANGED by D3: name handling stays local, post-emit."""
    router = _MockRouter()
    session = _Session(["mera naam Ravi hai", "vmc operator hoon", "done"])
    resume, _calls = _drive(session, router)
    assert resume["name"] == "Ravi"
    sent = router.all_message_text()
    assert "Ravi" not in sent
    assert "mera naam" not in sent
    assert onboarding_chat.WORKER_NAME_PLACEHOLDER in sent


# --- D4: the failed-attempt log line must name provider + model + reason ------


@pytest.fixture
def _isolated_ledger():
    """Deterministic in-process ledger (no ambient AI_SPEND_REDIS_URL)."""
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
    yield
    cost_tracker._ledger = None


def _real_settings(**overrides) -> Settings:
    base = dict(
        ai_enable_real_calls=True,
        gemini_flash_api_key="test-key",
        anthropic_api_key="anth-key",
        default_cheap_model="gemini-2.5-flash-lite",
        default_capable_model="gemini-2.5-flash",
        default_fallback_model="claude-haiku-4-5",
        ai_real_call_tasks="profiling_chat_turn,profile_extraction",
    )
    base.update(overrides)
    return Settings(**base)


def _fail_dispatch(monkeypatch, exc_factory) -> None:
    async def _complete(*, model, **_kwargs):
        raise exc_factory(model)

    monkeypatch.setattr(router_module.providers, "complete", _complete)


def _attempt_lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records
            if r.getMessage().startswith("llm attempt failed")]


def test_failed_attempt_message_names_provider_model_and_reason(
    monkeypatch, caplog, _isolated_ledger
):
    """D4: the bare "llm attempt failed" named nothing. Two prior debugging rounds
    in this project were lost to messages of exactly this kind, so the REASON must
    be in the message itself — the CLI never installs the JSON formatter, so a
    structured ``extra`` alone is invisible to the operator who sees this line."""
    _fail_dispatch(
        monkeypatch, lambda _m: LlmTransportError(REASON_HTTP_429, status_code=429)
    )
    router = AIRouter(_real_settings())
    with caplog.at_level(logging.WARNING, logger="ai.router"):
        _run(router.run("profiling_chat_turn", messages=[{"role": "user", "content": "vmc"}],
                        mock_response="MOCK"))

    lines = _attempt_lines(caplog)
    assert lines, "no attempt-failure line was logged"
    for line in lines:
        assert "provider=" in line
        assert "model=" in line
        assert "reason=" in line
    joined = "\n".join(lines)
    assert "reason=http_429" in joined
    assert "status=429" in joined
    assert "provider=google" in joined
    assert "model=gemini-2.5-flash-lite" in joined


def test_failed_attempt_message_distinguishes_an_untyped_exception(
    monkeypatch, caplog, _isolated_ledger
):
    """HONESTY: a plain exception carries NO transport reason code — only its class
    name. The line must say which of the two it is handing you rather than dressing
    a class name up as a diagnosis."""
    _fail_dispatch(monkeypatch, lambda _m: TimeoutError("boom"))
    router = AIRouter(_real_settings())
    with caplog.at_level(logging.WARNING, logger="ai.router"):
        _run(router.run("profiling_chat_turn", messages=[{"role": "user", "content": "vmc"}],
                        mock_response="MOCK"))

    joined = "\n".join(_attempt_lines(caplog))
    assert "error_class=TimeoutError" in joined
    assert "no transport reason code" in joined
    assert "reason=TimeoutError" not in joined  # not dressed up as a reason code


def test_failed_attempt_message_leaks_no_prompt_text_or_credential(
    monkeypatch, caplog, _isolated_ledger
):
    """§2: this line may appear in ops output. It carries closed-set codes, model
    ids and ints — never the (pseudonymized) prompt, the exception body, or a key."""
    secret = "sk-super-secret-key"
    _fail_dispatch(monkeypatch, lambda _m: RuntimeError(f"401 for {secret} on 9876543210"))
    router = AIRouter(_real_settings(gemini_flash_api_key=secret))
    messages = [{"role": "user", "content": "main [CITY_1] me rehta hu, zzqq-probe"}]
    with caplog.at_level(logging.WARNING, logger="ai.router"):
        _run(router.run("profiling_chat_turn", messages=messages, mock_response="MOCK"))

    joined = "\n".join(_attempt_lines(caplog))
    assert joined
    assert secret not in joined
    assert "zzqq-probe" not in joined
    assert "9876543210" not in joined
    assert "401 for" not in joined  # the exception BODY never appears


def test_the_provider_fallback_is_visible_per_attempt(
    monkeypatch, caplog, _isolated_ledger
):
    """The observed run showed two identical failures then a success. Each attempt
    must now identify ITS OWN provider/model, so a Gemini failure and a Haiku
    failure can never read the same."""
    import importlib.util

    real_find_spec = importlib.util.find_spec

    def _find_spec(name, *a, **k):
        return object() if name == "anthropic" else real_find_spec(name, *a, **k)

    monkeypatch.setattr(importlib.util, "find_spec", _find_spec)
    _fail_dispatch(
        monkeypatch,
        lambda model: LlmTransportError(REASON_HTTP_429, status_code=429)
        if "gemini" in model else LlmTransportError(REASON_NO_TEXT_CONTENT),
    )
    router = AIRouter(_real_settings())
    with caplog.at_level(logging.WARNING, logger="ai.router"):
        _run(router.run("profile_extraction", messages=[{"role": "user", "content": "vmc"}],
                        mock_response="MOCK"))

    joined = "\n".join(_attempt_lines(caplog))
    assert "provider=google" in joined and "reason=http_429" in joined
    assert "provider=anthropic" in joined and "reason=no_text_content" in joined
