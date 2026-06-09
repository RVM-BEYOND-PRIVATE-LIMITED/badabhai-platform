"""Langfuse wrapper tests — must be a safe no-op when keys/package are missing."""

from app.ai.langfuse_tracing import LangfuseTracer
from app.config import Settings


def test_disabled_when_keys_missing():
    tracer = LangfuseTracer(Settings())  # no langfuse keys
    assert tracer.enabled is False


def test_trace_is_noop_and_never_raises_when_disabled():
    tracer = LangfuseTracer(Settings())
    # Must not raise even though tracing is disabled.
    tracer.trace_generation(
        task_type="profiling_chat_turn",
        model="gemini-flash-lite",
        real_call=False,
        input_text="[CITY_1] me vmc operator",
        output_text="Badhiya bhai.",
        metadata={"estimated_cost_inr": 0.0},
    )


def test_keys_present_never_crashes_init():
    # Keys set. Whether or not the langfuse package is installed, init must never
    # raise — it degrades to disabled when the package/host is unavailable.
    tracer = LangfuseTracer(
        Settings(langfuse_public_key="pk-test", langfuse_secret_key="sk-test")
    )
    assert isinstance(tracer.enabled, bool)
