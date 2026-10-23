"""Audit fix F1 — AI_REAL_CALL_TASKS_DENY removes tasks from the real-call allowlist.

WHY IT EXISTS. Production's allowlist is a long line on the box, and since #1843 a value there
REPLACES the default rather than adding to it, so hand-editing it to drop one task risks dropping
others. The deny list lets one short line disarm one task (first use: `resume_generation`, whose
model-written blurb nothing reads).

WHAT MUST HOLD, whatever anyone writes into it:
  - empty (the default) is exactly today's behaviour, for every task;
  - it only NARROWS: a denied task falls to its mock even when allowlisted, and naming a task that
    is not allowlisted arms nothing;
  - it lives in the one gate every real call passes (`real_call_enabled_for`), so the router, the
    embedder and STT/translate all honour it without a second check of their own.
"""

from __future__ import annotations

import asyncio
import itertools

from app.ai.embeddings import EMBEDDING_TASK_TYPE
from app.ai.model_config import _ROUTE_SHAPES
from app.ai.router import AIRouter
from app.config import Settings
from app.stt import STT_TASK_TYPE
from app.tts import TTS_TASK_TYPE

# Every task a real call can be armed for: the router's tiers plus the three adapter tasks.
ALL_TASKS = sorted({*_ROUTE_SHAPES, EMBEDDING_TASK_TYPE, STT_TASK_TYPE, TTS_TASK_TYPE})
_MESSAGES = [{"role": "user", "content": "vmc 4 saal"}]


def _settings(allow: str, deny: str = "") -> Settings:
    """Master flag on and a placeholder key, so only the two lists decide. No call is made."""
    return Settings(
        _env_file=None,
        ai_enable_real_calls=True,
        gemini_flash_api_key="k",
        ai_real_call_tasks=allow,
        ai_real_call_tasks_deny=deny,
    )


def test_the_default_is_empty():
    assert Settings.model_fields["ai_real_call_tasks_deny"].default == ""
    assert _settings("profiling_chat_turn").real_call_task_denylist == frozenset()


def test_an_empty_deny_list_changes_nothing_for_any_task():
    """The merge-safety property: with the default, every task is armed exactly as before."""
    allow = ",".join(ALL_TASKS[::2])  # half the tasks allowlisted, so both outcomes are covered
    before = Settings(
        _env_file=None,
        ai_enable_real_calls=True,
        gemini_flash_api_key="k",
        ai_real_call_tasks=allow,
    )
    after = _settings(allow, deny="")
    for task in ALL_TASKS:
        assert after.real_call_enabled_for(task) == before.real_call_enabled_for(task), task


def test_a_denied_task_is_disarmed_and_its_neighbours_are_not():
    settings = _settings(
        "profiling_chat_turn,resume_generation,profile_extraction", deny="resume_generation"
    )
    assert settings.real_call_enabled_for("resume_generation") is False
    assert settings.real_call_enabled_for("profiling_chat_turn") is True
    assert settings.real_call_enabled_for("profile_extraction") is True


def test_it_can_only_narrow_never_arm():
    """For every pair of (allowlisted?, denied?) the result is allowlisted AND NOT denied."""
    for task, in_allow, in_deny in itertools.product(ALL_TASKS, (True, False), (True, False)):
        settings = _settings(task if in_allow else "", deny=task if in_deny else "")
        assert settings.real_call_enabled_for(task) is (in_allow and not in_deny), (
            task,
            in_allow,
            in_deny,
        )


def test_it_parses_like_the_allowlist():
    """Same grammar as AI_REAL_CALL_TASKS: commas, stray spaces and empty entries tolerated."""
    settings = _settings(
        "resume_generation,work_history_polish,profiling_chat_turn",
        deny=" resume_generation , ,work_history_polish,",
    )
    assert settings.real_call_task_denylist == frozenset(
        {"resume_generation", "work_history_polish"}
    )
    assert settings.real_call_enabled_for("profiling_chat_turn") is True


def test_the_router_takes_the_mock_path_for_a_denied_task():
    """End to end through the router: no real attempt, the caller's mock text, a healthy result.
    For `resume_generation` that mock IS the résumé template, so the résumé text is unchanged."""
    settings = _settings("resume_generation", deny="resume_generation")
    router = AIRouter(settings)
    content, meta = asyncio.run(
        router.run("resume_generation", messages=_MESSAGES, mock_response="TEMPLATE_TEXT")
    )
    assert content == "TEMPLATE_TEXT"
    assert meta.real_call is False
    assert meta.success is True
    assert meta.error_code is None


def test_the_master_gates_still_come_first():
    """A deny list cannot re-open anything the kill switch or the master flag closed."""
    killed = Settings(
        _env_file=None,
        ai_enable_real_calls=True,
        gemini_flash_api_key="k",
        ai_real_calls_kill_switch=True,
        ai_real_call_tasks="profiling_chat_turn",
        ai_real_call_tasks_deny="",
    )
    assert killed.real_call_enabled_for("profiling_chat_turn") is False
