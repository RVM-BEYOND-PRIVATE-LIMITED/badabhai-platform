#!/usr/bin/env python3
"""Price a full CNC-turner interview in INR, using the ai-service's OWN rate table.

    REPORT_INTERVIEW_COST=/tmp/cost pnpm --filter @badabhai/api run test interview-cost
    python scripts/price-interview.py /tmp/cost/interview.json

WHY IT IMPORTS RATHER THAN RESTATES. The INR rates and the token estimator live in
`apps/ai-service/app/ai/`. A pricer with its own copy of either is a second source that drifts
from the one the spend guardrails actually use, and the number it prints would then describe a
system nobody is running. This imports `estimate_tokens` and `estimate_cost_inr` directly, so if
a rate row changes, this output changes with it.

WHAT IT MODELS, and what it cannot. The ask sequence and every prompt string are REAL - emitted
by the live `nextQuestion` engine over the shipped packs. What is modelled is the model's OUTPUT
length, because no real call is made here: outputs are priced at the configured per-task cap,
which is the worst case rather than the likely one. A run with real keys would replace that
single assumption; everything else is measured.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "ai-service"))

from app.ai.cost_tracker import estimate_cost_inr, estimate_tokens  # noqa: E402
from app.ai.model_config import rate_inr_per_1k  # noqa: E402
from app.config import Settings  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))

    # SHIPPED DEFAULTS, read off the class rather than an instance. Instantiating `Settings()`
    # loads this machine's env, which is the wrong question - and on a developer box it can also
    # refuse to boot outright (the TD65 canonicalization-against-production guard). What is being
    # priced is what production runs, so the class defaults are the correct source.
    def default(name: str):
        return Settings.model_fields[name].default

    chat_model = default("default_pro_model")
    extract_model = default("default_capable_model")
    chat_cap = default("ai_chat_max_output_tokens")
    extract_cap = default("ai_extraction_max_output_tokens")
    target_inr = default("ai_target_profile_cost_inr")
    alert_inr = default("ai_cost_alert_profile_inr")

    print(f"chat turn      : {chat_model}  {rate_inr_per_1k(chat_model)} INR/1k (in, out)")
    print(f"extraction     : {extract_model}  {rate_inr_per_1k(extract_model)} INR/1k")
    print(f"output caps    : chat {chat_cap}, extraction {extract_cap}")
    print(f"target / alert : Rs {target_inr} / Rs {alert_inr}  (code defaults)")
    print()

    header = (
        f"{'band':<9}{'asks':>5}{'chat in':>9}{'A: COST-4':>11}"
        f"{'B: ~20wd':>10}{'B: at cap':>11}{'extract':>9}{'TOTAL B':>9}"
    )
    print(header)
    print("-" * len(header))

    for band, turns in report.items():
        # The chat prompt grows with the conversation: each turn carries the system prompt plus
        # every prior ask and answer. Summing per turn is what makes the total quadratic-ish and
        # is the whole reason a per-call number understates a per-profile one.
        history = ""
        chat_in = 0
        for turn in turns:
            served = turn["promptText"] + " " + " / ".join(turn["optionLabels"])
            chat_in += estimate_tokens(history + served)
            history += served + " " + turn["answerText"] + "\n"

        # TWO OUTPUT ASSUMPTIONS, because one of them alone misleads. The cap is the worst case
        # the guardrails are computed against; the persona rule caps a reply at 20 words, so a
        # real turn emits ~40 tokens and the cap over-reads it by more than an order of magnitude.
        # A number quoted at the cap makes the tier look unaffordable; one quoted at 40 hides what
        # a runaway costs. Both are printed.
        chat_out_cap = chat_cap * len(turns)
        chat_out_real = 40 * len(turns)

        # A. The SHIPPED default. COST-4 serves the templated question directly and skips the chat
        #    LLM on the straight-line path, so a worker who taps chips spends nothing on the ask.
        cost_a = 0.0
        # B. `ai_profiling_rephrase_enabled=true` (or send-every-turn): one real Pro call per turn.
        cost_b = estimate_cost_inr(chat_model, chat_in, chat_out_real)
        cost_b_cap = estimate_cost_inr(chat_model, chat_in, chat_out_cap)
        # Extraction runs once over the whole transcript, on the capable tier.
        extract_in = estimate_tokens(history)
        cost_x = estimate_cost_inr(extract_model, extract_in, extract_cap)

        print(
            f"{band:<9}{len(turns):>5}{chat_in:>9}{cost_a:>11.2f}"
            f"{cost_b:>10.2f}{cost_b_cap:>11.2f}{cost_x:>9.2f}{cost_b + cost_x:>9.2f}"
        )

    print()
    print("A = shipped default: AI_REAL_CALL_TASKS is empty (fail-closed) and COST-4 serves the")
    print("    templated ask, so a chip-tapping worker triggers no chat call at all.")
    print("B = chat turn armed AND rephrase/every-turn enabled. '~20wd' applies the persona")
    print("    reply limit; 'at cap' is what the spend guardrails are computed against.")
    print("Extraction is priced separately because it is armed by its own allowlist entry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
