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

# Phone detection is DIGIT-COUNT based, not character-count based (S-1, PR #392
# security review). The previous rule — `(?<!\d)\+?\d[\d\s\-]{7,}\d(?!\d)` — only
# accepted SPACE and DASH as separators, so a phone split on any other character
# ("9876.543.210", "9876,543,210", "(98765)43210", "98765_43210") matched neither
# this net NOR _RESIDUAL_DIGITS_RE (which needs 7+ CONSECUTIVE digits) and the raw
# number egressed. That hole PRE-DATES the D-1 carve-out and was only ever masked
# incidentally: the residual net blocked such a turn if some OTHER 7-8 digit run
# happened to co-occur. D-1 removes exactly that incidental cover in the salary
# case it exists to enable ("salary 1500000 hai, number 98765.43210 hai"), so the
# real rule is fixed here rather than relying on an accident.
#
# Rule: a run of digits joined by ANY NUMBER of separator chars each, totalling
# 9-13 DIGITS, is phone-shaped (Indian mobiles are 10; +country code / STD
# prefixes reach 12-13). Counting digits — not characters — is what makes the
# separator set safe to widen: "1,500,000" is 7 digits, so the Indian thousands
# separator cannot turn a salary into a [PHONE_n] on digit count alone.
#
# The `*` quantifier is load-bearing (S-1a/S-1b, PR #392 re-review). An earlier
# cut of this fix widened the separator SET but simultaneously narrowed the
# separator COUNT to at most one (`[...]?`). That REGRESSED against the old rule,
# whose `[\d\s\-]{7,}` accepted an unbounded run: "98765 - 43210", "98765  43210"
# (two spaces), "98765--43210", CRLF- and tab-separated forms all masked before
# and would have egressed after. It also left the original S-1 hole open for any
# 2+ char separator ("98765, 43210"), by the very same mechanism: D-1 masks the
# co-occurring amount, which removes the residual net's incidental cover, and the
# phone walks out. Single-separator matching pinned the implementation, not the
# threat class. `*` is verified 13/13 on the phone-shape matrix with no
# regressions and no ReDoS (<=1ms at the 20k cap; `[sep]*` and `\d` are disjoint
# classes, so there is no ambiguous backtracking).
#
# ACCEPTED COST of `*`: "salary 15,00,000, 2,50,000 expected" now masks to
# [PHONE_1] rather than two [AMOUNT_n] — a BENIGN OVER-MASK, sanctioned by the
# doctrine below: the label is imprecise, the safety property is not. D-1's
# purpose still holds — the turn MASKS rather than BLOCKS, and signals.py reads
# the RAW text locally, so salary extraction is unaffected.
#
# A 14+ digit consecutive run matches nothing here and falls to the residual net
# -> blocked (fail closed).
#
# Unicode separators are folded in (S-4). Python's `\s` already covers NBSP /
# narrow-NBSP / figure space / ideographic space, but NOT the dash family, the
# zero-width family, soft hyphen, middot or bullet — each of which defeated the
# ASCII-only class outright (verified). A zero-width space between two digit
# groups is not something a worker types by accident, so the safe reading is that
# it is a phone. `\d` is Unicode-aware, so fullwidth/Devanagari digits already
# mask correctly.
_PHONE_SEPARATORS = (
    r"\s.,\-()_"
    # dash family: hyphen, non-breaking hyphen, figure dash, en/em dash,
    # horizontal bar, minus sign, soft hyphen.
    "‐‑‒–—―−­"
    # separator-ish punctuation a number can be written with.
    "·•"
    # zero-width / invisible joiners: ZWSP, ZWNJ, ZWJ, word-joiner, ZWNBSP.
    "​‌‍⁠﻿"
)
_PHONE_RE = re.compile(r"(?<!\d)\d(?:[" + _PHONE_SEPARATORS + r"]*\d){8,12}(?!\d)")
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
# for a 7-13 digit run the gateway either BLOCKS (nothing is sent) or MASKS the run
# out of the text — the digits never reach an LLM either way. Over-masking is the
# locked safe direction; the token name is not a privacy control.
# 8-digit landlines cannot slip through either: Indian STD/landline numbers start
# 2-9, so they parse >= 20,000,000 and exceed the ceiling -> blocked. Exactly one
# 8-digit value (10000000) is in range, and it reads as a salary.
#
# ORDER IS LOAD-BEARING (S-2): money masking MUST run AFTER phone masking. On a
# CONSECUTIVE run the lookarounds alone stop money biting, but a separator-split
# phone exposes a 7-8 digit consecutive sub-run ("1234567" in "1234567.890") that
# money-first would tokenise, leaving the rest of the number raw.
#
# KNOWN RESIDUAL — risks-register R30 is OPEN, not closed. Two gaps remain:
#   1. A 9-13 digit phone split by a WORD ("98765 aur 43210", "98765 haan 43210")
#      is NOT detected — a 10-digit phone is trivially disguised this way. It is
#      deliberately not patched here: a proximity net false-fires on
#      "salary 15000 se 18000" (structurally identical) and would mask real salary
#      data. This needs a designed fix, not a rushed regex. Same class as the
#      chunk-seam shape in #395.
#   2. A 7-8 digit SEPARATOR-SPLIT run ("1_661318", "12.05.2024") is not
#      phone-shaped and has no 7 consecutive digits, so it passes. Tightening this
#      would block every date a worker types — the over-blocking class D-1 exists
#      to remove.
# Neither is live: AI_ENABLE_REAL_CALLS=false by default (invariant #5). Both MUST
# be re-assessed before that flag flips.
#
# tests/test_pseudonymize.py locks all of the above (incl. randomised property
# tests over 20,000 phone-shaped and 10,000 money-shaped cases — a fixed template
# set, NOT a proof over all inputs).
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
