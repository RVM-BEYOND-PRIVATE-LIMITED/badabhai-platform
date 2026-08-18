"""The observability layer added on top of the Langfuse wrapper.

WHAT THESE PIN, and why each one is here rather than being obvious:

1. THE HIERARCHY IS REAL. A workflow is the trace root and a task nests under it, while a
   task opened ALONE is still its own root. The second half is what let the workflow layer
   be added without touching a single existing call site, so it is pinned as hard as the
   first.
2. CORRELATION IS DETERMINISTIC. Two ai-service calls carrying the same BL-19 correlation
   id must derive the SAME Langfuse trace id, because that is the entire mechanism behind
   cross-service correlation — there is no shared store, only a pure function.
3. THE PROMPT VERSION IS ALWAYS RECORDED. Including — especially — with Langfuse prompt
   management OFF, which is the committed default. A content hash is a real version.
4. EVERY OPTIONAL SDK SURFACE DEGRADES TO A NO-OP. The `langfuse` package is not installed
   in dev or CI, so the exact method names for scoring, prompt fetching and trace
   continuation are unverifiable here. The wrapper therefore BINDS THEM BY PROBE, and these
   tests pin that a client exposing none of them, or a client whose methods all explode, is
   survivable rather than fatal.
5. LANGFUSE FAILING CANNOT FAIL AN AI CALL. Pinned end-to-end through the real router.

THE SDK IS STUBBED, NOT CONSTRUCTED — the same choice `test_langfuse_tracing.py` documents:
a real client registers an OTel exporter that ships spans from a background thread, which
the suite's outbound-network guard rightly refuses. Stubbing also lets these assert what the
SDK was actually HANDED, which is the half that silently regresses.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util

import pytest

from app.ai import cost_tracker, error_taxonomy, prompt_registry, trace_metadata
from app.ai.gemini_client import LlmResult
from app.ai.langfuse_tracing import (
    SCORE_BOOLEAN,
    SCORE_NUMERIC,
    LangfuseTracer,
    current_workflow,
    derive_trace_id,
)
from app.ai.provider_cooldown import reset_cooldown
from app.ai.router import AIRouter
from app.config import Settings


@pytest.fixture(autouse=True)
def _isolate_process_singletons():
    """Reset the two PROCESS-WIDE singletons the router reads, before every test.

    NOT boilerplate — the first draft of this file failed without it, and instructively.
    ``test_a_rate_limit_...`` arms the provider cooldown for "google", the cooldown is a
    module singleton with in-process state, and the NEXT test then found every candidate
    skipped as rate-limited and silently served a mock. The symptom was an assertion about
    Langfuse failing on a test that has nothing to do with Langfuse, which is the most
    expensive kind of test failure to read.

    The spend ledger gets the same treatment for the reason ``test_spend_cap`` documents:
    rebuilt from `_env_file=None` so an ambient AI_SPEND_REDIS_URL cannot make these
    machine-dependent.
    """
    reset_cooldown()
    cost_tracker._ledger = cost_tracker.SpendLedger(
        Settings(_env_file=None, ai_spend_redis_url=None)
    )
    yield
    reset_cooldown()
    cost_tracker._ledger = None


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeSpan:
    def __init__(self, kwargs):
        self.kwargs = kwargs
        self.updates = []

    def update(self, **fields):
        self.updates.append(fields)


class _FakeSpanContext:
    def __init__(self, kwargs, opened):
        self.span = _FakeSpan(kwargs)
        self._opened = opened

    def __enter__(self):
        self._opened.append(self.span)
        return self.span

    def __exit__(self, *exc):
        return False


class _FakePrompt:
    def __init__(self, text, version):
        self.prompt = text
        self.version = version


class _FakeClient:
    """A client exposing the FULL optional surface, so the probe binds everything."""

    def __init__(self, prompt: _FakePrompt | None = None):
        self.opened: list[_FakeSpan] = []
        self.scores: list[dict] = []
        self.prompt_calls: list[str] = []
        self._prompt = prompt

    def start_as_current_observation(self, **kwargs):
        return _FakeSpanContext(kwargs, self.opened)

    # Most-preferred scoring shape: attaches to the ACTIVE trace, needs no id from us.
    def score_current_trace(self, **kwargs):
        self.scores.append(kwargs)

    def get_prompt(self, name, **_kwargs):
        self.prompt_calls.append(name)
        return self._prompt


class _MinimalClient:
    """A client exposing ONLY span creation — no scores, no prompts, no continuation.

    This is the shape an older or newer SDK could present, and the one that must degrade
    silently instead of raising AttributeError inside a worker's interview.
    """

    def __init__(self):
        self.opened: list[_FakeSpan] = []

    def start_as_current_observation(self, **kwargs):
        return _FakeSpanContext(kwargs, self.opened)


class _FakePropagate:
    def __init__(self):
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return contextlib.nullcontext()


def _tracer(client=None, *, settings: Settings | None = None):
    """An ENABLED tracer over a stub client, with capabilities probed for real.

    `_probe_capabilities` is invoked deliberately rather than hand-setting the bindings:
    the probe is itself the thing most likely to break against a real SDK, so every test
    here exercises it.
    """
    tracer = LangfuseTracer(settings or Settings())
    client = client if client is not None else _FakeClient()
    tracer._enabled, tracer._client, tracer._propagate = True, client, _FakePropagate()
    tracer._probe_capabilities(type(client))
    return tracer, client


# ---------------------------------------------------------------------------
# trace_metadata — the standardized shape
# ---------------------------------------------------------------------------


def test_metadata_always_names_the_service_and_omits_absent_fields():
    meta = trace_metadata.build(workflow="build-worker-profile", task="profile_parse")
    assert meta["service"] == "ai-service"
    assert meta["workflow"] == "build-worker-profile"
    # OMITTED, not null-filled. A key present with a null value still creates a filter in
    # the Langfuse UI that can never match anything.
    assert "provider" not in meta
    assert "prompt_version" not in meta


def test_metadata_never_duplicates_a_native_langfuse_field():
    # model / environment / tokens / latency all have first-class homes on the SDK object.
    # Duplicating one means two copies that drift, and the native one is what the UI, the
    # pricing table and the evaluators actually read.
    meta = trace_metadata.build(
        workflow="w", task="t", provider="google", application_version="abc123"
    )
    for native in ("model", "environment", "usage_details", "latency_ms", "user_id", "tags"):
        assert native not in meta


def test_extra_may_override_a_standard_key():
    # The call site is closer to the truth than the builder; a silent drop would be worse.
    meta = trace_metadata.build(task="a", extra={"task": "b"})
    assert meta["task"] == "b"


def test_model_parameters_are_separate_from_metadata():
    params = trace_metadata.model_parameters(temperature=0.0, max_output_tokens=1024)
    assert params == {"temperature": 0.0, "max_output_tokens": 1024}


# ---------------------------------------------------------------------------
# error_taxonomy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        ("http_429", error_taxonomy.RATE_LIMIT),
        ("http_error", error_taxonomy.PROVIDER_ERROR),
        ("missing_key", error_taxonomy.AUTHENTICATION_ERROR),
        ("max_tokens_no_parts", error_taxonomy.OUTPUT_TRUNCATED),
        ("no_text_content", error_taxonomy.INVALID_OUTPUT),
        ("TimeoutError", error_taxonomy.TIMEOUT),
        ("ConnectError", error_taxonomy.NETWORK_ERROR),
    ],
)
def test_transport_reasons_map_to_categories(reason, expected):
    assert error_taxonomy.categorize_transport(reason) == expected


def test_an_unknown_code_becomes_unknown_and_never_echoes_itself():
    # THE PRIVACY PROPERTY. An untyped failure is reduced to its exception CLASS NAME
    # upstream, but if that ever carried text, echoing the input as the category would put
    # it on a trace attribute. "unknown" is the only safe fallback.
    weird = "SomeVendorError: worker said 9876543210"
    assert error_taxonomy.categorize_transport(weird) == error_taxonomy.UNKNOWN
    assert error_taxonomy.categorize_transport(weird) in error_taxonomy.CATEGORIES


def test_spend_store_unavailable_is_a_config_error_not_a_budget_stop():
    # Conflating these two already cost this project a debugging round — an unreachable
    # ledger presented as "you hit your cap". The category must keep them apart.
    assert error_taxonomy.categorize_terminal("spend_store_unavailable") == (
        error_taxonomy.CONFIG_ERROR
    )
    assert error_taxonomy.categorize_terminal("daily_cap_exceeded") == (
        error_taxonomy.BUDGET_BLOCKED
    )


def test_a_successful_call_has_no_error_category():
    # None, deliberately not "unknown": giving a healthy call an error category would put
    # every success into a dashboard slice named after a failure.
    assert error_taxonomy.categorize_terminal(None) is None


# ---------------------------------------------------------------------------
# prompt_registry
# ---------------------------------------------------------------------------


def test_local_prompt_gets_a_real_deterministic_version():
    prompt_registry.register("t-local", lambda: "you are a helpful assistant")
    a = prompt_registry.resolve("t-local")
    b = prompt_registry.resolve("t-local")
    assert a is not None and a.source == prompt_registry.SOURCE_LOCAL
    assert a.version.startswith("local:")
    assert a.version == b.version  # stable across calls
    assert a.client is None  # nothing to link to; the text did not come from Langfuse


def test_the_version_changes_when_and_only_when_the_prompt_changes():
    assert prompt_registry.local_version("a") == prompt_registry.local_version("a")
    assert prompt_registry.local_version("a") != prompt_registry.local_version("a ")


def test_an_unregistered_prompt_returns_none_rather_than_raising():
    assert prompt_registry.resolve("nobody-registered-this") is None


def test_langfuse_override_is_off_by_default():
    # The committed default must be byte-identical to life before prompt management.
    tracer, client = _tracer(_FakeClient(_FakePrompt("REMOTE", 7)))
    prompt_registry.register("t-default", lambda: "LOCAL")
    resolved = prompt_registry.resolve("t-default", tracer=tracer)
    assert resolved.text == "LOCAL"
    assert resolved.source == prompt_registry.SOURCE_LOCAL
    assert client.prompt_calls == []  # not even fetched


def test_langfuse_override_applies_when_explicitly_enabled():
    tracer, client = _tracer(
        _FakeClient(_FakePrompt("REMOTE", 7)),
        settings=Settings(langfuse_prompts_enabled=True),
    )
    prompt_registry.register("t-remote", lambda: "LOCAL")
    resolved = prompt_registry.resolve("t-remote", tracer=tracer)
    assert resolved.text == "REMOTE"
    assert resolved.version == "langfuse:v7"
    assert resolved.is_langfuse_managed
    # The SDK's own object rides along so the generation can be LINKED to the managed
    # prompt — that link is what lights up Langfuse's per-prompt metrics.
    assert resolved.client is not None
    assert client.prompt_calls == ["t-remote"]


def test_a_failing_or_empty_langfuse_fetch_falls_back_to_local():
    prompt_registry.register("t-fallback", lambda: "LOCAL")

    class _Exploding(_FakeClient):
        def get_prompt(self, name, **_kwargs):
            raise RuntimeError("langfuse is having a day")

    for client in (_Exploding(), _FakeClient(_FakePrompt("   ", 2)), _FakeClient(None)):
        tracer, _ = _tracer(client, settings=Settings(langfuse_prompts_enabled=True))
        resolved = prompt_registry.resolve("t-fallback", tracer=tracer)
        assert resolved.text == "LOCAL", f"{type(client).__name__} did not fall back"
        assert resolved.source == prompt_registry.SOURCE_LOCAL


def test_the_three_production_prompts_register_and_are_non_empty():
    prompt_registry.install_default_prompts()
    for name in (
        prompt_registry.INTERVIEW_TURN,
        prompt_registry.INTERVIEW_EXTRACT,
        prompt_registry.PROFILE_PARSE,
    ):
        resolved = prompt_registry.resolve(name)
        assert resolved is not None and resolved.text.strip(), name


# ---------------------------------------------------------------------------
# The workflow root + cross-service correlation
# ---------------------------------------------------------------------------


def test_a_workflow_is_the_root_and_a_task_nests_under_it():
    tracer, client = _tracer()
    with tracer.workflow(name="build-worker-profile", worker_ref="w_1"):
        with tracer.task(task_type="profile_parse"):
            pass
    root, child = client.opened
    assert root.kwargs["name"] == "build-worker-profile"
    assert child.kwargs["name"] == "parse-worker-profile"


def test_a_task_opened_alone_is_still_its_own_root():
    # The compatibility property that let the workflow layer land without touching a single
    # existing call site. If this breaks, every un-migrated route loses its trace.
    tracer, client = _tracer()
    with tracer.task(task_type="profile_parse", user_ref="w_1"):
        pass
    (span,) = client.opened
    assert span.kwargs["name"] == "parse-worker-profile"


def test_the_same_correlation_id_always_derives_the_same_trace_id():
    # THE WHOLE CROSS-SERVICE MECHANISM. There is no shared store between NestJS and this
    # service — only this pure function — so a drift here silently splits one workflow into
    # several unrelated traces.
    cid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    assert derive_trace_id(cid) == derive_trace_id(cid)
    assert derive_trace_id(cid) != derive_trace_id("other")
    # 32 lowercase hex = the W3C/OTel trace-id shape Langfuse expects.
    assert len(derive_trace_id(cid)) == 32
    assert derive_trace_id(cid) == derive_trace_id(cid).lower()
    int(derive_trace_id(cid), 16)  # raises if it is not hex


def test_the_correlation_id_is_never_published_verbatim_as_the_trace_id():
    # Hashed rather than hex-stripped, so the two identifier spaces stay independent and a
    # trace id stays opaque to anyone holding only a log line.
    cid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    assert derive_trace_id(cid) != cid.replace("-", "")


class _HashingIdClient(_FakeClient):
    """A client whose ``create_trace_id`` HASHES its seed, like the real SDK's.

    The other fakes here have no ``create_trace_id`` at all, so `_sdk_trace_id` returns
    its input unchanged and the normalisation step is invisible to them. That is exactly
    why the bug below survived every one of them.
    """

    @staticmethod
    def create_trace_id(seed):
        # Non-idempotent by construction, which is the property that matters:
        # f(f(x)) != f(x). Verified against langfuse 4.14.4, where
        # derive_trace_id -> d1bfaf4a... but create_trace_id(seed=that) -> bf268f59...
        import hashlib

        return hashlib.sha256(("salt" + seed).encode()).hexdigest()[:32]


def test_the_trace_id_is_normalised_EXACTLY_ONCE_across_workflow_task_and_accessor():
    """REGRESSION. Found by probing the real SDK, invisible to every fake before this one.

    `Langfuse.create_trace_id(seed=...)` hashes its seed rather than passing it through,
    so normalising at each use site instead of once at the source produced two distinct
    failures:

      1. `current_trace_id()` returned the UN-normalised id while the span carried the
         normalised one — so a score addressed by explicit trace_id would have attached
         to a trace that does not exist. (Latent: the probe binds `score_current_trace`,
         which addresses the active trace and takes no id.)
      2. A task nested in a workflow re-normalised an ALREADY-normalised id, hashing it a
         second time — giving the child a different trace id from its parent and
         splitting one logical workflow into two unrelated traces.

    One id, everywhere, is the whole contract.
    """
    tracer, client = _tracer(_HashingIdClient())
    assert tracer._trace_id_fn is not None, "the fake must expose create_trace_id"

    cid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    with tracer.workflow(name="build-worker-profile", correlation_id=cid):
        with tracer.task(task_type="profile_parse"):
            pass
        reported = tracer.current_trace_id()

    root, child = client.opened
    root_id = root.kwargs["trace_context"]["trace_id"]
    child_id = child.kwargs["trace_context"]["trace_id"]

    assert root_id == child_id, "parent and child must share ONE trace"
    assert reported == root_id, "current_trace_id() must return the id the span carries"
    # And it must be the seed hashed ONCE, never twice.
    assert root_id == _HashingIdClient.create_trace_id(derive_trace_id(cid))
    assert root_id != _HashingIdClient.create_trace_id(root_id)


def test_a_task_inherits_the_workflow_user_instead_of_clearing_it():
    # propagate_attributes(user_id=None) inside an open workflow would CLEAR the user the
    # workflow had just set — the whole per-worker cost view would go blank.
    tracer, _client = _tracer()
    propagate = tracer._propagate
    with tracer.workflow(name="build-worker-profile", worker_ref="w_9", session_id="s_1"):
        with tracer.task(task_type="profile_parse"):  # no user_ref of its own
            pass
    assert propagate.calls[-1]["user_id"] == "w_9"
    assert propagate.calls[-1]["session_id"] == "s_1"


def test_the_workflow_context_is_set_even_when_tracing_is_disabled():
    # The router reads it to stamp `workflow` into metadata; a mock-mode run must carry the
    # same shape as a real one or the two are not comparable.
    tracer = LangfuseTracer(Settings())
    assert tracer.enabled is False
    with tracer.workflow(name="build-worker-profile", worker_ref="w_1"):
        ctx = current_workflow()
        assert ctx is not None and ctx.workflow == "build-worker-profile"
    assert current_workflow() is None  # and it is reset on exit


# ---------------------------------------------------------------------------
# Capability probing + scores
# ---------------------------------------------------------------------------


def test_the_probe_reports_what_it_bound():
    tracer, _ = _tracer(_FakeClient())
    assert tracer.capabilities["scores"] == "current"
    assert tracer.capabilities["prompt_management"] is True


def test_a_minimal_client_reports_unavailable_rather_than_pretending():
    # The readout is the point: without it, "no scores in Langfuse" and "this SDK has no
    # scoring method" look identical from outside, and only one of them is a bug.
    tracer, _ = _tracer(_MinimalClient())
    assert tracer.capabilities["scores"] == "unavailable"
    assert tracer.capabilities["prompt_management"] is False


def test_scores_are_recorded_with_their_data_type():
    tracer, client = _tracer()
    tracer.record_score(name="parse_gate_acceptance", value=0.8, data_type=SCORE_NUMERIC)
    tracer.record_score(name="contract_valid", value=True, data_type=SCORE_BOOLEAN)
    assert client.scores[0] == {
        "name": "parse_gate_acceptance",
        "value": 0.8,
        "data_type": SCORE_NUMERIC,
    }
    # Booleans go over the wire as 1/0.
    assert client.scores[1]["value"] == 1


def test_scoring_a_client_that_cannot_score_is_a_silent_noop():
    tracer, _ = _tracer(_MinimalClient())
    tracer.record_score(name="x", value=1.0)  # must not raise


def test_a_score_method_that_explodes_cannot_break_the_caller():
    class _Exploding(_FakeClient):
        def score_current_trace(self, **kwargs):
            raise RuntimeError("langfuse is having a day")

    tracer, _ = _tracer(_Exploding())
    tracer.record_score(name="x", value=1.0)  # must not raise


# ---------------------------------------------------------------------------
# End-to-end through the REAL router
# ---------------------------------------------------------------------------


def _run(coro):
    """Drive one coroutine to completion.

    `asyncio.run` rather than `@pytest.mark.anyio`, matching `test_ai_router.py`: the anyio
    marker parametrizes every test over asyncio AND trio, and trio is not in
    requirements-dev.txt — so the marker would add a guaranteed-failing variant of every
    test below for no coverage gain. Nothing here is backend-specific.
    """
    return asyncio.run(coro)


def _real_settings(**overrides):
    base = dict(
        ai_enable_real_calls=True,
        gemini_flash_api_key="gem-key",
        ai_real_call_tasks="profile_parse",
        default_capable_model="gemini-2.5-flash",
        # Keep the chain single-provider so these assert on attempts, not on fallback.
        default_fallback_model="",
    )
    base.update(overrides)
    return Settings(**base)


def _generations(client):
    return [s for s in client.opened if s.kwargs.get("as_type") == "generation"]


def test_a_real_call_records_a_generation_with_the_full_metadata(monkeypatch):
    from app.ai import router as router_module

    async def _ok(**_kwargs):
        return LlmResult("{}", 91, 12)

    monkeypatch.setattr(router_module.providers, "complete", _ok)

    tracer, client = _tracer()
    prompt_registry.register("t-e2e", lambda: "SYSTEM PROMPT")
    prompt = prompt_registry.resolve("t-e2e")

    ai = AIRouter(_real_settings(), tracer=tracer)
    with tracer.workflow(name="build-worker-profile", worker_ref="w_1"):
        content, meta = _run(
            ai.run(
                "profile_parse",
                messages=[{"role": "user", "content": "hi"}],
                mock_response="{}",
                prompt=prompt,
            )
        )

    assert meta.real_call is True and meta.success is True
    (gen,) = _generations(client)
    md = gen.kwargs["metadata"]
    # Part 7's inventory, as far as the architecture can actually supply it.
    assert md["service"] == "ai-service"
    assert md["workflow"] == "build-worker-profile"
    assert md["task"] == "profile_parse"
    assert md["provider"] == "google"
    assert md["attempt"] == 1
    assert md["prompt_name"] == "t-e2e"
    assert md["prompt_version"].startswith("local:")
    assert md["prompt_source"] == "local"
    # Native fields, not metadata.
    assert gen.kwargs["model"] == "gemini-2.5-flash"
    assert gen.kwargs["model_parameters"]["temperature"] == 0.0
    # Tokens are what Langfuse prices the call from.
    assert gen.updates[-1]["usage_details"] == {"input": 91, "output": 12}
    assert "estimated_cost_inr" in gen.updates[-1]["metadata"]


def test_each_real_provider_attempt_gets_exactly_one_generation(monkeypatch):
    # Part 9: one generation per ACTUAL provider request — never a synthetic one for an
    # internal retry that never left the process. profile_parse allows 2 retries => 3.
    from app.ai import router as router_module

    calls = {"n": 0}

    async def _boom(**_kwargs):
        calls["n"] += 1
        raise RuntimeError("nope")

    monkeypatch.setattr(router_module.providers, "complete", _boom)

    tracer, client = _tracer()
    ai = AIRouter(_real_settings(), tracer=tracer)
    _content, meta = _run(
        ai.run("profile_parse", messages=[{"role": "user", "content": "hi"}], mock_response="{}")
    )

    gens = _generations(client)
    assert len(gens) == calls["n"] == meta.attempt_count
    assert [g.kwargs["metadata"]["attempt"] for g in gens] == list(range(1, len(gens) + 1))
    # Every failed attempt carries BOTH grains: the specific code and the coarse category.
    for gen in gens:
        last = gen.updates[-1]
        assert last["level"] == "ERROR"
        assert last["status_message"] == "RuntimeError"
        assert last["metadata"]["error_category"] == error_taxonomy.UNKNOWN


def test_a_rate_limit_is_categorized_and_marked_unretryable(monkeypatch):
    from app.ai import router as router_module
    from app.ai.errors import REASON_HTTP_429, LlmTransportError

    async def _429(**_kwargs):
        raise LlmTransportError(REASON_HTTP_429, status_code=429)

    monkeypatch.setattr(router_module.providers, "complete", _429)

    tracer, client = _tracer()
    ai = AIRouter(_real_settings(), tracer=tracer)
    _run(ai.run("profile_parse", messages=[{"role": "user", "content": "hi"}], mock_response="{}"))

    gens = _generations(client)
    # A 429 breaks the attempt loop — retrying is how you STAY rate-limited.
    assert len(gens) == 1
    md = gens[0].updates[-1]["metadata"]
    assert md["error_category"] == error_taxonomy.RATE_LIMIT
    assert md["retryable"] is False


def test_a_totally_broken_langfuse_cannot_fail_a_real_ai_call(monkeypatch):
    """PART 21, end to end: LLM succeeds + Langfuse fails => the AI request still succeeds."""
    from app.ai import router as router_module

    async def _ok(**_kwargs):
        return LlmResult("the real answer", 5, 5)

    monkeypatch.setattr(router_module.providers, "complete", _ok)

    class _Hostile:
        """Every single SDK entry point raises."""

        def start_as_current_observation(self, **_kwargs):
            raise RuntimeError("exporter is down")

        def score_current_trace(self, **_kwargs):
            raise RuntimeError("exporter is down")

        def get_prompt(self, *_a, **_k):
            raise RuntimeError("exporter is down")

    tracer, _ = _tracer(_Hostile())

    def _hostile_propagate(**_kwargs):
        raise RuntimeError("exporter is down")

    tracer._propagate = _hostile_propagate

    ai = AIRouter(_real_settings(), tracer=tracer)
    with tracer.workflow(name="build-worker-profile", worker_ref="w_1"):
        content, meta = _run(
            ai.run(
                "profile_parse",
                messages=[{"role": "user", "content": "hi"}],
                mock_response="{}",
            )
        )
        tracer.record_score(name="parse_gate_acceptance", value=1.0)

    assert content == "the real answer"
    assert meta.real_call is True and meta.success is True


def test_mock_posture_still_traces_and_still_reports_no_real_call():
    # The calls an operator most needs to see are the ones that never reached a provider.
    tracer, client = _tracer()
    ai = AIRouter(Settings(ai_enable_real_calls=False), tracer=tracer)
    content, meta = _run(
        ai.run("profile_parse", messages=[{"role": "user", "content": "hi"}], mock_response="MOCK")
    )
    assert content == "MOCK" and meta.real_call is False
    assert _generations(client) == []  # no provider request happened, so no generation
    (task,) = client.opened
    assert task.updates[-1]["metadata"]["real_call"] is False


# ---------------------------------------------------------------------------
# The guard against shipping a silently-dead integration
# ---------------------------------------------------------------------------

_LANGFUSE_INSTALLED = importlib.util.find_spec("langfuse") is not None


@pytest.mark.skipif(_LANGFUSE_INSTALLED is False, reason="langfuse is an optional dependency")
def test_the_wrapper_calls_names_the_real_sdk_actually_exposes():
    """THE TEST THAT STOPS THIS WHOLE FEATURE SHIPPING DEAD.

    Every fake above accepts ``**kwargs``, so none of them can catch a wrong SDK method or
    keyword name — and because the wrapper is fail-open by design, a wrong name produces
    silence, not an error. This asserts the wrapper's assumptions against the INSTALLED
    package, and is skipped when it is absent (dev and CI do not install it; the Docker
    image does, via requirements-ai.txt).

    If this fails after a langfuse upgrade, the fix is in `_probe_capabilities` — not here.
    """
    import inspect as _inspect

    from langfuse import Langfuse, propagate_attributes  # type: ignore

    assert callable(propagate_attributes)
    for kwarg in ("public_key", "secret_key", "base_url", "environment", "mask"):
        assert kwarg in _inspect.signature(Langfuse).parameters, kwarg
    assert hasattr(Langfuse, "start_as_current_observation")
    # At least ONE scoring shape must exist, or `record_score` is decoration.
    assert any(
        hasattr(Langfuse, name) for name in ("score_current_trace", "create_score", "score")
    ), "no known scoring method on the installed Langfuse client"
