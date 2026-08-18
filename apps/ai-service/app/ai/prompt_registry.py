"""Which prompt produced this output — answered for every generation, always.

THE QUESTION THIS EXISTS TO ANSWER. "v1 vs v2" and "model A vs model B" are only
answerable if every generation records WHICH PROMPT TEXT it was run with. Today the prompts
are Python — ``interview_system_prompt()`` builds itself from ``persona.json`` at import
time — so there is no version anywhere, and two traces a month apart are silently
incomparable if someone edited a string in between.

THE DESIGN, and the ordering of these two sentences is the whole point:

1. THE LOCAL PROMPT IS THE SOURCE OF TRUTH. It ships in the image, it is code-reviewed, and
   it is what runs. Every prompt therefore gets a version WITHOUT Langfuse being involved
   at all: ``local:<sha256[:12]>`` of the exact text that was sent. That is a real,
   deterministic identifier — it changes when and only when the prompt changes — so
   prompt-version observability works on day one, with tracing off, with no network, and
   with no Langfuse account.

2. LANGFUSE MAY OVERRIDE IT, and only if someone deliberately turns that on.
   ``LANGFUSE_PROMPTS_ENABLED`` defaults to FALSE, so the committed behaviour is
   byte-identical to what shipped before this module existed. With it on, a fetch failure,
   a slow response, a missing prompt or a broken SDK all fall back to the local text — the
   service never becomes unavailable because an observability backend is.

WHY NOT MIGRATE THE PROMPTS WHOLESALE. ``interview_system_prompt`` is GENERATED from
``packages/profiling-lexicon/data/persona.json`` — the closed sets a human signed off — and
its own docstring records why: "it has to be generated from the same file the gate reads,
or the two drift the first time someone edits one of them". Moving that text into Langfuse
would put the persona rules somewhere the build-time gate cannot see, and the first edit in
the Langfuse UI would silently unhook the sign-off. So the local builder stays authoritative
and Langfuse management is opt-in per deployment, not per prompt.

WHAT A CALLER GETS. ``resolve(name)`` returns a :class:`ResolvedPrompt` carrying the text to
send, a version to record, and — when the prompt really did come from Langfuse — the SDK's
own prompt object, so the generation can be LINKED to it and Langfuse's prompt-metrics view
lights up. Never raises.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..logging_config import get_logger

logger = get_logger("ai.prompts")

#: Stable Langfuse prompt names. Treat these like the observation names in
#: ``langfuse_tracing``: renaming one unhooks every dashboard, evaluator and prompt-version
#: comparison that referenced it. Kebab-case to match the observation-name convention.
INTERVIEW_TURN = "worker-interview-turn"
INTERVIEW_EXTRACT = "worker-interview-extract"
PROFILE_PARSE = "profile-parse"

#: ``prompt_source`` values. Two, and they mean different things to an operator: "local"
#: says the deploy decides the prompt, "langfuse" says someone outside the deploy can.
SOURCE_LOCAL = "local"
SOURCE_LANGFUSE = "langfuse"


@dataclass(frozen=True)
class ResolvedPrompt:
    """The prompt to send, plus everything needed to record which one it was."""

    name: str
    text: str
    #: ``local:<sha12>`` or ``langfuse:v<n>``. Prefixed so the two id spaces can never be
    #: confused in a dashboard filter — a bare "3" would be meaningless next to a hash.
    version: str
    source: str
    #: The SDK's prompt object when the text came from Langfuse, else None. Passed straight
    #: through to the generation so Langfuse can associate the two; we never introspect it.
    client: Any | None = None

    @property
    def is_langfuse_managed(self) -> bool:
        return self.source == SOURCE_LANGFUSE


def local_version(text: str) -> str:
    """``local:<sha256[:12]>`` — a real version for a prompt nobody has versioned.

    A CONTENT HASH rather than a hand-maintained integer, because a hand-maintained integer
    is a promise somebody has to keep on every edit and this codebase already has prompts
    that are BUILT at runtime (persona interpolation), where "remember to bump it" has no
    natural home. The hash cannot be forgotten and cannot be wrong: it is computed from the
    exact bytes that went to the provider.

    12 hex chars = 48 bits. Collision risk across the handful of prompt versions this
    project will ever have is nil, and it stays readable in a trace attribute.
    """
    return f"{SOURCE_LOCAL}:{hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]}"


#: name -> zero-arg builder for the LOCAL text. Registered rather than imported at module
#: scope so this module stays free of a dependency cycle: ``profiling.interview_prompts``
#: reads persona data, and importing it here would make the AI package depend on the
#: profiling package for something only the profiling routes need.
_BUILDERS: dict[str, Callable[[], str]] = {}


def register(name: str, builder: Callable[[], str]) -> None:
    """Bind a prompt name to the function that produces its local text.

    Idempotent by overwrite: a re-register (module reloaded under pytest) replaces rather
    than raising, because a prompt registry that can fail at import time would take the
    whole service down for an observability concern.
    """
    _BUILDERS[name] = builder


def registered_names() -> tuple[str, ...]:
    """Every registered prompt name, sorted. Used by the seeding CLI and by tests that
    assert the registry and the routes have not drifted apart."""
    return tuple(sorted(_BUILDERS))


def _local(name: str) -> ResolvedPrompt | None:
    builder = _BUILDERS.get(name)
    if builder is None:
        # A caller asked for a prompt nobody registered. Loud in the log, None to the
        # caller — the caller then uses its own literal, which is what it did before.
        logger.warning("prompt not registered", extra={"extra": {"prompt": name}})
        return None
    try:
        text = builder()
    except Exception as exc:  # pragma: no cover - a builder is a pure string function
        logger.warning(
            "prompt builder failed", extra={"extra": {"prompt": name, "error": str(exc)}}
        )
        return None
    return ResolvedPrompt(name=name, text=text, version=local_version(text), source=SOURCE_LOCAL)


def resolve(name: str, tracer: Any | None = None) -> ResolvedPrompt | None:
    """The prompt to use right now. ``None`` only if the name was never registered.

    THE FALLBACK IS THE FEATURE. Every failure mode of the Langfuse path — management
    disabled, SDK missing the method, network down, prompt absent, malformed payload —
    lands on the same branch: return the local prompt. That is what keeps Part 21's
    guarantee ("Langfuse failure must not break AI") true for prompt management, which is
    the one Langfuse feature that would otherwise sit on the critical path of a real call.
    """
    local = _local(name)
    if local is None:
        return None
    if tracer is None:
        return local

    fetched = None
    try:
        fetched = tracer.fetch_prompt(name, fallback=local.text)
    except Exception as exc:  # pragma: no cover - fetch_prompt is itself fail-open
        logger.warning(
            "langfuse prompt fetch failed; using local",
            extra={"extra": {"prompt": name, "error": str(exc)}},
        )
    if fetched is None:
        return local

    client, text, version = fetched
    # A fetch that came back EMPTY is treated as a miss, not as an override. An empty
    # system prompt is not a valid experiment, it is a mistake, and running one would
    # silently degrade every reply on that route until somebody noticed.
    if not text or not text.strip():
        logger.warning("langfuse prompt was empty; using local", extra={"extra": {"prompt": name}})
        return local
    return ResolvedPrompt(
        name=name,
        text=text,
        version=f"{SOURCE_LANGFUSE}:v{version}" if version is not None else SOURCE_LANGFUSE,
        source=SOURCE_LANGFUSE,
        client=client,
    )


def install_default_prompts() -> None:
    """Register the three production prompts that sit on a live LLM path.

    EXACTLY THREE, and the boundary is evidence-based rather than tidy: these are the
    prompts behind the only three routes that reach a provider today —
    ``POST /profiling/turn`` (Phase A), ``POST /profiling/extract`` (Phase C) and
    ``POST /profile/parse``. ``build_resume`` in ``extraction.py`` is deterministic string
    assembly with no model behind it, and the legacy ``/profile/extract`` prompt is on a
    route the OIE cutover left behind — registering either would claim prompt management
    over text no provider ever sees.

    Imports are LOCAL to this function, deliberately: it is called from the FastAPI
    lifespan, so the profiling package is imported after app construction rather than at
    ``app.ai`` import time, and the AI package keeps no import-time dependency on the
    profiling package.
    """
    from ..profiling.interview_prompts import extract_system_prompt, interview_system_prompt
    from ..profiling.parse_prompt import PARSE_SYSTEM_PROMPT

    register(INTERVIEW_TURN, interview_system_prompt)
    register(INTERVIEW_EXTRACT, extract_system_prompt)
    register(PROFILE_PARSE, lambda: PARSE_SYSTEM_PROMPT)
