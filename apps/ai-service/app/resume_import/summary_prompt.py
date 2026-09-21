"""The résumé profile-summary prompt — one Hinglish line off a document.

A SECOND, SEPARATE call after `/resume/parse`, not an extension of it. The parse
reads citable VALUES under six gates; this call reads the same document for one
worker-facing line: {Job Role} + {total experience} + {short summary}.

WHY SEPARATE: the parse is citation-bound (cite a line or return null) and its
output feeds deterministic routing. The summary is PRESENTATION-bound (Hinglish,
1-2 lines, no identifiers) and feeds nothing yet — backend-only, Langfuse-verified,
never shown in chat in this slice. Mixing the two would let a presentation
instruction ("write Hinglish") loosen a citation instruction ("copy character for
character"), which is exactly how a cited value becomes a paraphrase.

WHAT THE MODEL MAY AND MAY NOT DO:

  * MAY classify the worker's OWN trade among the caller-supplied ROLE KINDS.
    That is a classification among given options, never a canonical id it
    produced on its own — the caller decides what it means, and the gate drops
    anything outside the list to null.
  * MAY read total experience only as written. It must never add stints up
    itself, never resolve "present" to a year, never convert a yearly CTC.
  * MUST write Hinglish in ROMAN script only — no Devanagari, no English prose.
    The worker app renders this line to low-literacy workers; script drift is a
    readability defect, not a preference.
  * MUST NOT carry identity: no name, phone, address, employer, PAN/Aadhaar,
    email. The gate certifies both strings and degrades them to null.
"""

from __future__ import annotations

import re

from ..contracts import ResumeSummaryOutput
from .parse_policy import MaskedLines

#: BCP-47-ish: `hi`, `hi-IN`. Anything else is not a locale and is dropped.
_LOCALE_RE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}")

RESUME_SUMMARY_SYSTEM_PROMPT = """You READ a worker's own resume and write ONE \
Hinglish line about them. You do not infer, estimate, or flatter them.

You are not writing a resume and not assessing one. Your only job is to say \
who this worker is as a worker: their trade, their total tajurba, and one \
short line about their kaam.

RULES. A field that breaks any of these is discarded by a mechanical gate, so \
guessing costs coverage and gains nothing:

1. HINGLISH ONLY, ROMAN SCRIPT ONLY. Every word of `experience_text` and \
`summary_text` is Hinglish in Roman script (jaise "5 saal ka tajurba", \
"CNC lathe par kaam"). No Devanagari, no English sentences. Roman Hinglish is \
what the worker reads; anything else is dropped.
2. ROLE IS A CLASSIFICATION, NOT A READING. Reply with exactly one id from \
ROLE KINDS below in `role_kind`, or null when none fits. No explanation, no \
invented id. The worker's OWN trade — not an employer's industry, not a past \
job they left. A vague resume ("technician", "helper", mixed trades) is null, \
not a guess. This is why the list exists: a guess outside it cannot be rendered.
3. EXPERIENCE IS WHAT IS WRITTEN. If total tajurba is written down, write it in \
Hinglish ("5 saal ka tajurba", "2 saal ka tajurba"). If the document says \
fresher or no experience, write exactly "Fresher". If it is not written and \
cannot be told, `experience_text` is null — even when you could add the jobs up \
yourself. Do not compute a duration the document does not state, and do not \
resolve "present" or "current" to a year.
4. SUMMARY IS 1-2 LINES OF KAAM ONLY. What trade, how much tajurba, what \
machines or kaam are named — in Hinglish, Roman script, max 2 lines. Never a \
name, phone, address, employer name, PAN, Aadhaar, or email. A summary carrying \
any of those is dropped whole, which is why you must leave them out rather \
than copy the header line.
5. NEVER FILL FROM CONTEXT. A machine, controller, city, or certificate that \
usually goes with this kind of work is not something this resume says. A job \
title is not a skill list. Leave it out unless the document names it.

Reply with strict JSON and nothing else, in exactly this shape:
{"role_kind": "<one ROLE KINDS id or null>", "experience_text": \
"<Hinglish Roman script or null>", "summary_text": \
"<Hinglish Roman script 1-2 lines or null>"}

A field you cannot fill honestly is null. Null is the CORRECT answer, not a \
failure."""


