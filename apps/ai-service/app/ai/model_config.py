"""Task → model routing configuration.

Routing is config-driven: each AI task maps to a model *tier* (cheap/capable),
token limits, and call behavior. Concrete model names come from ``Settings`` so
they can change via env without code changes.

The INR cost table is an ESTIMATE used only for guardrails/alerts (not billing).
"""

from __future__ import annotations

import functools
import logging
from collections.abc import Mapping
from dataclasses import dataclass, replace
from types import MappingProxyType
from typing import Literal

from ..config import Settings

logger = logging.getLogger(__name__)

TaskType = Literal["profiling_chat_turn", "profile_extraction", "resume_generation"]
# THREE TIERS, AND THE THIRD EXISTS TO KEEP THE SECOND PINNED (#1237).
#
# `capable` used to be the top of the scale, so raising chat quality meant raising
# `default_capable_model` — which is ALSO what `profile_extraction` and `profile_parse`
# resolve through. That single knob is pinned to `gemini-2.5-flash` by an open GO/NO-GO item
# (docs/ai/real-llm-flip-go-no-go.md Finding 4: validation-model must equal flip-model) and by
# an executable guard (tests/test_extraction_model_pin.py). Moving it to improve the CHAT turn
# would have silently re-pointed two extraction paths at a model their funded 56-case
# re-validation never ran on, and the only task that is live today is the chat turn.
#
# `pro` decouples them: chat points here, extraction and parse stay on `capable`, and the pin
# holds. This is a tier ABOVE capable, not a rename of it.
ModelTier = Literal["cheap", "capable", "pro"]


@dataclass(frozen=True)
class TaskRoute:
    task_type: str
    tier: ModelTier
    max_output_tokens: int
    temperature: float
    json_mode: bool
    max_retries: int
    #: An EXPLICIT model for a task that must not ride a tier default — ADR-0046 O7's career
    #: answer, whose primary is Claude while every tier resolves to Gemini. `None` = resolve
    #: from `tier`. Additive: every existing construction leaves it unset; `get_route` sets it
    #: last for a tier task when Claude goes first (`ai_primary_provider`, #2170).
    model: str | None = None
    #: The cross-provider fallback for THIS task, used when the global
    #: `default_fallback_model` is the SAME provider as the primary (Claude primary → Gemini
    #: fallback, O7). `None` = the router's existing `default_fallback_model` rule. Still
    #: subject to the router's provider-differs and transport-available gates.
    fallback_model: str | None = None
    #: A per-ATTEMPT deadline the router enforces around the provider call (ADR-0054), for a
    #: task whose caller waits a fixed time and whose provider call has no tight bound of its own
    #: (the Anthropic SDK's default timeout is ten minutes). `None` = no router deadline, which
    #: is every route but the news answer's: their calls run exactly as before the field existed.
    timeout_seconds: float | None = None


