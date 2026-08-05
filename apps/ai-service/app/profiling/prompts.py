"""Prompt assembly for the worker interview + extraction.

THE CHAT TURN IS NO LONGER A REPHRASE. It used to be: a deterministic engine chose the
question from a hardcoded bank and the model, when it was called at all, only put the
chosen question into nicer words. The engine is gone. The model now conducts the whole
interview for whatever trade the worker actually does, and everything it needs to do
that lives in the static block below.

MESSAGE LAYOUT, AND WHY THE ORDER IS LOAD-BEARING:

  [0] STATIC  - persona + field set + JSON schema. BYTE-IDENTICAL for every worker and
                every turn, because Gemini's implicit cache only applies to a stable
                PREFIX and bills a hit at ~10% of the normal rate. This block is ~1.6k
                estimated tokens, which clears the 1024-token floor for the first time
                (the old ~200-token persona never did, and model_config.py documents
                caching as a no-op because of it). Interpolating ANYTHING per-worker
                here - a trade name, a turn counter, a session id - silently costs the
                whole discount, with no error and no test failure. Do not do it.
  [1] DYNAMIC - trade hint, progress, what is still missing. Everything variable.
  [2] HISTORY - the recent transcript, oldest to newest.
  [3] TURN    - the worker's message.

HISTORY IS THREADED AGAIN, DELIBERATELY REVERSING COST-3. It used to be dropped: the
engine already knew what to ask, so the model needed no memory, and re-sending the
transcript made input cost grow O(n^2). Neither half holds now - a model that cannot
see the conversation cannot ask a follow-up, which is the entire point of the change.
The quadratic is bounded instead by PROFILING_HISTORY_MAX_TURNS, making it
O(n * window), and the static prefix is cached.

Every string reaching these builders is already pseudonymized.
"""

from __future__ import annotations

from ..config import Settings
from ..contracts import ConversationMessage
from .persona import PERSONA_SYSTEM_BLOCK
from .rfs import FIELD_LABEL, field_brief
from .turn_schema import SCHEMA_HINT

_TRADE_LABEL: dict[str, str] = {
    "cnc_vmc": "CNC/VMC manufacturing",
    "welding": "welding & fabrication",
    "plumbing": "plumbing & piping",
    "carpentry": "carpentry & woodworking",
    "design": "design (graphic / product / mechanical)",
    "interior_design": "interior design & space planning",
}


def _trade_name(role_family: str) -> str:
    return _TRADE_LABEL.get(role_family, "CNC/VMC manufacturing")


# ---------------------------------------------------------------------------
# The chat turn
# ---------------------------------------------------------------------------


def static_system_block(settings: Settings) -> str:
    """messages[0]. MUST be byte-stable for a given configuration - see the header.

    Depends only on `Settings` (the field set), never on the worker, the session, the
    turn, or the trade. `test_prompt_cache` pins that property, because losing it costs
    the caching discount silently.
    """
    return "\n\n".join((PERSONA_SYSTEM_BLOCK, field_brief(settings), SCHEMA_HINT))


def turn_context_message(
    *,
    role_family: str | None,
    captured: dict[str, str],
    missing: list[str],
    turn_index: int,
    max_turns: int,
    force_complete: bool,
) -> str:
    """messages[1]. Everything that varies - kept OUT of the cached prefix.

    Telling the model what it already has is what implements "never ask what has already
    been answered" (Law 8) without a deterministic engine tracking it. Telling it what
    is missing is what keeps a free-form interview converging instead of wandering.
    """
    lines: list[str] = []

    # A HINT, not an instruction. The worker's actual trade is whatever they say it is;
    # this only helps the model pitch its vocabulary on turn one, and it must feel free
    # to abandon it the moment the worker says something else.
    if role_family:
        lines.append(
            "Likely trade (a hint only — believe the worker over this): "
            f"{_trade_name(role_family)}."
        )

    if captured:
        known = "; ".join(f"{FIELD_LABEL.get(k, k)}: {v}" for k, v in captured.items())
        lines.append(f"ALREADY ANSWERED — never ask about these again: {known}")
    else:
        lines.append("Nothing collected yet. This is the start of the conversation.")

    if missing:
        lines.append(
            "STILL MISSING: " + ", ".join(FIELD_LABEL.get(m, m) for m in missing) + "."
        )

    lines.append(f"This is turn {turn_index} of at most {max_turns}.")

    if force_complete:
        # The hard cap fired. The endpoint will force completion regardless of what
        # comes back, so the model's only remaining job is to close warmly.
        lines.append(
            "FINAL TURN. Do not ask a question. Thank them in one short line and tell "
            'them their resume is being made. Set "is_complete": true.'
        )
    elif not missing:
        lines.append(
            'Everything required is collected. Close warmly and set "is_complete": true.'
        )

    return "\n".join(lines)


def build_chat_messages(
    *,
    settings: Settings,
    history: list[ConversationMessage],
    worker_message: str,
    role_family: str | None,
    captured: dict[str, str],
    missing: list[str],
    turn_index: int,
    force_complete: bool = False,
    repair: str | None = None,
) -> list[dict[str, str]]:
    """Assemble one chat turn.

    `history` is expected PRE-WINDOWED by the caller (the API owns the buffer and the
    window size), so this function does not truncate: a builder that silently dropped
    turns would make the window invisible at the call site where the cost decision is
    actually made.

    `repair` carries the persona guard's correction on the single retry. It goes LAST,
    after the offending exchange, so the model sees what it wrote and why it was wrong.
    """
    messages: list[dict[str, str]] = [
        {"role": "system", "content": static_system_block(settings)},
        {
            "role": "system",
            "content": turn_context_message(
                role_family=role_family,
                captured=captured,
                missing=missing,
                turn_index=turn_index,
                max_turns=settings.profiling_max_turns,
                force_complete=force_complete,
            ),
        },
    ]

    for msg in history:
        if msg.role == "assistant":
            messages.append({"role": "assistant", "content": msg.text})
        elif msg.role == "worker":
            messages.append({"role": "user", "content": msg.text})
        # `system` history entries are dropped: they were never worker-visible and
        # re-feeding them would let an old instruction outrank the current turn.

    messages.append({"role": "user", "content": worker_message})

    if repair:
        messages.append({"role": "system", "content": repair})

    return messages


