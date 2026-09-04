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

WHAT IS PII HERE, and what is deliberately NOT (owner ruling 2026-07-31, from the
Master Context DEAD LIST):

- MASKED — the IDENTITY classes of CLAUDE.md §2 #2: phone numbers, person names,
  employer/company names, ID-doc tokens (PAN, Aadhaar, cued roll/registration ids).
  Money amounts are tokenised too, so digits never egress.
- NOT MASKED — **cities and states**. The DEAD LIST is explicit: "✗ cities as PII
  (→ a 20-point matching input; never redact)". A city identifies nobody, and it is
  the strongest matching signal the product has; redacting it protected nothing and
  cost the field on every model-authored surface. States followed: coarser geography
  cannot be more identifying than the city inside it.
- ALSO ON THE DEAD LIST: "✗ salary flagged as a phone number". Amounts are masked as
  ``[AMOUNT_n]``, never blocked and never re-labelled as a phone (see the D-1
  carve-out and the ORDER note at ``_MONEY_RUN_RE``).

Narrowing the DEFINITION of PII is not the same as relaxing the GATE: every
fail-closed path is unchanged, and over-masking remains the safe direction within the
identity classes.

Intentionally has NO third-party dependencies so its tests run with only pytest.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .profiling import lexicon as _lexicon

DEFAULT_MAX_LENGTH = 20_000

# --- Gazetteers / patterns -------------------------------------------------

# Known Indian manufacturing-hub cities (lowercased). Shared with the profiling
# signal detectors (app/profiling/signals.py) so there is one city gazetteer.
#
# THIS GAZETTEER IS FOR DETECTION, NOT MASKING (owner ruling 2026-07-31). The Master
# Context DEAD LIST is authoritative:
#
#     "✗ cities as PII (→ a 20-point matching input; never redact)"
#
# A worker's city is the single strongest matching signal this product has, and it is
# not identity: "Pune" identifies nobody. Masking it to [CITY_1] before the LLM cost us
# the field on every model-authored surface while protecting nothing. `signals.py`
# imports this set (and CITY_ALIASES) to READ the city off raw text locally — that use
# is unchanged and is why the set stays here.
# The set itself now lives in packages/profiling-lexicon/data/cities.json (mirrored into
# app/profiling/lexicon_data/) so the TypeScript orchestrator reads the SAME gazetteer —
# a second copy in TS would drift, and a city that stops being recognised is a silent
# 20-point matching loss, not an error. The import is a pure data loader with no
# app-level dependencies of its own, so it introduces no cycle with this module.
#
# `lexicon.load` RAISES on a missing file rather than returning {}. That is the correct
# failure mode here: an empty gazetteer would silently stop detecting cities, and this
# module must fail closed (CLAUDE.md §3).
KNOWN_CITIES: frozenset[str] = frozenset(_lexicon.load("cities")["canonical"])

# STATE MASKING IS GONE TOO (owner ruling 2026-07-31, same DEAD LIST entry).
#
# The removed comment claimed states were masked "so they never reach the LLM (TD56)".
# A state is COARSER geography than a city — if a city is not PII, a state cannot be —
# and the same matching argument applies with less force but the same sign. The
# gazetteer that did the masking (KNOWN_STATES / STATE_ABBREVS / _STATE_RE /
# _STATE_ABBREV_RE) is deleted rather than left dead: leaving a loaded state gazetteer
# in the privacy module is an invitation to re-add the mask. DETECTION is unaffected —
# signals.py has always carried its own `_STATE_NAMES` / `_STATE_ABBREVS` (it needs the
# canonical display names, which this set never had) and imports nothing state-shaped
# from here.

