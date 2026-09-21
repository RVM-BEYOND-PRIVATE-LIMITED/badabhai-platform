"""The résumé parse prompt — the interview's framing, pointed at a document.

`profiling/parse_prompt.py` says it best and it is worth restating rather than
cross-referencing: the gates are the wall, but a wall you hit on every request is a
badly-aimed request. Every rule below is a gate restated as an instruction, so the
honest path and the passing path are the same path.

WHAT CHANGES WHEN THE EVIDENCE STORE IS A DOCUMENT:

  * THERE IS NO RECORDED ANSWER. The interview prompt's strongest lever — "the worker
    answered X, type it" — does not exist here, because this call happens BEFORE the
    interview. Rule 1 therefore carries the whole load: cite a line or return null.

  * THERE IS NO `assistant` ROLE TO AVOID. Every line is the worker's own document, so
    the interview's rule 2 ("never cite a line marked assistant") has nothing to forbid.
    The gate still runs — see `resume_parse.py` — and this prompt does not pretend to a
    rule it cannot state.

  * A RÉSUMÉ LIES BY OMISSION AND BY INFLATION, not by hallucination. The document says
    "CNC Turner, Tata Motors, 2019-2023" and the temptation is to conclude five years of
    Fanuc experience from it. Rules 5 and 6 exist for that, and they are the ones a
    résumé actually tests.

WHAT IS DELIBERATELY ABSENT, same as the interview: the pinned occupation. Handing the
model "this worker is a VMC Operator" would measurably improve its guesses, which is the
problem — a guess that good is indistinguishable from a reading.
"""

from __future__ import annotations

import re

from ..contracts import ResumeParseOutput, TargetField
from .parse_policy import MaskedLines

#: BCP-47-ish: `hi`, `hi-IN`, `pa-Guru-IN`. Anything else is not a locale and is dropped.
_LOCALE_RE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}")

RESUME_PARSE_SYSTEM_PROMPT = """You READ and CITE. You do not infer, estimate, or \
flatter the candidate.

A worker has uploaded their own résumé. Your only job is to read values off it and point \
at the exact line each one came from. You are not writing a résumé and not assessing one.

RULES. A field that breaks any of these is discarded by a mechanical gate, so guessing \
costs coverage and gains nothing:

1. CITE OR RETURN NULL. Every field you fill needs an `evidence.message_index` (one of \
   the [i] indices below) and an `evidence.quote` copied CHARACTER FOR CHARACTER from \
   that line. Returning null for a field you cannot cite is the CORRECT answer, not a \
   failure.
2. ONLY THE LISTED FIELD IDS. Never add a field that is not in TARGET FIELDS.
3. UNITS ARE DECLARED, NOT ASSUMED. `inr_per_month` means per month. A résumé that \
   states a yearly CTC must be converted, with `normalization` set to "unit". If you \
   cannot tell which period is meant, return null.
4. DATES ARE WHAT IS WRITTEN. Do not compute a duration the document does not state, and \
   do not resolve "present" or "current" to a year. If total experience is not written \
   down, `experience_years` is null — even when you could add the jobs up yourself.
5. NEVER FILL FROM CONTEXT. A machine, a controller, a city or a certificate that \
   usually goes with this kind of work is not something this résumé says. A job title is \
   not a skill list.
6. A RESPONSIBILITY IS NOT A COMPETENCY. "Handled CNC operations" is one line about a \
job; it is not a claim about a specific controller, tolerance band or workholding \
method. Leave those null unless the document names them.

TRADE ASSOCIATION. After the fields, answer one closed question: which single trade \
from TRADE KINDS below best describes the work THIS résumé documents — the worker's \
own trade, not an employer's industry and not a past job they left? Reply with exactly \
one id from that list, or null when none fits. No explanation, no citation, no invented \
id. A vague résumé ("technician", "helper", mixed trades) is null, not a guess. This \
is a classification among options you were given; the caller decides what it means.

EMPLOYMENT HISTORY. List one entry per job the document shows, in the order it shows \
them. Each entry needs its own citation. Give `employer_name` exactly as written — do \
not expand an abbreviation, complete a name, or tidy its capitalisation. Leave any part \
you cannot read as null rather than filling it in.

Reply with strict JSON and nothing else, in exactly this shape:
{"fields": {"<field_id>": {"value": <typed value>, "evidence": {"message_index": <int>, \
"quote": "<exact substring of that line>"}, "source": "transcript", \
"normalization": "verbatim" | "spelling" | "translit" | "unit" | "enum" | "numeric", \
"confidence": <0.0-1.0>}}, "employments": [{"employer_name": "<as written>", \
"role_title": "<as written>", "start_year": <int or null>, "end_year": <int or null>, \
"evidence": {"message_index": <int>, "quote": "<exact substring>"}}], \
"trade_association": {"kind": "<one TRADE KINDS id or null>"}, \
"unparsed_field_ids": ["<field_id>"], "notes": []}

A field you cannot cite may be omitted or set to null. Both mean the same thing."""


