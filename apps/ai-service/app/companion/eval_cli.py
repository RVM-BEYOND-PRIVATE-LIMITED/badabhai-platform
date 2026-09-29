"""The companion evals' REAL gate (ADR-0046 A4) — staging only.

    python -m app.companion.eval_cli --classify --base-url http://localhost:8000
    python -m app.companion.eval_cli --edit-parse --base-url http://localhost:8000

SCORES A RUNNING SERVICE, and exits non-zero when the phase-1 §4 bars are missed (classifier:
>= 90% overall accuracy and >= 95% edit_resume precision; edit-parse: >= 90% exact rows and 0 rows
outside the catalogue). CI never runs this: the suite is mock-only, and the deterministic half of
the gate (set shape, scorer capability, containment) lives in
`tests/companion/test_companion_evals.py`.

WHAT IT SENDS. The classifier cases send `{text}`; the edit cases send the frozen fixture
catalogue and snapshot. Every line is fabricated test data — no worker text. The service
pseudonymizes at its endpoints exactly as in production.
"""

from __future__ import annotations

import argparse
import sys

import httpx

from app.config import get_settings

from . import eval_classify_gold as classify_gold
from . import eval_edit_parse_gold as edit_gold

#: The bars this CLI gates on — mirrored from the gold modules so they cannot drift.
THRESHOLDS = {
    "classify_accuracy": classify_gold.THRESHOLDS["accuracy"],
    "classify_edit_resume_precision": classify_gold.THRESHOLDS["edit_resume_precision"],
    "edit_exact": edit_gold.THRESHOLD,
}

#: The fixture the edit cases are parsed against — the same shape the API sends.
_EDIT_SNAPSHOT = [
    {
        "ref": "e1",
        "section": "employment",
        "fields": {
            "employer_name": "Tata Motors",
            "employer_city": "Pune",
            "role_label": "Welder",
            "work_done": "MIG welding",
            "start_ym": "2019-01",
            "end_ym": None,
        },
    },
    {"ref": "s1", "section": "skills", "fields": {"skill": "Milling"}},
    {"ref": "s2", "section": "skills", "fields": {"skill": "MIG welding"}},
    {"ref": "l1", "section": "languages", "fields": {"language": "hindi"}},
    {"ref": "l2", "section": "languages", "fields": {"language": "english"}},
    {
        "ref": "c1",
        "section": "qualifications",
        "fields": {
            "certificate_name": "ITI Machinist",
            "certificate_issuer": "NCVT",
            "certificate_year": "2018",
        },
    },
    {
        "ref": "q1",
        "section": "qualifications",
        "fields": {
            "education_credential": "iti",
            "education_field": "Machinist",
            "education_council": "ncvt",
            "education_year": "2018",
            "education_institute": "Govt ITI Faridabad",
        },
    },
    {
        "ref": "t1",
        "section": "qualifications",
        "fields": {
            "training_name": "Industrial Safety",
            "training_provider": "RVM",
            "training_year": "2020",
        },
    },
    {"ref": "o1", "section": "occupations", "fields": {"role_id": "role_welder"}},
    {
        "ref": "pref",
        "section": "preferences",
        "fields": {
            "shift": "day",
            "job_type": "permanent",
            "willing_to_travel": "false",
            "willing_to_relocate": "false",
            "accommodation_needed": "false",
            "expected_salary": "20000",
            "availability_status": "immediate",
            "availability_available_from": None,
            "availability_notice_period_days": None,
        },
    },
    {"ref": "pc1", "section": "preferences", "fields": {"preferred_cities": "Pune"}},
    {"ref": "wt1", "section": "preferences", "fields": {"work_types": "permanent"}},
    {"ref": "dr1", "section": "preferences", "fields": {"documents_ready": "aadhaar"}},
]


def _post(base_url: str, path: str, body: dict) -> dict:
    """httpx, exactly like the canonicalization eval — never urllib (SAST: file:// schemes)."""
    response = httpx.post(
        f"{base_url.rstrip('/')}{path}",
        json=body,
        headers=_service_auth_headers(),
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def _service_auth_headers() -> dict[str, str]:
    """The TD67 bearer, mirrored from this runner's own env so an armed service accepts the call."""
    token = get_settings().ai_internal_token
    return {"x-ai-internal-token": token} if token else {}


def run_classify_eval(base_url: str) -> classify_gold.ClassifyScore:
    def predict(text: str) -> str | None:
        body = _post(base_url, "/companion/classify", {"text": text, "recent_turns": []})
        if body.get("blocked"):
            return None
        return body.get("intent")

    return classify_gold.evaluate(predict)


def run_edit_parse_eval(base_url: str) -> edit_gold.EditScore:
    catalogue = [
        {"section": section, "field": field, "ops": list(ops)}
        for section, field, ops in edit_gold.CATALOGUE
    ]

    def predict(text: str) -> list[edit_gold.Row]:
        body = _post(
            base_url,
            "/companion/edit-parse",
            {
                "text": text,
                "catalogue": catalogue,
                "snapshot": _EDIT_SNAPSHOT,
                "max_rows": 3,
            },
        )
        return [
            (row["op"], row["section"], row.get("ref"), row.get("field"), row.get("value"))
            for row in body.get("rows", [])
        ]

    return edit_gold.evaluate(predict)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Companion v2 evals (staging only)")
    parser.add_argument("--base-url", required=True, help="the ai-service under test")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--classify", action="store_true")
    mode.add_argument("--edit-parse", action="store_true")
    args = parser.parse_args(argv)

    if args.classify:
        score = run_classify_eval(args.base_url)
        print(
            f"classifier: {score.correct}/{score.total} = {score.accuracy:.1%} "
            f"(bar {THRESHOLDS['classify_accuracy']:.0%}), "
            f"edit_resume precision {score.edit_resume_precision:.1%} "
            f"(bar {THRESHOLDS['classify_edit_resume_precision']:.0%})"
        )
        for miss in score.misses[:20]:
            print(f"  MISS {miss}")
        for failure in score.failed:
            print(f"  FAIL {failure}")
        return 1 if score.failed else 0

    score = run_edit_parse_eval(args.base_url)
    print(
        f"edit-parse: {score.exact}/{score.total} exact = {score.accuracy:.1%} "
        f"(bar {THRESHOLDS['edit_exact']:.0%})"
    )
    for miss in score.misses[:20]:
        print(f"  MISS {miss}")
    for failure in score.failed:
        print(f"  FAIL {failure}")
    return 1 if score.failed else 0


if __name__ == "__main__":
    sys.exit(main())
