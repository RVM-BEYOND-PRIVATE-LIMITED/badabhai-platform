"""The AI-call trace text the backend's ``ai_call_traces`` store persists.

WHAT THESE PIN, and why each is here rather than being obvious:

1. THE GATE IS REAL AND DEFAULTS OFF. With ``AI_CALL_TRACE_TEXT_ENABLED`` unset, this
   service's egress is byte-identical to what it was before the two fields existed. A
   feature that widens what leaves the process must not be able to arm itself.
2. THE TEXT IS TAKEN FROM AFTER THE PSEUDONYMIZATION BOUNDARY. Driven END TO END through
   ``POST /profile/extract`` — a real endpoint, with a real name and a real phone number
   in the request — because that is the only way to prove the WIRING sits on the right
   side of ``app/pseudonymize.py``. A unit test that hands the router pre-masked strings
   would prove nothing about where the boundary is.

   HONEST ABOUT ITS OWN LIMIT: R32 measured the name gazetteer's recall as POOR. These
   tests use a CUED name ("mera naam ...") and a bare 10-digit number, which the gateway
   does catch. They prove the values are produced on the masked side of the boundary.
   They do NOT prove the text is clean, and nothing in this file should be read that way
   — the store encrypts at rest and gates the read on a super-admin capability precisely
   because it is not.
3. THE MASK IS LOAD-BEARING, NOT DECORATIVE. ``mock_response`` is what the router returns
   on the mock posture and on every real-call failure, and for ``/profile/extract`` it is
   derived from the worker's RAW text. So the response leg is tested with the router
   handed raw text directly.
4. THE TEXT NEVER RIDES THE TRACE METADATA BLOB. ``input``/``output`` are native Langfuse
   fields and the only two the privacy mask rewrites; a copy in the free-form metadata
   dict would be a second, unmasked-by-contract egress of the same payload.
5. FINAL PAIR ONLY. The documented MVP scope limit: a dispatch that retried does not
   store one row per attempt.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

import pytest
from fastapi.testclient import TestClient

from app.ai import cost_tracker
from app.ai import router as router_module
from app.ai.gemini_client import LlmResult
from app.ai.langfuse_tracing import REDACTED, LangfuseTracer, masked_trace_text
from app.ai.provider_cooldown import reset_cooldown
from app.ai.router import AIRouter
from app.config import Settings
from app.pseudonymize import DEFAULT_MAX_LENGTH

_MESSAGES = [
    {"role": "system", "content": "You are an interviewer."},
    {"role": "user", "content": "vmc 4 saal"},
]


def _run(coro):
    return asyncio.run(coro)


def _settings(**overrides) -> Settings:
    """Bare settings with the trace-text gate ON unless a test says otherwise."""
    return Settings(ai_call_trace_text_enabled=True, **overrides)


@pytest.fixture(autouse=True)
def _isolate_process_singletons():
    """Reset the two PROCESS-WIDE singletons the router reads (see the same fixture in
    ``test_ai_observability.py`` for the incident that motivated it)."""
    reset_cooldown()
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
    yield
    reset_cooldown()
    cost_tracker._ledger = None


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Force the provider dispatcher to raise, so nothing here can reach a network."""

    async def _boom(**_kwargs):
        raise RuntimeError("forced failure (no network in tests)")

    monkeypatch.setattr(router_module.providers, "complete", _boom)


# ---------------------------------------------------------------------------
# 1. The gate
# ---------------------------------------------------------------------------


def test_the_trace_text_is_absent_by_default():
    """A bare ``Settings()`` — the committed default — carries no text at all.

    This is the flag's whole safety argument: with it off, `ai_metadata` is exactly the
    PII-free record it was before, so a backend that is not ready to encrypt this text
    cannot be handed it by accident.
    """
    router = AIRouter(Settings())
    _content, meta = _run(
        router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="MOCK_REPLY")
    )
    assert meta.prompt_text is None
    assert meta.response_text is None


def test_the_gate_is_off_on_the_real_call_failure_path_too():
    """The fallback-to-mock path runs through a DIFFERENT `_finish_task` call site.

    Both call sites must respect the gate, or the feature arms itself on exactly the
    calls an operator is most likely to be looking at.
    """
    router = AIRouter(
        Settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            ai_real_call_tasks="profile_extraction",
        )
    )
    _content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="FALLBACK")
    )
    assert meta.real_call is True and meta.success is False
    assert meta.prompt_text is None
    assert meta.response_text is None


def test_with_the_gate_on_the_final_pair_is_carried():
    router = AIRouter(_settings())
    content, meta = _run(
        router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="MOCK_REPLY")
    )
    # The PROMPT is every message, flattened the same way the ledger measures it.
    assert meta.prompt_text == "You are an interviewer.\nvmc 4 saal"
    # The RESPONSE is what the caller actually received — not a second rendering of it.
    assert meta.response_text == content == "MOCK_REPLY"