# Hinglish / colloquial aliases + common misspellings that resolve INTO the closed
# canonical KNOWN_CITIES set (alias -> canonical, both lowercased). This is NOT a
# loosening of the closed set: an alias only ever normalizes to an EXISTING
# canonical member (see signals._canonical_city). The pseudonymizer also matches
# these keys so an aliased city name is still masked before any LLM call.
CITY_ALIASES: dict[str, str] = dict(_lexicon.load("cities")["aliases"])
# Words that look like a leading name but are greetings/fillers — do not mask.
_NAME_STOPLIST = {
    "hello",
    "hi",
    "hey",
    "namaste",
    "namaskar",
    "sir",
    "madam",
    "yes",
    "no",
    "ok",
    "okay",
    "thanks",
    "thank",
    "ji",
    "haan",
    "nahi",
    "bhai",
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
# ACCEPTED COST of the DANDA (weighed, not waved through — see the Indic sweep
# below). Adding `।` means two amounts separated ONLY by a danda now read as one
# 10-digit phone: "salary 15,000। 18,000 expected" -> "salary [PHONE_1] expected".
# It was the ONE new false positive the whole Indic/CJK sweep introduced. Weighed:
#   * the profile is UNAFFECTED — signals.py reads the RAW text and still returns
#     current=15,000 / expected=18,000 (asserted in the tests);
#   * it MASKS rather than BLOCKS, so D-1's purpose holds;
#   * the natural Hindi form keeps words between the figures ("salary 15,000 hai।
#     aur 18,000 expected"), which does NOT trip it — a word breaks the run;
#   * against that: WITHOUT the danda a full 10-digit phone leaks at every Hindi
#     ASR utterance seam in a Hindi-first product (~4 seams per 120s note).
# Mislabelling two salaries the profile still captures correctly is plainly worth
# not leaking a phone number.
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
#
# INDIC / CJK sweep (found POST-MERGE by the #395 D-2 review; the S-4 fold-in was
# Latin-centric and had NO Devanagari, and the shape matrix had no danda case, so
# it passed review). The Hindi danda `।` U+0964 LEAKED: `number 98765। 43210`
# walked out un-masked and un-blocked. That is not R30's word-split residual — a
# danda is a SEPARATOR, the exact class this rule claims to catch. It matters more
# than one codepoint suggests: this is a Hindi-first product, Hindi ASR terminates
# utterances with a danda, and #395's chunked STT creates ~4 utterance-boundary
# seams per 120s voice note — so the danda is precisely the artifact that appears
# at a seam, splitting a phone across it.
#
# INCLUSION PRINCIPLE: a character joins this class when it is punctuation that
# terminates or groups text in a script our users plausibly emit, AND it carries
# no meaning in CNC/manufacturing worker text. Each group below was measured
# against a realistic Hindi/Hinglish/CNC corpus for NEW false positives.
#
# DELIBERATELY EXCLUDED (stated boundary, not an oversight) — each closes a leak
# but costs a MEASURED false positive on real worker text, and each is implausible
# as a phone separator, so the trade is not worth it:
#   `/`  dates + thread specs + fractions — "job 12/05/24 15/06/24 dono",
#        "M8/1.25", "1/2 inch"                                  -> 1 measured FP
#   `:`  times — "10:30:45 12:00:00 timing"                     -> 1 measured FP
#   `*`  CNC part dimensions — "part size 100*200*300 mm"       -> 1 measured FP
#   `+ # % = $ & ~ ^ < >` and quotes/brackets: arithmetic/technical meaning in
#        manufacturing text (tolerance "+0.05", tool "#4", "50% scrap", `"` =
#        inches). These measured 0 FP only because such strings are short; a
#        longer tolerance list would trip them. Excluded on principle, not luck.
# NOTE the asymmetry is deliberate: the FULLWIDTH forms (：．－) ARE included while
# their ASCII twins (`:` `.` `-`) are judged separately — a worker types "10:30",
# nobody types U+FF1A, so the fullwidth form is free to mask.
# Consequence recorded as a residual in risks-register R30: an ASCII `/`- or `:`-
# split phone ("98765/43210") is still undetected.
_PHONE_SEPARATORS = (
    r"\s.,\-()_;|"
    # dash family: hyphen, non-breaking hyphen, figure dash, en/em dash,
    # horizontal bar, minus sign, soft hyphen.
    "‐‑‒–—―−­"
    # separator-ish punctuation a number can be written with.
    "·•"
    # zero-width / invisible joiners: ZWSP, ZWNJ, ZWJ, word-joiner, ZWNBSP.
    "​‌‍⁠﻿"
    # INDIC (the #395 finding): Devanagari danda + double danda — the sentence
    # terminators Hindi ASR emits, and the artifact at every STT chunk seam. Both
    # codepoints are SHARED across Devanagari/Bengali/Gurmukhi/Gujarati/Oriya, so
    # these two characters cover the Indic scripts our users actually write. Plus
    # the Devanagari abbreviation sign.
    "।॥॰"
    # ARABIC-script punctuation: Urdu is an Indian scheduled language and is in
    # the ASR's language set, so an Urdu-speaking worker's transcript can carry
    # these. Comma, semicolon, full stop, decimal separator, thousands separator.
    "،؛۔٫٬"
    # CJK + FULLWIDTH forms: implausible from this product's users, but they cost
    # ZERO false positives on worker text (nobody types an ideographic comma
    # between phone digits) and they close the class against pasted / mixed-locale
    # input. Ideographic comma + full stop, katakana middle dot, fullwidth comma /
    # full stop / hyphen / colon, small hyphen.
    "、。・，．－﹣："
    # OTHER-SCRIPT dandas (Tibetan shad, Myanmar section sign): same functional
    # class as U+0964 and likewise 0 measured FP. Included for consistency rather
    # than drawing an arbitrary line at scripts we merely consider unlikely.
    "།၊"
)
_PHONE_RE = re.compile(r"(?<!\d)\d(?:[" + _PHONE_SEPARATORS + r"]*\d){8,12}(?!\d)")

# Email addresses. THE GAP THIS CLOSES, measured on main before the fix:
#
#     pseudonymize("ramesh@gmail.com")                  -> unchanged, blocked=False
#     pseudonymize("contact: ramesh.kumar@tatasteel.co.in") -> unchanged, blocked=False
#
# There was no email rule at all. That is three identity classes leaving in one
# string: the LOCAL PART is very often the worker's name, the DOMAIN is very often
# their EMPLOYER (the exact class `_EMPLOYER_RE` exists to mask, which it misses here
# because "tatasteel.co.in" carries no Ltd/Pvt suffix), and the address itself is a
# direct contact handle — the same category as the phone number two lines up. It
# reached both the provider AND, through the shared `mask=` hook, the trace store.
#
# ONE ATOMIC TOKEN, and that is why this runs FIRST in the pipeline rather than
# alongside the other identity rules. An email is a self-contained unit delimited by
# `@`, and every other rule that touches it makes things WORSE by fragmenting it:
# phone-first turns "worker9876543210@gmail.com" into "worker[PHONE_1]@gmail.com",
# which still publishes the domain and still looks masked. Masking the whole address
# in one move removes the name, the employer and the digits together.
#
# MASK, NOT BLOCK — consistent with phones and with the D-1 ruling that over-blocking
# is its own harm. A worker who types their email should not lose the turn.
#
# FALSE-POSITIVE BOUNDARY, measured against manufacturing/trade text. The TLD arm is
# `[A-Za-z]{2,}` (letters only, never digits), which is what keeps the `@` forms a
# machinist actually writes out of this rule:
#   "M8@1.25"          -> no match (TLD "25" is digits)
#   "part@100.5mm"     -> no match ("5mm" starts with a digit)
#   "welding @ 220V"   -> no match (no local@domain.tld shape)
#   "@ramesh"          -> no match (a bare handle has no domain)
# The lookbehind stops a partial match starting mid-address.
_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}"
)
_EMPLOYER_RE = re.compile(r"\b(?:[A-Z][\w&.]*\s+){1,4}" + _COMPANY_SUFFIX + r"\b")
_NAME_CUE_RE = re.compile(
    r"(?i:\bmy name is\b|\bmyself\b|\bi am\b|\bi'm\b|\bthis is\b|\bname is\b|"
    r"\bmera naam\b|\bnaam\b)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)"
)
_LEADING_NAME_RE = re.compile(r"^\s*([A-Z][a-z]+)\s*,")
_RESIDUAL_DIGITS_RE = re.compile(r"\d{7,}")