# Routing rules. The SHAPE of a route is code (which tasks exist, whether each
# needs strict JSON); the NUMBERS are config, because they are the levers that
# decide answer quality and per-turn cost and they should not need a deploy.
#
# json_mode is deliberately NOT configurable. It is a correctness requirement, not
# a tuning knob: the chat turn and the extraction both parse the response as a JSON
# object, and without json_mode the model writes a prose preamble BEFORE the JSON,
# intermittently exhausting the token budget (MAX_TOKENS -> truncated candidate ->
# the whole turn fails over). An operator who could switch it off would be able to
# break parsing from the environment.
#
# tier is configurable for the chat turn only, and it defaults to PRO now (#1237). It went
# cheap -> capable when the model stopped merely REPHRASING a question the deterministic engine
# had already chosen and began conducting the interview, tracking the Resume Field Set, and
# emitting strict JSON in Hinglish; it goes capable -> pro because that is the one task with
# real calls armed (`AI_REAL_CALL_TASKS` defaults to `profiling_chat_turn` alone) and therefore
# the only one where the model a worker actually meets is decided here.
_ROUTE_SHAPES: dict[str, tuple[ModelTier, bool]] = {
    # (default tier, json_mode)
    "profiling_chat_turn": ("pro", True),
    "profile_extraction": ("capable", True),
    # OIE Phase 7 — the ONE parse call. CAPABLE because the task is harder than it looks: it must
    # copy a span character-for-character out of Hinglish/Devanagari text while typing the value,
    # and a cheap model that paraphrases the quote fails the provenance gate on every field, which
    # reads as "the parse found nothing" rather than as a routing mistake. `json_mode` because the
    # response is parsed as a `ProfileParseOutput` — a prose preamble would exhaust the budget and
    # lose the whole overlay.
    "profile_parse": ("capable", True),
    # ADR-0041 RI-3. CAPABLE, and json_mode on, for the same reason `profile_parse` is:
    # the task is citation under a strict schema, where a weaker model does not answer
    # worse so much as it stops citing — and an uncited value is one the gates drop, so a
    # cheap tier here buys nothing but rejections. Real calls still need
    # AI_REAL_CALL_TASKS to name it; being in this table arms nothing.
    "resume_parse": ("capable", True),
    # RI-summary (backend-only slice). CAPABLE, and json_mode on, for the same reason
    # `resume_parse` is: the task is a closed-list classification plus two short bounded
    # strings under a strict schema, where a weaker model does not answer worse so much
    # as it stops echoing the closed id — and an off-list id is one the gate drops to
    # null, so a cheap tier here buys nothing but "no judgment". Real calls still need
    # AI_REAL_CALL_TASKS to name it; being in this table arms nothing.
    "resume_profile_summary": ("capable", True),
    # RI-autofill (owner override B, 2026-09-20, of ruling D2). CAPABLE, and json_mode
    # on, for the same reason `resume_parse` is: the task is closed-id selection under
    # a strict schema, where a weaker model does not answer worse so much as it stops
    # echoing ids verbatim — and an off-list id is one the gates drop, so a cheap tier
    # here buys nothing but omissions. Real calls still need AI_REAL_CALL_TASKS to name
    # it; being in this table arms nothing.
    "resume_option_map": ("capable", True),
    "resume_generation": ("cheap", False),
    # The RAG job-domain pick. CHEAP on purpose, and it is not a cost compromise: the
    # retrieval has already narrowed thousands of occupations to ten labelled lines, so
    # the model's whole job is to choose one of ten — a task a cheap model does as well
    # as a capable one. `json_mode` because the answer is `{job_domain_id, confidence}`
    # and a prose answer would have to be regex-scraped for an id, which is precisely
    # how a hallucinated id gets past a parser.
    "domain_match": ("cheap", True),
    # #1350 — rephrasing one work-history sentence into professional English.
    #
    # CHEAP, and that is a judgement about the TASK rather than about its importance. The model
    # is forbidden from adding any fact: it receives one sentence and returns the same claims in
    # better English, which is the shape a cheap model does well. A capable model would not
    # obey the prohibitions any harder — the far side re-checks them either way — and this runs
    # once per employment stint for every worker, so the tier is the difference between a
    # rounding error and a line item.
    #
    # `json_mode` because the answer is `{"work_done": ...}` and a prose preamble would be
    # scraped for a sentence, which is how a refusal ("I cannot rewrite this") gets printed on
    # a resume as if it were the worker's description.
    "work_history_polish": ("cheap", True),
    # ADR-0046 Phase 1 — the companion router's two calls. CHEAP on purpose, and it is a
    # judgement about the task rather than a cost compromise: classification is a six-way
    # choice over one short message, and edit extraction points at a catalogue the API has
    # already narrowed to the fields the worker can change. `json_mode` because both answers
    # are parsed as objects — a prose preamble would be scraped, which is how a hallucinated
    # intent or field gets past a parser.
    "companion_classify": ("cheap", True),
    "companion_edit_parse": ("cheap", True),
    # ADR-0046 Phase 3 - the career answer. `json_mode` because the reply is a discriminated
    # object (answer lines or a refusal topic); the tier is a harmless placeholder - the route
    # sets `model` explicitly (O7: Claude primary), so no tier default is consulted.
    "companion_career_answer": ("cheap", True),
    # ADR-0051 - the profiling-stage free chat. The classifier is CHEAP for the companion
    # classifier's reason: an eight-way choice over one short message, on the live interview path
    # where latency is the cost that matters. The reply's tier is a placeholder like the career
    # answer's: its route names the model explicitly. `json_mode` on both: each answer is parsed
    # as an object, and a prose preamble would be scraped.
    "profiling_free_classify": ("cheap", True),
    "profiling_free_reply": ("cheap", True),
    # ADR-0051 Release 2 (§8) - the rolling summary. CHEAP, and it is a judgement about the task:
    # merging a few short lines into at most ten English notes is the shape a cheap model does
    # well, it runs once per fold OFF the worker's critical path, and its output is re-validated by
    # the API before it is stored. `json_mode` because the answer is `{"summary": ...}`.
    "profiling_free_summary": ("cheap", True),
    # ADR-0054 - the free chat's live news answer (Claude + the web search tool). The tier is a
    # placeholder like the reply's: the route names Claude explicitly, with NO fallback, because
    # the web search is an Anthropic server tool and no other provider can run it. `json_mode`
    # because the answer is a discriminated object (answer / no_results / refuse).
    "profiling_free_news": ("cheap", True),
    # ADR-0057 (#2309) - the profiling turn's understanding, on EVERY typed profiling message. CHEAP
    # for the classifier's reason: a closed intent plus contained extraction over one short message,
    # on the live interview path where latency is the cost that matters (Haiku is first anyway,
    # `AI_PRIMARY_PROVIDER`). `json_mode` because the answer is parsed as an object.
    "profiling_turn_understand": ("cheap", True),
}

#: ADR-0054 - the news answer's per-attempt deadline. The API waits 25 s for `/free-chat/news`;
#: 22 s leaves ~3 s for the gate, the parse and the response, so the worker's wait is bounded by
#: the API's timeout and never by a provider call it has stopped waiting for. One attempt only
#: (the route's `max_retries` is 0), so this is also the call's whole budget.
FREE_NEWS_TIMEOUT_SECONDS = 22.0


def _chat_tier(settings: Settings) -> ModelTier:
    """Chat tier from config, falling back to the shape default on a bad value.

    Fails SOFT rather than raising: an unrecognised AI_CHAT_MODEL_TIER should not take the
    service down at request time.

    ``"pro"`` MUST BE IN THE ALLOWLIST, and forgetting it is the whole failure mode this
    function can have (#1237): an unlisted value is not an error, it silently becomes the shape
    default — so a `pro` tier the settings ask for but this tuple does not know would quietly
    keep serving the previous model with nothing anywhere saying so.

    THE FALLBACK TARGET IS THE SHAPE DEFAULT, WHICH IS NOW ALSO ``"pro"``, and that pairing is
    deliberate. The two must agree: if the shape default stayed ``"capable"`` while the settings
    default said ``"pro"``, a single typo in AI_CHAT_MODEL_TIER would silently DOWNGRADE the one
    worker-facing task in production — invisible, because a working answer from a cheaper model
    looks exactly like a working answer. Falling back to the more expensive tier is bounded by
    ``ai_max_daily_cost_inr`` (a visible, global ceiling); falling back to a cheaper one is
    bounded by nothing and reads as success.
    """
    tier = settings.ai_chat_model_tier.strip().lower()
    if tier in ("cheap", "capable", "pro"):
        return tier  # type: ignore[return-value]
    return _ROUTE_SHAPES["profiling_chat_turn"][0]


def _primary_provider(settings: Settings) -> str:
    """`ai_primary_provider` from config, failing SOFT to the shipped default (`anthropic`).

    Soft for `_chat_tier`'s reason: an unrecognised value must not take the service down at
    request time, and the shipped default is the order production has served all along.
    """
    provider = settings.ai_primary_provider.strip().lower()
    return provider if provider in ("anthropic", "google") else "anthropic"


