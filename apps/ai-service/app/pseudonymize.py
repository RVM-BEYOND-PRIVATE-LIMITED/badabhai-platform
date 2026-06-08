"""Pseudonymization gateway (stdlib-only, dependency-free).

This is the privacy boundary of the AI service: it runs BEFORE any LLM call and
replaces likely PII with request-scoped placeholder tokens.

Design rules (locked):
- The original<->token mapping is request-scoped only and is NEVER persisted or
  returned. Callers only ever see placeholder labels (e.g. "[PERSON_1]").
- The gateway FAILS CLOSED: on any parsing error, oversize input, or a residual
  numeric sequence that looks like un-masked PII, it returns ``blocked=True`` and
  the caller must NOT make an external LLM call.
- Phase 1 uses deterministic heuristics (regex + small gazetteers). Real
  NER/LLM-assisted detection comes later; over-masking is the safe direction.

Intentionally has NO third-party dependencies so its tests run with only pytest.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

DEFAULT_MAX_LENGTH = 20_000

# --- Gazetteers / patterns -------------------------------------------------

# Known Indian manufacturing-hub cities (lowercased). Longer names first so the
# alternation prefers multi-word matches.
_CITIES = sorted(
    {
        "new delhi", "navi mumbai", "greater noida",
        "faridabad", "delhi", "mumbai", "pune", "chennai", "bengaluru", "bangalore",
        "gurgaon", "gurugram", "noida", "hyderabad", "ahmedabad", "coimbatore",
        "rajkot", "ludhiana", "kolkata", "jaipur", "surat", "nashik", "nagpur",
        "indore", "vadodara", "aurangabad", "chandigarh", "kanpur", "lucknow",
        "bhopal", "manesar", "pithampur", "hosur", "peenya", "bawal", "sanand",
    },
    key=len,
    reverse=True,
)

# Words that look like a leading name but are greetings/fillers — do not mask.
_NAME_STOPLIST = {
    "hello", "hi", "hey", "namaste", "namaskar", "sir", "madam", "yes", "no",
    "ok", "okay", "thanks", "thank", "ji", "haan", "nahi", "bhai",
}

_COMPANY_SUFFIX = (
    r"(?:Industries|Industry|Pvt\.?|Private|Ltd\.?|Limited|Engineering|Engineers|"
    r"Works|Company|Co\.?|Corp\.?|Corporation|Enterprises|Manufacturing|"
    r"Technologies|Technology|Tech|Solutions|Motors|Steel|Auto|Forgings|"
    r"Castings|Tools|Precision|Fabrication|Fab)"
)

_PAN_RE = re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")
_AADHAAR_RE = re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")
# A "+"-optional run of >= ~9 digits possibly spaced/dashed (phone-like).
_PHONE_RE = re.compile(r"(?<!\d)\+?\d[\d\s\-]{7,}\d(?!\d)")
_EMPLOYER_RE = re.compile(r"\b(?:[A-Z][\w&.]*\s+){1,4}" + _COMPANY_SUFFIX + r"\b")
_NAME_CUE_RE = re.compile(
    r"(?i:\bmy name is\b|\bmyself\b|\bi am\b|\bi'm\b|\bthis is\b|\bname is\b|"
    r"\bmera naam\b|\bnaam\b)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)"
)
_LEADING_NAME_RE = re.compile(r"^\s*([A-Z][a-z]+)\s*,")
_CITY_RE = re.compile(r"\b(?:" + "|".join(re.escape(c) for c in _CITIES) + r")\b", re.IGNORECASE)
_RESIDUAL_DIGITS_RE = re.compile(r"\d{7,}")


@dataclass
class PseudonymizationResult:
    text: str
    blocked: bool
    blocked_reason: str | None
    replaced_entities: int
    placeholder_tokens: list[str]


def pseudonymize(text: str, max_length: int = DEFAULT_MAX_LENGTH) -> PseudonymizationResult:
    """Replace likely PII in ``text`` with placeholder tokens.

    Returns a :class:`PseudonymizationResult`. When ``blocked`` is True the caller
    MUST NOT send the text to an LLM.
    """
    try:
        if not isinstance(text, str):
            return PseudonymizationResult("", True, "input is not a string", 0, [])
        if len(text) > max_length:
            return PseudonymizationResult(
                "", True, f"input exceeds {max_length} characters", 0, []
            )

        registry: dict[tuple[str, str], str] = {}
        counters: dict[str, int] = {}
        tokens_used: list[str] = []

        def token_for(original: str, prefix: str) -> str:
            key = (prefix, original.strip().lower())
            existing = registry.get(key)
            if existing is not None:
                return existing
            counters[prefix] = counters.get(prefix, 0) + 1
            tok = f"[{prefix}_{counters[prefix]}]"
            registry[key] = tok
            tokens_used.append(tok)
            return tok

        def replace_group1(match: re.Match[str], prefix: str) -> str:
            """Replace only capture group 1 inside the full match (keeps the cue)."""
            name = match.group(1)
            if name.strip().lower() in _NAME_STOPLIST:
                return match.group(0)
            return match.group(0).replace(name, token_for(name, prefix))

        result = text

        # 1. ID-like tokens first (PAN, Aadhaar) so phone matching doesn't eat them.
        result = _PAN_RE.sub(lambda m: token_for(m.group(0), "ID"), result)
        result = _AADHAAR_RE.sub(lambda m: token_for(m.group(0), "ID"), result)
        # 2. Phone numbers.
        result = _PHONE_RE.sub(lambda m: token_for(m.group(0), "PHONE"), result)
        # 3. Employers / companies.
        result = _EMPLOYER_RE.sub(lambda m: token_for(m.group(0), "EMPLOYER"), result)
        # 4. Person names (cue-based, then leading-name heuristic).
        result = _NAME_CUE_RE.sub(lambda m: replace_group1(m, "PERSON"), result)
        result = _LEADING_NAME_RE.sub(lambda m: replace_group1(m, "PERSON"), result)
        # 5. Known cities.
        result = _CITY_RE.sub(lambda m: token_for(m.group(0), "CITY"), result)

        replaced = sum(counters.values())

        # Fail-closed safety net: any remaining long digit run is potential
        # un-masked numeric PII -> block.
        if _RESIDUAL_DIGITS_RE.search(result):
            return PseudonymizationResult(
                result, True, "residual numeric sequence detected", replaced, tokens_used
            )

        return PseudonymizationResult(result, False, None, replaced, tokens_used)

    except Exception as exc:  # pragma: no cover - defensive, fail closed
        return PseudonymizationResult("", True, f"pseudonymization error: {exc}", 0, [])
