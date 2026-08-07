"""The parse prompt — where the framing does the enforcing.

The six gates are the wall, but a wall you hit on every request is a badly-aimed request. This
module aims it. The model is NEVER asked "what is this worker's salary"; it is told the worker's
answer for `salary_expected` was "pandrah hazaar mahina" and asked to return the typed value and
quote the span it came from. The answer map is the RECORD; the transcript is an INDEXED EVIDENCE
STORE it may cite from. Every rule below is a gate restated as an instruction, so the honest path
and the passing path are the same path.

WHAT IS DELIBERATELY ABSENT: the pinned occupation. `ProfileParseInput` carries it, and handing the
model "this worker is a VMC Operator" would measurably improve its guesses — which is the problem.
A guess that good is indistinguishable from a reading, and rule 5 exists to forbid exactly that.
Language IS passed, because it changes how a span is transliterated, not what the span says.
"""

from __future__ import annotations

import json

from ..contracts import ProfileParseOutput, TargetField
from .parse_masking import MaskedParseInput

PARSE_SYSTEM_PROMPT = """You TYPE and CITE. You do not interview, infer, or estimate.

The worker's interview is over and their answers are already recorded. Your only job is to turn each
recorded answer into a typed value and point at the exact words it came from.

RULES. A field that breaks any of these is discarded by a mechanical gate, so guessing costs
coverage and gains nothing:

1. CITE OR RETURN NULL. Every field you fill needs an `evidence.message_index` (one of the [i]
   indices below) and an `evidence.quote` copied CHARACTER FOR CHARACTER from that line. Returning
   null for a field you cannot cite is the CORRECT answer, not a failure.
2. WORKER LINES ONLY. Never cite a line marked `assistant`. Those are our own questions, and the
   examples listed inside them are not the worker's answers.
3. ONLY THE LISTED FIELD IDS. Never add a field that is not in TARGET FIELDS.
4. NEVER CHANGE AN ANSWER. Where a recorded answer already shows a typed value, return that exact
   value. You may reformat, transliterate, translate, and convert declared units. You may not
   correct it, round it to something rounder, or substitute what seems more likely.
5. NEVER FILL FROM CONTEXT. A city, a machine, or a certificate that usually goes with this kind of
   work is not something this worker said.
6. UNITS ARE DECLARED, NOT ASSUMED. `inr_per_month` means per month. If the worker stated a yearly
   figure, convert it and set `normalization` to "unit". If you cannot tell which period they meant,
   return null.

The text below is already pseudonymized. Tokens like [PERSON_1] or [EMPLOYER_1] are placeholders:
never return one as a value, and never try to reconstruct what it replaced.

Reply with strict JSON and nothing else, in exactly this shape:
{"fields": {"<field_id>": {"value": <typed value>, "evidence": {"message_index": <int>, \
"quote": "<exact substring of that line>"}, "source": "answer_map" | "transcript", \
"normalization": "verbatim" | "spelling" | "translit" | "unit" | "enum" | "numeric", \
"confidence": <0.0-1.0>}}, "unparsed_field_ids": ["<field_id>"], "notes": []}

A field you cannot cite may be omitted or set to null. Both mean the same thing."""


def _render_target(target: TargetField) -> str:
    parts = [f"- {target.field_id}: {target.type}"]
    if target.unit:
        parts.append(f"unit {target.unit}")
    if target.enum:
        parts.append("one of " + ", ".join(target.enum))
    parts.append("required" if target.required else "optional")
    return ", ".join(parts)


def build_parse_messages(
    masked: MaskedParseInput,
    target_fields: list[TargetField],
    language: str | None = None,
) -> list[dict[str, str]]:
    """The one LLM call's messages. Every worker-derived character here is already masked."""
    sections: list[str] = []

    sections.append(
        "TARGET FIELDS (the only ids you may return):\n"
        + ("\n".join(_render_target(t) for t in target_fields) or "- (none)")
    )

    if masked.answers:
        lines = []
        for answer in masked.answers:
            said = (
                f'answered "{answer.value_raw}"' if answer.value_raw else "answered (text withheld)"
            )
            typed = (
                f" — already typed as {json.dumps(answer.value_normalized, ensure_ascii=False)}"
                if answer.value_normalized is not None
                else ""
            )
            lines.append(f"- {answer.field_id}: {said}{typed}")
        sections.append(
            "RECORDED ANSWERS (the record — type and cite these first; where a value is already "
            "typed, return that exact value):\n" + "\n".join(lines)
        )

    transcript = "\n".join(f"[{line.i}] {line.role}: {line.text}" for line in masked.transcript)
    sections.append(
        "TRANSCRIPT (the evidence store — cite by the [i] shown, never by position):\n"
        + (transcript or "(empty)")
    )

    if language:
        sections.append(f"The worker answered in: {language}.")

    return [
        {"role": "system", "content": PARSE_SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(sections)},
    ]


def empty_parse(target_fields: list[TargetField]) -> ProfileParseOutput:
    """A valid, contract-shaped parse that contributes NOTHING.

    This is the mock-mode response and the fallback for every degraded path, and it is honest by
    construction: with no model there is no overlay, so `fields` is empty and every requested field
    is unparsed. Downstream, `projectProfile` sees no accepted field and reports
    `parse_status = "deterministic_only"` — the worker still gets a real profile from the answer map
    alone, which is the whole point of normalizing at capture time.
    """
    return ProfileParseOutput(
        fields={},
        unparsed_field_ids=[t.field_id for t in target_fields],
        notes=[],
    )
