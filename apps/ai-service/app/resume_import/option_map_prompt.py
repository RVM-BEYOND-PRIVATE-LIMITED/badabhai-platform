"""The résumé option-mapping prompt — document lines onto pack option ids.

A THIRD call after `/resume/parse`, run at import time for form-routed workers.
The parse reads citable VALUES; this call answers one question per pack item:
which of THESE option ids does the document support.

OWNER OVERRIDE B (2026-09-20) OF RULING D2 APPLIES TO THE CONSUMER, NOT TO THIS
PROMPT. The API writes returned ids as answers on the identity "haan" without
per-fact confirmation — but this prompt stays as strict as the parse's: closed
ids copied verbatim, every mapping cited, anything else dropped. The override
widens what may be DONE with a mapping, never what counts AS one.
"""

from __future__ import annotations

import re

from ..contracts import ResumeMapQuestion, ResumeOptionMapOutput
from .parse_policy import MaskedLines

#: BCP-47-ish: `hi`, `hi-IN`. Anything else is not a locale and is dropped.
_LOCALE_RE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}")

RESUME_OPTION_MAP_SYSTEM_PROMPT = """You READ a worker's own resume and match it \
against a list of questions. You do not infer, estimate, or flatter them.

Each QUESTION below names something about the worker's trade and lists the only \
option ids you may return for it. Your only job is to say which of those ids the \
resume supports, and to point at the exact line each one came from. You are not \
writing a resume and not assessing one.

RULES. A mapping that breaks any of these is discarded by a mechanical gate, so \
guessing costs coverage and gains nothing:

1. CITE OR OMIT. Every mapping needs an `evidence.message_index` (one of the [i] \
indices below) and an `evidence.quote` copied CHARACTER FOR CHARACTER from that \
line. Omitting a question you cannot cite is the CORRECT answer, not a failure.
2. OPTION IDS ARE COPIED VERBATIM. Reply with `option_key` values EXACTLY as written \
under OPTIONS — same spelling, same underscores, same case. Never invent an id, \
never return a label in place of an id, never return an id from a different \
question. An id you cannot copy exactly is a question you omit.
3. ONE MAPPING PER QUESTION, AT MOST. Never return two mappings for the same \
`question_key`. A `single_select` question takes AT MOST ONE `option_key`; a \
`multi_select` takes the ones the document supports, each cited by the same span.
4. A RESPONSIBILITY IS NOT A COMPETENCY. "Handled grinding operations" supports no \
specific machine, controller, tolerance band or material. Leave those questions \
out unless the document NAMES the thing the option says.
5. NEVER FILL FROM CONTEXT. A machine, controller, city, or certificate that \
usually goes with this kind of work is not something this resume says. Omit it \
unless the document names it.

Reply with strict JSON and nothing else, in exactly this shape:
{"mappings": [{"question_key": "<one QUESTION id>", "option_keys": ["<verbatim \
option ids>"], "evidence": {"message_index": <int>, "quote": "<exact substring \
of that line>"}}]}

A question you cannot fill honestly is omitted. Omission is the CORRECT answer, \
not a failure."""


#: Caller-controlled reviewed copy, but still rendered into a prompt — so
#: shape-checked here: non-blank ids, capped in length and count, deduplicated
#: questions. Anything else is dropped, never repaired.
_MAX_QUESTIONS = 40
_MAX_OPTIONS_PER_QUESTION = 32
_MAX_ID_LEN = 40
_MAX_LABEL_LEN = 200
_MAX_PROMPT_LEN = 500


def _clean(text: object, limit: int) -> str | None:
    if not isinstance(text, str):
        return None
    cleaned = text.strip()
    if not cleaned or len(cleaned) > limit:
        return None
    return cleaned


def _sanitize_questions(questions: list[ResumeMapQuestion] | None) -> list[ResumeMapQuestion]:
    seen: list[ResumeMapQuestion] = []
    seen_keys: set[str] = set()
    for question in questions or []:
        if not isinstance(question, ResumeMapQuestion):
            continue
        key = _clean(question.question_key, _MAX_ID_LEN)
        if key is None or key in seen_keys:
            continue
        options = []
        for option in question.options or []:
            option_key = _clean(getattr(option, "option_key", None), _MAX_ID_LEN)
            label = _clean(getattr(option, "label_text", None), _MAX_LABEL_LEN)
            if option_key is None or label is None:
                continue
            if any(o.option_key == option_key for o in options):
                continue
            options.append(type(option)(option_key=option_key, label_text=label))
            if len(options) >= _MAX_OPTIONS_PER_QUESTION:
                break
        if not options:
            continue
        seen_keys.add(key)
        seen.append(
            ResumeMapQuestion(question_key=key, answer_type=question.answer_type, options=options)
        )
        if len(seen) >= _MAX_QUESTIONS:
            break
    return seen


def _render_question(question: ResumeMapQuestion, prompt_text: str | None = None) -> str:
    lines = [f"QUESTION `{question.question_key}` ({question.answer_type}):"]
    if prompt_text:
        lines.append(f"  asks: {prompt_text}")
    lines.append("  OPTIONS (the only ids you may return for this question):")
    lines.extend(f"  - {o.option_key}: {o.label_text}" for o in question.options)
    return "\n".join(lines)


def build_resume_option_map_messages(
    masked: MaskedLines,
    questions: list[ResumeMapQuestion] | None = None,
    prompts: dict[str, str] | None = None,
    language: str | None = None,
    system_prompt: str | None = None,
) -> list[dict[str, str]]:
    """The one LLM call's messages.

    EVERY WORKER-DERIVED CHARACTER HERE HAS BEEN THROUGH `mask_resume_lines` —
    and under ADR-0041 D5 the policy that ran may have been `passthrough_masker`,
    meaning the document arrives unmasked BY DESIGN (see `parse_policy`). What this
    function must not do is widen it: `questions`, `prompts` and `language` come
    from the CALLER (reviewed pack copy), not the document.

    NO "already pseudonymized" CLAIM IN THE PROMPT — same reason as the parse and
    summary prompts: repeating it would be false whenever the raw-text flag is on.
    """
    sections: list[str] = []

    clean = _sanitize_questions(questions)
    prompt_map = prompts or {}
    rendered = []
    for question in clean:
        prompt_text = _clean(prompt_map.get(question.question_key), _MAX_PROMPT_LEN)
        rendered.append(_render_question(question, prompt_text))
    sections.append(
        "QUESTIONS (at most one mapping each; ids verbatim or omit):\n"
        + ("\n\n".join(rendered) or "- (none)")
    )

    document = "\n".join(f"[{line.index}] {line.text}" for line in masked.lines)
    sections.append(
        "RESUME (the evidence store — cite by the [i] shown, never by position):\n"
        + (document or "(empty)")
    )

    if language and _LOCALE_RE.fullmatch(language):
        # SHAPE-CHECKED, not merely truthy — the same reasoning as the parse prompt.
        sections.append(f"The resume is written in: {language}.")

    return [
        {"role": "system", "content": system_prompt or RESUME_OPTION_MAP_SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(sections)},
    ]


def empty_resume_option_map(failure_reason: str | None = None) -> ResumeOptionMapOutput:
    """A valid, contract-shaped mapping that contributes NOTHING.

    The mock-mode response and the fallback for every degraded path. Honest by
    construction: with no model there is no reading, so `mappings` is empty.
    Ruling D9 is what makes this safe to return — an import that yields nothing
    stages nothing, and the Haan hands over to an unfilled form.
    """
    return ResumeOptionMapOutput(
        mappings=[],
        notes=[],
        failure_reason=failure_reason,
    )