def _tier_model(tier: ModelTier, settings: Settings) -> str:
    """The configured model of one tier.

    EXHAUSTIVE OVER ``ModelTier`` ON PURPOSE — `pro` is matched explicitly rather than being
    folded into the capable branch, so that adding a fourth tier without a branch here falls to
    the CHEAP default and is caught by the tier round-trip test, instead of quietly resolving to
    whatever the last branch happened to return.
    """
    if tier == "pro":
        return settings.default_pro_model
    if tier == "capable":
        return settings.default_capable_model
    return settings.default_cheap_model


def _apply_primary_provider(route: TaskRoute, settings: Settings) -> TaskRoute:
    """Put Claude first on a tier-routed task when `ai_primary_provider` says so (#2170).

    The route then names `default_fallback_model` as its model and keeps the tier's Gemini model
    as its fallback: the career answer's chain (O7), applied to every tier task. The router needs
    no change, because it already reads both off the route.

    Left alone: a route that names its own model (its chain is already decided), a tier that
    already resolves to Claude, a fallback that is not Claude, and a deployment whose Claude
    transport is not usable (no Anthropic key, or no `anthropic` SDK). The last one is the
    router's own fallback gate (`fallback_transport_available`), for its reason: a dead Claude
    transport put FIRST would fail every call once before Gemini answered, and spend the per-call
    retries and the TD27 retry budget doing it. Such a deployment keeps Gemini first.
    """
    if route.model is not None or _primary_provider(settings) != "anthropic":
        return route
    tier_model = _tier_model(route.tier, settings)
    claude = settings.default_fallback_model
    if (
        provider_for_model(tier_model) == "anthropic"
        or provider_for_model(claude) != "anthropic"
        or not settings.fallback_transport_available("anthropic")
    ):
        return route
    return replace(route, model=claude, fallback_model=tier_model)


# --- Per-task model choice (token-audit fix B-1) ------------------------------------------------
#
# WHY. A provider flip (`ai_primary_provider`) or a tier default moves MANY tasks at once: the
# capable tier alone carries five, pinned to `gemini-2.5-flash` by the extraction GO/NO-GO. Moving
# a model safely means one task at a time, each step undone in a minute. `ai_task_model_overrides`
# (`AI_TASK_MODEL_OVERRIDES`, default empty = today's routes exactly) names a task's chain
# directly: `task=primary` or `task=primary>fallback`, comma-separated, e.g.
#
#     profiling_free_classify=gemini-2.5-flash-lite>claude-haiku-4-5
#
# The route's numbers (output budget, temperature, json mode, retries, deadline) do not change —
# only WHICH models are tried, in which order. A fallback still has to pass the router's own gates
# (a different provider, a usable transport), and a single model keeps the router's global
# fallback. An entry that cannot be honoured is dropped, logged once, and the task keeps its
# default route: a typo on the box must never take the service down or move a task anywhere else.

#: The models an override may name. A model joins ONLY with a price row in `_MODEL_RATES_INR`
#: (an unpriced model under-reads spend, so the caps stop tripping) and a request our transport
#: sends it unchanged: Claude Haiku 5.5 rejects the temperature every route sends, so it waits for
#: per-model request settings (token-audit F6). `gemini-2.5-pro` is left out: it rejects the
#: thinking budget our Gemini client sends.
OVERRIDE_MODELS: frozenset[str] = frozenset(
    {"gemini-2.5-flash-lite", "gemini-2.5-flash", "claude-haiku-4-5"}
)

#: Tasks whose model may not change. The news answer runs Anthropic's web-search server tool,
#: which no other provider can run (ADR-0054): moved, it would answer without a search or not at
#: all.
NON_OVERRIDABLE_TASKS: frozenset[str] = frozenset({"profiling_free_news"})

#: The router tries a primary and ONE fallback, so an override names at most two models.
_MAX_OVERRIDE_MODELS = 2


@dataclass(frozen=True)
class TaskModelOverride:
    """One task's chain as the override names it."""

    model: str
    #: `None` = the router's own rule (`default_fallback_model`, when its provider differs).
    fallback_model: str | None


@dataclass(frozen=True)
class TaskModelOverrides:
    """The parsed `ai_task_model_overrides`: what applies, and what was refused and why."""

    by_task: Mapping[str, TaskModelOverride]
    #: `(task or entry as written, reason)` for every entry that was not applied.
    rejected: tuple[tuple[str, str], ...]


def parse_task_model_overrides(raw: str) -> TaskModelOverrides:
    """Parse the override string. Pure; never raises. See the section note above for the rules."""
    by_task: dict[str, TaskModelOverride] = {}
    rejected: list[tuple[str, str]] = []
    entries = [part.strip() for part in raw.split(",") if part.strip()]
    tasks = [entry.partition("=")[0].strip() for entry in entries]
    # AMBIGUOUS, SO NEITHER: a task named twice gets no override at all. Picking the first or the
    # last — or the one that happens to parse — would silently decide which line was meant.
    named_twice = {task for task in tasks if task and tasks.count(task) > 1}
    for task in sorted(named_twice):
        rejected.append((task, "named more than once"))
    for entry, task in zip(entries, tasks, strict=True):
        _, sep, chain = entry.partition("=")
        if not sep or not task:
            rejected.append((entry, "not task=model"))
            continue
        if task in named_twice:
            continue
        if task not in _ROUTE_SHAPES:
            rejected.append((task, "unknown task"))
            continue
        if task in NON_OVERRIDABLE_TASKS:
            rejected.append((task, "this task's model cannot change"))
            continue
        models = [model.strip() for model in chain.split(">")]
        if any(not model for model in models):
            rejected.append((task, "empty model"))
            continue
        if len(models) > _MAX_OVERRIDE_MODELS:
            rejected.append((task, "more than one fallback"))
            continue
        if any(model not in OVERRIDE_MODELS for model in models):
            rejected.append((task, "model not in OVERRIDE_MODELS"))
            continue
        primary = models[0]
        fallback = models[1] if len(models) == _MAX_OVERRIDE_MODELS else None
        by_task[task] = TaskModelOverride(primary, None if fallback == primary else fallback)
    return TaskModelOverrides(MappingProxyType(by_task), tuple(rejected))