# ---------------------------------------------------------------------------
# Extraction + resume — UNCHANGED by the chat rewrite.
# ---------------------------------------------------------------------------
# These run on the whole transcript AFTER the interview, are a different task type with
# their own route and token budget, and are not affected by how the questions were
# chosen. Left exactly as they were.


def extraction_system_prompt(role_family: str = "cnc_vmc") -> str:
    trade = _trade_name(role_family)
    return (
        f"You convert a messy Hinglish worker chat transcript into a STRICT JSON "
        f"worker profile for {trade}. Output JSON ONLY, using the schema "
        "keys provided. Use null or empty arrays where unknown — never invent values. "
        "The transcript is pseudonymized: tokens like [PERSON_1], [EMPLOYER_1], "
        "[PHONE_1], [ID_1], [AMOUNT_1] are placeholders; never guess the real values "
        "behind them. City names are NOT placeholders — they are real and may be used.\n"
        "Convert Hinglish number-words and durations to numbers: 'aadha'/'adha'=0.5, "
        "'pauna'/'paune'=0.75, 'sava'=1.25, 'dedh'/'dhedh'=1.5, 'paune do'=1.75, "
        "'dhai'/'dhaai'=2.5; 'saal'/'sal'/'varsh'=years, 'mahina'/'mahine'/'month'=months "
        "(convert months to a fraction of a year). Example: 'dedh saal' -> "
        "experience_years 1.5; '6 mahine' -> 0.5.\n"
        "TWO SEPARATE education fields, both scalars (a string or null), DISTINCT from "
        "the `education` list (which holds ITI/diploma/training mentions): "
        "`education_level` = the worker's highest schooling level as a short label "
        "('10th', '12th', 'ITI', 'Diploma', 'B.Tech', 'Graduate'); `education_field` = "
        "their stream/branch of study ('Electronics', 'Mechanical', 'Computer Science', "
        "'Electrical'). Fill each ONLY from what the worker actually says about their "
        "studies; use null when they did not mention it.\n"
        "CAPTURE what the worker DID say, even if rough — null is only for what they "
        "genuinely did not mention (this applies to the fields below; for the role, "
        "follow the canonical-role rules):\n"
        "- A stated duration of work -> experience_years (even if the work sounds "
        "basic, e.g. 'button dabate the dedh saal' -> 1.5).\n"
        "- Operating ANY machine, even generic 'CNC' with no specific type -> add 'CNC' "
        "to machines (use 'VMC'/'CNC Lathe'/etc. only when the worker names it).\n"
        "- 'chalata tha'/'operate karta tha'/'button dabata tha' -> operation_knowledge "
        "at least 'basic'.\n"
        "Lines starting 'Bada Bhai:' are OUR OWN questions to the worker, not their "
        "answers. Read them for context only. Never take a value from them: if our "
        "question lists options ('Fanuc, Siemens, Mitsubishi?') and the worker names "
        "one, record ONLY the one they named. If our question gives an example "
        "('jaise 2 saal ya 5 saal') the example is not their answer. If a topic was "
        "asked but not answered, it stays null/empty.\n"
        # The LLM emits PHRASES; the vector layer assigns ids. A model that answered
        # `"skills": ["skill_mig_welding"]` had that id-shaped string persisted and
        # RENDERED ON THE RESUME as if the worker had said it. This block is the prompt
        # half of the fix; the enforcement half (a drop filter, because a prompt is a
        # request and not a guarantee) lives in profile_extractor.
        "PHRASES, NOT IDS. In `skills`, `machines` and `controllers` write the words a "
        "shop-floor worker would actually say — 'MIG welding', 'tool offset setting', "
        "'drawing reading', 'VMC', 'CNC Lathe', 'Fanuc'. NEVER write a taxonomy or "
        "database id in those three arrays: nothing shaped like skill_mig_welding, "
        "mach_vmc, dom_welding or role_welder, and no lower_snake_case code word of any "
        "kind. If you do not know the English term, KEEP THE WORKER'S OWN HINGLISH WORD "
        "('kharad', 'chhilai', 'ghisai', 'setting', 'ghisai ka kaam') — a rough phrase is "
        "useful to us, an invented id is not, and any id you write there is DISCARDED.\n"
        "The ONE exception is the `canonical_role_id` field described below: that field, "
        "and only that field, takes exactly one id from the closed list given there. The "
        "rule above governs the skills/machines/controllers arrays only — it does not "
        "apply to canonical_role_id.\n"
    )


EXTRACTION_SYSTEM_PROMPT = extraction_system_prompt()


RESUME_SYSTEM_PROMPT = (
    "You write a short, plain worker summary from a structured profile. "
    "2-4 sentences, factual, no buzzwords, no invented details, and no personal "
    "identity data (the backend adds the name separately). "
    "If the profile lists education or certifications (e.g. ITI, Diploma, NCVT), "
    "mention them briefly; if it lists none, do not invent any.\n"
    "CRITICAL: All profile fields are already human-readable labels, never "
    "taxonomy IDs. Use the labels exactly as given — do not write raw IDs "
    "like skill_milling or role_vmc_operator.\n"
)
