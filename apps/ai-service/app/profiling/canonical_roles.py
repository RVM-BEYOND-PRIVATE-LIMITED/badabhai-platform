"""The closed set of canonical CNC/VMC role ids the LLM must canonicalize into.

Single source of truth derived from ``signals._ROLES`` (the heuristic gazetteer
is the taxonomy authority): ``role_id -> trade_id`` plus short descriptions and a
disambiguation rubric used to instruct the model. The LLM proposes a
``canonical_role_id``; the endpoint VALIDATES it against ``ROLE_TRADE`` before
trusting it, so a hallucinated id can never enter the profile.

Taxonomy/test data only — no PII.
"""

from __future__ import annotations

import json

from .signals import _EXTRA_ROLE_TRADES, _ROLES

# role_id -> trade_id, straight from the gazetteer (the taxonomy source of truth).
#
# `_ROLES` (keyword-matched) PLUS `_EXTRA_ROLE_TRADES` (in the closed set, but assigned
# by dedicated gated logic rather than a keyword — `role_welder`, whose assignment runs
# through `signals._assign_welding_role`). The closed SET and the keyword TABLE are
# deliberately not the same thing: see the note on `_EXTRA_ROLE_TRADES`.
ROLE_TRADE: dict[str, str] = {
    **{rid: tid for _, _, rid, tid in _ROLES},
    **dict(_EXTRA_ROLE_TRADES),
}
# Ordered, de-duplicated role ids (the closed allow-set offered to the model).
ROLE_IDS: tuple[str, ...] = tuple(ROLE_TRADE)

# One-line descriptions shown to the model. Keys MUST stay a subset of ROLE_IDS.
ROLE_DESCRIPTIONS: dict[str, str] = {
    "role_vmc_operator": "operates a VMC (vertical machining center)",
    "role_hmc_operator": "operates an HMC (horizontal machining center)",
    "role_cnc_turner_operator": "CNC lathe / turning operator (round parts)",
    "role_cnc_setter_operator": "sets up CNC machines as the MAIN job (not just incidental)",
    "role_cnc_grinding_operator": "CNC grinding operator (cylindrical/surface, sizing by grinding)",
    "role_cnc_programmer": "writes / edits CNC programs (G-code / M-code)",
    "role_cam_programmer": "CAM programming — tool paths in Mastercam / Fusion / NX",
    # TAX-WELD-1: welding is in scope. The id is added to the CLOSED set (a wider
    # enumerated whitelist, never free text — ADR-0028 §(d)), not to a free-form field.
    "role_welder": "welder — MIG / TIG / arc / gas welding as the main job",
}


def canonicalization_instruction() -> str:
    """The system-prompt block that turns extraction into canonicalization.

    Encodes the same conventions the gold set uses so the model's ids line up
    with the taxonomy: primary/current activity wins; setter only when setting is
    the main job; map misspellings / spelled-out / implicit phrasings.
    """
    lines = "\n".join(f"- {rid}: {ROLE_DESCRIPTIONS.get(rid, '')}" for rid in ROLE_IDS)
    return (
        "\nCANONICAL ROLE: set `canonical_role_id` to the worker's PRIMARY role, "
        "choosing EXACTLY ONE id from this closed set (or null if none fits):\n"
        f"{lines}\n"
        "Rules:\n"
        "- Use the worker's MAIN / CURRENT activity (if they did X before but mainly do "
        "Y now, choose Y).\n"
        "- Map misspellings and spelled-out forms: vimmc/vmc/'vertical machining center' "
        "-> role_vmc_operator; 'horizontal machining center'/hmc -> role_hmc_operator; "
        "programer/'cnc program banata hu'/'g-code likhta hu' -> role_cnc_programmer; "
        "'cam programing'/'tool path' -> role_cam_programmer; grindr/'ghisai'/'round part "
        "size pe laana' -> role_cnc_grinding_operator; lathe/turning/'katai' -> "
        "role_cnc_turner_operator; welder/'welding ka kaam'/MIG/TIG/GMAW/GTAW/arc/stick "
        "welding -> role_welder.\n"
        "- Choose role_cnc_setter_operator ONLY if the worker calls themselves a setter or "
        "says setting/setup is their MAIN job. Incidental setting by an operator (e.g. just "
        "'tool offset setting') KEEPS the operator role.\n"
        "- Choose role_welder only when welding is the MAIN job. A machining worker who "
        "welds incidentally KEEPS their machining role.\n"
        "- Use null when the worker is only a helper/labourer, the trade is unrelated "
        "to CNC/VMC or welding, OR they state no concrete role/machine/task (e.g. 'naya hu', "
        "'kuch nahi aata', 'abhi seekh raha hu' with nothing specific). Do NOT guess a "
        "role from thin air. Output ONLY an id from the set above, or null.\n"
    )


def normalize_role_id(value: object) -> str | None:
    """Return ``value`` only if it is a known canonical role id, else None.

    The trust boundary for LLM output: anything not in the closed set (a
    hallucinated/empty/typo id) is rejected so it can never reach the profile.
    """
    return value if isinstance(value, str) and value in ROLE_TRADE else None


def coerce_json_text(content: str) -> str:
    """Return the first balanced ``{...}`` JSON object in ``content``, tolerating a
    ```json ... ``` markdown fence or surrounding prose around it.

    Conversational models (notably Claude, which has no strict JSON mode) routinely
    wrap JSON in a fence — a raw ``json.loads`` / ``model_validate_json`` then fails
    and the extraction silently falls back to the empty heuristic. Every place that
    parses model JSON for a profile MUST go through this first. Falls back to the
    stripped content when no object is found (so a clean JSON string is unchanged).
    """
    text = (content or "").strip()
    start = text.find("{")
    if start == -1:
        return text
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text


def extract_canonical_role_id(content: str) -> str | None:
    """Pull ``canonical_role_id`` from raw LLM JSON, tolerating a markdown fence and
    any other malformed sibling fields. Returns None if the content is not a JSON
    object or lacks the key — canonicalization must not hinge on the whole
    enrichment draft validating.

    Shared by the extraction endpoint and the onboarding CLI so both apply the
    SAME parse + (via ``normalize_role_id``) the same closed-set trust boundary.
    """
    try:
        data = json.loads(coerce_json_text(content))
    except (json.JSONDecodeError, TypeError):
        return None
    value = data.get("canonical_role_id") if isinstance(data, dict) else None
    return value if isinstance(value, str) else None