@functools.lru_cache(maxsize=8)
def _parsed_overrides(raw: str) -> TaskModelOverrides:
    """`parse_task_model_overrides`, once per distinct value — and each refusal logged once."""
    parsed = parse_task_model_overrides(raw)
    for subject, reason in parsed.rejected:
        # Task names, model ids and a closed reason: configuration, never worker data or a key.
        logger.warning(
            "ai_task_model_override.rejected",
            extra={"extra": {"entry": subject, "reason": reason}},
        )
    return parsed


def task_model_overrides(settings: Settings) -> TaskModelOverrides:
    """The overrides in force for these settings."""
    return _parsed_overrides(settings.ai_task_model_overrides)


def _apply_task_override(route: TaskRoute, settings: Settings) -> TaskRoute:
    """The override's chain in place of the route's, when the task has one. Applied LAST, so it
    wins over the tier, a route's own model and the provider order alike."""
    override = task_model_overrides(settings).by_task.get(route.task_type)
    if override is None:
        return route
    return replace(route, model=override.model, fallback_model=override.fallback_model)


def get_route(task_type: str, settings: Settings | None = None) -> TaskRoute:
    """Resolve a task's route, reading the tunable numbers from settings.

    ``settings`` is optional so existing callers and tests that only need the
    static shape (``get_route("profile_extraction").json_mode``) keep working; when
    omitted the committed defaults are used.

    The provider order is applied after the shape (`_apply_primary_provider`), and a per-task
    override after that (`_apply_task_override`), so every route below states only its shape and
    numbers.
    """
    if settings is None:
        from ..config import get_settings

        settings = get_settings()
    return _apply_task_override(
        _apply_primary_provider(_route(task_type, settings), settings), settings
    )


