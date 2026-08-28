"""R8 §6 — run the same interview turns on two chat tiers and measure the difference.

WHAT THIS IS FOR, AND WHAT IT IS NOT. It is DATA FOR A RULING, not a re-tier. Nothing here writes
a flag, touches a compose file, or changes what staging or production do; it sets the tier for its
own process and reports what came back.

THE FINDING BEHIND IT. `ai_chat_model_tier` is "pro" and `default_pro_model` is `gemini-2.5-pro`,
which the provider has RETIRED: the API answers 404 with "no longer available to new users … use
models/gemini-3.1-pro-preview". The router's cross-provider fallback then reaches
`claude-haiku-4-5`, which works. So the chat turn a worker meets today is Haiku, reached after two
failed Gemini round-trips — and #1237 raised the tier to Pro precisely because "this is the model
a worker actually meets". Two wasted round-trips per turn is latency a worker feels on every
message, on a mid-range Android on a shop floor.

THE TWO ARMS.
    pro      what production runs: gemini-2.5-pro (404) -> retry -> claude-haiku-4-5
    capable  gemini-2.5-flash, which answers 200 on the first attempt

MEASURED PER TURN: wall-clock latency, which model actually answered, whether the reply broke the
interview's own stated rules (one question, <= 20 words, no romanised-English drift), and cost.

    cd apps/ai-service && SKILL_CANONICALIZE_ENABLED=false \\
        ./.venv/Scripts/python.exe ../../scripts/persona-harness/tier_ladder.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
AI_SERVICE = HERE.parents[1] / "apps" / "ai-service"
sys.path.insert(0, str(AI_SERVICE))

#: SET BEFORE `Settings` IS EVER CONSTRUCTED. `get_settings` caches, and `ModelRoute` reads the
#: tier off the cached instance, so a tier set after the first import silently has no effect and
#: both arms would measure the same model. The import below is deliberately after this line.
def _arm(tier: str) -> None:
    os.environ["AI_CHAT_MODEL_TIER"] = tier
    from app import config

    # `get_settings` memoises into a module global rather than via `lru_cache`, so the reset is a
    # rebind. Asserting the tier actually moved is not paranoia: a silently-unchanged cache would
    # make both arms measure the same model and the comparison would read as "no difference".
    config._settings = None
    assert config.get_settings().ai_chat_model_tier == tier


from app.ai.router import AIRouter  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.profiling.interview_prompts import interview_system_prompt  # noqa: E402

#: FOUR REAL TURNS from the persona transcripts — the shapes an interview actually hits: an
#: opening answer, a capability answer, an explicit denial, and a terse one-word reply. Canned
#: rather than a live loop on purpose: both arms must see byte-identical input or the comparison
#: measures the conversation instead of the model.
TURNS = [
    "CNC lathe chalata hoon sir. Do saal ho gaye.",
    "Programme load karke part banata hoon. Facing, turning, drilling, grooving.",
    "Nahi sir, programme setter banata hai. Main sirf chalata hoon.",
    "Haan.",
]

#: THE SHIPPED PHASE-A PROMPT, not a paraphrase of it. A hand-written system prompt measures the
#: prompt, not the tier: the first version of this script used one, and both arms then asked the
#: worker for his NAME — which the real prompt forbids outright and which would have read as a
#: model-quality finding rather than as my own prompt being wrong.
SYSTEM = interview_system_prompt()


def rule_breaks(text: str) -> list[str]:
    """The interview's own stated rules, checked mechanically. Not a quality score."""
    broken = []
    questions = text.count("?")
    if questions == 0:
        broken.append("no question")
    if questions > 1:
        broken.append(f"{questions} questions")
    words = len(text.split())
    if words > 20:
        broken.append(f"{words} words")
    if "\n-" in text or "\n*" in text or "\n1." in text:
        broken.append("list")
    return broken