def _render_target(target: TargetField) -> str:
    parts = [f"- {target.field_id}: {target.type}"]
    if target.unit:
        parts.append(f"unit {target.unit}")
    if target.enum:
        parts.append("one of " + ", ".join(target.enum))
    parts.append("required" if target.required else "optional")
    return ", ".join(parts)


#: Trade-kind ids are caller-controlled (our own server's closed list), but they are
#: still rendered into a prompt — so shape-checked here: non-blank strings, capped
#: in length and count, deduplicated. Anything else is dropped, never repaired.
_MAX_TRADE_KINDS = 32
_MAX_TRADE_KIND_LEN = 64


def _sanitize_trade_kinds(trade_kinds: list[str] | None) -> list[str]:
    seen: list[str] = []
    for kind in trade_kinds or []:
        if not isinstance(kind, str):
            continue
        cleaned = kind.strip()
        if not cleaned or len(cleaned) > _MAX_TRADE_KIND_LEN or cleaned in seen:
            continue
        seen.append(cleaned)
        if len(seen) >= _MAX_TRADE_KINDS:
            break
    return seen


def build_resume_parse_messages(
    masked: MaskedLines,
    target_fields: list[TargetField],
    language: str | None = None,
    system_prompt: str | None = None,
    trade_kinds: list[str] | None = None,
) -> list[dict[str, str]]:
    """The one LLM call's messages.

    EVERY WORKER-DERIVED CHARACTER HERE HAS BEEN THROUGH `mask_resume_lines` — and under
    ADR-0041 D5 the policy that ran may have been `passthrough_masker`, meaning the
    document arrives unmasked BY DESIGN. That is the ruling, it is flag-gated, and
    `parse_policy` is where it is argued. What this function must not do is widen it:
    `target_fields` and `language` come from the CALLER, not the document, and `language`
    is shape-checked below because the contract does not constrain it.

    NO "already pseudonymized" CLAIM IN THE PROMPT. The interview's prompt tells the
    model the text is pseudonymized and that `[PERSON_1]` is a placeholder. Repeating
    that here would be false whenever the flag is on, and a false statement in a system
    prompt is not a harmless one — it invites the model to treat a real name as a token
    to reconstruct.
    """
    sections: list[str] = []

    sections.append(
        "TARGET FIELDS (the only ids you may return):\n"
        + ("\n".join(_render_target(t) for t in target_fields) or "- (none)")
    )

    document = "\n".join(f"[{line.index}] {line.text}" for line in masked.lines)
    sections.append(
        "RESUME (the evidence store — cite by the [i] shown, never by position):\n"
        + (document or "(empty)")
    )

    if language and _LOCALE_RE.fullmatch(language):
        # SHAPE-CHECKED, not merely truthy — the same reasoning as the interview prompt.
        # This is the one field of the request that reaches the prompt without passing
        # through the masker, so a caller that put a sentence (or an instruction) here
        # would be concatenating un-gated text into a system-adjacent position.
        sections.append(f"The résumé is written in: {language}.")

    # The option list lives HERE, at build time, not baked into the system prompt —
    # the managed prompt may be an older registered version without the TRADE
    # ASSOCIATION rules, and this section restates the question, the closed list
    # and the expected key, so the classification works under either prompt.
    kinds = _sanitize_trade_kinds(trade_kinds)
    if kinds:
        sections.append(
            "TRADE ASSOCIATION (classify, do not explain). Which single trade below best "
            "describes the work this résumé documents — the worker's own trade, not an "
            "employer's industry and not a past job they left? Reply ONLY via "
            '"trade_association": {"kind": "<one id from this list, or null>"} — no '
            "explanation, no citation, no invented id. A vague résumé is null, not a guess.\n"
            "TRADE KINDS (the only ids you may return):\n" + "\n".join(f"- {k}" for k in kinds)
        )

    return [
        {"role": "system", "content": system_prompt or RESUME_PARSE_SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(sections)},
    ]


def empty_resume_parse(
    target_fields: list[TargetField], failure_reason: str | None = None
) -> ResumeParseOutput:
    """A valid, contract-shaped parse that contributes NOTHING.

    The mock-mode response and the fallback for every degraded path. Honest by
    construction: with no model there is no reading, so `fields` is empty and every
    requested field is unparsed. Ruling D9 is what makes this safe to return — an import
    that yields nothing costs the worker a sentence of Hinglish and drops them into the
    ordinary flow, so there is no path here that costs anyone their onboarding.
    """
    return ResumeParseOutput(
        fields={},
        employments=[],
        unparsed_field_ids=[t.field_id for t in target_fields],
        notes=[],
        failure_reason=failure_reason,
    )