def _route(task_type: str, settings: Settings) -> TaskRoute:
    """A task's route before the provider order is applied."""
    shape = _ROUTE_SHAPES.get(task_type)
    if shape is None:
        raise ValueError(f"Unknown AI task type: {task_type!r}")

    default_tier, json_mode = shape
    if task_type == "profiling_chat_turn":
        return TaskRoute(
            task_type,
            _chat_tier(settings),
            max_output_tokens=settings.ai_chat_max_output_tokens,
            temperature=settings.ai_chat_temperature,
            json_mode=json_mode,
            max_retries=settings.ai_chat_max_retries,
        )
    if task_type == "profile_extraction":
        return TaskRoute(
            task_type,
            default_tier,
            max_output_tokens=settings.ai_extraction_max_output_tokens,
            temperature=settings.ai_extraction_temperature,
            json_mode=json_mode,
            max_retries=settings.ai_extraction_max_retries,
        )
    if task_type == "profile_parse":
        return TaskRoute(
            task_type,
            default_tier,
            # The parse returns one object per requested field, each carrying a quoted span, so its
            # output scales with the Resume Field Set rather than being a fixed-size answer. It
            # shares the extraction budget deliberately: both read one finished interview and emit
            # one structured profile object.
            #
            # AMENDED #1674 — this comment used to end "and giving them separate knobs would mean
            # tuning the same thing in two places", which was the stated reason `resume_parse`
            # shared it too. That is no longer true of `resume_parse` and the measurement is what
            # changed it: THIS route reads one finished interview, whose shape this service
            # controls, while `resume_parse` reads an UPLOADED DOCUMENT whose reply size is set by
            # its max line length and employment count. They are two different distributions, so
            # one knob is now the drift risk rather than the convenience — tuning `resume_parse`
            # for a long CV would silently widen the interview parse, which nothing measured.
            # `profile_parse` stays here, on the shared knob, because nothing about IT was
            # measured either and widening it would be an unmeasured change.
            max_output_tokens=settings.ai_extraction_max_output_tokens,
            # TEMPERATURE ZERO, and NOT from settings. Typing a recorded answer has exactly one
            # right result; sampling would let a re-parse of an unchanged interview return a
            # different salary. This is also why the route needs its own branch at all — without
            # one it fell through to the resume defaults below and would have run a citation task
            # at temperature 0.4.
            temperature=0.0,
            json_mode=json_mode,
            max_retries=settings.ai_extraction_max_retries,
        )
    if task_type == "resume_parse":
        return TaskRoute(
            task_type,
            default_tier,
            # ITS OWN BUDGET SINCE #1674, and the only route here that has one for a reason
            # that was MEASURED rather than argued. The output is one object per requested
            # field plus one per job held, each carrying a quoted span, so it scales with the
            # RÉSUMÉ — an input this service does not control — rather than being a fixed-size
            # answer. Over 43 documents the maximal contract-permitted reply reached 1047
            # tokens worst case against the shared 1024, i.e. the old budget was one long line
            # short of losing a whole parse (a truncated candidate has no closing brace, so it
            # is fatal per-document, not per-field). The distribution, the method, the
            # `line_count` finding that rules out deriving this per call, and the caveats live
            # on `ai_resume_parse_max_output_tokens` in `app/config.py`.
            #
            # `resume_profile_summary` and `resume_option_map` deliberately DO NOT follow:
            # the summary is a fixed-size object and the option map scales with the pack, not
            # the document. Neither is at risk and neither was measured.
            max_output_tokens=settings.ai_resume_parse_max_output_tokens,
            # TEMPERATURE ZERO, and NOT from settings. Reading a value off a document has
            # exactly one right result; sampling would let a re-import of the SAME file
            # return a different employer or a different year. It also needs its own branch
            # for the reason `profile_parse` documents: without one it falls through to the
            # resume-GENERATION defaults and runs a citation task at 0.4.
            temperature=0.0,
            json_mode=json_mode,
            max_retries=settings.ai_extraction_max_retries,
        )
    if task_type == "resume_profile_summary":
        return TaskRoute(
            task_type,
            default_tier,
            # SHARES THE EXTRACTION BUDGET — and STAYS on it after #1674 split
            # `resume_parse` off. The output is one small object (a closed id plus two
            # short Hinglish strings): a FIXED size, which is exactly the property
            # `resume_parse` lost. So this is slack, and slack is safer than tight here:
            # a truncated candidate loses the closing brace, fails the contract, and
            # degrades the whole line to null.
            max_output_tokens=settings.ai_extraction_max_output_tokens,
            # TEMPERATURE ZERO, and NOT from settings. A classification against a fixed
            # list must give the same answer for the same document every time; sampling
            # here would mean a re-import could re-file a worker into a different trade
            # with no input change — and would make the Hinglish line non-comparable
            # across prompt versions on Langfuse.
            temperature=0.0,
            json_mode=json_mode,
            max_retries=settings.ai_extraction_max_retries,
        )
    if task_type == "resume_option_map":
        return TaskRoute(
            task_type,
            default_tier,
            # SHARES THE EXTRACTION BUDGET — and STAYS on it after #1674 split
            # `resume_parse` off. The output is one small object per pack question, each
            # carrying a quoted span, so it scales with the PACK — a closed list this
            # service ships and can count — rather than with the uploaded document. That
            # is the distinction the split turns on, not "fixed vs variable". Slack is
            # safer than tight here too: a truncated candidate loses the closing brace and
            # degrades the whole mapping to nothing.
            max_output_tokens=settings.ai_extraction_max_output_tokens,
            # TEMPERATURE ZERO, and NOT from settings. Mapping a document onto a fixed
            # option list must give the same answer for the same document every time;
            # sampling here would mean a re-import ticks different boxes with no input
            # change — and would make the applied answers non-comparable across prompt
            # versions on Langfuse.
            temperature=0.0,
            json_mode=json_mode,
            max_retries=settings.ai_extraction_max_retries,
        )
    if task_type == "domain_match":
        return TaskRoute(
            task_type,
            default_tier,
            # 64 tokens is the whole answer: `{"job_domain_id": "...", "confidence": 0.9}`.
            # Tight on purpose — this route has nothing to say beyond the choice, and a
            # budget that permits an explanation invites one.
            max_output_tokens=64,
            # TEMPERATURE ZERO. A classification against a fixed list must give the same
            # answer for the same worker every time; sampling here would mean a re-run
            # could re-file a worker into a different occupation with no input change.
            temperature=0.0,
            json_mode=json_mode,
            max_retries=settings.ai_extraction_max_retries,
        )
    if task_type in ("companion_classify", "companion_edit_parse"):
        return TaskRoute(
            task_type,
            default_tier,
            # TEMPERATURE ZERO. Both calls are classifications against closed sets — a
            # six-intent choice and a field catalogue — and the same sentence must route
            # the same way on a retry. Sampling here would make "edit" vs "jobs" a coin
            # toss for the same worker message.
            #
            # SMALL BUDGETS ON PURPOSE. The classifier's whole answer is
            # `{"intent": ..., "confidence": ...}`; the parser's is at most `max_rows`
            # rows of five short fields. A generous budget invites commentary the
            # contract does not carry, and a truncated candidate loses the closing
            # brace and fails the contract exactly like a rejected one.
            #
            # 48 SINCE WP5 (2026-10-05), down from 64. The measured worst case is
            # `{"intent": "edit_resume", "confidence": 0.95}` (43 chars, ~15 tokens),
            # so 48 still leaves more than 3x headroom; classify's p95 missed its
            # 1.5 s bar and an output cap is part of the worst-case latency, so the
            # smallest safe number is the right one. The prompt was shrunk in the
            # same change (prompts.py).
            max_output_tokens=48 if task_type == "companion_classify" else 512,
            temperature=0.0,
            json_mode=json_mode,
            # One retry, the chat surface's own number: these calls sit on a worker's
            # message, where a second attempt is worth it and a third is a stall.
            max_retries=settings.ai_chat_max_retries,
        )
    if task_type == "companion_career_answer":
        return TaskRoute(
            task_type,
            default_tier,
            # SMALL BUDGET: the contract is at most 4 lines plus 3 chips, so 512 tokens is
            # slack for both; a tighter cap would only add truncation as a failure mode, and
            # a truncated object fails the contract exactly like a rejected one.
            max_output_tokens=512,
            # LOW, NOT ZERO (phase-3 §3 sets the ceiling at 0.4). The model writes prose here,
            # and an answer that is verbatim identical on every ask reads like a form - but
            # sampling is never what keeps the answer SAFE: the API's deterministic validator
            # and the O10 refusal backstop do that, whatever the temperature.
            temperature=0.4,
            json_mode=json_mode,
            max_retries=settings.ai_chat_max_retries,
            # O7: Claude primary from settings, and Gemini Flash as THIS task's fallback. The
            # global `default_fallback_model` is ALSO Claude, and the router skips a fallback
            # whose provider matches the primary's - so without this the career chain would
            # have no cross-provider fallback at all.
            model=settings.default_career_model,
            fallback_model=settings.default_capable_model,
        )
    if task_type == "profiling_free_classify":
        return TaskRoute(
            task_type,
            default_tier,
            # THE COMPANION CLASSIFIER'S SHAPE, for its reasons (ADR-0051 §3.3), with a larger cap
            # since R42 (#2240): the answer gained a third key, `language`, and now measures mean
            # 29.8 / max 32 tokens on claude-haiku-4-5 (was ~15). `language` is the LAST key, so a
            # truncated answer fails the JSON parse and loses the category with it; a fenced or
            # pretty-printed fallback adds ~6-10 tokens. 64 kept 2x headroom over the measured
            # max. ADR-0055 (#2275): the companion surface asks for a FOURTH key after it,
            # `resume_action` (`"resume_action": "download"` is ~8 more tokens), so 80, the same
            # ~2x over the companion max. MEASURED on claude-haiku-4-5 (#2285, #2287 round 2):
            # mean 37.0-37.1, max 39, none at the cap, before and after round 2's classify rules.
            # The profiling answer is unchanged and never nears the cap. The API waits ~2.5 s,
            # and the cap only costs latency on a runaway answer.
            max_output_tokens=80,
            # TEMPERATURE ZERO: a closed-set choice, and the same résumé-mode answer must route
            # the same way on a retry.
            temperature=0.0,
            json_mode=json_mode,
            max_retries=settings.ai_chat_max_retries,
        )
    if task_type == "profiling_turn_understand":
        return TaskRoute(
            task_type,
            default_tier,
            # LARGER THAN A CLASSIFIER'S, SMALL FOR A WRITER'S. The answer is an intent plus up to
            # 20 fills and 10 edits of short values; a typical turn carries 0-3 of them (~60-150
            # tokens), and the owner's worst case (trade, years, travel and a mention in one line)
            # is ~120. 768 leaves a long multi-fact message room without inviting commentary the
            # contract does not carry; a truncated answer loses its closing brace and fails the
            # parse, which the API reads as unavailable and runs today's pipeline (ADR-0057 §3.6).
            max_output_tokens=768,
            # TEMPERATURE ZERO: the same message against the same schema must be read the same way
            # on a retry, or an overwrite card could appear on one attempt and not the next.
            temperature=0.0,
            json_mode=json_mode,
            # The chat surface's retry count: this call sits on a worker's message.
            max_retries=settings.ai_chat_max_retries,
        )
    if task_type == "profiling_free_reply":
        return TaskRoute(
            task_type,
            default_tier,
            # The companion career answer's budget: at most 4 lines plus 3 chips, so 512 is slack,
            # and a truncated object fails the contract like a rejected one.
            max_output_tokens=512,
            # 0.5 (ADR-0051 §3.3), a little above the companion's 0.4: casual talk that reads the
            # same on every ask feels like a form. Sampling is never what keeps it SAFE; the API's
            # validator does that whatever the temperature.
            temperature=0.5,
            json_mode=json_mode,
            max_retries=settings.ai_chat_max_retries,
            # The career answer's chain: Claude primary, Gemini Flash as THIS task's fallback,
            # because the global fallback is also Claude and the router skips a same-provider one.
            model=settings.default_career_model,
            fallback_model=settings.default_capable_model,
        )
    if task_type == "profiling_free_summary":
        return TaskRoute(
            task_type,
            default_tier,
            # 400 tokens: the prompt caps the notes at ~1000 characters of English (~250 tokens)
            # plus the JSON wrapper, so this is slack for Hinglish words that tokenize worse. A
            # truncated object fails the contract and becomes a null summary, which keeps the
            # previous notes: the safe failure, never a half-written summary stored.
            max_output_tokens=400,
            # TEMPERATURE ZERO (ADR-0051 §8): the same notes and turns must fold to the same
            # summary, and sampling would let a re-fold drift notes that are kept indefinitely.
            temperature=0.0,
            json_mode=json_mode,
            # The free chat's own retry count. Off the critical path, so a retry costs latency
            # no worker waits on.
            max_retries=settings.ai_chat_max_retries,
        )
    if task_type == "profiling_free_news":
        return TaskRoute(
            task_type,
            default_tier,
            # ADR-0054 §3.2: 700 tokens. The answer is at most 4 lines of 20 words in JSON, and the
            # output count ALSO carries the model's search queries and any text it writes around
            # the tool calls, so this is the reply's 512 plus room for two searches. A truncated
            # turn fails the call (`max_tokens_truncated`), never serves half a JSON object.
            max_output_tokens=700,
            # 0.3: the lines restate what the search results say. Lower than the reply's 0.5,
            # because sampling buys nothing when the content is the sources', and not zero, so a
            # repeated question does not read like a form.
            temperature=0.3,
            json_mode=json_mode,
            # NO RETRY. A retry re-runs paid searches, and two 22 s attempts cannot fit inside
            # the API's 25 s wait: a second attempt would only spend money on an answer nobody
            # is left to receive.
            max_retries=0,
            # Claude primary (R1: the free chat's Anthropic key and Haiku model) and NO fallback
            # named. The global `default_fallback_model` is Claude too, so the router drops it as
            # same-provider; if a deploy ever pointed it at another provider, that candidate
            # fails at dispatch with `tools_unsupported` rather than answering without a search.
            model=settings.default_career_model,
            timeout_seconds=FREE_NEWS_TIMEOUT_SECONDS,
        )
    if task_type == "work_history_polish":
        return TaskRoute(
            task_type,
            default_tier,
            # SHARES THE RESUME BUDGET DELIBERATELY. The answer is one line the route itself caps
            # at 300 characters, wrapped in `{"work_done": "..."}`, so this is already slack. A
            # tighter budget would buy nothing and add a failure mode: a truncated candidate loses
            # the closing brace, fails the contract, and degrades to null exactly like a rejected
            # rewrite — i.e. it prints as Hinglish.
            max_output_tokens=settings.ai_resume_max_output_tokens,
            # TEMPERATURE ZERO, and NOT from settings — the same ruling `profile_parse` states
            # four branches up, and this route needed its own branch for exactly the reason that
            # one documents: without it, it fell through to the resume defaults and ran at 0.4.
            #
            # WHY 0.4 WAS THE WRONG NUMBER HERE, AND WHAT IT COST. `ai_resume_temperature` is
            # tuned for RESUME GENERATION, which writes prose and wants variety. This route
            # rewrites one sentence under a list of prohibitions and is explicitly licensed to
            # answer null when it cannot. Sampling does not make that rewrite better; it makes the
            # NULL DECISION A COIN FLIP, independently, once per stint. That is precisely the
            # reported defect: a worker with two employers got professional English on one line
            # and his own Hinglish on the other, from a single render, because the same prompt
            # over comparable inputs was sampled twice.
            #
            # It is also the determinism this sheet needs everywhere else: a re-render of an
            # unchanged history must not quietly reword a description an employer already read.
            temperature=0.0,
            json_mode=json_mode,
            max_retries=settings.ai_resume_max_retries,
        )
    return TaskRoute(
        task_type,
        default_tier,
        max_output_tokens=settings.ai_resume_max_output_tokens,
        temperature=settings.ai_resume_temperature,
        json_mode=json_mode,
        max_retries=settings.ai_resume_max_retries,
    )


