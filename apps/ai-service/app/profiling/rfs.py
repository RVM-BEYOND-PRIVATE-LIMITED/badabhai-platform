"""The Resume Field Set - what the interview must come away with.

THIS REPLACES THE QUESTION BANK. The old design encoded 7 hardcoded role families in
632 lines of Python, so supporting a cook, a driver or a tailor meant writing a new
question pack. The model now invents its own questions for whatever trade the worker
actually does, and the only thing fixed is WHAT IT MUST COLLECT. That target is this
module, and the required/optional split is CONFIG (PROFILING_REQUIRED_FIELDS /
PROFILING_OPTIONAL_FIELDS), so changing what a resume needs is an env edit, never a
code edit. That is the whole meaning of "generalized profiling".

REQUIRED vs OPTIONAL is the distinction persona Law 4 turns on. Law 4 governs what the
model may ASK; it does not govern what we may RECORD. A worker who volunteers an ITI
diploma or a driving licence gets it on their resume without ever being interrogated
for it - so optional fields are captured-if-offered and never asked.

TRADE-AGNOSTIC BY CONSTRUCTION. `tools_equipment` is a VMC and a Fanuc controller for a
machinist, an overlock for a tailor, a tandoor for a cook, an LMV licence class for a
driver. One field, no per-trade code, which is exactly what the question bank could not
do.

PRIVACY: there is deliberately NO field here for name, phone, address, employer name,
or any ID. Persona Law 5 forbids asking for them and `pseudonymize` blocks them from
reaching the model at all; leaving them out of the vocabulary too means an LLM that
tried to volunteer one has nowhere to put it.
"""

from __future__ import annotations

from ..config import Settings

# What each field id MEANS, rendered into the prompt so the model knows what it is
# collecting. Deliberately phrased as the INFORMATION wanted, never as a question to
# ask - the model writes the questions, in the worker's trade and register.
FIELD_GUIDE: dict[str, str] = {
    "trade": "what work they do, in their own words",
    "skills": "what they can actually do - tasks, machines, tools, software, materials",
    "experience_years": "how long they have done this work (a number of years)",
    "current_city": "the city they are in now",
    "preferred_locations": "where they want to work (may differ from where they are)",
    "salary_expected": "the pay they want, and per month or per day",
    "availability": "when they can start, or their notice period",
    "tools_equipment": "specific machines, tools, vehicles or software they operate",
    "salary_current": "what they earn now",
    "education_level": "highest schooling (10th, 12th, ITI, Diploma, Graduate)",
    "education_field": "their stream or trade of study",
    "certifications": "certificates, licences or trade tickets they hold",
    "work_history": "roles held and for how long (NEVER the employer's name)",
    "languages": "languages they speak",
    "relocation_willingness": "whether they would move city for work",
}

# A short, human label for a field id, for the missing-field nudge and for logs.
FIELD_LABEL: dict[str, str] = {
    "trade": "trade",
    "skills": "skills",
    "experience_years": "experience",
    "current_city": "current city",
    "preferred_locations": "preferred locations",
    "salary_expected": "expected salary",
    "availability": "availability",
    "tools_equipment": "tools/equipment",
    "salary_current": "current salary",
    "education_level": "education level",
    "education_field": "field of study",
    "certifications": "certifications",
    "work_history": "work history",
    "languages": "languages",
    "relocation_willingness": "relocation",
}


def required_fields(settings: Settings) -> tuple[str, ...]:
    return settings.profiling_required_field_list


def optional_fields(settings: Settings) -> tuple[str, ...]:
    return settings.profiling_optional_field_list


def known_fields(settings: Settings) -> frozenset[str]:
    """The closed vocabulary the model may write into `captured`.

    Anything else is DROPPED rather than stored - the same fail-safe posture the
    extraction path takes with model-invented taxonomy ids. A model that hallucinates
    a field name should cost us one ignored key, not a junk column in a resume.
    """
    return frozenset(settings.profiling_all_fields)


def normalize_captured(
    captured: dict[str, object] | None,
    settings: Settings,
) -> tuple[dict[str, str], list[str]]:
    """Coerce the model's `captured` map to `{known_field: short string}`.

    Returns (kept, dropped_keys). Values are stringified and trimmed; empty ones are
    dropped, because "the model wrote the key with an empty value" must not read as
    "the worker answered". Long values are truncated - a captured field is a SHORT
    fact ("VMC operator", "5 saal", "Pune"), and anything longer is the model
    summarising the conversation into a field, which is not what these are for.
    """
    if not isinstance(captured, dict):
        return {}, []
    allowed = known_fields(settings)
    kept: dict[str, str] = {}
    dropped: list[str] = []
    for key, value in captured.items():
        if key not in allowed:
            dropped.append(str(key))
            continue
        if value is None:
            continue
        text = " ".join(str(value).split())
        if not text:
            continue
        kept[key] = text[:_MAX_VALUE_CHARS]
    return kept, dropped


_MAX_VALUE_CHARS = 120


def missing_required(captured: dict[str, str], settings: Settings) -> list[str]:
    """Required fields with nothing captured yet, in the configured order.

    Order is preserved so the nudge names the fields in the priority the operator set,
    rather than in whatever order a dict happened to iterate.
    """
    return [f for f in required_fields(settings) if not captured.get(f)]


def is_complete(captured: dict[str, str], settings: Settings) -> bool:
    """Every REQUIRED field captured. Optional fields never gate completion - they are
    a bonus if the worker volunteered them, and asking for them would break Law 4."""
    return not missing_required(captured, settings)


def field_brief(settings: Settings) -> str:
    """The collection target, rendered for the system prompt.

    Split required/optional explicitly, because the model must understand that the
    optional list is a RECORDING vocabulary and not an asking list - that distinction
    is the whole of Law 4, and a flat list would read as fifteen things to ask about.
    """
    req = required_fields(settings)
    opt = optional_fields(settings)

    lines = ["FIELDS YOU MUST COLLECT. Ask about these, one at a time, in any order that",
             "follows the conversation naturally:"]
    for f in req:
        lines.append(f"  {f} - {FIELD_GUIDE.get(f, FIELD_LABEL.get(f, f))}")
    if opt:
        lines.append("")
        lines.append("RECORD THESE ONLY IF THE WORKER VOLUNTEERS THEM. Never ask for them:")
        for f in opt:
            lines.append(f"  {f} - {FIELD_GUIDE.get(f, FIELD_LABEL.get(f, f))}")
    return "\n".join(lines)