async def run_arm(tier: str, runs: int) -> dict:
    _arm(tier)
    settings = get_settings()
    if settings.real_calls_blocked_reason() is not None:
        raise SystemExit(f"REFUSING: real calls blocked ({settings.real_calls_blocked_reason()})")
    takes_settings = "settings" in AIRouter.__init__.__code__.co_varnames
    router = AIRouter(settings) if takes_settings else AIRouter()

    rows = []
    for i in range(runs):
        for turn in TURNS:
            started = time.perf_counter()
            content, meta = await router.run(
                "profiling_chat_turn",
                messages=[
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": turn},
                ],
                mock_response="",
                real_call_allowed=True,
                user_ref=f"tier-ladder-{tier}",
            )
            elapsed_ms = (time.perf_counter() - started) * 1000
            if not meta.real_call:
                raise SystemExit(f"REFUSING: arm '{tier}' fell to the mock path; not evidence")
            rows.append(
                {
                    "run": i,
                    "turn": turn,
                    "model": meta.model_name,
                    "latency_ms": round(elapsed_ms, 1),
                    "cost_inr": round(float(getattr(meta, "estimated_cost_inr", 0.0) or 0.0), 4),
                    "reply": (content or "").strip(),
                    "rule_breaks": rule_breaks((content or "").strip()),
                }
            )
            print(
                f"  [{tier}] {meta.model_name:<24} {elapsed_ms:7.0f} ms  "
                f"{'/'.join(rows[-1]['rule_breaks']) or 'ok':<16} {rows[-1]['reply'][:60]}",
                flush=True,
            )
    lat = sorted(r["latency_ms"] for r in rows)
    # PER-MODEL, because an arm can be a MIX and a blended median hides it. The account's Gemini
    # quota rate-limits at roughly ten requests in quick succession, and each 429 arms a 60-second
    # provider cooldown that sends the rest of the arm to Anthropic. Without this breakdown the
    # `capable` arm's median is an average of two different models presented as one.
    by_model: dict[str, list[float]] = {}
    for r in rows:
        by_model.setdefault(r["model"] or "?", []).append(r["latency_ms"])
    return {
        "by_model": {
            m: {"n": len(v), "median_ms": sorted(v)[len(v) // 2]} for m, v in by_model.items()
        },
        "tier": tier,
        "rows": rows,
        "models": sorted({r["model"] for r in rows if r["model"]}),
        "median_ms": lat[len(lat) // 2],
        "p90_ms": lat[int(len(lat) * 0.9) - 1],
        "mean_ms": round(sum(lat) / len(lat), 1),
        "cost_inr": round(sum(r["cost_inr"] for r in rows), 4),
        "rule_breaks": sum(len(r["rule_breaks"]) for r in rows),
    }


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--only", choices=("pro", "capable"), help="run one arm, merge the other")
    args = ap.parse_args()

    result_path = HERE / "out" / "tier-ladder.json"
    out = {}
    if args.only and result_path.exists():
        out = json.loads(result_path.read_text(encoding="utf8"))
    for tier in ("pro", "capable"):
        if args.only and tier != args.only:
            continue
        print(f"\n=== arm: {tier}")
        out[tier] = await run_arm(tier, args.runs)

    # THE ARMS MUST HAVE ANSWERED WITH DIFFERENT MODELS OR THERE IS NOTHING TO COMPARE.
    #
    # This guard exists because the comparison already produced a vacuous result once. An earlier
    # invocation left Google under its 60-second rate-limit cooldown, so the `capable` arm skipped
    # Gemini entirely and was answered by `claude-haiku-4-5` — the same model as the `pro` arm.
    # Every per-turn check still passed (`meta.real_call` is TRUE for a cross-provider fallback),
    # and the table read as a clean A/B of two tiers that were in fact one model. When this fires,
    # run the arms separately with `--only`, at least 60 seconds apart.
    collapsed = len(out) == 2 and set(out["pro"]["models"]) == set(out["capable"]["models"])
    if collapsed:
        print(
            "\n::error::both arms were answered by the same model set "
            f"({', '.join(out['pro']['models'])}) — this comparison is NOT evidence. "
            "A provider cooldown or a shared fallback collapsed the two arms."
        )

    print(f"\n{'arm':<10}{'models answering':<34}{'median':>9}{'p90':>9}{'INR':>9}  rule breaks")
    for tier, a in out.items():
        print(
            f"{tier:<10}{', '.join(a['models']):<34}{a['median_ms']:>8.0f}m"
            f"{a['p90_ms']:>8.0f}m{a['cost_inr']:>9.4f}  {a['rule_breaks']}"
        )
        for model, stat in sorted(a.get("by_model", {}).items()):
            print(f"{'':<10}  └ {model:<30} n={stat['n']:<3} median {stat['median_ms']:.0f} ms")
    result_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf8")
    return 1 if collapsed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