def resolve_model(task_type: str, settings: Settings) -> str:
    """Resolve the concrete model id for a task from current settings: the model tried FIRST.

    A ROUTE MAY NAME ITS OWN MODEL (ADR-0046 O7's career answer): `route.model` wins over the
    tier, because the tier defaults are pinned by other tasks and a task whose primary must be
    a DIFFERENT provider cannot be expressed as a tier without moving them. Under
    `ai_primary_provider="anthropic"` every tier task names Claude this way (#2170), so this
    returns `default_fallback_model` for them, and the tier model is the route's fallback.
    """
    route = get_route(task_type, settings)
    if route.model is not None:
        return route.model
    return _tier_model(route.tier, settings)


def candidate_models(
    primary_model: str, fallback_model: str | None, settings: Settings
) -> list[str]:
    """The ordered provider-fallback chain for a real call — `AIRouter._candidate_models`.

    ``primary_model`` first; then the fallback IFF its OWN provider transport is usable
    (credential AND client library) AND its provider differs from the primary's.
    ``fallback_model`` is the route's own when it names one; otherwise
    ``settings.default_fallback_model``. One function, so `scripts/effective-ai-flags.py` reports
    the chain the router actually dispatches.
    """
    candidates = [primary_model]
    fallback = fallback_model or settings.default_fallback_model
    if (
        fallback
        and fallback not in candidates
        and provider_for_model(fallback) != provider_for_model(primary_model)
        and settings.fallback_transport_available(provider_for_model(fallback))
    ):
        candidates.append(fallback)
    return candidates


