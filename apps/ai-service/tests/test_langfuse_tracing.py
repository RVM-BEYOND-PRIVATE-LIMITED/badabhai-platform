"""Langfuse wrapper tests.

Two properties are load-bearing and everything here exists to pin one of them:

1. TRACING IS OPTIONAL. Missing keys, a missing package or a broken client must
   degrade to a no-op, never to an exception — an interview must not be able to fail
   because an observability backend is unreachable.
2. TRACING IS NOT A PRIVACY HOLE. The mask re-runs the pseudonymization gate over
   everything the SDK is handed, and fails CLOSED on a payload the gate refuses.
"""

import contextlib

import pytest

from app.ai.langfuse_tracing import (
    REDACTED,
    LangfuseTracer,
    Observation,
    _mask,
    _trace_identity,
)
from app.config import Settings


# --- optional-by-construction ----------------------------------------------
def test_disabled_when_keys_missing():
    tracer = LangfuseTracer(Settings())  # no langfuse keys
    assert tracer.enabled is False


def test_task_and_observation_are_noops_when_disabled():
    tracer = LangfuseTracer(Settings())
    with tracer.task(
        task_type="profile_extraction", input=[{"role": "user", "content": "hi"}]
    ) as t:
        assert isinstance(t, Observation)
        # Must not raise even though there is nothing behind it.
        t.update(output="Theek hai.", metadata={"estimated_cost_inr": 0.0}, level="ERROR")
        with tracer.observation(name="llm-call", as_type="generation", model="gemini") as gen:
            gen.update(output="x", usage_details={"input": 1, "output": 2})


def test_flush_and_shutdown_are_noops_when_disabled():
    tracer = LangfuseTracer(Settings())
    tracer.flush()
    tracer.shutdown()


def test_keys_present_never_crashes_init():
    # Keys set. Whether or not the langfuse package is installed, init must never
    # raise — it degrades to disabled when the package/host is unavailable.
    tracer = LangfuseTracer(Settings(langfuse_public_key="pk-test", langfuse_secret_key="sk-test"))
    assert isinstance(tracer.enabled, bool)


# --- an ENABLED tracer, without a live SDK ---------------------------------
# The SDK is stubbed rather than constructed: a real client registers an OTel
# exporter that ships spans over the network from a background thread, which the
# suite's outbound-network guard rightly refuses. Stubbing also lets these assert
# what the SDK was actually HANDED, which is the part that can silently regress.
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


class _FakeClient:
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


def _enabled_tracer() -> tuple[LangfuseTracer, _FakeClient, _FakePropagate]:
    tracer = LangfuseTracer(Settings())
    client, propagate = _FakeClient(), _FakePropagate()
    tracer._enabled, tracer._client, tracer._propagate = True, client, propagate
    return tracer, client, propagate


def test_task_sets_stable_name_user_and_tags():
    tracer, client, propagate = _enabled_tracer()
    with tracer.task(
        task_type="profile_extraction", input=[{"role": "user", "content": "hi"}], user_ref="w_1"
    ) as task:
        task.update(output="done")

    (span,) = client.opened
    assert span.kwargs["name"] == "extract-worker-profile"  # verb-first, not the model
    assert span.kwargs["as_type"] == "span"
    assert span.updates == [{"output": "done"}]
    # user_id is the OPAQUE worker ref, and the attributes are propagated so the ROOT
    # span carries them too — not only its children.
    assert propagate.calls == [
        {
            "user_id": "w_1",
            "session_id": None,
            "tags": ["feature:profiling", "task:profile_extraction"],
        }
    ]


def test_task_tags_the_real_versus_mock_posture():
    tracer, _client, propagate = _enabled_tracer()
    with tracer.task(task_type="resume_generation", real_call=True):
        pass
    assert "real-call" in propagate.calls[0]["tags"]


def test_generation_carries_model_and_token_usage():
    tracer, client, _propagate = _enabled_tracer()
    with tracer.observation(name="llm-call", as_type="generation", model="gemini-flash") as gen:
        gen.update(output="ok", usage_details={"input": 91, "output": 12})

    (span,) = client.opened
    # `as_type` is load-bearing: only a generation carries model/tokens/cost.
    assert span.kwargs["as_type"] == "generation"
    assert span.kwargs["model"] == "gemini-flash"
    assert span.updates[0]["usage_details"] == {"input": 91, "output": 12}


# --- the contract the naive `try: with ...: yield` shape breaks -------------
# A caller's exception must propagate UNCHANGED through a traced block. The obvious
# implementation catches it, yields a second time and raises "generator didn't stop
# after throw()" from inside the observability layer — turning a provider timeout
# into a crash. Pinned on BOTH scopes, enabled and disabled.
@pytest.mark.parametrize("enabled", [False, True])
def test_body_exceptions_propagate_unchanged(enabled):
    tracer = _enabled_tracer()[0] if enabled else LangfuseTracer(Settings())
    with pytest.raises(ValueError, match="boom"):
        with tracer.task(task_type="resume_generation"):
            raise ValueError("boom")
    with pytest.raises(ValueError, match="boom"):
        with tracer.observation(name="llm-call", as_type="generation"):
            raise ValueError("boom")


def test_a_broken_sdk_degrades_to_a_noop_instead_of_raising():
    tracer, _client, _propagate = _enabled_tracer()

    def _explode(**_kwargs):
        raise RuntimeError("sdk is having a day")

    tracer._client.start_as_current_observation = _explode
    with tracer.task(task_type="profile_extraction") as task:
        task.update(output="the caller's work still finishes")


# --- the privacy mask -------------------------------------------------------
def test_mask_redacts_pii_that_slipped_through():
    # A phone number is exactly what must never reach an observability backend.
    masked = _mask(data="call me on 9876543210")
    assert "9876543210" not in masked


def test_mask_walks_containers():
    masked = _mask(data=[{"role": "user", "content": "reach me at 9876543210"}])
    assert "9876543210" not in masked[0]["content"]
    assert masked[0]["role"] == "user"  # structure preserved


def test_mask_fails_closed_on_a_blocked_payload():
    # Over the gate's length cap => blocked => the WHOLE payload is dropped rather
    # than exported unmasked.
    assert _mask(data="x" * 20_001) == REDACTED


def test_mask_leaves_non_text_scalars_alone():
    # Token counts, INR estimates and flags are the useful half of a trace and carry
    # no identity — rewriting them would only degrade the trace.
    assert _mask(data={"input_tokens": 91, "cost_inr": 0.02, "real_call": True, "e": None}) == {
        "input_tokens": 91,
        "cost_inr": 0.02,
        "real_call": True,
        "e": None,
    }


def test_mask_never_raises_on_odd_input():
    class Odd:
        def __str__(self) -> str:
            raise RuntimeError("nope")

    odd = Odd()
    assert _mask(data=odd) is odd  # passed through, no exception


# --- naming -----------------------------------------------------------------
def test_trace_identity_maps_known_tasks_and_keeps_unknown_ones():
    assert _trace_identity("profile_extraction") == ("extract-worker-profile", "profiling")
    # An unmapped task keeps its own identity instead of vanishing into a bucket.
    assert _trace_identity("some_new_task") == ("some-new-task", "other")
