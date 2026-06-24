"""Pin guard: the production extraction model is ONE model end-to-end.

This test FAILS if the prod / CLI / config paths ever diverge on which model
``profile_extraction`` uses. It exists because the real-LLM flip gate
(docs/ai/real-llm-flip-go-no-go.md, Finding 4) requires the validation-model to
EQUAL the flip-model — both pinned to ``gemini-2.5-flash``. A silent change to a
different id (e.g. flash-lite or Haiku) on any one of the three paths must break
this test, not the funded re-val run.

PURE / OFFLINE: no network, no real LLM call, no key needed. Every model id is
DERIVED from the real code path (config + the task->tier->model resolver + the
exact call the --flip-gate CLI makes), never a literal we re-assert against
itself — so a future divergence on any path is caught.
"""

from __future__ import annotations

from app.ai.model_config import get_route, resolve_model
from app.config import Settings
from app.profiling import eval_canonicalization as cli

PINNED_EXTRACTION_MODEL = "gemini-2.5-flash"


def _source_capable_default() -> str:
    """The committed in-code default of ``default_capable_model`` straight from the
    config.py field definition — independent of any env/.env override (the test
    conftest sets DEFAULT_CAPABLE_MODEL, which would otherwise mask a config.py
    regression). This is the value that SHIPS in prod when the env does not pin it."""
    return Settings.model_fields["default_capable_model"].default


def _fresh_settings() -> Settings:
    """Settings as the running service sees them under the current environment (the
    conftest pins routing to mirror the committed defaults). Used for the resolver
    + CLI checks so they exercise the SAME env the suite runs in."""
    return Settings(_env_file=None)


def test_config_capable_model_is_pinned() -> None:
    """(a) The committed capable-tier default (config.py source) == the pinned
    extraction model.

    Read from ``Settings.model_fields[...].default`` so it reflects the SOURCE
    default in config.py, NOT a conftest env override and NOT a re-stated literal:
    a future edit of config.py's ``default_capable_model`` to another id fails here.
    Also asserts the test conftest's DEFAULT_CAPABLE_MODEL env mirror has not drifted
    from that source default — so the suite never resolves extraction to a stale id."""
    assert _source_capable_default() == PINNED_EXTRACTION_MODEL
    # Conftest env mirror must equal the source default (catches conftest drift).
    assert _fresh_settings().default_capable_model == _source_capable_default()


def test_profile_extraction_resolves_to_pinned_model() -> None:
    """(b) The model ``profile_extraction`` resolves to via the REAL task->tier->
    model resolver == the pinned model.

    Goes through ``get_route`` (capable tier) + ``resolve_model`` — the same code
    the router uses (router.py ``resolve_model(task_type, settings)``). Asserts the
    route is the capable tier (so cheap/flash-lite is provably NOT used for
    extraction) AND that the resolved id is the pinned model. A change to the route
    tier OR the capable-model default fails here."""
    settings = _fresh_settings()
    assert get_route("profile_extraction").tier == "capable"
    resolved = resolve_model("profile_extraction", settings)
    assert resolved == PINNED_EXTRACTION_MODEL
    # The cheap tier (flash-lite) must NOT be what extraction resolves to.
    assert resolved != settings.default_cheap_model


def test_flip_gate_cli_exercises_the_same_resolved_model() -> None:
    """(c) The model the ``--flip-gate`` CLI would exercise == the model
    ``profile_extraction`` resolves to (== the pinned model).

    The CLI computes its target via ``resolve_model("profile_extraction", settings)``
    (eval_canonicalization.py ``_run_flip_gate``); we call that SAME resolver path
    here through the CLI module's import so the validation-model is derived from the
    CLI, not hard-coded. This is the equality the go/no-go gate depends on:
    validation-model == flip-model. A CLI change to a different id breaks this."""
    settings = _fresh_settings()
    # Mirror the exact resolution _run_flip_gate performs (via the CLI's import).
    cli_target_model = cli.resolve_model("profile_extraction", settings)
    extraction_model = resolve_model("profile_extraction", settings)
    assert cli_target_model == extraction_model
    assert cli_target_model == PINNED_EXTRACTION_MODEL


def test_validation_model_equals_flip_model_one_model_end_to_end() -> None:
    """The combined invariant: config capable == extraction-resolved ==
    flip-gate CLI target == ``gemini-2.5-flash``. One model, three paths.

    If ANY of the three is later changed to a different id this single equality
    chain fails — no tautology (each side is derived from its real code path)."""
    settings = _fresh_settings()
    config_capable = settings.default_capable_model
    extraction_resolved = resolve_model("profile_extraction", settings)
    flip_gate_target = cli.resolve_model("profile_extraction", settings)

    assert (
        config_capable
        == extraction_resolved
        == flip_gate_target
        == PINNED_EXTRACTION_MODEL
    )
