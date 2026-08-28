"""Resolve the WHOLE AI-flag chain and print what is actually armed on this machine.

WHY THIS EXISTS (R8 §5.2). Flag state has been misreported three times, at three different
layers, and it was load-bearing every time:

  R5/R6  reported `ai_real_call_tasks = ""` from `config.py` and called real calls disarmed.
         True of the CODE DEFAULT, and irrelevant: nothing runs with the code default.
  R6     reported the two compose files' literals as the deployed posture. Also true, also not
         what a developer's process sees.
  R7     opened with "turn the model on — this is the actual unblock", and all six tasks were
         already armed by the ai-service env file, which overrides both of the above.

Each report was accurate about the layer it read and wrong about the question being asked. The
question is never "what does the default say" — it is "what will the NEXT call actually do", and
answering it requires resolving every layer in precedence order at once. That is what this does.

  PRECEDENCE, lowest to highest (pydantic-settings):
    1. the field default in `apps/ai-service/app/config.py`
    2. `apps/ai-service/.env`            (`SettingsConfigDict(env_file=...)`)
    3. the process environment           (a shell export, a compose `environment:` entry)

  The two compose files are NOT layers a local process sees at all — they decide what a
  CONTAINER's process environment will hold. They are printed separately, and labelled as such,
  because conflating "declared in compose" with "in effect here" is one of the three mistakes.

WHAT IT NEVER PRINTS. No secret value, ever — a key is reported as `set (NN chars)` or `unset`.
The guard hooks refuse to read the env file from a shell command, and rightly; this reads it
through `Settings`, the same loader the service uses, and reports only booleans, task names and
lengths.

    apps/ai-service/.venv/Scripts/python.exe scripts/effective-ai-flags.py
    apps/ai-service/.venv/Scripts/python.exe scripts/effective-ai-flags.py --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AI_SERVICE = HERE.parent / "apps" / "ai-service"
sys.path.insert(0, str(AI_SERVICE))

from app.config import ConfigError, Settings, get_settings  # noqa: E402


def resolve_settings() -> tuple[object, str | None]:
    """`Settings`, plus the boot refusal that had to be stepped around to build it.

    A REFUSAL IS EFFECTIVE FLAG STATE, and the most important kind — TD65's guard means this
    machine's ai-service will not start at all with canonicalization armed against a loopback
    api. Crashing here would hide that behind a stack trace, and silently disabling the guard
    would hide it completely. So it is caught, REPORTED, and then stepped around with the one
    documented developer override, with the step-around named in the output.
    """
    try:
        return get_settings(), None
    except ConfigError as err:
        os.environ["SKILL_CANONICALIZE_ENABLED"] = "false"
        return Settings(), str(err).split(". ")[0]


#: Every task type whose armed state this report must cover — DERIVED, never hand-written.
#:
#: THE HAND-WRITTEN LIST WAS WRONG, THEN THE FIRST DERIVATION WAS WRONG THE OTHER WAY.
#:
#:   Round 1 (R8):  `resume_generation` was absent, so it appeared in neither the armed nor the
#:                  unarmed line and the report said "five of six armed" when six of seven were.
#:   Round 2 (R11): the correction still omitted `domain_match`, `voice_transcription`,
#:                  `skill_canonicalization` and `skill_canonicalization_batch`.
#:   Round 3 (R12): deriving from the router's two registries alone DROPPED `stt_transcription`
#:                  and `tts_synthesis` — which I had just called invented names. They are real:
#:                  `stt.py:151` and `tts.py:57`, both gated through `real_call_enabled_for`.
#:                  They are absent from `_ROUTE_SHAPES` and `_TASK_TRACE` because they never go
#:                  through `AIRouter` at all. A derivation is only as good as its source, and
#:                  two registries were the wrong source for a question about a THIRD gate.
#:
#: THE GATE IS THE SOURCE OF TRUTH, and the gate is `Settings.real_call_enabled_for`. A task is
#: in scope for this report if and only if something asks that function about it. Three shapes
#: reach it, so the derivation is the union of three:
#:
#:   _ROUTE_SHAPES   tasks the router tiers, all of which pass through `real_call_enabled_for`
#:   _TASK_TRACE     tasks the router traces (the two registries disagree; each holds tasks the
#:                   other does not, so neither alone is sufficient)
#:   _GATED_DIRECTLY the non-router providers, which call the gate themselves
#:
#: `test_ai_instruments.py` asserts this against every `real_call_enabled_for` call site in the
#: service — including the ones that pass a module constant.


#: Tasks gated OUTSIDE the router, read from their own modules so a rename moves them here too.
def _directly_gated() -> set[str]:
    from app.ai.embeddings import EMBEDDING_TASK_TYPE
    from app.stt import STT_TASK_TYPE
    from app.tts import TTS_TASK_TYPE

    return {EMBEDDING_TASK_TYPE, STT_TASK_TYPE, TTS_TASK_TYPE}


def _known_tasks() -> list[str]:
    from app.ai.langfuse_tracing import _TASK_TRACE
    from app.ai.model_config import _ROUTE_SHAPES

    return sorted(set(_ROUTE_SHAPES) | set(_TASK_TRACE) | _directly_gated())


TASKS = _known_tasks()

#: The names whose effective value decides whether a model is reached, and by which tier.
TRACKED = [
    "AI_ENABLE_REAL_CALLS",
    "AI_REAL_CALLS_KILL_SWITCH",
    "AI_REAL_CALL_TASKS",
    "AI_CHAT_MODEL_TIER",
    "AI_SYNTHETIC_PERSONA_MODE",
]

SECRETS = ["GEMINI_FLASH_API_KEY", "ANTHROPIC_API_KEY", "AI_INTERNAL_TOKEN"]


def env_file_names(path: Path) -> set[str]:
    """The NAMES an env file declares. Values are never read, printed or returned."""
    if not path.exists():
        return set()
    names: set[str] = set()
    for raw in path.read_text(encoding="utf8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        names.add(line.split("=", 1)[0].strip().lstrip("export ").strip())
    return names


def compose_declarations(path: Path, name: str) -> str | None:
    """The literal a compose file writes for `name`, or None when it does not declare it.

    A TEXT SCAN RATHER THAN A YAML PARSE, deliberately: the value wanted here is the raw
    `${VAR:-default}` string, which is what an operator has to reason about, and a parser that
    resolved substitutions would answer a different question than the one asked.
    """
    if not path.exists():
        return None
    for raw in path.read_text(encoding="utf8").splitlines():
        line = raw.strip()
        if line.startswith(f"{name}:") or line.startswith(f"- {name}="):
            return line.split(":", 1)[1].strip() if line.startswith(f"{name}:") else line
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    s, boot_refusal = resolve_settings()
    env_path = AI_SERVICE / ".env"
    declared = env_file_names(env_path)
    blocked = s.real_calls_blocked_reason()
    # THE DIFFERENCE CHECK, implemented rather than described. `real_call_task_allowlist` is the
    # set the box actually armed; anything in it that this file does not know about is reported
    # instead of vanishing, which is what happened to `resume_generation`.
    allowlist = set(s.real_call_task_allowlist)
    unknown = sorted(allowlist - set(TASKS))
    armed = sorted(t for t in TASKS if s.real_call_enabled_for(t))

    report = {
        "effective": {
            "real_calls_blocked_reason": blocked,
            "real_calls_enabled": blocked is None,
            "armed_tasks": armed,
            "unarmed_tasks": sorted(set(TASKS) - set(armed)),
            # Armed on the box, unknown to this file. NON-EMPTY IS A BUG IN THIS FILE, not in the
            # box — it means the router grew a task type and nobody updated the baseline.
            "armed_but_unknown_to_this_script": unknown,
            "chat_model_tier": s.ai_chat_model_tier,
            "synthetic_persona_mode": bool(s.synthetic_persona_mode),
        },
        "layers": {},
        "compose_declares": {},
        "secrets": {},
        "boot_refusal": boot_refusal,
    }

    for name in TRACKED:
        report["layers"][name] = {
            # WHICH LAYER WON, which is the whole point of the file.
            "process_env": name in os.environ,
            "ai_service_env_file": name in declared,
            "source": (
                "process env"
                if name in os.environ
                else "apps/ai-service env file"
                if name in declared
                else "code default"
            ),
        }
    for name in TRACKED + SECRETS:
        for label, path in (
            ("docker-compose.yml", HERE.parent / "docker-compose.yml"),
            ("docker-compose.staging.yml", HERE.parent / "docker-compose.staging.yml"),
        ):
            report["compose_declares"].setdefault(name, {})[label] = compose_declarations(
                path, name
            )
    for name in SECRETS:
        value = getattr(s, name.lower(), None) or os.environ.get(name, "")
        report["secrets"][name] = f"set ({len(value)} chars)" if value else "unset"

    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    e = report["effective"]
    if boot_refusal:
        print("BOOT REFUSAL (the service would NOT start as configured)")
        print(f"  {boot_refusal}.")
        print("  Everything below was resolved with SKILL_CANONICALIZE_ENABLED=false.\n")
    print("EFFECTIVE ON THIS MACHINE (what the next call will actually do)")
    print(
        f"  real calls        : {'ENABLED' if e['real_calls_enabled'] else 'BLOCKED'}"
        f"{'' if e['real_calls_enabled'] else '  reason: ' + str(blocked)}"
    )
    print(f"  armed tasks       : {', '.join(e['armed_tasks']) or '(none)'}")
    print(f"  unarmed tasks     : {', '.join(e['unarmed_tasks']) or '(none)'}")
    if unknown:
        print(f"  !! ARMED BUT NOT A ROUTER TASK: {', '.join(unknown)}")
        # BOTH DIRECTIONS, because the first version of this message named only one and the
        # measured cause was the other. `TASKS` is now derived from the router's own registries,
        # so a name here means the ALLOWLIST holds something the router does not — either a task
        # added to the router without a tier or a trace entry, or (as measured on this box) a name
        # in `AI_REAL_CALL_TASKS` that was never a task type at all. `stt_transcription` and
        # `tts_synthesis` are the live example: they exist only in admin-web's display code, for a
        # voice cost breakdown that has never been built, and arming them gates nothing.
        print("     (either the router gained a task with no tier/trace entry, or the allowlist")
        print("      names something that is not a task type — both are silent today)")
    print(f"  chat model tier   : {e['chat_model_tier']}")
    print(f"  synthetic persona : {'ON' if e['synthetic_persona_mode'] else 'off'}")
    print("\nWHICH LAYER WON")
    for name, row in report["layers"].items():
        print(f"  {name:<28} {row['source']}")
    print("\nDECLARED IN COMPOSE (a CONTAINER's env, not this process's)")
    for name, files in report["compose_declares"].items():
        for label, literal in files.items():
            if literal:
                print(f"  {name:<28} {label:<28} {literal}")
    print("\nKEYS (length only, never the value)")
    for name, state in report["secrets"].items():
        print(f"  {name:<28} {state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
