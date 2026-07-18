"""Miss attribution: pseudonymization over-masking (TD3) vs extraction error.

When a per-field gold case misses, the cause is one of two things:

1. **Over-masking (TD3)** — the pseudonymization gateway replaced the very span
   the correct answer depends on (e.g. it masked "Fanuc" thinking it was a name),
   so the LLM never saw the evidence. This is a *privacy-gateway* problem, not an
   extraction problem; biasing to over-masking is deliberate, but it costs recall.
2. **Extraction error** — the anchor span survived pseudonymization (it is still
   present in the masked text), so the model *did* see the evidence but failed to
   canonicalize it. This is a *prompt/model* problem.

We attribute by re-running the SAME fabricated input through the real
``/pseudonymize`` endpoint (the one the extraction path uses) and checking whether
the field's anchor term(s) survive in the pseudonymized text:

    anchor present in masked text  -> extraction_error
    anchor masked / removed        -> over_masking (TD3)

This goes THROUGH the privacy gateway exactly like extraction does — it never
inspects the original<->token mapping (which is never returned) and never bypasses
pseudonymization. Anchors are matched on the FABRICATED gold text only (no PII).

PRIVACY: anchors are technical vocabulary (role/machine/skill words, digits for
experience) — never identity PII. All inputs are fabricated Hinglish.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from app.profiling import canonicalization_gold as gold

# A pseudonymizer: text -> the pseudonymized (masked) text. Defaults to calling
# the local in-process gateway; the CLI can pass a client that POSTs to
# ``/pseudonymize`` so attribution exercises the real endpoint.
PseudonymizeFn = Callable[[str], str]

OVER_MASKING = "over_masking"  # TD3 — anchor was masked away
EXTRACTION_ERROR = "extraction_error"  # anchor survived, model mis-read it

# Field -> the literal anchor terms (lowercased) whose presence the correct
# answer depends on. If ANY anchor for the field is gone from the masked text we
# call it over-masking; otherwise the evidence survived -> extraction error.
#
# These are the canonical vocabulary the heuristic/LLM keys on (mirrors the
# keyword tables in signals.py). For role/trade we reuse the role keyword set.
_ROLE_ANCHORS: dict[str, tuple[str, ...]] = {
    "role_cam_programmer": ("cam programmer", "cam programing", "cam software", "cam program"),
    "role_cnc_programmer": ("programmer", "program", "g code", "g-code"),
    "role_cnc_setter_operator": ("setter", "setting"),
    "role_vmc_operator": ("vmc", "vertical machining", "vertical centre"),
    "role_hmc_operator": ("hmc", "horizontal machining", "horizonta"),
    "role_cnc_grinding_operator": ("grinding", "grinder", "grindr", "ghisai", "cylindrical"),
    "role_cnc_turner_operator": ("turner", "turning", "lathe"),
    "role_welder": ("welder", "welding", "mig", "tig", "arc"),  # TAX-WELD-1
}

_SKILL_ANCHORS: dict[str, tuple[str, ...]] = {
    "skill_fanuc": ("fanuc",),
    "skill_siemens": ("siemens",),
    "skill_mitsubishi": ("mitsubishi",),
    "skill_program_editing": ("program", "g code", "g-code", "m code"),
    "skill_cam_software": ("mastercam", "fusion"),
    "skill_gdt_reading": ("gd&t", "gdt", "drawing"),
    "skill_tool_offset_setting": ("tool offset", "offset"),
    "skill_fixture_setup": ("fixture",),
    # TAX-WELD-1 — anchors for the pre-existing welding corpus ids.
    "skill_mig_welding": ("mig", "gmaw"),
    "skill_tig_welding": ("tig", "gtaw"),
    "skill_arc_welding": ("arc", "smaw", "stick"),
    "skill_gas_cutting": ("gas cutting", "oxy"),
    "skill_welder_occupation": ("welder", "welding"),
}

_MACHINE_ANCHORS: dict[str, tuple[str, ...]] = {
    "mach_vmc": ("vmc", "vertical machining"),
    "mach_hmc": ("hmc", "horizontal machining"),
    "mach_cnc_lathe": ("lathe", "turning"),
    "mach_cylindrical_grinder": ("cylindrical",),
    "mach_cnc_grinder": ("grinding", "grinder"),
}

# Experience anchor: the literal digit run for the expected years (e.g. "5").
_DIGITS_RE = re.compile(r"\d+")


def _default_pseudonymize(text: str) -> str:
    # Local in-process gateway (no network). Returns the masked text. If the
    # gateway BLOCKS we return its (partial) masked text so anchor checks still
    # reflect what would have been sent — a blocked input never reaches the LLM,
    # which is itself a form of over-masking and surfaces as missing anchors.
    from app.pseudonymize import pseudonymize

    return pseudonymize(text).text


def _anchors_for(field: str, expected: object) -> tuple[str, ...]:
    """The lowercased anchor terms the answer for ``(field, expected)`` rests on."""
    if field in ("role", "trade"):
        role = expected if field == "role" else _trade_to_role(expected)
        if isinstance(role, str):
            return _ROLE_ANCHORS.get(role, ())
        return ()
    if field == "skills":
        anchors: list[str] = []
        for sid in expected or ():  # type: ignore[union-attr]
            anchors.extend(_SKILL_ANCHORS.get(sid, ()))
        return tuple(anchors)
    if field == "machines":
        anchors = []
        for mid in expected or ():  # type: ignore[union-attr]
            anchors.extend(_MACHINE_ANCHORS.get(mid, ()))
        return tuple(anchors)
    if field == "experience":
        if isinstance(expected, (int, float)):
            return (str(int(expected)),)
        return ()
    return ()


def _trade_to_role(trade: object) -> str | None:
    if not isinstance(trade, str):
        return None
    for role, tid in gold.ROLE_TO_TRADE.items():
        if tid == trade:
            return role
    return None


@dataclass(frozen=True)
class Attribution:
    text: str
    tier: str
    field: str
    cause: str  # OVER_MASKING | EXTRACTION_ERROR
    anchors: tuple[str, ...]          # canonical anchors for the expected answer
    present_in_original: tuple[str, ...]  # anchors literally in the source text
    surviving: tuple[str, ...]            # of those, still present after masking


def attribute_match(
    match: gold.FieldMatch, *, pseudonymize_fn: PseudonymizeFn = _default_pseudonymize
) -> Attribution:
    """Classify ONE missed ``FieldMatch`` as over-masking (TD3) vs extraction error.

    The distinction is about what the GATEWAY did, not about spelling:

    - We first find which anchors are LITERALLY in the original fabricated text.
    - Then we re-pseudonymize and see which of THOSE survive.
    - Over-masking (TD3) = an anchor was in the original but the gateway removed
      it (present_in_original non-empty, none survive). The model never saw the
      evidence.
    - Extraction error = either the anchor never appeared literally (out-of-vocab
      spelling / implicit phrasing the model must infer) OR it survived masking
      but was still mis-canonicalized. Either way the gateway is not at fault.
    """
    anchors = _anchors_for(match.field, match.expected)
    original = match.text.lower()
    present = tuple(a for a in anchors if a in original)
    masked = pseudonymize_fn(match.text).lower()
    surviving = tuple(a for a in present if a in masked)
    # Over-masking iff some anchor WAS in the source but the gateway removed all
    # of them. If nothing relevant was in the source, the gateway can't be the
    # cause -> extraction error (the model had to infer from implicit phrasing).
    if present and not surviving:
        cause = OVER_MASKING
    else:
        cause = EXTRACTION_ERROR
    return Attribution(match.text, match.tier, match.field, cause, anchors, present, surviving)


@dataclass(frozen=True)
class AttributionSummary:
    attributions: tuple[Attribution, ...]

    @property
    def over_masking(self) -> tuple[Attribution, ...]:
        return tuple(a for a in self.attributions if a.cause == OVER_MASKING)

    @property
    def extraction_errors(self) -> tuple[Attribution, ...]:
        return tuple(a for a in self.attributions if a.cause == EXTRACTION_ERROR)

    @property
    def dominant_cause(self) -> str | None:
        if not self.attributions:
            return None
        n_over = len(self.over_masking)
        n_ext = len(self.extraction_errors)
        if n_over == n_ext:
            return "tie"
        return OVER_MASKING if n_over > n_ext else EXTRACTION_ERROR


def attribute_misses(
    result: gold.PerFieldEvalResult,
    *,
    pseudonymize_fn: PseudonymizeFn = _default_pseudonymize,
) -> AttributionSummary:
    """Attribute every miss in a per-field eval result. Returns the split."""
    attributions = tuple(
        attribute_match(m, pseudonymize_fn=pseudonymize_fn) for m in result.misses
    )
    return AttributionSummary(attributions)