# Credential / registration IDs, masked on their CUE rather than their shape.
#
# The certifications question ("Koi certificate hai — jaise NCVT, NSQF ya
# apprenticeship?") became MUST_ASK on 2026-07-22, so every worker is now invited
# to type a roll or registration number. Measured, those answers slipped the whole
# gate: `_PHONE_RE` accepts many separators but NOT "/", and `_RESIDUAL_DIGITS_RE`
# needs 7+ CONSECUTIVE digits, so "R/2019/123456", "MH2019CN4471" and
# "NAPS/2020/44521" all reached the LLM verbatim (blocked=False, replaced=0).
#
# Shape alone cannot catch these — "R/2019/123456" is not distinguishable from a
# machine model or a drawing number by shape. So the rule is CUE-anchored: an
# alphanumeric run of 6+ characters that follows a roll/registration/certificate
# cue. That keeps it narrow (a bare "MH2019CN4471" with no cue is untouched, and
# the residual net still governs long digit runs) and, being an over-mask on an
# ID-doc token, errs in the locked safe direction (§2 #2 names ID-doc tokens
# explicitly).
#
# Two details are load-bearing, both found by measurement:
#   - `\b` AFTER the cue. Without it the `cert` alternative matched the first four
#     letters of "certificate" and group 1 ate the rest, so "NCVT certificate hai"
#     came out as "NCVT cert[ID_1] hai" — mangling ordinary text while leaving the
#     actual ID in the same sentence unmasked.
#   - group 1 must contain a DIGIT. A credential ID always does; without the
#     requirement "certificate number chahiye" masked the Hindi word "chahiye".
#
# QUADRATIC-SCAN BOUND on the digit lookahead (`{0,%d}` below, not `*`).
#
# MEASURED: one 20,000-character BENIGN message — `"reg-" * 5000`, no digits at all —
# stalled the event loop for 1243ms (997ms of it inside `pseudonymize`, 975ms of THAT
# inside this one pattern; the control 20k input costs 7-12ms). `/profiling/respond`
# and `/profile/extract` are `async def` and call `pseudonymize()` INLINE, so the stall
# is the whole process, not one request: every concurrent worker's turn waits.
#
# THE MECHANISM. In `"reg-reg-reg-…"` every `reg` is `\b`-delimited, so the cue matches
# at ~5000 offsets. At each one the unbounded `[A-Za-z0-9/\-]*` scanned forward to the
# END of the string — the class contains both `-` and alphanumerics, so nothing stops
# it — looking for a digit that is never there. 5000 cues x 20k characters = O(n^2).
# (`"reg-abc"*n` is fast for the opposite reason: `abcreg` gives no `\b`, so there is
# only one cue. The cost needs MANY cues, which a separator-joined cue produces.)
#
# THE BOUND IS STRUCTURAL, NOT A REWRITE. Only the lookahead's quantifier changes:
# `*` -> `{0,64}`. Worst case becomes 5000 x 64 instead of 5000 x 20000. The capture
# group stays UNBOUNDED, so what gets masked is byte-identical — a matched credential
# id is still consumed whole, however long. The only behavioural difference is an id
# whose FIRST digit sits past 64 leading `[A-Za-z0-9/\-]` characters, which no roll or
# registration number resembles; 64 is ~5x the longest realistic prefix. The residual
# digit net still governs long digit runs either way.
#
# NOT the max_length cap's job: 20,000 characters is UNDER `DEFAULT_MAX_LENGTH`, so the
# fail-closed size gate never fires here — this input is accepted, as it should be. The
# cap bounds size; this bounds work per character.
_CREDENTIAL_ID_LOOKAHEAD_MAX = 64
_CREDENTIAL_ID_RE = re.compile(
    r"(?i:\b(?:roll|reg|regd|registration|certificate|cert|enrol(?:l)?ment|licence|license)\b"
    r"(?:\s+(?:ka|ki|ke|mera|meri))?"
    r"\s*(?:no\.?|number|num|#)?\s*[:\-]?\s*)"
    r"(?=[A-Za-z0-9/\-]{0," + str(_CREDENTIAL_ID_LOOKAHEAD_MAX) + r"}\d)"
    r"([A-Za-z0-9][A-Za-z0-9/\-]{5,})"
)

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
            return PseudonymizationResult("", True, f"input exceeds {max_length} characters", 0, [])

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

        def replace_leading_name(match: re.Match[str]) -> str:
            """The leading-name heuristic, with the city carve-out step 5 already ruled.

            A CITY IS NOT A NAME, and this rule was masking three of them. ``[A-Z][a-z]+``
            followed by a comma is a good guess at "Ramesh, main welder hoon" and an equally
            good match for "Faridabad, Haryana mein kaam karta hoon" — which came out as
            ``[PERSON_1], Haryana ...``. Measured: 35 of the 38 canonical cities were masked
            this way, the three survivors only because the pattern cannot span a space.

            That directly contradicts the owner ruling recorded at step 5 below — cities are a
            matching input and are never redacted — and it is not a harmless over-mask:
            ``city_current`` and ``cities_preferred`` are Required fields and distance is one of
            the four filters that actually reject a candidate, so the worker silently loses the
            signal that decides whether he is reachable at all.

            The cue-based rule keeps its own replacer untouched. "Mera naam X" is explicit
            evidence of a name and stays masked whatever X is; only the no-cue guess defers.
            """
            candidate = match.group(1).strip().lower()
            if candidate in KNOWN_CITIES or candidate in CITY_ALIASES:
                return match.group(0)
            return replace_group1(match, "PERSON")

        result = text

        # 0. EMAIL FIRST — before every other rule, because it is the only pattern
        #    here that is a COMPOSITE of other identity classes (a name in the local
        #    part, an employer in the domain, sometimes a phone in either). Any rule
        #    that runs ahead of it fragments the address instead of removing it, and a
        #    fragment still publishes the half it did not touch. See `_EMAIL_RE`.
        result = _EMAIL_RE.sub(lambda m: token_for(m.group(0), "EMAIL"), result)
        # 1. ID-like tokens (PAN, Aadhaar, cued credential IDs) so phone
        #    matching doesn't eat them.
        result = _PAN_RE.sub(lambda m: token_for(m.group(0), "ID"), result)
        result = _AADHAAR_RE.sub(lambda m: token_for(m.group(0), "ID"), result)
        #    Its own replacer, not `replace_group1`: that one consults the NAME
        #    stoplist, which has no business vetoing an ID mask.
        result = _CREDENTIAL_ID_RE.sub(
            lambda m: m.group(0).replace(m.group(1), token_for(m.group(1), "ID")), result
        )
        # 2. Phone numbers.
        result = _PHONE_RE.sub(lambda m: token_for(m.group(0), "PHONE"), result)
        # 3. Employers / companies.
        result = _EMPLOYER_RE.sub(lambda m: token_for(m.group(0), "EMPLOYER"), result)
        # 4. Person names (cue-based, then leading-name heuristic).
        result = _NAME_CUE_RE.sub(lambda m: replace_group1(m, "PERSON"), result)
        result = _LEADING_NAME_RE.sub(replace_leading_name, result)
        # 5. (removed) CITY / STATE masking — owner ruling 2026-07-31, Master Context
        #    DEAD LIST: "✗ cities as PII (→ a 20-point matching input; never redact)".
        #    "Pune" identifies nobody, and masking it to [CITY_1] cost the product its
        #    strongest matching signal on every model-authored surface (the résumé's
        #    location line, the extraction transcript, the translate leg) while
        #    protecting nothing. States went with them: coarser geography cannot be
        #    more identifying than the city inside it.
        #
        #    WHAT DID NOT MOVE, and this is the whole point of stating it here: every
        #    IDENTITY class above and every fail-closed path below is untouched. PAN /
        #    Aadhaar / cued credential ids, phones, employers and person names still
        #    mask; the residual-digit net still blocks; oversize, non-string, parse
        #    error and the bare-except still block. This ruling narrows the definition
        #    of PII by exactly two non-identity classes — it does not relax the gate.
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