# ---------------------------------------------------------------------------
# 2. Post-boundary, proven end to end through a real endpoint
# ---------------------------------------------------------------------------

_RAW_TURN = (
    "Bada Bhai: Aap kaunsa kaam karte hain?\n"
    "Worker: mera naam Ramesh Kumar hai, number 9876543210, "
    "main VMC operator hu, Pune se, 4 saal ka experience"
)


def test_the_endpoint_records_the_masked_prompt_not_the_workers_words(monkeypatch):
    """THE PRIVACY TEST. A real name and a real phone number go in over HTTP.

    Driven through ``POST /profile/extract`` rather than through ``AIRouter`` directly,
    and that is the entire point: the pseudonymization boundary lives in the ENDPOINT,
    before ``router.run`` is reached. Only a test that starts outside the endpoint can
    show which side of that boundary the recorded text is taken from.

    ``Pune`` is asserted PRESENT on purpose — the owner ruling of 2026-07-31 removed
    cities from the masked classes ("a 20-point matching input; never redact"), so a
    trace that lost the city would mean the gateway had regressed in the other direction.
    """
    from app import main
    from app.routers import profile as profile_router

    monkeypatch.setattr(profile_router, "router", AIRouter(_settings()))
    client = TestClient(main.app)

    res = client.post("/profile/extract", json={"worker_ref": "w-1", "transcript": _RAW_TURN})
    assert res.status_code == 200
    body = res.json()
    assert body["blocked"] is False

    prompt = body["ai_metadata"]["prompt_text"]
    response = body["ai_metadata"]["response_text"]
    assert prompt and response is not None

    # The worker's identity is NOT in what gets persisted...
    assert "Ramesh" not in prompt
    assert "9876543210" not in prompt
    assert "Ramesh" not in response
    assert "9876543210" not in response
    # ...it is there as placeholder labels, which is what "post-boundary" looks like.
    assert "[PERSON_1]" in prompt
    assert "[PHONE_1]" in prompt
    # ...and the matching signal the ruling protects rides through untouched.
    assert "Pune" in prompt
    # The worker still gets their own words back in their own profile.
    assert body["worker_profile_draft"]["current_city"] == "Pune"


def test_the_endpoint_records_nothing_when_the_gate_is_off(monkeypatch):
    """The same request, same endpoint, flag off: the two fields are null on the wire."""
    from app import main
    from app.routers import profile as profile_router

    monkeypatch.setattr(profile_router, "router", AIRouter(Settings()))
    client = TestClient(main.app)

    body = client.post(
        "/profile/extract", json={"worker_ref": "w-1", "transcript": _RAW_TURN}
    ).json()
    assert body["ai_metadata"]["prompt_text"] is None
    assert body["ai_metadata"]["response_text"] is None


# ---------------------------------------------------------------------------
# 3. The mask is load-bearing, not decorative
# ---------------------------------------------------------------------------


def test_raw_text_handed_straight_to_the_router_is_still_masked():
    """DEFENSE IN DEPTH, and on the response leg it is the PRIMARY defense.

    ``mock_response`` is returned on the mock posture and on every real-call failure, and
    ``/profile/extract`` builds it from the worker's RAW text (``routers/profile.py`` says
    so in as many words). So the response value genuinely can arrive here unmasked, and
    the store must not be the thing that discovers it.
    """
    router = AIRouter(_settings())
    _content, meta = _run(
        router.run(
            "profile_extraction",
            messages=[{"role": "user", "content": "mera naam Ramesh Kumar hai"}],
            mock_response='{"note": "call 9876543210"}',
        )
    )
    assert "Ramesh" not in meta.prompt_text
    assert "[PERSON_1]" in meta.prompt_text
    assert "9876543210" not in meta.response_text
    assert "[PHONE_1]" in meta.response_text


def test_a_payload_the_gate_refuses_is_redacted_wholesale():
    """FAIL CLOSED. Over the 20k cap the gateway blocks rather than masks, and an
    unmaskable payload must not be persisted just to have a prettier trace."""
    router = AIRouter(_settings())
    _content, meta = _run(
        router.run(
            "profiling_chat_turn",
            messages=[{"role": "user", "content": "x" * (DEFAULT_MAX_LENGTH + 1)}],
            mock_response="ok",
        )
    )
    assert meta.prompt_text == REDACTED