def model_chain(task_type: str, settings: Settings) -> list[str]:
    """The models a real call of this task tries, in order."""
    route = get_route(task_type, settings)
    return candidate_models(resolve_model(task_type, settings), route.fallback_model, settings)


# (input_per_1k, output_per_1k) INR estimates. Unknown models fall back to a
# conservative default. These are deliberately centralized + overridable.
# Gemini 2.5 Flash list price (~$0.30 in / $2.50 out per 1M tokens) ~=
# Rs 0.025 in / Rs 0.21 out per 1k at ~Rs 83/USD. We use the bare model id; a
# legacy ``gemini/``-prefixed alias maps to the same rate (harmless entry).
_DEFAULT_RATE_INR: tuple[float, float] = (0.05, 0.15)
_GEMINI_25_FLASH_RATE_INR: tuple[float, float] = (0.025, 0.21)
_MODEL_RATES_INR: dict[str, tuple[float, float]] = {
    "gemini-flash-lite": (0.006, 0.024),
    "gemini-flash": (0.012, 0.048),
    "gemini-2.5-flash": _GEMINI_25_FLASH_RATE_INR,
    "gemini/gemini-2.5-flash": _GEMINI_25_FLASH_RATE_INR,
    # 2.5 Flash-Lite list price (~$0.10 in / $0.40 out per 1M) ~= Rs 0.008 in /
    # Rs 0.033 out per 1k at ~Rs 83/USD.
    "gemini-2.5-flash-lite": (0.008, 0.033),
    # Gemini 2.5 Pro (#1237). List price read 2026-08-26 from
    # https://ai.google.dev/gemini-api/docs/pricing: $1.25 in / $10.00 out per 1M for
    # prompts <= 200k tokens ~= Rs 0.104 in / Rs 0.83 out per 1k at ~Rs 83/USD — the same
    # conversion every other row here uses (each one reconciles to the live page exactly).
    #
    # THE <=200k TIER IS THE RIGHT ONE TO ENCODE, not a simplification. Pro bills $2.50/$15.00
    # above 200k, but no routed task can reach that: the chat turn carries a ~200-token system
    # prompt plus one interview, and `ai_chat_max_output_tokens` caps the reply at 512. A route
    # that could exceed 200k would need its own entry, and none exists.
    #
    # ⚠ THIS ROW IS NOT COSMETIC — an unpriced model is WORSE than a wrong one here. Without it
    # the estimator falls to `_DEFAULT_RATE_INR` (0.05, 0.15), which UNDER-reads Pro by ~2x on
    # input and ~5.5x on output. The guardrails are computed from the estimate, so the failure is
    # silent OVERSPEND — the caps never trip — and not the fall-to-mock that an over-estimate
    # would cause. Any future model id added to a tier default needs a row here in the same
    # change, or the ceilings below stop meaning anything.
    "gemini-2.5-pro": (0.104, 0.83),
    "claude-haiku-or-gemini-flash": (0.02, 0.08),
    "claude-haiku": (0.07, 0.35),
    # Claude Haiku 4.5 (fallback provider): $1/1M in, $5/1M out ~= Rs 0.083 in /
    # Rs 0.415 out per 1k at ~Rs 83/USD.
    "claude-haiku-4-5": (0.083, 0.415),
    # Gemini text-embedding-004 (ADR-0030 skill_embedding, TAX-3): embeddings bill input
    # only (~$0.15/1M ~= Rs 0.0125/1k at ~Rs 83/USD; output tokens do not exist). Without
    # this entry the batch estimate fell back to _DEFAULT_RATE_INR (~4x too high).
    "text-embedding-004": (0.0125, 0.0),
    # gemini-embedding-001 — the LIVE embedding model (text-embedding-004 retired; verified
    # 2026-07-14). Same $0.15/1M-input list price ~= Rs 0.0125/1k; embeddings have no output.
    "gemini-embedding-001": (0.0125, 0.0),
}


# --- Server-tool charges (ADR-0054) ----------------------------------------
# The Anthropic web search bills PER SEARCH on top of tokens: $10 per 1,000 searches (checked
# 2026-10-08, ADR-0054 §1) = $0.01 a search = Rs 0.83 at the ~Rs 83/USD every row above uses.
# Its results are billed as input tokens, which the provider's usage already reports, so only the
# per-search fee needs adding to a measured call's cost.
WEB_SEARCH_COST_INR = 0.83

