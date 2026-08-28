"""R7 §5 — does anchoring a capability chip to an EMPLOYER narrow the claim set?

THE HAZARD. §8.3's asymmetry rule was designed for free text: "chalata hoon" stays operating,
"set karta hoon" may raise the modifier. A chip grid bypasses it entirely — ticking is free, there
is no phrasing to resolve downward, and every tick is a literal claim, so the property test built
in R5 cannot see an over-claim at all. §5.3 calls an unclaimed capability upgrade the most
damaging failure available to us, and it surfaces at the machine trial.

THE EXPERIMENT. The same capability grid, the same worker, two question framings:

    UNANCHORED   "Inme se kya kya aata hai aapko?"        (which of these can you do)
    ANCHORED     "Shakti Precision me inme se kya kiya?"  (which of these did you do AT X)

The model is given the persona's own transcript and asked to answer AS that worker under each
framing. The transcript is the ground truth: anything ticked that his own words do not support is
an over-claim, and the measure is how many of those each framing produces.

WHAT THIS IS NOT. A model role-playing a 2-year turner is not a 2-year turner, and it will not
reproduce a real man's incentive to tick what he has watched someone else do. So the experiment
CANNOT establish the absolute over-claim rate. It can establish whether the framing changes the
claim set under identical conditions, which is the question §5 actually asks. Both arms run N
times because a single sample of a sampled model is not a measurement.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
AI_SERVICE = HERE.parents[1] / "apps" / "ai-service"
sys.path.insert(0, str(AI_SERVICE))

from app.ai.router import AIRouter  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.profiling.canonical_roles import coerce_json_text  # noqa: E402

# The turner pack's capability grid, as the worker sees it. Chip labels are the pack's own.
GRID = {
    "turning_operation": ["Facing / OD turning", "Boring", "Threading", "Grooving / parting",
                          "Drilling / tapping", "Knurling"],
    "setting_operation": ["Tool offset", "Work offset", "Tool nose radius compensation",
                          "Chuck / jaw change", "Tailstock setting", "First-piece setup"],
    "programming_level": ["Offset hi badalta hoon", "Programme edit kar leta hoon",
                          "Naya programme likh leta hoon", "CAM software se banata hoon"],
    "advanced_capability": ["Live tooling", "Bar feeder", "Sub-spindle", "C-axis", "Y-axis",
                            "Inme se koi nahi"],
    "quality_work": ["First-piece check", "In-process checking", "SPC chart",
                     "Rejection analysis", "Inme se koi nahi"],
}

UNANCHORED = (
    "Neeche capability ki list hai. Worker ki baat padh kar bataiye ki wo AS THE WORKER "
    "kaunse chips tick karega, agar usse poocha jaye: \"Inme se kya kya aata hai aapko?\""
)
ANCHORED = (
    "Neeche capability ki list hai. Worker ki baat padh kar bataiye ki wo AS THE WORKER "
    "kaunse chips tick karega, agar usse poocha jaye: \"{employer} me inme se kya kya kaam "
    "aapne khud kiya?\" — yaani sirf wahi jo usne us employer ke paas khud kiya ho."
)

SYSTEM = (
    "You simulate how a blue-collar Indian machine operator answers a chip-selection screen in a "
    "job app. You are NOT evaluating him and you are NOT being careful on his behalf — answer the "
    "way he would actually tap, including any optimism a man looking for a better job would have. "
    "Reply with JSON only: {\"<attribute_key>\": [\"<chip label>\", ...], ...}. Use the chip "
    "labels verbatim. Include only chips he would tick."
)

#: THE ARM THAT CAN ACTUALLY DISCRIMINATE, and the first version of this experiment lacked it.
#:
#: Given only a transcript, a model answers both framings from the same evidence and the two arms
#: come out identical — which measures the model's groundedness, not the framing. The hazard §5
#: names is a HUMAN incentive: a man who wants the job, who has stood next to a setter for two
#: years, ticking what he has watched. That incentive is not in the transcript, so it has to be
#: supplied or the unanchored arm has no room to over-claim and the comparison is vacuous.
#:
#: Supplying it is not stacking the deck. The claim under test is "anchoring to an employer
#: constrains a claim a general 'can you do this' does not" — and that claim is only testable
#: where there is a claim to constrain.
INCENTIVE = (
    " He badly wants this job and believes he could do more than his current employer lets him. "
    "He has stood beside senior setters for two years and has watched them work. When a chip "
    "describes something he has SEEN done, or thinks he could manage, he tends to tick it."
)


def transcript_of(persona: dict) -> str:
    return "\n".join(
        ("Worker: " if role == "worker" else "Bada Bhai: ") + text
        for role, text in persona["transcript"]
    )


async def run_arm(
    router, persona: dict, framing: str, n: int, incentive: bool = False
) -> list[dict]:
    grid = json.dumps(GRID, ensure_ascii=False, indent=1)
    user = f"{framing}\n\nWorker ki baat:\n{transcript_of(persona)}\n\nCapability list:\n{grid}"
    out = []
    for _ in range(n):
        content, meta = await router.run(
            "profiling_chat_turn",
            messages=[
                {"role": "system", "content": SYSTEM + (INCENTIVE if incentive else "")},
                {"role": "user", "content": user},
            ],
            mock_response="{}",
            real_call_allowed=True,
            user_ref="anchoring-experiment",
        )
        if not meta.real_call:
            raise SystemExit("REFUSING: this arm fell to the mock path; the result is not evidence")
        try:
            out.append(json.loads(coerce_json_text(content)))
        except Exception:
            out.append({})
    return out


def flatten(picks: dict) -> set[tuple[str, str]]:
    return {
        (key, chip)
        for key, chips in picks.items()
        if isinstance(chips, list)
        for chip in chips
        if isinstance(chip, str) and chip != "Inme se koi nahi"
    }


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--persona", default="p2_two_year_operator")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--incentive", action="store_true",
                    help="give the simulated worker the over-claim pressure a real one has")
    args = ap.parse_args()

    settings = get_settings()
    if settings.real_calls_blocked_reason() is not None:
        print("REFUSING: real calls are blocked; a mock arm proves nothing", file=sys.stderr)
        return 2

    personas = json.loads((HERE / "personas.json").read_text(encoding="utf8"))["personas"]
    persona = {p["id"]: p for p in personas}[args.persona]
    employer = persona["employments"][0]["employer_name"] if persona["employments"] else "us jagah"

    takes_settings = "settings" in AIRouter.__init__.__code__.co_varnames
    router = AIRouter(settings) if takes_settings else AIRouter()
    inc = args.incentive
    unanchored = await run_arm(router, persona, UNANCHORED, args.runs, inc)
    anchored = await run_arm(router, persona, ANCHORED.format(employer=employer), args.runs, inc)

    def tally(runs: list[dict]) -> Counter:
        c: Counter = Counter()
        for r in runs:
            for item in flatten(r):
                c[item] += 1
        return c

    tu, ta = tally(unanchored), tally(anchored)
    sizes_u = [len(flatten(r)) for r in unanchored]
    sizes_a = [len(flatten(r)) for r in anchored]

    print(f"persona   : {persona['id']}  ({persona['label']})")
    print(f"employer  : {employer}")
    print(f"runs/arm  : {args.runs}\n")
    print(f"UNANCHORED claims per run : {sizes_u}  mean {sum(sizes_u)/len(sizes_u):.1f}")
    print(f"ANCHORED   claims per run : {sizes_a}  mean {sum(sizes_a)/len(sizes_a):.1f}\n")

    only_u = sorted(set(tu) - set(ta))
    only_a = sorted(set(ta) - set(tu))
    print(f"chips claimed ONLY when unanchored ({len(only_u)}):")
    for k, c in only_u:
        print(f"    {k:<20} {c}  [{tu[(k, c)]}/{args.runs} runs]")
    print(f"\nchips claimed ONLY when anchored ({len(only_a)}):")
    for k, c in only_a:
        print(f"    {k:<20} {c}  [{ta[(k, c)]}/{args.runs} runs]")

    (HERE / "out" / f"anchoring{'-incentive' if inc else ''}.json").write_text(
        json.dumps(
            {
                "persona": persona["id"],
                "runs": args.runs,
                "incentive": inc,
                "unanchored_sizes": sizes_u,
                "anchored_sizes": sizes_a,
                "unanchored_tally": {f"{k}|{c}": n for (k, c), n in tu.items()},
                "anchored_tally": {f"{k}|{c}": n for (k, c), n in ta.items()},
                "only_unanchored": [f"{k}|{c}" for k, c in only_u],
                "only_anchored": [f"{k}|{c}" for k, c in only_a],
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