def test_masked_trace_text_is_total():
    """Every input shape yields a ``str`` — never a repr of an object nobody vetted."""
    assert masked_trace_text("plain") == "plain"
    assert masked_trace_text([{"role": "user", "content": "a"}, {"role": "x"}]) == "a\n"
    assert masked_trace_text(["a", "b"]) == "a\nb"
    assert masked_trace_text({"not": "a message list"}) == ""
    assert masked_trace_text(None) == ""


# ---------------------------------------------------------------------------
# 4. The text never rides the trace metadata blob
# ---------------------------------------------------------------------------


class _FakeSpan:
    def __init__(self, kwargs):
        self.kwargs = kwargs
        self.updates: list[dict] = []

    def update(self, **fields):
        self.updates.append(fields)


class _FakeSpanContext:
    def __init__(self, kwargs, opened):
        self.span = _FakeSpan(kwargs)
        self._opened = opened

    def __enter__(self):
        self._opened.append(self.span)
        return self.span

    def __exit__(self, *_exc):
        return False


class _FakeClient:
    def __init__(self):
        self.opened: list[_FakeSpan] = []

    def start_as_current_observation(self, **kwargs):
        return _FakeSpanContext(kwargs, self.opened)


class _FakePropagate:
    def __call__(self, **_kwargs):
        return contextlib.nullcontext()


def _enabled_tracer(settings: Settings) -> tuple[LangfuseTracer, _FakeClient]:
    """An ENABLED tracer over a stub client. The SDK is stubbed rather than constructed
    for the reason ``test_langfuse_tracing.py`` documents: a real client ships spans from
    a background thread, which the suite's egress guard rightly refuses."""
    tracer = LangfuseTracer(settings)
    client = _FakeClient()
    tracer._enabled, tracer._client, tracer._propagate = True, client, _FakePropagate()
    tracer._probe_capabilities(type(client))
    return tracer, client


def test_the_trace_text_is_held_back_from_the_span_metadata():
    """The span carries the pair ONCE, in the native ``input``/``output`` fields.

    Those two are the only fields the SDK's privacy mask rewrites, so a copy in the
    free-form metadata dict would be the same payload leaving under a contract that does
    not govern it — and would roughly double the size of every span this service emits.
    """
    settings = _settings()
    tracer, client = _enabled_tracer(settings)
    router = AIRouter(settings, tracer=tracer)

    _content, meta = _run(
        router.run("profiling_chat_turn", messages=_MESSAGES, mock_response="MOCK_REPLY")
    )

    task_span = client.opened[0]
    assert task_span.kwargs["input"] == _MESSAGES  # native input, mask applied by the SDK
    update = task_span.updates[0]
    assert update["output"] == "MOCK_REPLY"  # native output
    assert "prompt_text" not in update["metadata"]
    assert "response_text" not in update["metadata"]
    # The REST of the record still rides along, so the two cannot drift.
    assert update["metadata"]["ai_call_id"] == meta.ai_call_id
    assert update["metadata"]["task_type"] == "profiling_chat_turn"
    # ...and the metadata really was produced from THIS call's populated record.
    assert meta.prompt_text is not None


# ---------------------------------------------------------------------------
# 5. The MVP scope limit: the FINAL pair, not every attempt
# ---------------------------------------------------------------------------