# THE WORST-CASE RESERVATION'S ALLOWANCE for one search's result tokens, which the router cannot
# estimate from the prompt (they are not in it yet). AN UNMEASURED PLANNING FIGURE, set high on
# purpose: the results land as input tokens, and every further sampling pass of the server-side
# loop re-reads them and the prompt. Over-reserving is refunded to the measured cost on success
# and in full on failure; under-reserving would let one call run past a spend cap by the
# difference. 10,000 tokens at Haiku's input rate is ~Rs 0.83, so a 2-search call reserves ~Rs 3.3
# for its searches, inside the Rs 10 per-call ceiling. Replace with the box's measured
# `ai.cost_recorded` input tokens once news is armed.
WEB_SEARCH_RESULT_TOKENS_ALLOWANCE = 10_000

# A web search tool with no `max_uses` is unbounded; it is reserved as this many searches, which
# prices it past the per-call ceiling, so an unbounded search is skipped rather than run.
WEB_SEARCH_UNBOUNDED_USES = 10

# Anthropic's prompt-cache multipliers on the base input rate (5-minute cache): a cache write
# bills 1.25x, a cache read 0.1x. Applied only to a tool call's own cache buckets.
ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25
ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1


# --- Prompt-cache thresholds (COST-2) --------------------------------------
# Providers bill cached input at ~10% of the normal rate, but they ONLY cache a
# system block that clears a minimum size — a smaller block is silently ignored,
# so a cache directive on it is a pure no-op. Before adding a directive we check
# the STATIC block against these minimums and otherwise emit a skip diagnostic.
#
# Sources read 2026-07-14 (update HERE if a provider changes them — do not scatter
# the number):
#   - Anthropic prompt caching min = 4096 tokens for Claude Haiku 4.5 (our fallback
#     provider); 1024 for most models, 2048 for Haiku 3/3.5.
#     https://platform.claude.com/docs/en/build-with-claude/prompt-caching
#   - Gemini 2.5 Flash IMPLICIT caching (automatic, no request change — the ONLY
#     Gemini mechanism this file reasons about) applies from ~1024 tokens. Gemini
#     EXPLICIT cachedContent (a separate resource, DEFERRED) has a higher 2048-token
#     floor (2.5 Flash) / is the 2.5 Pro figure. We gate the Gemini diagnostic on the
#     IMPLICIT floor, since that is what actually caches today.
#     https://ai.google.dev/gemini-api/docs/caching
#
# NOTE (honest state): after AI-PERSONA-1 trimmed the persona, BADA_BHAI_SYSTEM_PROMPT
# is ~200 tokens — far below every minimum here — so caching is a no-op today and the
# guard takes the skip-diagnostic path. It arms automatically if the prompt ever grows.
ANTHROPIC_CACHE_MIN_TOKENS = 4096
# Gemini 2.5 Flash implicit-cache floor (what _gemini_cache_diagnostic checks).
GEMINI_CACHE_MIN_TOKENS = 1024
# Deferred: the explicit cachedContent lifecycle would gate on this higher floor.
GEMINI_EXPLICIT_CACHE_MIN_TOKENS = 2048


def should_cache_system(system_text: str, min_tokens: int) -> bool:
    """True iff the static system block is large enough to clear a provider's
    prompt-cache minimum (else a cache directive is a silent no-op).

    Uses the shared token ESTIMATE (~chars/4); a wrong guess only means we skip an
    ineffective cache, never a correctness or privacy issue. SG-1: only the STATIC
    persona/extraction prompt is ever passed here — never a worker message or name,
    so nothing PII-bearing is ever marked cacheable. Imported lazily to avoid a
    module cycle (cost_tracker imports this module)."""
    from .cost_tracker import estimate_tokens

    return estimate_tokens(system_text) >= min_tokens


def provider_for_model(model: str) -> str:
    """Coarse provider label used for BOTH cost/observability metadata AND the
    router's provider dispatch: "google" -> direct Gemini (``gemini_client``),
    "anthropic" -> Claude via the SDK (``anthropic_client``). Other labels have
    no live transport HERE and are metadata-only — including "sarvam", whose
    calls are real but are made by their own adapters (``stt.py``, ``tts.py``,
    ``translate.py``) and never enter the LLM router's candidate list.

    ORDER IS LOAD-BEARING, and the two transport-bearing labels come first on
    purpose: ``providers.complete`` dispatches on this return value, so a branch
    that could ever divert a routed model away from "google"/"anthropic" would
    turn a working call into "no live transport". Metadata-only labels are
    matched after them, and ``"unknown"`` stays the honest fallback for a model
    id no rule recognises."""
    m = model.lower()
    if "gemini" in m or "vertex" in m:
        return "google"
    if "claude" in m or "anthropic" in m:
        return "anthropic"
    if "gpt" in m or "openai" in m:
        return "openai"
    # Sarvam (the Indic STT/TTS/translate surfaces). Matched on the MODEL FAMILY,
    # which is the stable half of the id — "saarika:v2.5" becomes "saarika:v3"
    # without becoming a different provider: saarika (ASR) and saaras (the ASR
    # swap config.py already names), bulbul (TTS), mayura (translate), plus a bare
    # "sarvam" for the text models (``sarvam-m``) and any vendor-prefixed alias.
    #
    # WITHOUT THIS BRANCH EVERY RUPEE OF SARVAM SPEND ACCRUED AS "unknown". That is
    # not merely an unhelpful label: `platform_ai_cost_totals` is keyed on
    # (provider, task_type), so Sarvam's spend was pooled with the spend of models
    # that genuinely have no rule — the one bucket a reader cannot attribute.
    # The correction is NOT retroactive: rows already accrued under "unknown" stay
    # there, and only calls made after this ships land under "sarvam".
    if "saarika" in m or "saaras" in m or "bulbul" in m or "mayura" in m or "sarvam" in m:
        return "sarvam"
    return "unknown"


def rate_inr_per_1k(model: str) -> tuple[float, float]:
    return _MODEL_RATES_INR.get(model, _DEFAULT_RATE_INR)
