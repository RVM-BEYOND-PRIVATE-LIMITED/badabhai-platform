"""THE HARD-IDENTIFIER OUTPUT FLOOR — what no model-written value may carry, under either posture.

READ `app/llm_input_policy.py` FIRST. That module moves what may reach a model's PROMPT behind
`AI_RAW_PII_ENABLED` (docs/decisions/0047-lift-pii-restriction.md). This one answers the other
question, what a value the MODEL wrote may carry once it is stored or printed, and its answer is
the same under both postures:

    INPUT   what may reach the MODEL.       ← `llm_input_policy`; `raw=True` moves it.
    OUTPUT  what may be STORED or PRINTED.  ← the certifiers, and this floor beneath them.

WHY A FLOOR, AND WHY HERE (ADR-0047 §6, G1). Four outputs on switched routes were guarded only by
"would the gateway BLOCK this", or by nothing: Phase C's `_certified*` walls, the work-history
polish rewrite, the classic /profiling/turn output and the /profile/parse `evidence.quote`. That
held while the model read placeholders. Given raw text, it can echo the phone or PAN the worker
typed into any of them, and the gateway MASKS a phone rather than blocking it. Measured, and
pinned in section 6 of `tests/test_llm_input_policy.py` — with three more outputs the same probe
found once every switched route was run armed: /profile/extract's stored rich draft
(`merge_model_draft`), companion v2's edit rows (`parse_edit_rows`; the API drops the same row
again) and the /resume/generate `summary`, which nothing renders yet.

A VALUE THAT CARRIES A HARD IDENTIFIER IS DROPPED — never masked, never rewritten. The classes
are `HARD_IDENTIFIER_CLASSES` (PAN, Aadhaar, phone, email, a credential id, a GSTIN, a 14+ digit
run), through the same `contains_hard_identifier` the résumé route's gate 6 already refuses them
with (`parse_policy.resume_value_certifier`), so the two walls cannot drift. Dropping is safe for
the same reason it is everywhere else: every one of these fields is optional downstream, and a
mask token printed on a résumé is worse than an absent line.

IT READS NO FLAG, and no function here takes an argument that could carry one. With the flag off
the model reads masked text, so the floor is a near no-op: it fires only on an identifier the
model composed itself, or on a digit sequence the gateway would also call a phone
("2010-2015, 2016-2020") — and dropping that is the over-masking direction.

A PERSON NAME IS NOT A HARD IDENTIFIER (ruled 2026-09-11; see `contains_hard_identifier`), and
nothing here claims to catch one. The worker's own name on the employer copy is kept out at the
source instead: apps/api's `redactKnownName` runs in profile extraction whatever the flag says
(ADR-0047 G2). Nor does the floor catch a number spelled out in words (R30); neither does the
gateway.

Never raises, never logs, never returns what it dropped.
"""

from __future__ import annotations

from .pseudonymize import contains_hard_identifier


def carries_hard_identifier(text: str | None) -> bool:
    """True when ``text`` carries a hard identifier. ``None`` carries nothing.

    Fail closed: a scanner error comes back from `contains_hard_identifier` as a class of its
    own ("scanner_error"), which reads here as True, so the value is dropped rather than kept.
    """
    return text is not None and contains_hard_identifier(text) is not None


def floored_scalar(value: str | None) -> str | None:
    """``value`` unchanged, or None when it carries a hard identifier."""
    return None if carries_hard_identifier(value) else value


def floored_items(values: list[str]) -> list[str]:
    """The entries that carry no hard identifier, in order. Drops per ITEM, so one echoed phone
    never costs a worker the other four skills."""
    return [value for value in values if not carries_hard_identifier(value)]
