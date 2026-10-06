"""A3 — the companion's model routes and prompt-registry entries (ADR-0046 Phase 1; P3 career).

The endpoints themselves are covered in `test_companion.py` / `test_companion_career.py`;
this file pins what the route layer owns:

1. WHICH ROUTE each task resolves to. The Phase-1 pair is cheap tier, JSON mode, temperature
   zero, a small budget — both calls classify against closed sets, so the same sentence must
   route the same way on a retry, and a generous budget would invite commentary the contract
   cannot carry. The Phase-3 career answer is the deliberate exception (O7): Claude primary
   from settings, Gemini Flash as its own fallback, low-but-not-zero temperature.
2. That every prompt is REGISTERED, so each generation records a version and "which prompt
   routed / wrote this" is answerable from one trace.
"""

from __future__ import annotations

from app.ai import prompt_registry
from app.ai.model_config import _ROUTE_SHAPES, get_route, resolve_model
from app.companion.prompts import (
    CAREER_SYSTEM_PROMPT,
    CLASSIFY_SYSTEM_PROMPT,
    EDIT_PARSE_SYSTEM_PROMPT,
)
from app.config import get_settings

CLASSIFY = "companion_classify"
EDIT_PARSE = "companion_edit_parse"
CAREER = "companion_career_answer"


def test_the_two_companion_tasks_are_routed_cheap_and_json() -> None:
    # Cheap because both are closed-set choices the retrieval/catalogue has already narrowed;
    # JSON because both answers are parsed as objects, and a prose preamble would be scraped.
    assert _ROUTE_SHAPES[CLASSIFY] == ("cheap", True)
    assert _ROUTE_SHAPES[EDIT_PARSE] == ("cheap", True)


def test_each_route_is_deterministic_and_small() -> None:
    classify = get_route(CLASSIFY)
    edit = get_route(EDIT_PARSE)
    for route in (classify, edit):
        assert route.tier == "cheap"
        assert route.json_mode is True
        # TEMPERATURE ZERO: the same worker message must classify the same way on a retry.
        assert route.temperature == 0.0
    # The classifier's whole answer is `{"intent": ..., "confidence": ...}`; the parser's is
    # at most `max_rows` rows of five short fields. 48 (WP5, 2026-10-05, was 64) is the
    # smallest safe cap: the worst-case answer is ~15 tokens, so it leaves 3x headroom while
    # keeping the worst-case latency down.
    assert classify.max_output_tokens == 48
    assert edit.max_output_tokens > classify.max_output_tokens


def test_the_cheap_tier_resolves_the_configured_cheap_model() -> None:
    settings = get_settings()
    assert resolve_model(CLASSIFY, settings) == settings.default_cheap_model
    assert resolve_model(EDIT_PARSE, settings) == settings.default_cheap_model


def test_both_prompts_are_registered_with_a_local_version() -> None:
    prompt_registry.install_default_prompts()
    names = prompt_registry.registered_names()
    assert prompt_registry.COMPANION_CLASSIFY in names
    assert prompt_registry.COMPANION_EDIT_PARSE in names

    resolved = prompt_registry.resolve(prompt_registry.COMPANION_CLASSIFY)
    assert resolved is not None
    # The registered text IS the route's fallback literal: no interpolation, no drift — a
    # Langfuse-managed copy is the only way the two can differ, and that is deliberate.
    assert resolved.text == CLASSIFY_SYSTEM_PROMPT
    assert resolved.version.startswith("local:")
    assert resolved.source == prompt_registry.SOURCE_LOCAL

    edit = prompt_registry.resolve(prompt_registry.COMPANION_EDIT_PARSE)
    assert edit is not None
    assert edit.text == EDIT_PARSE_SYSTEM_PROMPT


def test_a_prompt_edit_moves_its_version() -> None:
    # Version = content hash, so an edited prompt is a new version (the registry's promise):
    # two different texts can never share a version.
    assert prompt_registry.local_version("rule A") != prompt_registry.local_version("rule B")


# --- ADR-0046 P3 — the career answer's route (O7) ------------------------------


def test_the_career_task_resolves_claude_with_a_gemini_fallback() -> None:
    """O7: career answers on Claude, existing fallbacks apply — and the fallback has to be
    stated per-task, because the global fallback model is ALSO Claude and the router skips a
    same-provider candidate. Without `fallback_model` this chain would have no fallback."""
    settings = get_settings()
    route = get_route(CAREER, settings)
    assert resolve_model(CAREER, settings) == settings.default_career_model
    assert settings.default_career_model.startswith("claude")
    assert route.fallback_model == settings.default_capable_model
    assert route.json_mode is True
    # LOW, NOT ZERO (phase-3 §3's ≤ 0.4 ceiling): the model writes prose, and the validator —
    # not the sampler — is what keeps the answer safe.
    assert 0.0 < route.temperature <= 0.4
    assert route.max_output_tokens == 512


def test_the_career_route_is_not_reachable_through_a_tier_default() -> None:
    """The tier is a placeholder; the model is explicit. A future tier change must not be able
    to move the career model by accident."""
    settings = get_settings()
    assert resolve_model(CAREER, settings) != settings.default_cheap_model
    assert resolve_model(CAREER, settings) != settings.default_capable_model
    assert resolve_model(CAREER, settings) != settings.default_pro_model


def test_the_career_prompt_is_registered_with_a_local_version() -> None:
    prompt_registry.install_default_prompts()
    assert prompt_registry.COMPANION_CAREER in prompt_registry.registered_names()
    resolved = prompt_registry.resolve(prompt_registry.COMPANION_CAREER)
    assert resolved is not None
    assert resolved.text == CAREER_SYSTEM_PROMPT
    assert resolved.version.startswith("local:")
