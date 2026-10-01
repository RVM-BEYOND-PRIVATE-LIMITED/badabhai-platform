"""WHAT MAY REACH A MODEL'S PROMPT — the one input switch behind `AI_RAW_PII_ENABLED`.

READ `app/resume_import/parse_policy.py` FIRST. This module is its generalisation: ADR-0041 D5
moved one route's INPUT policy behind a flag, and the owner decision of 2026-09-30
(docs/decisions/0047-lift-pii-restriction.md) moves every route's, behind one more. The two
questions that file keeps apart stay apart here, for the same reason:

    INPUT   what may reach the MODEL.       ← this module; `raw=True` moves it.
    OUTPUT  what may be STORED or PRINTED.  ← the certifiers; nothing here can reach them.

So nothing in this module is a certifier, and no certifier takes a `raw` argument. The failure
mode is the one `parse_policy` names: hand a wall the input policy and the flag silently becomes
"store whatever the model wrote". Output stays untrusted under both postures.

UNTRUSTED IS NOT THE SAME AS SUFFICIENT. Four outputs passed a wall that refused only what the
gateway would BLOCK, or no wall at all (and three more were found later: /profile/extract's rich
draft, companion v2's edit rows and the /resume/generate summary); that held while the model read
placeholders, but given raw text it can echo an identifier the gateway merely MASKS. Measured,
pinned as strict xfails, and closed by ADR-0047 G1 with `app/output_floor.py`: a hard-identifier
floor under those outputs that reads no flag — never a `raw` argument on a wall. Section 6 of the
test file pins all seven.

ONE PROMPT INPUT STAYS MASKED UNDER `raw=True`, by decision: the skills stage's echoed draft
(`routers/profiling._certified_skills_draft`). It is the API's settled state rather than the
worker's words, it is never read back into an output, and certifying it only ever over-masks.

KEYWORD-ONLY `raw`, PASSED BY THE ROUTE, NEVER READ HERE. The security question is "who can turn
masking off, and from where"; a gate that reached for the settings singleton would answer
"anything that imports it", while this one answers "the route that called it", and
`tests/test_llm_input_policy.py` lists those routes.

THE SIZE CAPS SURVIVE `raw=True`, and so does the non-string refusal. They bound cost and denial
of service, not PII: a 20,000-character message is refused whether or not it is masked, and a
transcript line is still one utterance of at most `PARSE_MESSAGE_MAX_CHARS`. The refusal is the
gateway's own (`pseudonymize` performs exactly these two checks first), so a blocked result reads
identically under either posture and the callers' blocked branches need no second vocabulary.

`pseudonymize()` IS NOT THE SWITCH and must never become it. The same function certifies stored
values, masks the Langfuse export, de-identifies the corpus and masks the at-rest growth queue;
a pass-through inside it would disable all of those at once.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .logging_config import get_logger
from .profiling.parse_masking import PARSE_MESSAGE_MAX_CHARS, Masker, default_masker
from .pseudonymize import DEFAULT_MAX_LENGTH, PseudonymizationResult, TokenScope, pseudonymize

if TYPE_CHECKING:
    from .config import Settings

logger = get_logger("ai.privacy")


def llm_input_gate(
    text: str,
    *,
    raw: bool,
    max_length: int = DEFAULT_MAX_LENGTH,
    scope: TokenScope | None = None,
) -> PseudonymizationResult:
    """`text` as the MODEL may see it: pseudonymized, or unchanged when `raw`.

    `raw=False` IS `pseudonymize(text, max_length=..., scope=...)` and nothing else, which is what
    keeps the default posture byte-identical to the call it replaced. `scope` is the request's
    shared placeholder numbering (`TokenScope`, #1869) and matters only when masking. `raw=True`
    returns the text untouched with `replaced_entities=0` and no placeholder tokens — blocked
    only when it is not a string or exceeds `max_length`, and then with the gateway's own verdict.
    """
    if not raw or not isinstance(text, str) or len(text) > max_length:
        return pseudonymize(text, max_length=max_length, scope=scope)
    return PseudonymizationResult(
        text=text,
        blocked=False,
        blocked_reason=None,
        replaced_entities=0,
        placeholder_tokens=[],
    )


def raw_line_masker(text: str) -> tuple[bool, str]:
    """The per-line `Masker` for `raw=True`: unmasked, capped at `PARSE_MESSAGE_MAX_CHARS`.

    NOT `parse_masking.passthrough_masker`, which drops the cap as well as the masking. That one
    stays the synthetic-persona masker and D5's résumé masker; a real interview line keeps the
    same one-utterance bound under either posture, so ON differs from OFF in masking only.
    """
    result = llm_input_gate(text, raw=True, max_length=PARSE_MESSAGE_MAX_CHARS)
    return result.blocked, result.text


def llm_input_masker(*, raw: bool) -> Masker:
    """The per-line masker a transcript-shaped prompt input goes through."""
    return raw_line_masker if raw else default_masker


def resume_input_raw(settings: Settings) -> bool:
    """The résumé routes' input posture: D5's own flag OR the platform flag.

    Kept as TWO flags on purpose, so each can be rolled back without the other. Either one
    selects `parse_policy.input_masker(raw_text_enabled=True)`, D5's uncapped pass-through,
    exactly as D5 alone always has; the résumé's output wall (`resume_value_certifier`) reads
    neither.
    """
    return settings.resume_parse_raw_text_enabled or settings.ai_raw_pii_enabled


def log_input_posture(settings: Settings) -> None:
    """Announce at BOOT that prompts and traces leave this process unmasked — only when they do.

    The flag is armed by a secret and a redeploy with no code change behind it, so without this
    line nothing the process itself emits says which posture it served; the answer would live
    only in the secret's history. Silent when off, so the default boot is unchanged. A closed
    boolean and fixed text: there is nothing in it to leak.
    """
    if settings.ai_raw_pii_enabled:
        logger.warning(
            "AI_RAW_PII_ENABLED is ON: model prompts and AI traces carry unmasked worker text",
            extra={"extra": {"ai_raw_pii_enabled": True}},
        )