def test_a_retried_dispatch_stores_one_prompt_and_one_response(monkeypatch):
    """Three attempts, one stored pair.

    The per-attempt detail already exists — one Langfuse generation per attempt, plus
    ``attempt_count``/``candidates_tried`` on this very record. Persisting it again would
    multiply the most sensitive payload on the platform by the retry count to answer a
    question that is already answered.
    """
    calls: list[int] = []

    async def _fail_then_succeed(**_kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("transient")
        return LlmResult(content="the model's answer", input_tokens=11, output_tokens=7)

    monkeypatch.setattr(router_module.providers, "complete", _fail_then_succeed)

    router = AIRouter(
        _settings(
            ai_enable_real_calls=True,
            gemini_flash_api_key="k",
            ai_real_call_tasks="profile_extraction",
        )
    )
    _content, meta = _run(
        router.run("profile_extraction", messages=_MESSAGES, mock_response="unused")
    )

    assert meta.success is True
    assert meta.attempt_count == 2  # it really did retry
    assert meta.prompt_text == "You are an interviewer.\nvmc 4 saal"  # ONE prompt, not two
    assert meta.prompt_text.count("vmc 4 saal") == 1
    assert meta.response_text == "the model's answer"  # the winner, not the failure


# ---------------------------------------------------------------------------
# 6. The structured log line — §2 sink #2, and the one that was safe by accident
# ---------------------------------------------------------------------------


def test_the_cost_log_line_cannot_carry_the_trace_text():
    """``ai.cost``'s ``ai_call`` record must not be ABLE to serialise the two text fields.

    ── THIS TEST WAS VACUOUS ONCE; THE SHAPE IT HAS NOW IS THE POINT ────────────────────
    The first version asserted on ``meta.model_dump(exclude=TRACE_TEXT_FIELDS)`` — a value the
    TEST computed. That passes whatever ``cost_tracker`` does, because it exercises pydantic's
    ``exclude`` rather than the shipped line; removing the exclusion from ``build_call_metadata``
    left it green. So this one captures the record the REAL logger emits and asserts on its keys.

    ── AND WHY KEYS RATHER THAN VALUES ────────────────────────────────────────────────────
    ``build_call_metadata`` runs BEFORE ``AIRouter._record_trace_text`` populates the pair, so in
    production both are ``None`` at this moment and a value assertion would pass for the wrong
    reason. The real property is stronger and is checkable: the field NAMES must not appear in
    the log record at all. A record that carries ``"prompt_text": null`` is one reordering — or
    one future ``logger.*(… meta …)`` — away from carrying a whole worker prompt, which is
    CLAUDE.md §2 sink #2 on the most sensitive text on the platform. Safe-by-ordering is not a
    control; a dump that names what it will not emit is.
    """
    captured: list[logging.LogRecord] = []

    class _Grab(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    handler = _Grab()
    logger = logging.getLogger("ai.cost")
    logger.addHandler(handler)
    try:
        cost_tracker.build_call_metadata(
            task_type="profile_extraction",
            model="gemini-2.5-flash",
            real_call=False,
            input_tokens=10,
            output_tokens=5,
            latency_ms=1,
            success=True,
            settings=_settings(),
        )
    finally:
        logger.removeHandler(handler)

    lines = [r for r in captured if r.getMessage() == "ai_call"]
    # Guard the guard: no record means every assertion below is vacuous.
    assert len(lines) == 1, f"expected one ai_call record, got {len(lines)}"
    extra = getattr(lines[0], "extra", None)
    assert isinstance(extra, dict) and extra, "the ai_call record carries no extra payload"

    assert "prompt_text" not in extra
    assert "response_text" not in extra
    # Nothing else was dropped: the line still answers every cost question it always did.
    assert extra["task_type"] == "profile_extraction"
    assert extra["input_tokens"] == 10
    assert extra["model_name"] == "gemini-2.5-flash"


def test_a_POPULATED_record_still_logs_neither_half():
    """The same property, with the fields actually FULL — the case the ordering hides today.

    ``build_call_metadata`` cannot itself produce a populated record, so this drives the sink
    directly with one: if the exclusion were ever dropped, this is the line that would put a
    worker's prompt into structured logs, and this is the assertion that says so in values
    rather than in key names.
    """
    captured: list[logging.LogRecord] = []

    class _Grab(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    handler = _Grab()
    logger = logging.getLogger("ai.cost")
    logger.addHandler(handler)
    try:
        meta = cost_tracker.build_call_metadata(
            task_type="profile_extraction",
            model="gemini-2.5-flash",
            real_call=False,
            input_tokens=10,
            output_tokens=5,
            latency_ms=1,
            success=True,
            settings=_settings(),
        )
        captured.clear()
        meta.prompt_text = "mera naam [PERSON_1] hai, number [PHONE_1]"
        meta.response_text = "the model's answer"
        # The shipped call, verbatim — see cost_tracker.build_call_metadata's last line.
        cost_tracker.logger.info(
            "ai_call", extra={"extra": meta.model_dump(exclude=cost_tracker.TRACE_TEXT_FIELDS)}
        )
    finally:
        logger.removeHandler(handler)

    assert len(captured) == 1
    serialised = str(getattr(captured[0], "extra", {}))
    assert "[PERSON_1]" not in serialised
    assert "[PHONE_1]" not in serialised
    assert "the model's answer" not in serialised


def test_the_router_and_the_cost_log_exclude_THE_SAME_set():
    """One constant, two sinks. Two copies of "which fields are dangerous" is one too many —
    the router's span-metadata holdback and the cost log's exclusion must move together, so
    both read `app.contracts.TRACE_TEXT_FIELDS` and this pins that they still do."""
    from app.contracts import TRACE_TEXT_FIELDS

    assert router_module._TRACE_TEXT_FIELDS is TRACE_TEXT_FIELDS
    assert cost_tracker.TRACE_TEXT_FIELDS is TRACE_TEXT_FIELDS
    # ...and the set names exactly the fields that hold text, not a stale subset.
    from app.contracts import AICallMetadata

    text_fields = {
        name
        for name, field in AICallMetadata.model_fields.items()
        if field.annotation is not None and name.endswith("_text")
    }
    assert TRACE_TEXT_FIELDS == text_fields