def _is_employer_only_mask(result: PseudonymizationResult) -> bool:
    """True when the ONLY placeholders minted for a label were ``[EMPLOYER_n]``.

    Deliberately narrow. A PHONE / ID / PERSON / AMOUNT mask on a skill label is a
    genuine PII signal and must keep dropping the label; the employer pattern is the
    only one whose vocabulary provably overlaps trade terms (its suffix list contains
    Steel, Engineering, Tools, Precision, Tech, Fabrication, Manufacturing), so it is
    the only one this rescue considers.

    CITY / STATE are no longer in that list because the gateway no longer mints those
    tokens at all (owner ruling 2026-07-31). One consequence is worth naming, since it
    WIDENS what survives certification: a label like "welding in Pune" used to mask to
    "[CITY_1]" and be DROPPED from the résumé; it now certifies clean and is kept. That
    is the intended direction — the city was never PII, and dropping the label was the
    same silent data loss FIX-5 documents below for "Stainless Steel".
    """
    return bool(result.placeholder_tokens) and all(
        tok.startswith("[EMPLOYER_") for tok in result.placeholder_tokens
    )


def _is_known_trade_vocabulary(label: str) -> bool:
    """Whole-label vocabulary test, delegated to the ONE curated vocabulary.

    The vocabulary lives in ``app/profiling/signals.py``, derived from the keyword and
    label tables the detector itself matches on, so it cannot drift from what the
    product actually recognises. The import is DEFERRED because ``signals`` imports
    THIS module at load time (``KNOWN_CITIES`` / ``MAX_PLAUSIBLE_SALARY_INR``) — a
    module-level import here would be a cycle, and this module is deliberately
    dependency-light. By call time both modules are fully loaded.

    Any failure to consult the vocabulary returns False, i.e. the label is DROPPED —
    the pre-existing behaviour. The rescue can only ever keep a label the vocabulary
    positively recognises; it can never widen the gate by failing.
    """
    try:
        from .profiling.signals import is_curated_vocabulary_label

        return is_curated_vocabulary_label(label)
    except Exception:  # pragma: no cover - defensive; degrade to today's behaviour
        return False


