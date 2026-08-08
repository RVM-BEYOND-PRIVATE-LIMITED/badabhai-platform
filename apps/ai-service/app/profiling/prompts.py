"""Prompt assembly for extraction and resume generation.

THE CHAT TURN IS GONE FROM THIS FILE (OIE Phase 8). It used to hold the whole worker
interview: a cached static persona block, a per-turn context message, and a history
threader — everything a model needed to conduct a conversation. It needs none of it now,
because a model no longer conducts one. Questions come from reviewed question packs and
the orchestrator picks them deterministically, so the only prompts left here are the two
that run AFTER the interview, on the whole transcript, as their own task types.

WHAT SURVIVED AND WHY IT IS UNCHANGED. ``extraction_system_prompt`` and
``RESUME_SYSTEM_PROMPT`` were never affected by how the questions were chosen — they read
a finished transcript. ``/profile/extract`` also stays live: an interview finalized before
the cutover has no answer map, and re-parsing its transcript is exactly what should
happen to it.

Every string reaching these builders is already pseudonymized.
"""

from __future__ import annotations

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
