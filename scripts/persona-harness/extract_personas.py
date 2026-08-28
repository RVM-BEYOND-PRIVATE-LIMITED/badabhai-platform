"""R7 §1/§2 — run each synthetic persona's transcript through the REAL Phase C extraction.

WHAT IS REAL HERE, stated plainly because the mock path has burned this project twice:

  * the model call is real — ``AIRouter`` with ``real_call_allowed=True``, the shipped prompt,
    the shipped candidate ladder and the shipped cost ledger;
  * the handler is the shipped one — ``routers.profiling._extract``, the exact body
    ``/profiling/extract`` runs, including output re-certification;
  * only the MASKER differs, and it differs by argument rather than by a flag read inside the
    body (``passthrough_masker``, reachable only on an armed process).

WHAT IS NOT EXERCISED, and must not be reported as if it were: the HTTP layer and its internal
-token auth. This calls ``_extract`` in-process. The route that would carry it
(``/synthetic/extract``) exists and is registration-gated; it is simply not the door used here,
because sending a bearer token through a shell to a second process buys nothing the in-process
call does not already prove about the model and the handler.

EVERY RUN REPORTS ``is_mock`` AND THE MODEL THAT ANSWERED. A run that fell to mock is a FAILED
run and says so in its own artifact rather than producing a plausible profile from nothing.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AI_SERVICE = HERE.parents[1] / "apps" / "ai-service"
sys.path.insert(0, str(AI_SERVICE))

from app.config import get_settings  # noqa: E402
from app.contracts import InterviewExtractInput, TranscriptLine  # noqa: E402
from app.profiling.parse_masking import passthrough_masker  # noqa: E402
from app.routers.profiling import _extract  # noqa: E402


def load_personas() -> list[dict]:
    data = json.loads((HERE / "personas.json").read_text(encoding="utf8"))
    return data["personas"]


async def run_one(persona: dict, out_dir: Path) -> dict:
    lines = [
        TranscriptLine(i=i, role=role, text=text)
        for i, (role, text) in enumerate(persona["transcript"])
    ]
    body = InterviewExtractInput(
        schema_version="oie.v1",
        worker_ref=persona["id"],
        transcript=lines,
    )
    out = await _extract(body, passthrough_masker)

    meta = out.ai_metadata
    record = {
        "persona_id": persona["id"],
        # THE HONESTY BLOCK. Read this before reading anything below it.
        "run": {
            "is_mock": out.is_mock,
            "real_call": bool(meta and meta.real_call),
            "model_name": meta.model_name if meta else None,
            "provider": meta.provider if meta else None,
            "candidates_tried": list(meta.candidates_tried) if meta else [],
            "input_tokens": meta.input_tokens if meta else None,
            "output_tokens": meta.output_tokens if meta else None,
            "cost_inr": meta.estimated_cost_inr if meta else None,
            "latency_ms": meta.latency_ms if meta else None,
            "error_code": meta.error_code if meta else None,
        },
        "extract": out.model_dump(exclude={"ai_metadata"}),
    }
    (out_dir / f"{persona['id']}.extract.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf8"
    )
    return record


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="persona id; default is all five")
    ap.add_argument("--out", default=str(HERE / "out"))
    args = ap.parse_args()

    settings = get_settings()
    blocked = settings.real_calls_blocked_reason()
    armed = settings.real_call_enabled_for("profile_extraction")
    print(f"synthetic mode : {settings.synthetic_persona_mode}")
    print(f"real calls     : {'ENABLED' if blocked is None else f'BLOCKED — {blocked}'}")
    print(f"extract armed  : {armed}")
    if blocked is not None or not armed:
        # FAIL LOUDLY RATHER THAN PRODUCE A MOCK PROFILE. R7 §2 is explicit about this and the
        # register records two prior occasions where a mock run was read as a real result.
        print("REFUSING TO RUN: this would extract from the mock path and the output would be "
              "a plausible profile built from nothing.", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    personas = [p for p in load_personas() if not args.only or p["id"] == args.only]
    if not personas:
        print(f"no persona matched {args.only!r}", file=sys.stderr)
        return 2

    total = 0.0
    for p in personas:
        rec = await run_one(p, out_dir)
        run = rec["run"]
        total += run["cost_inr"] or 0.0
        flag = "REAL" if run["real_call"] else "*** MOCK — RESULT IS NOT EVIDENCE ***"
        print(
            f"{p['id']:<26} {flag:<38} {run['model_name']} "
            f"₹{run['cost_inr']} {run['latency_ms']}ms "
            f"exp={len(rec['extract'].get('experiences', []))} "
            f"skills={len(rec['extract'].get('skills', []))}"
        )
    print(f"\ntotal extraction spend: ₹{round(total, 4)} over {len(personas)} persona(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