def certified_clean_skill_labels(labels: list[str]) -> list[str]:
    """Keep only labels this gateway certifies CLEAN (Q14/ADR-0030 OQ#3 — SG-2).

    A label passes when ``pseudonymize(label)`` (a) does not block,
    (b) masks nothing (``replaced_entities == 0``), and (c) returns the label
    byte-identical. Anything else — blocked, masked, altered, or an internal
    gateway error (which returns ``blocked=True``) — is DROPPED (fail-closed:
    over-drop, never keep a suspect label). Purely additive certification: it
    never relaxes the gateway, never returns masked text or the token mapping,
    and never logs. Used to certify ``DraftProfile.skill_labels`` AT REST when
    populated (profile extraction) and to RE-certify at the résumé boundary.

    PLUS ONE NARROW RESCUE (the FIX-5 silent-data-loss bug). MEASURED on main:

        pseudonymize("Stainless Steel")                -> "[EMPLOYER_1]"
        pseudonymize("Diploma Mechanical Engineering") -> "[EMPLOYER_1]"
        certified_clean_skill_labels(
            ["Stainless Steel", "Diploma Mechanical Engineering", "VMC Operation"]
        )                                              -> ["VMC Operation"]

    Two real skills and a real qualification were being DELETED from every worker's
    persisted profile and résumé, silently, with no counter and no log of what went.
    The cause is `_COMPANY_SUFFIX` overlapping ordinary trade vocabulary, not a
    genuine PII hit.

    So a label ALSO passes when BOTH hold: the gateway's only placeholders were
    ``[EMPLOYER_n]`` (`_is_employer_only_mask`) AND every token of the label is
    curated trade/education vocabulary (`_is_known_trade_vocabulary`). Both halves are
    load-bearing — a company name always carries a token no trade table contains (a
    proper noun, or a legal form like Industries / Pvt / Ltd / Works / Enterprises),
    so "Ramesh Steel Industries" and "Jyoti CNC Industries" still drop. `pseudonymize`
    itself is UNCHANGED: on general free text those strings mask exactly as before.
    The ORIGINAL label is returned, never the masked text.
    """
    kept: list[str] = []
    for label in labels:
        result = pseudonymize(label)
        if result.blocked:
            continue
        if result.replaced_entities == 0 and result.text == label:
            kept.append(label)
            continue
        if _is_employer_only_mask(result) and _is_known_trade_vocabulary(label):
            kept.append(label)
    return kept
