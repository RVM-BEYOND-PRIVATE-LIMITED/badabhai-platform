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

# Known Indian manufacturing-hub cities (lowercased). Shared with the profiling
# signal detectors (app/profiling/signals.py) so there is one city gazetteer.
KNOWN_CITIES: frozenset[str] = frozenset(
    {
        "new delhi", "navi mumbai", "greater noida",
        "faridabad", "delhi", "mumbai", "pune", "chennai", "bengaluru", "bangalore",
        "gurgaon", "gurugram", "noida", "hyderabad", "ahmedabad", "coimbatore",
        "rajkot", "ludhiana", "kolkata", "jaipur", "surat", "nashik", "nagpur",
        "indore", "vadodara", "aurangabad", "chandigarh", "kanpur", "lucknow",
        "bhopal", "manesar", "pithampur", "hosur", "peenya", "bawal", "sanand",
    }
)

# Hinglish / colloquial aliases + common misspellings that resolve INTO the closed
# canonical KNOWN_CITIES set (alias -> canonical, both lowercased). This is NOT a
# loosening of the closed set: an alias only ever normalizes to an EXISTING
# canonical member (see signals._canonical_city). The pseudonymizer also matches
# these keys so an aliased city name is still masked before any LLM call.
CITY_ALIASES: dict[str, str] = {
    "dilli": "delhi",
    "dilly": "delhi",
    "bombay": "mumbai",
    "bengaluru": "bangalore",
    "banglore": "bangalore",
    "gurgaon": "gurugram",
    "gudgaon": "gurugram",
    "calcutta": "kolkata",
    "poona": "pune",
}
# Every token the city detector should RECOGNIZE = the canonical set + the alias
# keys. Longer names first so the regex alternation prefers multi-word matches.
_CITY_TOKENS = sorted(set(KNOWN_CITIES) | set(CITY_ALIASES), key=len, reverse=True)
_CITIES = _CITY_TOKENS  # kept name-stable for internal references

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

# --- D-1 money-amount carve-out (context-drift register 2026-07-16 row D-1;
# --- owner ruling 2026-07-17) -----------------------------------------------
# A worker typing an annual salary ("1000000", "salary 1200000") used to have the
# whole turn BLOCKED by the residual-digit net, contradicting signals.py which
# accepts salaries up to 10,000,000. The fix is NOT an allow-through: recognized
# money amounts are MASKED to [AMOUNT_n] before the residual net, so the digits
# STILL never reach an LLM (over-masking, the locked safe direction) — but the
# turn is no longer blocked, and the RAW text (read locally, never sent) still
# reaches the signal detectors so salary extraction works.
#
# Decision boundary (keep in sync with the tests in tests/test_pseudonymize.py):
#   * 1-6 digit runs  -> never tripped the residual net; unchanged.
#   * 7-8 digit runs  -> masked to [AMOUNT_n] ONLY when the run parses to a
#     plausible salary in [1,000,000 .. MAX_PLAUSIBLE_SALARY_INR] (the range
#     signals._parse_amount accepts) AND has no leading zero (a zero-led run is
#     a reference/account shape, not money). Everything else is left for the
#     residual net -> BLOCKED (genuinely ambiguous fails closed, unchanged).
#   * 9-10+ digit runs -> phone shape (Indian mobiles are 10 digits): _PHONE_RE
#     masks them as [PHONE_n] BEFORE this step, and the (?<!\d)/(?!\d) guards
#     below can never carve a sub-run out of a longer one, so a 9+ digit run can
#     NEVER be re-labelled as money.
#
# Why a mis-labelled phone FRAGMENT is still safe. A 7-digit run (e.g. "9876543")
# is not a dialable Indian number but could be a fragment of one, and it does fall
# in the money range -> it is masked [AMOUNT_n] rather than blocked. The LABEL is
# then imprecise, but the SAFETY PROPERTY is unchanged and is what matters here:
# for ANY 7-10 digit run the gateway either BLOCKS (nothing is sent) or MASKS the
# run out of the text — the digits never reach an LLM either way. Over-masking is
# the locked safe direction; the token name is not a privacy control.
# 8-digit landlines cannot slip through either: Indian STD/landline numbers start
# 2-9, so they parse >= 20,000,000 and exceed the ceiling -> blocked. Exactly one
# 8-digit value (10000000) is in range, and it reads as a salary.
# tests/test_pseudonymize.py locks all of this, incl. an exhaustive property test.
_MONEY_RUN_RE = re.compile(r"(?<!\d)\d{7,8}(?!\d)")
_MONEY_MIN_INR = 1_000_000  # the smallest 7-digit run
# Upper bound of a plausible salary. Single source of truth shared with
# app/profiling/signals.py (_parse_amount) — signals imports it from here
# (this module must stay import-free of signals to avoid a cycle).
MAX_PLAUSIBLE_SALARY_INR = 10_000_000


@dataclass
class PseudonymizationResult:
    text: str
    blocked: bool
    blocked_reason: str | None
    replaced_entities: int
    placeholder_tokens: list[str]


def _mask_money_amount(token_for):
    """Substitution callback for the D-1 money carve-out: mask a 7-8 digit run
    to [AMOUNT_n] ONLY when it is a plausible in-range salary (see the decision
    boundary at ``_MONEY_RUN_RE``); leave everything else untouched so the
    residual net blocks it (fail closed)."""

    def _sub(match: re.Match[str]) -> str:
        run = match.group(0)
        if run.startswith("0"):  # zero-led = reference/account shape, not money
            return run
        if _MONEY_MIN_INR <= int(run) <= MAX_PLAUSIBLE_SALARY_INR:
            return token_for(run, "AMOUNT")
        return run

    return _sub


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
        # 6. D-1 money-amount carve-out (see the decision boundary above): a 7-8
        #    digit run that reads as an in-range salary is MASKED to [AMOUNT_n]
        #    so the digits never reach the LLM but the turn is not blocked.
        #    Out-of-range / zero-led runs are deliberately left in place — the
        #    residual net below blocks them (fail closed).
        result = _MONEY_RUN_RE.sub(_mask_money_amount(token_for), result)

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


def certified_clean_skill_labels(labels: list[str]) -> list[str]:
    """Keep only labels this gateway certifies CLEAN (Q14/ADR-0030 OQ#3 — SG-2).

    A label passes ONLY when ``pseudonymize(label)`` (a) does not block,
    (b) masks nothing (``replaced_entities == 0``), and (c) returns the label
    byte-identical. Anything else — blocked, masked, altered, or an internal
    gateway error (which returns ``blocked=True``) — is DROPPED (fail-closed:
    over-drop, never keep a suspect label). Purely additive certification: it
    never relaxes the gateway, never returns masked text or the token mapping,
    and never logs. Used to certify ``DraftProfile.skill_labels`` AT REST when
    populated (profile extraction) and to RE-certify at the résumé boundary.
    """
    return [
        label
        for label in labels
        if (r := pseudonymize(label)).blocked is False
        and r.replaced_entities == 0
        and r.text == label
    ]
