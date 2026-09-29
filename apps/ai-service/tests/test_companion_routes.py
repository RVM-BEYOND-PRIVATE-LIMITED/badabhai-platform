"""A3 — the companion's model routes and prompt-registry entries (ADR-0046 Phase 1).

The endpoints themselves are covered in `test_companion.py`; this file pins the two things
A3 owns:

1. WHICH ROUTE each task resolves to — cheap tier, JSON mode, temperature zero, a small
   budget. Both calls classify against closed sets, so the same sentence must route the same
   way on a retry, and a generous budget would invite commentary the contract cannot carry.
2. That both prompts are REGISTERED, so every generation records a version and "which prompt
   routed this message" is answerable from one trace.
"""

from __future__ import annotations

from app.ai import prompt_registry
from app.ai.model_config import _ROUTE_SHAPES, get_route, resolve_model
from app.companion.prompts import CLASSIFY_SYSTEM_PROMPT, EDIT_PARSE_SYSTEM_PROMPT
from app.config import get_settings

CLASSIFY = "companion_classify"
EDIT_PARSE = "companion_edit_parse"


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
    # at most `max_rows` rows of five short fields.
    assert classify.max_output_tokens == 64
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