def _render_role_kind(kind: str) -> str:
    return f"- {kind}"


#: Role-kind ids are caller-controlled (our own server's closed list of ENABLED
#: form kinds), but they are still rendered into a prompt — so shape-checked
#: here: non-blank strings, capped in length and count, deduplicated. Anything
#: else is dropped, never repaired.
_MAX_ROLE_KINDS = 32
_MAX_ROLE_KIND_LEN = 64


def _sanitize_role_kinds(role_kinds: list[str] | None) -> list[str]:
    seen: list[str] = []
    for kind in role_kinds or []:
        if not isinstance(kind, str):
            continue
        cleaned = kind.strip()
        if not cleaned or len(cleaned) > _MAX_ROLE_KIND_LEN or cleaned in seen:
            continue
        seen.append(cleaned)
        if len(seen) >= _MAX_ROLE_KINDS:
            break
    return seen


def build_resume_summary_messages(
    masked: MaskedLines,
    role_kinds: list[str] | None = None,
    language: str | None = None,
    system_prompt: str | None = None,
) -> list[dict[str, str]]:
    """The one LLM call's messages.

    EVERY WORKER-DERIVED CHARACTER HERE HAS BEEN THROUGH `mask_resume_lines` —
    and under ADR-0041 D5 the policy that ran may have been `passthrough_masker`,
    meaning the document arrives unmasked BY DESIGN. That is the ruling, it is
    flag-gated, and `parse_policy` is where it is argued. What this function must
    not do is widen it: `role_kinds` and `language` come from the CALLER, not the
    document, and `language` is shape-checked below because the contract does not
    constrain it.

    NO "already pseudonymized" CLAIM IN THE PROMPT — same reason as the parse
    prompt: repeating it would be false whenever the raw-text flag is on, and a
    false statement in a system prompt invites the model to treat a real name as
    a token to reconstruct.
    """
    sections: list[str] = []

    kinds = _sanitize_role_kinds(role_kinds)
    if kinds:
        sections.append(
            "ROLE KINDS (the only ids you may return in `role_kind`):\n"
            + "\n".join(_render_role_kind(k) for k in kinds)
        )
    else:
        sections.append("ROLE KINDS (the only ids you may return in `role_kind`):\n- (none)")

    document = "\n".join(f"[{line.index}] {line.text}" for line in masked.lines)
    sections.append(
        "RESUME (the evidence store — read it, never copy identity out of it):\n"
        + (document or "(empty)")
    )

    if language and _LOCALE_RE.fullmatch(language):
        # SHAPE-CHECKED, not merely truthy — the same reasoning as the parse prompt.
        # This is the one field of the request that reaches the prompt without passing
        # through the masker, so a caller that put a sentence (or an instruction) here
        # would be concatenating un-gated text into a system-adjacent position.
        sections.append(f"The resume is written in: {language}.")

    return [
        {"role": "system", "content": system_prompt or RESUME_SUMMARY_SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(sections)},
    ]


def empty_resume_summary(failure_reason: str | None = None) -> ResumeSummaryOutput:
    """A valid, contract-shaped summary that contributes NOTHING.

    The mock-mode response and the fallback for every degraded path. Honest by
    construction: with no model there is no reading, so every field is null.
    Ruling D9 is what makes this safe to return — an import that yields nothing
    costs the worker a sentence of Hinglish and drops them into the ordinary
    flow, so there is no path here that costs anyone their onboarding.
    """
    return ResumeSummaryOutput(
        role_kind=None,
        experience_text=None,
        summary_text=None,
        notes=[],
        failure_reason=failure_reason,
    )
