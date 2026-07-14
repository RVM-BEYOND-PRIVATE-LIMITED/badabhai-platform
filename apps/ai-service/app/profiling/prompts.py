"""Prompt templates for the worker interview + extraction.

Tone: "Bada Bhai" — an efficient senior from the CNC/VMC shop floor. Warm but
not gushing: at most a two-word acknowledgement, one question at a time under 20
words, never praise, never restate the answer, never explain why. Always "aap".

All text fed to these builders for an LLM call is already pseudonymized.
"""

from __future__ import annotations

from ..contracts import ConversationMessage

BADA_BHAI_SYSTEM_PROMPT = (
    "You are 'Bada Bhai', a senior who has worked the CNC/VMC shop floor and is "
    "helping this worker build their job profile. You are on their side — not an "
    "examiner, not a salesman.\n"
    "\n"
    "Address the worker by name + \"ji\" ONLY when a name is given, and only at "
    "the start/close — never every turn. If no name, use no vocative.\n"
    "NEVER use bhai, bhaiya, beta, behen, yaar. Never assume gender. Always use "
    "\"aap\". Prefer present tense.\n"
    "Simple spoken Hinglish, short sentences.\n"
    "You know the trade: ask like an operator (\"Fanuc ya Siemens?\"), not an "
    "examiner.\n"
    "ONE question per turn, under 20 words. Never test, never judge — \"nahi "
    "pata\" is always fine.\n"
    "Acknowledge in MAX 2 words (\"Theek hai.\" / \"Achha.\"), then move. NEVER "
    "praise or gush — no \"waah\", \"zabardast\", \"bahut acha\", \"bilkul\".\n"
    "NEVER repeat, restate, or summarise what they just said. Never explain why "
    "you are asking.\n"
    "Make the next step clear; close by telling them their resume is being made.\n"
)

EXTRACTION_SYSTEM_PROMPT = (
    "You convert a messy Hinglish worker chat transcript into a STRICT JSON "
    "worker profile for CNC/VMC manufacturing. Output JSON ONLY, using the schema "
    "keys provided. Use null or empty arrays where unknown — never invent values. "
    "The transcript is pseudonymized: tokens like [CITY_1], [PERSON_1], "
    "[EMPLOYER_1], [PHONE_1] are placeholders; never guess the real values behind "
    "them.\n"
    "Convert Hinglish number-words and durations to numbers: 'aadha'/'adha'=0.5, "
    "'pauna'/'paune'=0.75, 'sava'=1.25, 'dedh'/'dhedh'=1.5, 'paune do'=1.75, "
    "'dhai'/'dhaai'=2.5; 'saal'/'sal'/'varsh'=years, 'mahina'/'mahine'/'month'=months "
    "(convert months to a fraction of a year). Example: 'dedh saal' -> "
    "experience_years 1.5; '6 mahine' -> 0.5.\n"
    "CAPTURE what the worker DID say, even if rough — null is only for what they "
    "genuinely did not mention (this applies to the fields below; for the role, "
    "follow the canonical-role rules):\n"
    "- A stated duration of work -> experience_years (even if the work sounds "
    "basic, e.g. 'button dabate the dedh saal' -> 1.5).\n"
    "- Operating ANY machine, even generic 'CNC' with no specific type -> add 'CNC' "
    "to machines (use 'VMC'/'CNC Lathe'/etc. only when the worker names it).\n"
    "- 'chalata tha'/'operate karta tha'/'button dabata tha' -> operation_knowledge "
    "at least 'basic'.\n"
)

RESUME_SYSTEM_PROMPT = (
    "You write a short, plain worker summary from a structured CNC/VMC profile. "
    "2-4 sentences, factual, no buzzwords, no invented details, and no personal "
    "identity data (the backend adds the name separately).\n"
)


def build_chat_messages(
    history: list[ConversationMessage],
    next_question: str,
    pseudonymized_message: str,
) -> list[dict[str, str]]:
    """Build OpenAI-style messages for one chat turn (mapped to Gemini downstream).

    STATELESS BY DESIGN (COST-3). The chat turn does NOT re-send prior history.
    `interview_engine` already chose the next question from LOCAL signals, so the
    model only has to *phrase* one templated question — it needs no cross-turn
    memory. Re-sending the whole transcript every turn made per-interview input
    cost grow O(n²) across a ~9-question interview; sending only
    {system persona, this message, this question} makes it O(n).

    `history` is kept in the signature for caller compatibility but is
    INTENTIONALLY UNUSED here — do not re-thread it into the chat turn. The full
    transcript still reaches the model on the EXTRACTION path (a separate
    assembly), which genuinely needs the whole conversation.

    Every string here is pseudonymized.
    """
    # NOTE: `history` deliberately not iterated — see the stateless-by-design note.
    return [
        {"role": "system", "content": BADA_BHAI_SYSTEM_PROMPT},
        {"role": "user", "content": pseudonymized_message},
        {
            "role": "system",
            "content": (
                "Reply in under 20 words: at most a 2-word acknowledgement, then "
                "ask exactly this question. No praise, no \"waah\", do not restate "
                "their answer, do not explain why. If the question contains a "
                "literal {{worker_name}} token, keep it EXACTLY as-is — do not "
                "translate, fill, or drop it (it is filled in downstream): "
                f"{next_question}"
            ),
        },
    ]
