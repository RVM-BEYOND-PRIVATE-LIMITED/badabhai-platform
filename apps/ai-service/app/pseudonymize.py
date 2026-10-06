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

import hashlib
import re
import secrets
import unicodedata
from collections.abc import Callable, Iterable
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

# ALL-CAPS EMPLOYERS (issue #1875, risks-register R48). `_COMPANY_SUFFIX` is case-SENSITIVE
# while the prefix words of `_EMPLOYER_RE` (`_TITLE_NAME_WORD`, a capital then `[\w&.]`) already
# accept capitals, so an employer written in capitals never matched. MEASURED on main before this
# rule:
#
#     pseudonymize("  TATA MOTORS LTD").text              -> "  TATA MOTORS LTD"   (0 masked)
#     pseudonymize("BHARAT FORGE LIMITED").text           -> unchanged             (0 masked)
#     pseudonymize("XYZ ENGINEERING WORKS PVT LTD").text  -> unchanged             (0 masked)
#     pseudonymize("main TATA MOTORS LTD mein tha").text  -> unchanged             (0 masked)
#
# ("Tata MOTORS Pvt Ltd" was already masked: the title-case "Pvt"/"Ltd" carry it.) Workers type in
# capitals and an OCR'd résumé prints the company that way. WHO READ IT RAW, by posture:
#   - WHATEVER THE FLAG — every consumer that calls `pseudonymize()` directly: the at-rest masked
#     copies (the growth queue, the training corpus, the job-posting draft), the embedding input
#     (`app/ai/embeddings.py`, SG-2; ADR-0047 §4 keeps it masked), and the clean-or-withhold
#     certifiers, which certified "TATA MOTORS LTD" as clean.
#   - ONLY WITH `AI_RAW_PII_ENABLED` OFF — the prompt (through `llm_input_policy`) and the trace
#     sinks. `trace_mask(raw=settings.ai_raw_pii_enabled)` FOLLOWS the flag: off, the Langfuse
#     export and `ai_call_traces` re-mask through this function; on, they pass the raw text the
#     provider was sent, so this rule does not reach them.
#
# WHY NOT make `_COMPANY_SUFFIX` case-insensitive (the issue's first suggestion). Seventeen of its
# twenty-eight words are trade vocabulary (Steel, Tools, Auto, Tech, Works, Engineering, Engineers,
# Motors, Precision, Fabrication, Fab, Forgings, Castings, Technologies, Technology, Solutions,
# Manufacturing), and in capitals they are ordinary SHOUTED SPEECH: "MAIN STEEL PLANT MEIN THA",
# "MAIN AUTO CHALATA HOON", "CNC PRECISION WORK". MEASURED 2026-10-01 over 31,907 distinct strings
# of the repo's own text (the question packs, both lexicon copies, the job-domain corpus, the
# ai-service test and eval-gold strings), each UPPER-CASED as a stand-in for shouted input: a
# case-insensitive suffix list newly masks 1,521 of them (9,442 words), this rule 380 (1,966
# words); as written, 158 against 6. An over-fired [EMPLOYER_n] is not free since ADR-0047: the
# certifiers WITHHOLD the honest value (the "Stainless Steel" loss documented at
# `certified_clean_skill_labels`), the at-rest copies lose the trade word, and the payer
# job-posting draft keeps the masked text and asks for a retype.
#
# THE RULE (`_EMPLOYER_CAPS_RE`). In capitals a span is an employer only when it ENDS IN A CORPORATE
# FORM: LTD, PVT, CORP (each also with a dot), LIMITED, CORPORATION, INDUSTRIES, ENTERPRISES, LLP,
# LLC, W.L.L, and — guarded, details 2 and 3 — PRIVATE, COMPANY, INDUSTRY, CO. Up to four NAME WORDS
# precede it (title case's window), so a trade word still counts INSIDE a name ("XYZ ENGINEERING
# WORKS PVT LTD"); it cannot END one. The rule has its OWN word grammar, so title case keeps main's:
#   - a name word starts with a capital, or with 1-4 digits and a capital ("3M INDIA LTD",
#     "24X7 SECURITY SERVICES PVT LTD"), and may carry "&", "." and a dash ("J.K.", "TATA-MOTORS",
#     "WARANA CO-OPERATIVE SUGAR MILLS LTD"). An earlier cut that reused title case's grammar gave
#     "3M [EMPLOYER_1]", "TATA-[EMPLOYER_1]", "WARANA CO-[EMPLOYER_1]".
#   - after any name word may sit ONE joiner that does not count toward the four: a bare "&" or the
#     Indian parenthesised abbreviation "(P)", "(I)", "(PVT)", "(INDIA)", "(OPC)". That earlier cut
#     left "SHARMA & CO." and "XYZ (P) LTD" raw and certified clean, and gave "LARSEN & TOUBRO
#     LIMITED" -> "LARSEN & [EMPLOYER_1]", "XYZ ENGINEERING (INDIA) PVT LTD" -> "XYZ ENGINEERING
#     (INDIA) [EMPLOYER_1]".
#
# FIVE DETAILS, each load-bearing and pinned by a test that fails without it:
#   1. A SEPARATE rule that runs AFTER `_EMPLOYER_RE`, `_NAME_CUE_RE` and `_LEADING_NAME_RE`, on
#      their output (rule 4b in `_mask`) — never an alternation inside `_COMPANY_SUFFIX`, and never
#      ahead of a name rule. Every rule that could compete with it so reads exactly main's input
#      and keeps main's exact span, and this rule can only mask what they left raw. An alternation
#      can SHORTEN a title-case match — in a run of six capitalised words whose fifth is "LTD",
#      "Om Sai Ram Krishna LTD Steel", main masks "Sai … Steel" and an alternation would mask
#      "Om … LTD" and leave "Steel" raw. Ahead of the name rules it ATE THE CUE (security review
#      F2): "MY NAME IS CO Ramesh" -> "[EMPLOYER_1] Ramesh", where main gives "MY NAME IS
#      [PERSON_1]"; so did "MERA NAAM PVT RAMESH" and "I AM LIMITED Ramesh Kumar".
#   2. A dash after PRIVATE, COMPANY, INDUSTRY or CO makes a compound, not a legal form ("PRIVATE-
#      SECTOR", "INDUSTRY-READY", "QUALITY CO-ORDINATOR" stay raw; title case masks "Quality
#      Co-ordinator" to "[EMPLOYER_1]-ordinator" and is left as it is). The other forms never
#      compound, so a dash after them is a place or a unit: "BHARAT FORGE LTD-CHAKAN" ->
#      "[EMPLOYER_1]-CHAKAN", as title case already masks "Tata Motors Ltd-Pune". A guard on every
#      form left those raw and certified clean. It covers the whole dash family (`_CAPS_DASHES`),
#      not only ASCII: an autocorrected "CO–ORDINATOR" is the same compound.
#   3. CO compounds across a SPACE or a DOT too, and each of these masked before the closed list
#      `_CAPS_CO_COMPOUND`: "QUALITY CO ORDINATOR", "G54 WORK CO ORDINATE SYSTEM", "THANKS FOR YOUR
#      CO OPERATION", "SHIVAJI NAGAR PUNE CO OP SOCIETY" (the city with it), "MERA CO WORKER",
#      "MIG CO 2 WELDING", "QUALITY CO.ORDINATOR". Closed on purpose: "XYZ & CO OPERATIONS MANAGER"
#      and "SHARMA & CO 2 SAAL" are still employers.
#   4. A word holding a 7+ digit run is not a name word. In capitals every word is a name word, so
#      "X12345678 LTD" was swallowed into [EMPLOYER_1] — and a turn main BLOCKED on the
#      residual-digit net passed. The walls that read `.blocked` as their refusal then emitted raw
#      text main refused. With the lookahead it blocks exactly as on main, and "AB1234567 LTD" keeps
#      main's "AB[AMOUNT_1] LTD".
#   5. Each word is BOUNDED at `_CAPS_NAME_WORD_MAX` characters and POSSESSIVE. Reusing title case's
#      then-unbounded `[A-Z][\w&.]*` was O(n^2) on a run with many word boundaries and no
#      whitespace — every letter after a "." or "&" is a start, and each start scanned to the end
#      of the run — and so DOUBLED a stall title case then had. See COST; #1891 has since given
#      title case this same bound (`_TITLE_NAME_WORD`).
#
# INC IS NOT A FORM. In worker and payer pay talk "INC" is "incentive" or "including": "OT AUR INC
# MILTA THA" masked to "[EMPLOYER_1] MILTA THA", "CTC 3 LPA INC. PF" lost the unit. An Indian
# blue-collar employer is practically never an "Inc", and title case has no "Inc" either.
#
# TITLE CASE IS UNTOUCHED BY THIS RULE. `_COMPANY_SUFFIX` and `_EMPLOYER_RE` were byte-identical to
# main when it landed, as was the input of every rule ahead of this one (detail 1); #1891 has
# since bounded `_EMPLOYER_RE`'s name word, which moves no corpus output (`_TITLE_NAME_WORD`). On
# the corpus above taken AS WRITTEN this rule changes 6 of 31,907 strings, each because it holds a
# capitals corporate form: five NCO descriptions naming public bodies ("MUNICIPAL CORPORATION",
# "LIFE INSURANCE CORPORATION") and the TokenScope fixture "…, TATA MOTORS LTD". In neither view
# does a string leave raw a word main masked, or stop blocking where main blocked; no outcome of the
# three certifiers moves over 4,765 lexicon labels (as written, UPPER and Title). Re-measured after
# the detail-1 reorder: the same counts, and no corpus string's output moved. The cost of not
# touching title case, as it stood: "Acme Llp", "Sharma & Co." and "Xyz (P) Ltd" did not mask, and
# "Tata Motors LTD" left the trailing "LTD" raw beside its [EMPLOYER_1]; #1892 closed each in
# separate passes after this one (see `_EMPLOYER_STOPWORDS`).
#
# ONE EXCEPTION, PRE-EXISTING, CLOSED BY #1890 (risks-register R49). Within a view this rule only
# ADDS masking, by construction. The #1738 two-view check in `pseudonymize` was the one place where
# more masking could mean LESS protection: it counted a spaced-view region as covered when it merely
# OVERLAPPED a reader-masked region. "my name is<ZWSP>Ramesh Kumar CO": the reader view merges
# "isRamesh", so the cue misses and this rule masks "Kumar CO"; the spaced view masks "Ramesh Kumar"
# as a name; the two overlap on "Kumar", so the turn passes as "my name isRamesh [EMPLOYER_1]" where
# main BLOCKED it. Main also passed the title-case twin ("…Ramesh Kumar Steel"); this rule extended
# the shape to the capitals forms. #1890 fixed it in the two-view check (`_is_covered`: covered only
# when every kept offset is reader-masked); every such turn now BLOCKS, pinned by
# `test_a_name_hidden_by_an_invisible_beside_a_capitals_form_fails_closed`.
# The check also stops blocking in a SAFE way: when the reader view now masks every kept offset the
# spaced view masked, nothing either view found egresses, so it passes as designed. Over the
# property test's 4,000 seeded samples (invisible separators, name cues) main blocks 28 turns this
# rule passed: 18 of that full-cover kind, 10 of the R49 kind (11 with the rule ahead of the names)
# — the 10 block again since #1890.
#
# STATED BOUNDARY OF THIS RULE, both directions. UNDER — raw, each pinned by a
# `test_KNOWN_RESIDUAL_*`. #1892 has since closed the lower-case, title-case-twin, M/S and 5+ word
# rows of this list with separate passes (`_EMPLOYER_STOPWORDS`); they are kept as this rule's own
# boundary:
#   - no corporate form: "MAIN TATA MOTORS MEIN THA", "BAJAJ AUTO", "GUPTA & SONS", an M/S firm
#     ("M/S SHARMA TRADERS", now #1892's cue rule) — the price of not masking "MAIN STEEL PLANT";
#   - lower case: "tata motors ltd", "TATA MOTORS ltd" — the same case-sensitivity one level down
#     (now #1892's lower-case rule, after its own over-mask measurement);
#   - a form not on the list ("ACME INC", the Gulf "EST."), or a dash after a guarded one
#     ("MARUTI COMPANY-PUNE");
#   - five or more name words before the form leave the leading ones raw: "RAMESH KUMAR SHARMA
#     ENGINEERING WORKS PVT LTD" -> "RAMESH [EMPLOYER_1] LTD" (title case splits its twin at the
#     trade suffix and masks it whole). A six-word window here masks it, at +474 words over 228
#     strings of the upper-cased corpus; #1892 widens it only before a strong form instead.
# OVER: in capitals EVERY word is a candidate name word, so the span takes up to four words before
#   the form ("CNC OPERATOR FOR TATA MOTORS LTD" -> "CNC [EMPLOYER_1]"), and a corporate word used
#   as ordinary speech masks ("MAIN PRIVATE COMPANY MEIN THA" -> "[EMPLOYER_1] MEIN THA") — exactly
#   as the title-case twin of each already does on main. Of the 452 spans this rule adds in the
#   upper-cased corpus, 343 end in PRIVATE, COMPANY or INDUSTRY, and 292 of the 380 strings change
#   only through one of those three. Dropping them as END forms would leave "MARUTI COMPANY" raw;
#   that narrowing is a privacy decision, not made here. Over-masking an identity class is the safe
#   direction. Pinned by
#   `test_ACCEPTED_a_shouted_corporate_word_over_masks_exactly_like_its_title_case_twin`.
#
# COST, measured 2026-10-01 (median, this laptop). A typical line: +2-10 us per `pseudonymize` call
# (17 -> 27 us on a 10-word shouted sentence, the worst). The worst 20,000-character input tried for
# this rule alone, 327 dotted 60-character words, costs 42 ms (112 ms before detail 5's possessive);
# "A." * 10000 costs 18 ms, where the unbounded first cut cost 1,575 ms and took `pseudonymize` from
# 1,576 to 3,131 ms. The 1,576 ms that remained was `_EMPLOYER_RE`'s own unbounded `[\w&.]*`, since
# bounded the same way (#1891, `_TITLE_NAME_WORD`).
#
#: The dash family, for a regex class: ASCII hyphen; hyphen, non-breaking hyphen, figure dash, en
#: dash, em dash, horizontal bar (U+2010-U+2015); minus sign; small and fullwidth hyphen. Inside a
#: capitals name it joins two words; after a compounding form it makes a compound (detail 2).
_CAPS_DASHES = r"\-‐‑‒–—―−﹣－"
#: The longest capitals name word, in characters (detail 5 and COST above).
_CAPS_NAME_WORD_MAX = 64
#: How many name words may precede the corporate form — title case's window. Joiners do not count.
_CAPS_NAME_WORDS_MAX = 4
_CAPS_NAME_WORD_CHARS = r"[\w&." + _CAPS_DASHES + r"]"
_CAPS_NAME_WORD = (
    # Detail 4: a word holding a 7+ digit run is not a name word.
    r"(?!" + _CAPS_NAME_WORD_CHARS + r"{0," + str(_CAPS_NAME_WORD_MAX - 7) + r"}\d{7})"
    r"(?:[A-Z]|\d{1,4}[A-Z])"
    + _CAPS_NAME_WORD_CHARS
    # Detail 5: bounded, and POSSESSIVE (`{m,n}+`, Python 3.11+; the image runs 3.12). A word is
    # always followed by whitespace, which the class excludes, so giving characters back can never
    # help a match; not trying is what took the worst input measured from 112 ms to 42 ms.
    + r"{0,"
    + str(_CAPS_NAME_WORD_MAX - 5)
    + r"}+"
)
#: Between two name words: a bare "&", or an Indian parenthesised abbreviation ("(P)", "(I)" …).
_CAPS_JOINER = r"(?:&|\((?:P|I|PVT|INDIA|OPC)\.?\))"
#: Detail 3: what makes "CO" a compound across a space or a dot. Closed on purpose.
_CAPS_CO_COMPOUND = (
    r"(?:ORDINAT|OPERAT(?:ION|IVE|E)\b|OP\b|WORKER|CURRICULAR|2[^\S\r\n]*(?:WELD|GAS))"
)
_CORPORATE_FORM_CAPS = (
    r"(?:LTD\.?|LIMITED|PVT\.?|CORP\.?|CORPORATION|INDUSTRIES|ENTERPRISES|LLP|LLC|W\.L\.L"
    # Detail 2: a dash after these makes a compound ("PRIVATE-SECTOR", "INDUSTRY-READY").
    r"|(?:PRIVATE|COMPANY|INDUSTRY)(?![" + _CAPS_DASHES + r"])"
    # Details 2 and 3: CO compounds across a dash always, across a space or a dot on the list.
    r"|CO(?![" + _CAPS_DASHES + r"]|\.?[^\S\r\n]*" + _CAPS_CO_COMPOUND + r")\.?)"
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


def phone_shaped_runs(text: str) -> list[str]:
    """Every digit run the phone rule claims in ``text``, in order. READ-ONLY.

    For a caller that must know WHICH runs the gateway calls a phone without re-deriving
    `_PHONE_RE` (the job-posting chat's draft-safety decision, issue #1731: a dashed pay range
    "20000-25000" is phone-shaped). It changes no masking — the gateway still masks every one of
    these runs before anything leaves the process, and nothing here un-masks egress.
    """
    return [match.group(0) for match in _PHONE_RE.finditer(text or "")]


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
# THE TITLE-CASE NAME WORD IS BOUNDED AND POSSESSIVE (issue #1891, risks-register R48). It was
# `[A-Z][\w&.]*`, unbounded, and on a run with many word boundaries and no whitespace that is
# O(n^2): every letter after a "." or "&" is a start, and each start scanned to the end of the run
# for the whitespace a suffix needs. At 20,000 characters, under `DEFAULT_MAX_LENGTH` so the size
# gate never fires, `pseudonymize("A." * 10000)` took 2.1 s, and 4.3 s with one invisible
# character, because #1738's two views each run the rule (2026-10-03, min of 5).
# `/profiling/respond` and `/profile/extract` call `pseudonymize()` inline inside `async def`, so
# the stall is the whole event loop, and every clean-or-withhold wall runs it whatever
# `AI_RAW_PII_ENABLED` says: the defect `_CREDENTIAL_ID_LOOKAHEAD_MAX` already fixed once. Bounded,
# those two inputs cost 37 and 82 ms.
#
# THE CAPITALS RULE'S BOUND, reused so the two cannot drift: `_CAPS_NAME_WORD_MAX` characters,
# possessive (detail 5 at `_CORPORATE_FORM_CAPS`). Possessive changes no match: a word is always
# followed by `\s+`, which `[\w&.]` excludes, so giving characters back can never help. The bound
# changes one thing, a name word over 64 characters: an undotted one no longer opens a span
# ("<65 letters> Steel" stays raw), and a dotted one masks from the first "." or "&" boundary within
# 64 characters of its end ("A." * 40 + " Steel" -> "A." * 8 + "[EMPLOYER_1]"; main masked it
# whole), as the capitals rule always has. No employer has a 65-character word: the longest
# capital-led run in the #1875 corpus is 43 characters. RE-MEASURED over that corpus (31,984
# distinct strings, as written and upper-cased) and its 4,765 certifier labels: no output, no
# blocked status and no certifier outcome moves. The price is linear: a run main matched from its
# first letter is now scanned 64 characters per start ("A." * 9990 + " Steel": 4 -> 37 ms).
_TITLE_NAME_WORD = r"[A-Z][\w&.]{0," + str(_CAPS_NAME_WORD_MAX - 1) + r"}+"
_EMPLOYER_RE = re.compile(r"\b(?:" + _TITLE_NAME_WORD + r"\s+){1,4}" + _COMPANY_SUFFIX + r"\b")
#: Issue #1875 — see `_CORPORATE_FORM_CAPS`. Runs AFTER `_EMPLOYER_RE` and both name rules, on their
#: output (rule 4b in `_mask`, detail 1). A name word opens the span; at most one joiner follows
#: each name word and none counts toward the window.
_CAPS_NAME_WORD_THEN_JOINER = _CAPS_NAME_WORD + r"(?:\s+" + _CAPS_JOINER + r")?"
_EMPLOYER_CAPS_RE = re.compile(
    r"\b"
    + _CAPS_NAME_WORD_THEN_JOINER
    + r"(?:\s+"
    + _CAPS_NAME_WORD_THEN_JOINER
    + r"){0,"
    + str(_CAPS_NAME_WORDS_MAX - 1)
    + r"}\s+"
    + _CORPORATE_FORM_CAPS
    + r"\b"
)
# THE EMPLOYER SHAPES #1875 LEFT RAW (issue #1892, risks-register R48). Measured on main before
# these rules (2026-10-03):
#
#     pseudonymize("tata motors ltd").text           -> "tata motors ltd"           (0 masked)
#     pseudonymize("Larsen & Toubro Limited").text   -> "Larsen & [EMPLOYER_1]"
#     pseudonymize("Sharma & Co.").text              -> "Sharma & Co."              (0 masked)
#     pseudonymize("M/S SHARMA TRADERS").text        -> "M/S SHARMA TRADERS"        (0 masked)
#     pseudonymize("RAMESH KUMAR SHARMA ENGINEERING WORKS PVT LTD").text
#                                                    -> "RAMESH [EMPLOYER_1] LTD"
#
# The three left wholly raw also certified clean, so the walls passed them raw whatever
# AI_RAW_PII_ENABLED says (who reads the gateway raw, by posture: the #1875 notes above). FIVE
# PASSES, each separate. Four run after the title-case rule, both name rules and the capitals rule,
# on their output (rules 4c-4f in `_mask`); the long pass runs just ahead of the capitals rule (4a)
# and is built so it never takes part of a capitals span (item 4 below).
#   1. LOWER AND SENTENCE CASE (`_EMPLOYER_LOWER_RE`): up to four name words of any case before a
#      form that stays corporate in lower case — LTD, LLP, LLC, W.L.L, PVT LTD / PRIVATE LIMITED
#      and their glued spellings ("pvt.ltd", "(P)LTD"), "& CO" — or, after TWO or more name words,
#      INDUSTRIES, ENTERPRISES, CORPORATION, "CO." ("jai bhavani industries", "verma brothers
#      co."). Never "limited", "company", "pvt" or "private" alone: in worker Hinglish they are
#      ordinary words ("knowledge limited hai", "private company mein tha", "pvt job"). Left raw, as
#      a KIND of company: a span of sector words ("auto ancillary industries"; before a strong form
#      sector words only, so a brand stays a firm: "automobile pvt ltd company" raw, "siemens ltd"
#      masked) and a lone generic adjective ("korean pvt ltd company", `_GENERIC_ADJECTIVES`). In
#      lower case every word is a candidate, so a STOPWORD (`_EMPLOYER_STOPWORDS`) can neither open
#      nor sit inside the span, a JOB word (`_ROLE_WORDS` but `_FIRM_NAME_TRADE_WORDS`) sits nowhere
#      in it, and a role, a DEPARTMENT (`_DEPARTMENT_WORDS`), a CITY or a form word never OPENS it:
#      "cnc turner at tata motors ltd" keeps "cnc turner at", "machine operator xyz pvt ltd" keeps
#      "machine operator", "quality inspector bharat forge ltd" keeps "quality inspector", "pune
#      tata motors ltd" keeps "pune". (A city further in is masked with the firm: OVER, below.)
#   2. THE TITLE-CASE TWINS OF #1875's FIXES (`_EMPLOYER_TITLE_FORM_RE`, `_EMPLOYER_ABSORB_RE`).
#      The capitals grammar with title-case forms masks "Sharma & Co.", "Xyz (P) Ltd", "Acme Llp"
#      (Pvt and Private only before Ltd or Limited: "Govt & Private Jobs" is a job preference).
#      The absorb pass folds into an existing token what the title-case rule left beside it: a
#      trailing form ("Tata Motors LTD", "Tata Steel industries pvt ltd" -> one token), one or two
#      name words before a joiner ("Larsen & [EMPLOYER_1]"), a digit-led word ("3M [EMPLOYER_1]")
#      or a word glued on by a dash ("Hero-[EMPLOYER_1]"). It mints nothing. It leaves alone a lead
#      of trade or sector words ("Welding & [EMPLOYER_1]", "Oil & [EMPLOYER_1]"), a city
#      ("Pune-[EMPLOYER_1]"), a duration ("3Yrs [EMPLOYER_1]"), and a word holding 7+ digits:
#      "AB12345678-Tata Steel" still BLOCKS on the residual-digit net, as on main.
#   3. THE M/S CUE (`_EMPLOYER_MS_CUE_RE`): "M/S", "M/s.", "M / S", "M/S:", "M/S:-", then a firm
#      that ENDS on a word naming a business — the small firm with no corporate form ("M/S. KRISHNA
#      FABRICATORS"), without touching shouted speech ("MAIN STEEL PLANT" has no cue). "M/S" also
#      abbreviates mild steel and metres per second, and a payer's verb or a locality follows the
#      firm; so the cue never follows a measurement ("3 m/s submersible pumps"), the firm never
#      opens on mild-steel stock, a material, a unit, a role or a city (`_MS_NOT_A_FIRM_WORDS`), and
#      it ends on its firm word, leaving what follows raw ("M/S SHARMA TRADERS BHOSARI ME HELPER",
#      "M/S SHARMA TRADERS-BHOSARI", "M/s ABC Engineering Pvt Ltd requires CNC operators"). A strong
#      firm word (traders, fabricators, transport, sons, …) is enough; a generic one (works, parts,
#      tools, engineering, …) is not, after mild-steel stock or, in lower case, after nothing but
#      sector words ("m/s truck body works", "m/s power tools" stay raw; `_is_ms_trade_talk`). A
#      "firm" of nothing but curated trade vocabulary is a skill ("M/S PIPING SYSTEMS"). A firm an
#      earlier rule masked takes only a firm word right after its token ("M/[EMPLOYER_1] Traders" ->
#      "M/[EMPLOYER_1]"), never words past it. Never across a line, and never cutting a word.
#   4. FIVE OR SIX NAME WORDS (`_EMPLOYER_LONG_RE`), only before a STRONG form (PVT LTD, PRIVATE
#      LIMITED, LTD, LLP, LLC), with "and" as a joiner ("SHIV SHAKTI PLASTIC MOULDING AND
#      PACKAGING PVT LTD"). It runs ahead of the capitals rule, whose four-word window would
#      otherwise take the last four words and leave the first raw — and so it never holds a word
#      where the capitals or title-form rule would END (`_NOT_A_CAPITALS_OR_TITLE_FORM_WORD`), and
#      its own form ends where that rule would not take the next word (`_LONG_FORM_END`): either
#      let it start or stop inside a capitals span and leave that span's name raw ("KRISHNA
#      INDUSTRIES turning … pvt ltd", "Hero Traders INDUSTRIES-PUNE …", "…works LTD-patil MOTORS
#      LTD"; security review, rounds one to four). A city, a role, a department or a form word never
#      opens it, and no job word sits in it ("MACHINE OPERATOR SHREE GANESH ENGINEERING WORKS PVT
#      LTD" -> "MACHINE OPERATOR [EMPLOYER_1]").
#   5. SHARED: every span opens at a REAL word start (`_SPAN_START`) and uses horizontal space only
#      (`_H`), so the "S" of "M/S" never opens a firm and no span takes a résumé's role or city line
#      into the next line's firm; each pass is GATED on its mandatory piece (`_RULE_GATES`), which
#      changes no output and keeps the cost off the many lines with no form, cue or token.
#
# MEASURED 2026-10-03, every pass switched off against on, each string as written, UPPER-CASED
# (shouting), lower-cased (phone typing) and Sentence-cased (a phone keyboard), re-measured after
# each review round:
#   - 50,918 distinct repo strings: #1875's 31,984 plus 18,934 it lacked (the profiling-lexicon
#     utterance fixtures, apps/api string literals, ai-service app strings, the fabricated résumé
#     CSV). Changed: 7 as written, 7 upper, 72 lower, 72 sentence. No string anywhere leaves a word
#     main masked raw, stops blocking or newly blocks; no outcome of the three certifiers moves over
#     5,507 lexicon and vocabulary labels in four casings. Of the 7 written, 6 are employers and one
#     is NCO prose ("… removal corporation"); upper-cased all 7 are employers; lower-cased, the rest
#     are firms or public bodies (LIC, ESIC, a municipal corporation — which the capitals rule
#     already masks).
#   - 1,324 fabricated worker and payer lines built to trip these rules (trigger words in their
#     ordinary sense: "limited", "pvt job", "m/s" units, mild steel, "& co-worker", Title Case job
#     titles): 7 lines over-mask as written (12 words), 6 upper, 3 lower. Each is accepted below.
#   - 576 fabricated lines naming 590 employers. Caught as written, before -> after: lower case
#     1% -> 75%, title-case twins 32% -> 99%, M/S firms 16% -> 95%, five or more name words
#     27% -> 78%; capitals forms and title-case suffixes stay 100%, firms with neither a form nor a
#     cue stay 0% (by design, below).
#   - Two corpora the reviewers wrote to break these passes, firms bracketed: the third review's
#     804 lines and the fourth review's 678. Lines with a word main kept now inside a token: 243 ->
#     94 and 162 -> 30 over the third and fourth rounds' fixes. What remains is the OVER list's
#     shapes (the industry shape: 28 of 30 and 11 of 36 lines built for it; generic company talk:
#     7 of 50 and 8 of 61; mild steel: 10 of 78; 3 of 156 ordinary lines), firms the third
#     review's corpus left unbracketed, and forms folded into a token ("JAI [EMPLOYER_1] LTD" ->
#     "JAI [EMPLOYER_1]"). On the fourth review's corpus units, payer ads and roles are at 0, and
#     the curated mild-steel skill labels certify as on main. Firms that corpus brackets but the
#     passes leave raw: 98 -> 60 lines (M/S firms with no firm word, most of it).
# Each candidate was measured alone first. Rejected on those numbers: lower-case "limited" alone
# (+17 employers, but +10 worker lines such as "programming ka knowledge limited hai"), lower-case
# "company" (+7 employers, +12 repo and +11 worker lines), the weak forms after ONE word (+22 NCO
# prose lines: "other enterprises", "various industries"), an M/S cue without the mild-steel guard
# (+8 worker lines as written, +9 upper-cased, not one more employer), an M/S cue with no firm word
# (71 of 125 mild-steel lines and 17 of 20 payer ads over-masked), and a weak form after an "-ing"
# word left raw ("sharma trading co." raw). A window of eight words bought nothing in any corpus,
# so the long rule keeps six.
# REVIEWED 2026-10-03 (security, code, performance, red team, mutation, claims, sweep), four rounds.
# Fixed from the first: the absorb leads' missing 7-digit refusal (a turn main blocked passed — the
# blocker), the M/S match cutting a word, the long pass taking part of a capitals span, mild-steel
# trade words and role words after M/S, cities and roles opening spans, spans crossing lines,
# stopword gaps ("hamari", "choti", "A.K." read as "a"), "Govt & Private Jobs", "3Yrs", one firm
# split into two tokens, two M/S firms in a row, and a 5x worst case on dotted text (spans opened at
# every letter of "B.B.B."). From the second: a capitals form with a dash after it let the long
# pass take part of a capitals span again. From the third: the long pass's own form ending inside a
# capitals word ("LTD-patil"), and M/S over-masks of mild steel, payer ads and localities — the
# firm word replaced the never-after-a-number and next-cue guards (and re-opened "M/S TOOL CRAFT",
# a firm with no firm word: UNDER). From the fourth: a veto's characters losing their source
# offsets (an invisible then hid a firm the visible text masked: `_apply`), the measurement guard
# narrowed back, generic firm words, a whole firm's token, job words inside a span, and the
# brand and "-ing" regressions of the third round's vetoes. From a final check: a joiner counted
# as a word in `_LONG_FORM_END`.
#
# STATED BOUNDARY. UNDER — raw, each pinned by a `test_KNOWN_RESIDUAL_*` unless marked:
#   - no corporate form and no cue, any case: "BAJAJ AUTO", "gupta & sons", "SHREE SAI ENGINEERING
#     WORKS" — the price of not masking shouted trade speech (#1875);
#   - lower case "limited", "company", a weak form after one word or after nothing but sector
#     words: "bharat forge limited", "omkar engineering company", "gupta industries",
#     "precision engineering industries" — and a strong form after nothing but sector words
#     ("precision engineering pvt ltd", unpinned);
#   - a stopword inside a firm: "xyz and sons ltd" -> "xyz and [EMPLOYER_1]" (as title case leaves
#     "Gupta and [EMPLOYER_1]" on main), "steel authority of [EMPLOYER_1]"; a job word inside one
#     loses the words before it ("sharma fitter works ltd" -> "sharma fitter [EMPLOYER_1]",
#     unpinned);
#   - an M/S firm with no firm word ("M/S TOOL CRAFT", "M/S SIEMENS", "M/S SAI PRECISION REQUIRES
#     VMC OPERATORS"), opening on a stopword, a mild-steel word, a role word or a city ("M/S THE
#     ROYAL ENGINEERS", "M/S STEEL CENTRE", "M/S CNC TURNING WORKS", "M/S PUNE SHARMA TRADERS"),
#     after a small number ("1 M/S SHARMA TRADERS"), before a dot or a slash ("M/S SHARMA
#     TRADERS.PUNE"), generic in lower case ("m/s precision components", unpinned), ending on a
#     generic firm word after mild-steel stock ("M/S BALAJI STRUCTURE WORKS"), or name words
#     between a half-masked firm's token and its firm word ("M/S Hanuman Steel Om Sai Traders"
#     -> "M/[EMPLOYER_1] Om Sai Traders", as main leaves them);
#   - lower case, a weak form after nothing but sector words or curated vocabulary ("water tech
#     industries"); a long name with a dot glued after its form ("…PVT LTD.CHAKAN" -> "RAMESH
#     [EMPLOYER_1]CHAKAN", as main);
#   - seven or more name words, five before a non-strong form, or four and a joiner: "B C D E F G
#     H PVT LTD" -> "B [EMPLOYER_1]"; "SRI RAMA KRISHNA CASTING AND FORGING LIMITED" -> "SRI RAMA
#     [EMPLOYER_1]"; "SRI SAI IRON AND STEEL PVT LTD" -> "SRI [EMPLOYER_1]" (main leaves "SRI" raw
#     too: "SRI [EMPLOYER_1] LTD");
#   - spelling the passes do not read: "sharma &  co" (two spaces), "fitter/tata motors ltd" (a
#     slash glues the first word on), a firm wrapped across a line, a city as the first word of a
#     firm ("pune industrial gases pvt ltd" -> "pune [EMPLOYER_1]"), a city glued on by a dash, a
#     dot or "&" ("pune-tata motors ltd" -> "pune-tata [EMPLOYER_1]"; "nashik-sharma & co" raw).
# OVER — accepted, each pinned by a `test_ACCEPTED_*`:
#   - the absorb pass extends a title-case over-mask that exists on main by the word in front of
#     it: "Hiring Fitter & Welder For Steel Industry Project" -> "Hiring [EMPLOYER_1] Project",
#     "Walk-In Interview For Quality Co-ordinator" -> "[EMPLOYER_1]-ordinator";
#   - the long rule widens a span before PVT LTD on telegraphic text: "… WITH PPAP APQP FMEA MSA
#     SPC KNOWLEDGE PVT LTD" -> "… WITH [EMPLOYER_1]";
#   - a weak form after two ordinary words or a product noun: "garbage removal corporation",
#     "rice mill industries me loader", "agarbatti making industries" -> "[EMPLOYER_1] …";
#   - a city other than a span's first word is masked with it, as the capitals and title-case
#     rules do: "Pune Sharma & Co." -> "[EMPLOYER_1].", "bhosari pune tata motors ltd" ->
#     "[EMPLOYER_1]"; and a locality outside the gazetteer, or a job the lists lack, opens a
#     lower-case span: "chakan bharat forge ltd", "forklift tata motors ltd" -> "[EMPLOYER_1]";
#   - a payer's benefit before "pvt ltd company": "bus facility pvt ltd company" -> "[EMPLOYER_1]
#     company";
#   - trade talk ending on a generic firm word, unless a name word is mild-steel stock or, in lower
#     case, every name word is a sector word: "m/s hand tools se kaam" -> "m/s [EMPLOYER_1] se
#     kaam".
#
# TWO VIEWS (#1738). The two-view check can stop blocking where the reader view now masks what the
# spaced view found. "Larsen &<ZWSP>Toubro Limited" now BLOCKS (the spaced view absorbs "Larsen",
# the reader view cannot), where main passed it with "Larsen" raw. One way it passes what main
# blocked: "full" — "my name is<ZWSP>Ramesh Kumar ltd" -> "my [EMPLOYER_1]", the name masked under
# an employer label. Before #1890 there was a second, R49's partial overlap, which these passes
# extended as #1875 extended it: with an invisible right after a name cue, "my name is<ZWSP>Ramesh
# Kumar Llp" (and "& Co.", "(P) Ltd", "W.l.l", "& Toubro Ltd", "-Toubro Ltd", a long lower-case
# span) passed as "my name isRamesh [EMPLOYER_1]"; with one that merges a word into a dash-glued
# run, "Sharma Motors<WJ>A-ONE Motors" passed as "Sharma [EMPLOYER_1]" (the absorb pass folds the
# reader view's "MotorsA-" into the token). Each shape is pinned, now as a block. On the third
# review's generator, re-run on the final rules (20,000 lines that each carry an invisible): main's
# own R49 name egress was 208 lines; these passes added 194 that main blocked (0.97%) and closed 46
# of main's. With invisibles in 2% of lines: 3 added in 20,000. They reached the at-rest copies
# (corpus, growth queue, payer draft) and the embedding input; the walls withheld every such turn.
# Security review: SHIP with this registered (R49) and owner-acknowledged (acknowledged
# 2026-10-03). #1890 fixed it in the two-view check, not here: each R49 shape above now BLOCKS.
# A long span may also split an earlier span and leave a separator or a bare form word between two
# tokens ("xa xb xc xd SHARMA LTD PVT" -> "[EMPLOYER_1] PVT"): no name word, so it stays.
#
# COST, measured 2026-10-03 (this laptop, under load). A typical line: +1-5 us mean (1,882
# real-shaped worker turns, the question packs, the test fixtures); a line holding a lower-case
# employer about 2.5-3x (25 -> 64-70 us). On the worst 20,000-character inputs found the work is
# linear — every word is a span start and each start reads at most six words: the reviewers'
# dotted shapes cost x1.1-1.4 their base (x5.3 before spans opened only at real word starts), and
# the largest shares are one-letter words before a form ("b " x 9,990 + " ltd": 7 -> 40 ms) and
# joiners ("Ab (P) " x 2,850 + " ltd": 9 -> 46 ms). No input found adds more than ~37 ms. Every
# name word is bounded and possessive (detail 5), and the word lists are compiled as tries.
#
#: Words that never open or sit inside a firm name when every word is a candidate: function words,
#: determiners, pronouns and adverbs, English and Hinglish. Every #1892 name word refuses them —
#: the lower-case, long, title-form and M/S spans and the absorbed lead. Matched case-insensitively.
_EMPLOYER_STOPWORDS = (
    # English
    "a", "an", "the", "at", "in", "on", "of", "for", "from", "with", "to", "by", "as", "and", "or",
    "is", "was", "were", "am", "are", "be", "been", "my", "i", "me", "we", "our", "his", "her",
    "this", "that", "worked", "working", "work", "job", "since", "till", "until", "after", "before",
    # Hinglish
    "aur", "ya", "se", "ka", "ki", "ke", "ko", "ne", "pe", "par", "mein", "mai", "main", "maine",
    "mujhe", "hum", "humne", "mera", "meri", "mere", "tha", "thi", "thay", "hai", "hain", "hoon",
    "hu", "ho", "hota", "hoti", "hote", "kiya", "kia", "kaam", "naukri", "saal", "sal", "mahine",
    "mahina", "tak", "abhi", "pehle", "phir", "wahan", "yahan", "wala", "wali", "wale", "bhi",
    "naam", "myself", "nahi", "nhi", "na", "haan", "chahiye", "chahie", "chaiye", "tarah",
    # Hinglish possessives ("hamari company pvt ltd hai")
    "hamari", "hamara", "hamare", "humari", "humara", "humare", "unki", "unka", "unke", "uski",
    "uska", "uske", "teri", "tera", "tere", "tumhari", "tumhara", "tumhare", "aapki", "aapka",
    "aapke",
    # Determiners and quantifiers: "ek pvt ltd company", "koi pvt. ltd.", "kai sari industries"
    "ek", "koi", "kisi", "sab", "sabhi", "kya", "kaun", "badi", "bada", "bade", "bari", "bara",
    "bare", "chhoti", "chhota", "chhote", "choti", "chota", "chote", "achhi", "acchi", "accha",
    "achi", "acha", "ache", "achhe", "acche", "achche", "si", "local", "alag", "kai", "kayi",
    "bahut", "sari", "saari", "any", "some", "every", "each", "all", "big", "small", "large",
    "leading", "reputed", "famous", "good", "top", "best", "mnc", "type", "kind", "companies",
    "firms",
    # Payer and duration words: "Hiring Fitter & …", "3 YRS & ABOVE …"
    "hiring", "urgent", "required", "requirement", "wanted", "need", "needed", "yrs", "yr",
    "years", "year", "months", "month", "experience", "exp",
    # English determiners, pronouns and modals ("various industries", "other enterprises")
    "other", "various", "different", "many", "several", "multiple", "related", "allied", "those",
    "these", "such", "entire", "whole", "within", "between", "under", "over", "into", "about", "no",
    "not", "very", "more", "most", "less", "much", "only", "also", "its", "their", "your", "it",
    "they", "he", "she", "us", "them", "who", "which", "what", "where", "when", "how", "can",
    "could", "will", "would", "should", "may", "must", "has", "have", "had", "do", "does", "did",
    "two", "three", "four", "five",
    # Adverbs, where a firm name never ends: "jobs mostly industries mein"
    "mostly", "mainly", "currently", "previously", "usually", "generally", "especially",
    "recently", "really", "totally", "fully", "highly", "quite", "rather",
    # Hinglish determiners ("apni company", "dusri company", "nayi company")
    "iss", "uss", "apni", "apna", "apne", "dusri", "dusra", "doosri", "nayi", "naya", "nai",
    "purani", "purana", "wahi", "same", "kaunsi", "jis", "jo",
    # Hinglish demonstratives, numerals and time words ("ye pvt ltd hai", "teen pvt ltd company",
    # "iti ke baad …"), and a payer's "free" ("ROOM FREE … PVT LTD"; third review)
    "ye", "yeh", "wo", "woh", "vo", "yaha", "waha", "baad", "pehli", "pehla", "baar", "teen",
    "char", "chaar", "paanch", "free", "ghante",
    # ... and the second word of a kind of company ("iso certified pvt ltd company", "export
    # oriented …", "third party payroll …"; fourth review)
    "certified", "oriented", "approved", "established", "payroll", "party",
)  # fmt: skip
#: The adjectives of "a <kind of> pvt ltd company" ("korean pvt ltd company me", "registered pvt
#: ltd company hai"). Alone before a lower-case form they name a kind of company and the span is
#: left raw (`replace_lower_case_firm`); unlike a stopword, one may still open a longer firm
#: ("indian oil corporation ltd", "M/S INDIAN STEEL TRADERS"; fourth review).
_GENERIC_ADJECTIVES = frozenset(
    (
        "naami", "known", "japani", "japanese", "korean", "german", "chinese", "american",
        "foreign", "indian", "videshi", "desi", "registered", "permanent", "stable", "genuine",
        "branded", "multinational", "new", "listed", "dono", "usi",
    )
)  # fmt: skip
#: Roles, trades, qualifications and pay — what a worker writes right BEFORE a firm ("iti fitter
#: tata motors ltd", "hiring cnc operator xyz pvt ltd", "15000 salary xyz pvt ltd") or right after
#: an M/S firm ("M/S SHARMA TRADERS WELDER"). None ever opens a lower-case, long or M/S span, and
#: none but `_FIRM_NAME_TRADE_WORDS` stands inside one.
_ROLE_WORDS = (
    "cnc", "vmc", "hmc", "operator", "operators", "welder", "fitter", "helper", "turner",
    "electrician", "supervisor", "setter", "programmer", "machinist", "technician", "mechanic",
    "plumber", "carpenter", "painter", "rigger", "foreman", "driver", "loader", "packer",
    "grinder", "fabricator", "iti", "diploma", "degree", "mechanical", "electrical", "salary",
    "shift", "pf", "esic", "esi", "fresher", "apprentice", "trainee", "certificate",
    "certification", "vacancy", "vacancies", "post", "posts", "midc",
    # more roles a worker writes before a firm ("quality inspector bharat forge ltd", "mason l&t
    # ltd site pe", "office boy xyz pvt ltd"; third review)
    "inspector", "keeper", "storekeeper", "guard", "mason", "draftsman", "draughtsman", "mistri",
    "mistry", "lineman", "wireman", "accountant", "cook", "attendant", "karigar", "majdoor",
    "mazdoor", "peon", "sweeper", "cleaner", "clerk", "boy", "engineer", "manager", "executive",
    "incharge", "worker", "workers", "cutter", "staff", "maker", "leader", "officer", "tailor",
    "handler",
)  # fmt: skip
#: The role words a firm is often named with ("M/S. AMBIKA CNC WORKS", "xyz electrical works pvt
#: ltd", "om fabricator works"): they may sit inside a span. Every other role word is a JOB word,
#: which no lower-case, long or M/S span holds anywhere — so the span starts after the job a worker
#: names in front of a firm ("machine operator xyz pvt ltd" -> "machine operator [EMPLOYER_1]",
#: "assembly line operator tata motors ltd" -> "assembly line operator [EMPLOYER_1]"; fourth
#: review). The price: a firm with a job word inside loses its leading words ("sharma fitter works
#: ltd" -> "sharma fitter [EMPLOYER_1]").
_FIRM_NAME_TRADE_WORDS = frozenset({"cnc", "vmc", "hmc", "mechanical", "electrical", "fabricator"})
#: Departments: a lower-case or long span never OPENS on one ("quality inspector …", "store keeper
#: …", "MAINTENANCE FITTER SHREE SAI … PVT LTD"), though a firm may hold one ("xyz security
#: services pvt ltd", "M/S XYZ SECURITY SERVICES") — so, unlike a job word, one may sit inside.
_DEPARTMENT_WORDS = (
    "quality", "maintenance", "production", "store", "stores", "security", "office", "delivery",
    "packing", "assembly", "dispatch", "warehouse", "purchase", "admin", "accounts",
    "housekeeping",
)  # fmt: skip


def _alternation_trie(phrases: Iterable[str]) -> str:
    """``phrases`` (lower case) as ONE regex alternation shaped like a character trie.

    A flat ``a|an|and|at|…`` is tried branch by branch at every position; these lists hold up to a
    few hundred entries and the rules test them at every word, so the flat form cost ~10x on an
    ordinary line. As a trie the engine tests one branch per character. Matches exactly the same
    strings: the caller's lookahead backtracks through the optional tails. A space in a phrase
    matches one or more horizontal spaces (multi-word city names)."""
    trie: dict[str, dict] = {}
    for phrase in phrases:
        node = trie
        for char in phrase:
            node = node.setdefault(char, {})
        node[""] = {}

    def emit(node: dict[str, dict]) -> str:
        branches = [
            (r"[^\S\r\n]+" if char == " " else re.escape(char)) + emit(child)
            for char, child in sorted(node.items())
            if char
        ]
        if not branches:
            return ""
        body = "(?:" + "|".join(branches) + ")"
        return body + "?" if "" in node else body

    return emit(trie)


def _not_a_whole_word_from(words: Iterable[str]) -> str:
    """A lookahead refusing any of ``words`` as a WHOLE word, any case. A dash or a dot followed by
    a letter makes a compound or an initialism, not the word: "A-ONE", "in-house" and "A.K." are not
    the stopwords "a", "in"; "kiya." before a space still is "kiya"."""
    return r"(?!(?i:" + _alternation_trie(words) + r")(?![\w&]|[." + _CAPS_DASHES + r"]\w))"


_EMPLOYER_STOP = _not_a_whole_word_from(_EMPLOYER_STOPWORDS)
_NOT_A_ROLE_WORD = _not_a_whole_word_from(_ROLE_WORDS)
_NOT_A_JOB_WORD = _not_a_whole_word_from(
    word for word in _ROLE_WORDS if word not in _FIRM_NAME_TRADE_WORDS
)
#: Cities are never redacted (owner ruling 2026-07-31), so a city never opens a lower-case, long or
#: M/S span nor is absorbed into a token ("pune tata motors ltd" -> "pune [EMPLOYER_1]",
#: "Pune-[EMPLOYER_1]" stays). The title-form pass mirrors the title-case and capitals rules
#: instead (`_CORPORATE_FORM_TITLE`).
_CITY_WORD_ALTERNATION = _alternation_trie(
    " ".join(name.lower().split()) for name in set(KNOWN_CITIES) | set(CITY_ALIASES)
)
_NOT_A_CITY = r"(?!(?i:" + _CITY_WORD_ALTERNATION + r")\b)"
#: Horizontal space only: no #1892 span crosses a line, so a résumé's role line or city line is
#: never taken into the firm on the next line ("fitter\ntata motors ltd" -> "fitter\n[EMPLOYER_1]").
_H = r"[^\S\r\n]+"
#: Where a #1892 span may open: a REAL word start, not a letter inside a dotted, dashed, glued or
#: slashed run. The "S" of "M/S" never opens a firm, and a run like "B.B.B." offers one start, not
#: one per letter: that took the reviewers' worst shape from x5.3 its base to x1.3 (COST).
_SPAN_START = r"(?<![\w&./" + _CAPS_DASHES + r"])"

#: Sector and trade words. A weak lower-case form or an absorbed lead made of nothing else names an
#: industry, not a firm: "auto ancillary industries", "micro irrigation industries", "Oil & Gas
#: Industry". Closed on purpose, beside the curated vocabulary (`_is_known_trade_vocabulary`).
_SECTOR_WORDS = frozenset(
    (
        "oil", "gas", "food", "foods", "beverage", "beverages", "textile", "textiles", "garment",
        "garments", "apparel", "iron", "steel", "metal", "metals", "auto", "automobile",
        "automobiles", "automotive", "ancillary", "component", "components", "parts", "spare",
        "spares", "engineering", "mechanical", "electrical", "electronic", "electronics",
        "chemical", "chemicals", "pharma", "pharmaceutical", "pharmaceuticals", "plastic",
        "plastics", "rubber", "paper", "packaging", "glass", "cement", "construction",
        "infrastructure", "power", "energy", "solar", "mining", "logistics", "transport",
        "retail", "hospitality", "healthcare", "fmcg", "process", "processing", "heavy", "light",
        "scale", "manufacturing", "fabrication", "forging", "forgings", "casting", "castings",
        "foundry", "machining", "moulding", "molding", "tool", "tools", "precision", "agro",
        "agriculture", "agricultural", "dairy", "sugar", "paint", "paints", "printing",
        "software", "hardware", "irrigation", "micro", "aerospace", "defence", "defense",
        "marine", "shipping", "railway", "railways", "telecom", "it", "ites", "service",
        "services", "security", "facility", "facilities", "district", "public", "government",
        "sector", "allied", "core", "export", "exports", "cottage", "household", "consumer",
        "durables", "goods", "appliances", "civil",
        # facilities: "paint shop pvt ltd company", "steel plant ltd" (fourth review)
        "plant", "unit", "factory", "shop", "mill", "house", "room",
    )
)  # fmt: skip
_PHRASE_WORD_RE = re.compile(r"[a-z0-9]+")


#: The form words a lower-case span may read as name words ("automobile pvt" before "ltd"): the
#: sector check skips them, so "automobile pvt ltd company" is an industry like "automobile ltd".
_LOWER_FORM_WORD_RE = re.compile(r"(?i)\b(?:pvt|private|ltd|limited|company|co)\b\.?")


def _is_sector_words_only(text: str) -> bool:
    """True when every word of ``text`` is a sector word — the curated vocabulary does not count
    here: it holds brands ("siemens ltd", "haas ltd" are firms; fourth review)."""
    words = _PHRASE_WORD_RE.findall(text.lower())
    return bool(words) and all(word in _SECTOR_WORDS for word in words)


def _is_sector_phrase(text: str) -> bool:
    """True when every word of ``text`` is a sector word or curated trade vocabulary. FAILS
    CLOSED: no word, or any error consulting the vocabulary, reads as False — the text is a firm
    and is masked."""
    words = _PHRASE_WORD_RE.findall(text.lower())
    rest = " ".join(word for word in words if word not in _SECTOR_WORDS)
    return bool(words) and (not rest or _is_known_trade_vocabulary(rest))


def _stopword_guarded_name_word(opening: str, opening_max: int) -> str:
    """A name word of the #1892 rules: never a stopword, never holding a 7+ digit run (detail 4),
    ``opening`` (at most ``opening_max`` characters) then the capitals grammar, 64 characters in
    all, possessive (detail 5)."""
    return (
        _EMPLOYER_STOP
        + r"(?!"
        + _CAPS_NAME_WORD_CHARS
        + r"{0,"
        + str(_CAPS_NAME_WORD_MAX - 7)
        + r"}\d{7})"
        + opening
        + _CAPS_NAME_WORD_CHARS
        + r"{0,"
        + str(_CAPS_NAME_WORD_MAX - opening_max)
        + r"}+"
    )


#: A name word of ANY case: a letter, then the capitals grammar (`_CAPS_NAME_WORD_CHARS`), the same
#: 64-character possessive bound and the same 7-digit refusal (details 4 and 5). Never a stopword.
_ANY_NAME_WORD = _stopword_guarded_name_word(r"[A-Za-z]", 1)
#: The Indian parenthesised abbreviations, any case: "(P)", "(I)", "(PVT)", "(INDIA)", "(OPC)".
_JOINER_ABBREVIATION = r"\((?i:P|I|PVT|INDIA|OPC)\.?\)"
_ANY_JOINER = r"(?:&|" + _JOINER_ABBREVIATION + r")"
_ANY_NAME_WORD_THEN_JOINER = _NOT_A_JOB_WORD + _ANY_NAME_WORD + r"(?:" + _H + _ANY_JOINER + r")?"
_CO_COMPOUND_ANY_CASE = r"(?i:" + _CAPS_CO_COMPOUND + r")"
#: The double form, and its glued and abbreviated spellings: "pvt ltd", "private limited",
#: "pvt.ltd", "pvtltd", "(p)ltd".
_DOUBLE_CORPORATE_FORM = (
    r"(?i:(?:pvt\.?|private)[^\S\r\n]+(?:ltd\.?|limited)|(?:pvt\.?|\(p\))[^\S\r\n]*ltd\.?)"
)

#: Class 2 — the title-case twins of `_CORPORATE_FORM_CAPS` (same guards, compound list any case).
#: Pvt and Private only with Ltd or Limited after them: "Govt & Private Jobs" is a job preference.
#: Like the capitals rule and main's title-case rule ("Pune Tata Motors Ltd" -> "[EMPLOYER_1]"),
#: and unlike the other #1892 passes, it takes a leading city ("Pune Sharma & Co." ->
#: "[EMPLOYER_1]."): a city guard here would split title case in two ("Bombay Dyeing & Co." ->
#: "Bombay [EMPLOYER_1]." beside "Delhi Steel Pvt Ltd" -> "[EMPLOYER_1]"; second review).
_CORPORATE_FORM_TITLE = (
    r"(?:Ltd\.?|Limited|Corp\.?|Corporation|Industries|Enterprises|Llp|Llc|W\.l\.l"
    r"|(?:Pvt\.?|Private)" + _H + r"(?:Ltd\.?|Limited)"
    r"|(?:Company|Industry)(?![" + _CAPS_DASHES + r"])"
    r"|Co(?![" + _CAPS_DASHES + r"]|\.?[^\S\r\n]*" + _CO_COMPOUND_ANY_CASE + r")\.?)"
)
_TITLE_FORM_NAME_WORD_THEN_JOINER = (
    _EMPLOYER_STOP + _CAPS_NAME_WORD + r"(?:" + _H + _ANY_JOINER + r")?"
)
_EMPLOYER_TITLE_FORM_RE = re.compile(
    _SPAN_START
    + _TITLE_FORM_NAME_WORD_THEN_JOINER
    + r"(?:"
    + _H
    + _TITLE_FORM_NAME_WORD_THEN_JOINER
    + r"){0,"
    + str(_CAPS_NAME_WORDS_MAX - 1)
    + r"}"
    + _H
    + _CORPORATE_FORM_TITLE
    + r"\b"
)

#: Class 1 — forms that stay corporate in any case after ONE name word: never "limited",
#: "company", "pvt" alone.
_CORPORATE_FORM_ANY_CASE = (
    r"(?:(?i:ltd\.?|llp|llc|w\.l\.l)|"
    + _DOUBLE_CORPORATE_FORM
    # "& co" only right after the joiner, with #1875's compound guards ("fitter & co-worker").
    + r"|(?<=&[^\S\r\n])(?i:co)(?!["
    + _CAPS_DASHES
    + r"]|\.?[^\S\r\n]*"
    + _CO_COMPOUND_ANY_CASE
    + r")\.?)"
)
#: ... and forms that are ordinary nouns too ("various industries", "municipal corporation"), so
#: they need TWO OR MORE name words, and not only sector words (`replace_lower_case_firm`). "co."
#: needs its dot.
_CORPORATE_FORM_ANY_CASE_WEAK = (
    r"(?:(?i:industries|enterprises|corporation)"
    r"|(?i:co)\.(?![" + _CAPS_DASHES + r"]|[^\S\r\n]*" + _CO_COMPOUND_ANY_CASE + r"))"
)
#: A lower-case span never opens on a form word or a generic noun: "[EMPLOYER_1] pvt ltd" is a
#: trailing form to absorb, not a second firm called "pvt"; "company" may sit inside a firm
#: ("sharma company pvt ltd") but opens only generic talk ("hamari company pvt ltd hai"). Nor on a
#: city or a role word.
_LOWER_NEVER_OPENS = (
    "pvt", "private", "ltd", "limited", "llp", "llc", "company", "firm", "factory", "plant",
    "kampani", "kampni", "industries", "enterprises", "corporation", "co",
)  # fmt: skip
_NEVER_OPENS = _not_a_whole_word_from(_LOWER_NEVER_OPENS + _DEPARTMENT_WORDS)
_LOWER_SPAN_OPENER = _SPAN_START + _NOT_A_CITY + _NOT_A_ROLE_WORD + _NEVER_OPENS
_EMPLOYER_LOWER_RE = re.compile(
    _LOWER_SPAN_OPENER
    + _ANY_NAME_WORD_THEN_JOINER
    # One pass over the words; `more` records a second name word, which a weak form needs.
    + r"(?P<more>"
    + _H
    + _ANY_NAME_WORD_THEN_JOINER
    + r"(?:"
    + _H
    + _ANY_NAME_WORD_THEN_JOINER
    + r"){0,"
    + str(_CAPS_NAME_WORDS_MAX - 2)
    + r"})?(?:"
    + _H
    + r"(?P<strong>"
    + _CORPORATE_FORM_ANY_CASE
    + r")\b|(?(more)"
    + _H
    + r"(?P<weak>"
    + _CORPORATE_FORM_ANY_CASE_WEAK
    + r")(?!\w)|(?!)))"
)

#: Class 4 — five or six name words, only before a strong form (`_STRONG_CORPORATE_FORM`).
_EMPLOYER_LONG_NAME_WORDS = (5, 6)
#: The forms no one says in ordinary speech, in any case: never "limited" alone ("knowledge limited
#: hai"), never PRIVATE, COMPANY, INDUSTRY, CO.
_STRONG_CORPORATE_FORM = r"(?:" + _DOUBLE_CORPORATE_FORM + r"|(?i:ltd\.?|llp|llc))"
#: A long span holds no word where the capitals rule or the title-form pass would END: it runs AHEAD
#: of both, and such a word inside would let it start on that rule's form and leave the rule's name
#: words raw ("KRISHNA INDUSTRIES turning … pvt ltd" -> "KRISHNA [EMPLOYER_1]"; security review).
#: Their own form patterns, so a form those rules end on with a dash after it is refused as well
#: ("Hero Traders INDUSTRIES-PUNE …": the capitals rule takes "Hero Traders INDUSTRIES"; second
#: review). A lower-case form word is no earlier rule's form, so it may sit inside ("kanha krishna
#: wire and cable industries pvt ltd").
_NOT_A_CAPITALS_OR_TITLE_FORM_WORD = (
    r"(?!(?:" + _CORPORATE_FORM_CAPS + r"|" + _CORPORATE_FORM_TITLE + r")\b)"
)
#: In a long name "and" joins two name words ("… MOULDING AND PACKAGING PVT LTD") like "&" does.
_LONG_NAME_JOINER = r"(?:&|(?i:and)(?!\w)|" + _JOINER_ABBREVIATION + r")"
_LONG_NAME_WORD_THEN_JOINER = (
    _NOT_A_CAPITALS_OR_TITLE_FORM_WORD
    + _NOT_A_JOB_WORD
    + _ANY_NAME_WORD
    + r"(?:"
    + _H
    + _LONG_NAME_JOINER
    + r")?"
)
#: Where the long span's form ends: at a real word end, or before a dash or a slash, so what it
#: glues on stays outside the token ("…WORKS PVT LTD-CHAKAN" -> "[EMPLOYER_1]-CHAKAN") — unless
#: a capitals or title-case form follows within a few words, where the capitals rule takes the
#: glued word into its own span and the long span must not end inside it ("…works LTD-patil
#: MOTORS LTD", "…LTD-pune-patil MOTORS LTD", "…LTD-patil A B C & CO" — a joiner costs no word,
#: as in the capitals rule; third to fifth reviews).
_LONG_FORM_JOINER = r"(?:" + _H + _ANY_JOINER + r")?"
_LONG_FORM_END = (
    r"(?![\w&.])(?![/"
    + _CAPS_DASHES
    + r"]\S*"
    + _LONG_FORM_JOINER
    + r"(?:"
    + _H
    + r"\S+"
    + _LONG_FORM_JOINER
    + r"){0,3}"
    + _H
    + r"(?:"
    + _CORPORATE_FORM_CAPS
    + r"|"
    + _CORPORATE_FORM_TITLE
    + r")\b)"
)
_EMPLOYER_LONG_RE = re.compile(
    _SPAN_START
    + _NOT_A_CITY
    + _NOT_A_ROLE_WORD
    + _NEVER_OPENS
    + _LONG_NAME_WORD_THEN_JOINER
    + r"(?:"
    + _H
    + _LONG_NAME_WORD_THEN_JOINER
    + r"){"
    + str(_EMPLOYER_LONG_NAME_WORDS[0] - 1)
    + ","
    + str(_EMPLOYER_LONG_NAME_WORDS[1] - 1)
    + r"}"
    + _H
    + _STRONG_CORPORATE_FORM
    + _LONG_FORM_END
)

#: A placeholder this module minted for an employer.
_EMPLOYER_TOKEN = r"\[EMPLOYER_\d+\]"
_EMPLOYER_TOKEN_RE = re.compile(_EMPLOYER_TOKEN)
#: Class 3 — the M/S cue ("Messrs"), never across a line. "M / S", "M/S.", "M/S:" and "M/S:-" are
#: the same cue. "M/" right before a token is the cue whose "S" the title-case rule took as a name
#: word ("M/S Hanuman Steel Traders" -> "M/[EMPLOYER_1] Traders"). Never after a measurement — a
#: number of one to three digits or a decimal, up to three spaces before ("3 m/s submersible
#: pumps", "1.5 m/s hydraulic systems"; fourth review) — but after a year, so a résumé's dates do
#: not hide the firm ("2016-2019 M/S XYZ TRADERS", "07/2016 TO 06/2019 M/S …").
_MS_AFTER_A_MEASUREMENT = "".join(
    r"(?<!(?<!\d)\d{" + str(digits) + r"}[^\S\r\n]{" + str(spaces) + r"})"
    for digits in (1, 2, 3)
    for spaces in (1, 2, 3)
)
_MS_CUE = (
    r"(?<![\w/])(?=[Mm])" + _MS_AFTER_A_MEASUREMENT + r"[Mm][^\S\r\n]?/[^\S\r\n]?"
    r"(?:[Ss](?![\w/])\.?[^\S\r\n]*(?:[:"
    + _CAPS_DASHES
    + r"][^\S\r\n]*){0,2}|(?="
    + _EMPLOYER_TOKEN
    + r"))"
)
_MS_NAME_WORD = _stopword_guarded_name_word(r"(?:[A-Za-z]|\d{1,4}[A-Za-z])", 5)
#: An M/S name word ends at a real word end: one longer than the bound fails the match instead of
#: being cut inside a digit run (security review), and "S/S" (stainless) is not a word.
_MS_WORD_END = r"(?![\w&./" + _CAPS_DASHES + r"])"
#: Mild-steel stock, products and the work done on them: what "m/s" names in a welder's or a
#: fabricator's talk ("m/s plate", "M/S ANGLE", "m/s truck body works", "M/S WATER TANK FABRICATION
#: WORKS"). None opens an M/S firm, and none sits in front of a generic firm word
#: (`_MS_WEAK_FIRM_WORDS`, `replace_ms_firm`).
_MS_STOCK_WORDS = (
    "plate", "plates", "angle", "angles", "channel", "channels", "structure", "structures",
    "structural", "sheet", "sheets", "pipe", "pipes", "rod", "rods", "bar", "bars", "beam", "beams",
    "tube", "tubes", "flat", "flats", "round", "rounds", "section", "sections", "fabrication",
    "gate", "gates", "grill", "grills", "shed", "frame", "frames", "coil", "wire", "sariya",
    "saria", "sarya", "patti", "girder", "purlin", "jaali", "jali", "railing", "material", "door",
    "doors", "window", "windows", "trolley", "body", "tank", "tanks", "almirah", "chadar", "truss",
    "bracket", "brackets", "tmt", "scrap", "profile", "strip", "strips", "gauge", "pipeline",
    "cutter", "shutter", "shutters", "rolling", "furniture", "erection", "bending", "grinding",
    "fitting", "staircase", "flooring", "chequered", "hollow", "square", "duct", "ducting",
    "bucket", "conveyor", "floor", "mezzanine", "tray", "building", "hook", "pulley", "chain",
)  # fmt: skip
#: What "M/S" also abbreviates: MILD STEEL (`_MS_STOCK_WORDS`, its materials and processes: "M/S
#: Tig Welding") and metres per second ("m/s matlab meter per second", "speed m/s check karna").
#: None opens a firm, nor does a role word (`_ROLE_WORDS`) or a city; and a "firm" made of nothing
#: but curated trade vocabulary is left alone (`replace_ms_firm`).
_MS_NOT_A_FIRM_WORDS = _MS_STOCK_WORDS + (
    # mild-steel materials and processes, which firms are named with ("KUMAR STEEL WORKS")
    "metal", "steel", "welding", "cutting", "work", "kaam", "tig", "mig", "arc", "gas", "co2",
    "ss", "gi", "welders", "fitters", "helpers",
    # the cue named, not used ("M/S firms" in a document)
    "firm", "firms",
    # unit talk
    "unit", "units", "matlab", "means", "mean", "speed", "velocity", "per", "meter", "metre",
    "meters", "metres", "second", "seconds", "sec", "check", "rakho", "likho", "bolte", "bolo",
    "nikalo", "convert", "conversion", "formula", "value",
)  # fmt: skip
_MS_FIRST_NAME_WORD = (
    _NOT_A_CITY
    + _NOT_A_ROLE_WORD
    + _not_a_whole_word_from(_MS_NOT_A_FIRM_WORDS)
    + _MS_NAME_WORD
    + _MS_WORD_END
)
#: No city and no job word stands between the first word and the firm word — but the trade words a
#: firm is often named with may ("M/S. AMBIKA CNC WORKS", "M/S SHREE ELECTRICAL WORKS").
_MS_FOLLOWING_WORD = (
    r"(?:"
    + _EMPLOYER_TOKEN
    + r"|"
    + _NOT_A_CITY
    + _NOT_A_JOB_WORD
    + _MS_NAME_WORD
    + _MS_WORD_END
    + r")"
)
#: An M/S firm ENDS on a word that names a business (third review): "M/S SHARMA TRADERS", "m/s
#: gupta & sons", "M/S OM SAI TRANSPORT". Mild-steel talk ("m/s hollow section ka fabrication"), a
#: payer's verb and role after the firm ("M/s ABC Engineering Pvt Ltd requires CNC operators") and a
#: locality after it ("M/S SHARMA TRADERS BHOSARI") rarely reach one, so they stay raw. A role's
#: plural, not the role ("fabricators", not "fabricator"). A dash may follow the word,
#: and what it glues on stays outside the token ("M/S SHARMA TRADERS-BHOSARI" -> "M/S
#: [EMPLOYER_1]-BHOSARI"), except after "co" ("co-worker").
_MS_STRONG_FIRM_WORDS = (
    "traders", "trader", "trading", "fabricators", "engineers", "enterprises", "enterprise",
    "industries", "udyog", "transport", "transports", "logistics", "roadways", "roadlines",
    "carriers", "movers", "travels", "contractors", "builders", "developers", "associates",
    "agency", "agencies", "consultants", "consultancy", "company", "corporation", "corp", "sons",
    "brothers", "bros", "motors", "automobiles", "castings", "forgings", "mills", "suppliers",
    "steels", "alloys", "exports", "impex", "international", "overseas", "stores", "moulders",
    "paints", "packers", "printers", "erectors", "manpower", "ltd", "limited", "llp", "llc",
)  # fmt: skip
#: ... and the generic nouns that also end trade talk ("m/s truck body works", "m/s power tools",
#: "m/s auto parts welding"): a firm ending on one is left raw when a name word is mild-steel
#: stock, or when the firm is in lower case and every name word is a sector word (`replace_ms_firm`,
#: `_is_ms_trade_talk`; fourth review). Title Case and CAPITALS keep it a firm: "M/s Precision
#: Components", "M/S SHREE SAI ENGINEERING WORKS".
_MS_WEAK_FIRM_WORDS = frozenset(
    (
        "works", "workshop", "engineering", "engg", "construction", "constructions", "projects",
        "services", "solutions", "group", "systems", "technologies", "tech", "tools", "dies",
        "parts", "components", "products", "metals", "electricals", "electronics", "plastics",
        "polymers", "textiles", "garments", "foods", "chemicals", "garage", "hydraulics",
        "pneumatics", "packaging", "centre", "center", "fab", "automation", "controls",
        "instruments", "equipments", "machinery", "pumps", "valves", "fasteners", "springs",
        "contractor", "infra",
    )
)  # fmt: skip
_MS_FIRM_WORD = (
    r"(?:(?i:"
    + _alternation_trie(_MS_STRONG_FIRM_WORDS + tuple(sorted(_MS_WEAK_FIRM_WORDS)))
    + r")\.?(?![\w&./])|(?i:co)\.?(?![\w&./"
    + _CAPS_DASHES
    + r"]))"
)
_EMPLOYER_MS_CUE_RE = re.compile(
    _MS_CUE
    + r"("
    # A firm an earlier rule masked takes only a firm word right after its token ("M/[EMPLOYER_1]
    # Traders", "M/s. [EMPLOYER_1] & Dies"), never words past it ("M/S TATA MOTORS LTD SPARE
    # PARTS"; fourth review).
    + _EMPLOYER_TOKEN
    + r"(?:"
    + _H
    + _ANY_JOINER
    + r")?"
    + _H
    + _MS_FIRM_WORD
    + r"|"
    + _MS_FIRST_NAME_WORD
    + r"(?:"
    + _H
    + _ANY_JOINER
    + r")?(?:"
    + _H
    + _MS_FOLLOWING_WORD
    + r"(?:"
    + _H
    + _ANY_JOINER
    + r")?){0,"
    + str(_CAPS_NAME_WORDS_MAX - 1)
    + r"}"
    + _H
    + _MS_FIRM_WORD
    + r")"
)
_MS_FIRM_TEXT_WORD_RE = re.compile(r"[A-Za-z0-9]+")


def _is_ms_trade_talk(firm: str) -> bool:
    """True when an M/S "firm" ending on a generic firm word is trade talk (`_MS_WEAK_FIRM_WORDS`):
    a name word is mild-steel stock ("m/s truck body works"; "fabrication" names firms too, "m/s
    nandi fabrication works"), or the firm is in lower case and every name word is a sector word
    ("m/s power tools", "m/s civil engineering")."""
    words = [word.lower() for word in _MS_FIRM_TEXT_WORD_RE.findall(firm)]
    if len(words) < 2 or words[-1] not in _MS_WEAK_FIRM_WORDS:
        return False
    names = words[:-1]
    if any(word in _MS_STOCK_WORDS and word != "fabrication" for word in names):
        return True
    return firm == firm.lower() and all(word in _SECTOR_WORDS for word in names)


#: What separates an absorbed lead from the token: a joiner or a dash.
_ABSORB_LEAD_SEPARATOR_RE = re.compile(_ANY_JOINER + r"|[" + _CAPS_DASHES + r"]")
#: Class 2 — the corporate form left beside a token ("[EMPLOYER_1] LTD", "[EMPLOYER_1] industries
#: pvt ltd"), any case; and the name word left in front of a joiner ("Larsen & [EMPLOYER_1]").
_TRAILING_CORPORATE_FORM = (
    r"(?:(?i:ltd\.?|limited|llp|llc|w\.l\.l|corp\.?|corporation|industries|enterprises)\b|"
    + _DOUBLE_CORPORATE_FORM
    + r"\b|(?i:co)\.(?!\w))"
)
_EMPLOYER_ABSORB_TRAIL = (
    r"(?:" + _H + r"(?:" + _ANY_JOINER + _H + r")?" + _TRAILING_CORPORATE_FORM + r")"
)
#: The name word the title-case rule left in front of its match, where #1875's capitals grammar
#: would have taken it. Never a stopword ("Hiring Fitter & …", "3 YRS & …") and never a city.
_ABSORB_LEAD_WORD = _NOT_A_CITY + _EMPLOYER_STOP + _CAPS_NAME_WORD
#: Detail 4 for the dash-glued lead, which cannot use `_CAPS_NAME_WORD` (whose class holds the
#: dash): a word holding a 7+ digit run is never absorbed, or "AB12345678-[EMPLOYER_1]" — which
#: main BLOCKS on the residual-digit net — would fold its digits into the token and pass.
_NO_SEVEN_DIGIT_RUN = r"(?![\w&.]{0," + str(_CAPS_NAME_WORD_MAX - 7) + r"}\d{7})"
#: A duration, a class or an amount is not a digit-led name: "3Yrs", "10Th", "15K".
_NOT_A_DURATION = r"(?!\d{1,4}(?i:yrs?|years?|months?|th|st|nd|rd|k|lpa)\b)"
_EMPLOYER_ABSORB_LEAD = (
    # Every lead opens on a capital or a digit; the lookahead skips the other word starts cheaply.
    _SPAN_START
    + r"(?=[A-Z\d])(?:"
    # one or two name words, then a joiner: "Larsen & [EMPLOYER_1]", "Shah Sharma & [EMPLOYER_1]"
    + r"(?:"
    + _ABSORB_LEAD_WORD
    + _H
    + r")?"
    + _ABSORB_LEAD_WORD
    + _H
    + _ANY_JOINER
    + _H
    # a digit-led name word: "3M [EMPLOYER_1]", "4S [EMPLOYER_1]" (with detail 4's refusal)
    + r"|(?=\d{1,4}[A-Z])"
    + _NOT_A_DURATION
    + _EMPLOYER_STOP
    + _CAPS_NAME_WORD
    + _H
    # a name word glued on by a dash: "Hero-[EMPLOYER_1]", "Kalyani-[EMPLOYER_1]"
    + r"|"
    + _NOT_A_CITY
    + _EMPLOYER_STOP
    + _NO_SEVEN_DIGIT_RUN
    + r"[A-Z][\w&.]{0,"
    + str(_CAPS_NAME_WORD_MAX - 1)
    + r"}+["
    + _CAPS_DASHES
    + r"])"
)
_EMPLOYER_ABSORB_RE = re.compile(
    r"(?:"
    + _EMPLOYER_ABSORB_LEAD
    + _EMPLOYER_TOKEN
    + _EMPLOYER_ABSORB_TRAIL
    + r"*|"
    + _EMPLOYER_TOKEN
    + _EMPLOYER_ABSORB_TRAIL
    + r"+)"
)
#: A GATE per #1892 rule: a cheap pattern that matches somewhere in every text the rule can match
#: in, so a text it misses skips the rule outright. Each is the rule's own mandatory piece, so a
#: gate never changes an output; it only spares the per-word stopword checks on the many lines
#: that hold no corporate form, M/S cue or employer token. Keyed by the IDENTITY of the shipped
#: pattern (hashing a `re.Pattern` hashes its whole compiled program, ~8 us a call for these), and
#: the entry holds the pattern itself so its id cannot be reused; a test that swaps a rule for
#: another pattern runs that pattern ungated.
_RULE_GATES: dict[int, tuple[re.Pattern[str], re.Pattern[str]]] = {
    id(rule): (rule, gate)
    for rule, gate in (
        # The rule's own form with its word end, so "Co" inside "Computer" does not open it.
        (_EMPLOYER_LONG_RE, re.compile(_STRONG_CORPORATE_FORM + r"\b")),
        (_EMPLOYER_TITLE_FORM_RE, re.compile(_CORPORATE_FORM_TITLE + r"\b")),
        # A flat literal set every lower-case form contains, any case: far cheaper to scan than
        # the forms themselves (no lookbehind, no compound guard), and still a necessary condition.
        (
            _EMPLOYER_LOWER_RE,
            re.compile(
                r"(?i:ltd|llp|llc|w\.l\.l|limited|industries|enterprises|corporation"
                r"|&[^\S\r\n]co|co\.)"
            ),
        ),
        (_EMPLOYER_MS_CUE_RE, re.compile(r"[Mm][^\S\r\n]?/")),
        (_EMPLOYER_ABSORB_RE, _EMPLOYER_TOKEN_RE),
    )
}


def _gate_is_shut(regex: re.Pattern[str], text: str) -> bool:
    """True when ``regex`` is a gated #1892 rule whose gate finds nothing in ``text``."""
    entry = _RULE_GATES.get(id(regex))
    return entry is not None and entry[0] is regex and entry[1].search(text) is None


_NAME_CUE_RE = re.compile(
    r"(?i:\bmy name is\b|\bmyself\b|\bi am\b|\bi'm\b|\bthis is\b|\bname is\b|"
    r"\bmera naam\b|\bnaam\b)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)"
)
# #1738 — the label's start as a READER sees it. `^\s*` used to be the only thing allowed in front
# of the word, so a bullet, a quote, a dash or a list number ("• Ramesh, welding", "1. Ramesh,
# welding") switched the whole rule off — and with it the #1730 closed-vocabulary check that
# `is_certified_clean` reads through this same regex. `[\W_]*` skips any run of non-word
# characters, and one short list number may sit inside it; digits otherwise still stop the match,
# so "10 Welders, urgent" is not read as a name. After the word, anything that is neither a word
# character nor the comma itself may precede the comma ('"Ramesh", welding').
#
# Invisible format characters and Latin combining marks are not handled here: `pseudonymize`
# removes them from the whole text first (`_normalised_view`), so this regex never sees them.
_LEADING_NAME_RE = re.compile(r"^[\W_]*(?:\d{1,2}[.)][\W_]*)?([A-Z][a-z]+)[^\w,]*,")
# The shortest leading word the trade-vocabulary carve-out may release (issue #1728, owner
# ruling 2026-09-25; see `replace_leading_name`). The curated vocabulary holds 3-letter tokens
# that ALSO read as names in a leading position — "Max", "Mag", "Arc", "Gas", "Cam", "Oxy" —
# and "Max, welder" is exactly the shape the no-cue guess exists to catch, so below this floor
# the guess still wins. That is the RULED TRADE-OFF, and it has a real cost, stated here so
# nobody reads the floor as free: an all-caps acronym ("CNC", "ITI", "VMC") never matches
# `[A-Z][a-z]+`, but phone keyboards title-case the first letter of a message, so the natural
# shapes "Cnc, vmc", "Iti, fitter", "Mig, tig welding", "Vmc, hmc operator" and "Cmm, vernier"
# DO match — and at 3 letters they stay masked as [PERSON_1]. #1728 is not fixed for them.
# Releasing them is an owner decision (e.g. a narrow acronym list kept apart from name-like
# tokens such as max / mag / arc / gas / cam / oxy), not a floor to lower quietly; the residual
# is pinned by `test_KNOWN_RESIDUAL_a_title_cased_3_letter_trade_acronym_is_still_masked`.
_LEADING_VOCABULARY_MIN_LEN = 4
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
#
# THE CUE-TO-VALUE CONNECTOR IS LINEAR (issue #1933, risks-register R54). It was
# `\s*(?:no\.?|number|num|#)?\s*[:\-]?\s*`: three whitespace quantifiers with only optional
# tokens between them. On a cue followed by a whitespace run that then fails the digit
# lookahead, every split of the run among the three was tried, which is O(k^3) in the run.
# `pseudonymize("reg" + " " * 800 + "!")` took 1.6-6.0 s (2026-10-03), far under the size cap,
# inline in `async def`, whatever `AI_RAW_PII_ENABLED` says (the walls, the at-rest copies and
# the embedding input all run this rule). Each whitespace quantifier is now folded into the
# optional token it FOLLOWS: `\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:\-]\s*)?`. That is linear,
# because the "no" word and the separator never start with whitespace, so after the leading
# `\s*` there is exactly one way to read a run. IT MATCHES THE SAME SPANS ON EVERY INPUT, not
# only on realistic ones: the two forms accept the same strings, and in priority order they
# try the same value starts first, the old form only adding repeats of starts it had already
# tried (or starts on whitespace, which the value can never take). Measured over the repo
# corpus and a seeded fuzz of cue lines: 0 span differences on this rule, `_RESUME_CUED_ID_RE`
# and the salary guard's copy (`tests/test_pseudonymize_cued_id_linear.py`,
# `scripts/measure_cued_id_linear.py`). No possessive quantifier, so the TypeScript ports in
# `apps/api` and the lexicon's `credentialBefore` carry the same text.
#
# A DOT AFTER THE CUE AND A ":-" SEPARATOR ARE READ (issue #1950, risks-register R56). The
# connector had no token that starts with ".", the separator was one character, and "regn" was no
# cue, so the common certificate spellings "Reg.No.:- <id>", "Regn. No. <id>" and "Roll.No-<id>"
# never reached their value: the ID stayed raw, G1/G2 admitted it under both postures, and the
# salary guard let its digits through as pay. "reg no:- <id>" missed for the separator alone.
# Three additive tokens, all outside the whitespace structure above: `\.?` straight after the cue
# word (the abbreviation dot, so "Reg." reads exactly as "Reg"), "regn" among the cues, and `-?`
# after the separator (":-" and "--" read as ":" and "-"). None of them is whitespace and each is
# followed by a different class, so a run still has one reading and the rule stays linear. The
# accepted language is a superset, so every VERDICT only grows: a G1/G2 refusal, a certifier
# refusal or a salary-guard drop is never lost. The masked TEXT grows per cue, but not across
# cues: `sub` is non-overlapping and this rule runs before the phone rule, so a newly read dotted
# cue's value can swallow a later cue glued on by "/" or "-" ("Cert. NAPS/2020/reg: 445566" leaves
# 445566 raw) or the first group of a spaced phone ("Licence. 098765 43210"). The same happens on
# the undotted spelling, on PRE and here alike; the walls still refuse both. Risks-register R62.
# Over the repo corpus (#1875's method, `scripts/measure_cued_id_dot.py`) no string changes; the
# dot is transparent by construction, so a number written straight after "cert." masks or is
# dropped as pay exactly as it was after "cert". The test file
# `tests/test_pseudonymize_cued_id_dot.py` pins the shapes, the near misses and the measurement.
# "Reg . No" (a SPACED dot), "Num.", "No: -", an en dash, "No #" and "No.=" are still not read;
# see the doc.
_CREDENTIAL_ID_LOOKAHEAD_MAX = 64
_CREDENTIAL_ID_RE = re.compile(
    r"(?i:\b(?:roll|reg|regd|regn|registration|certificate|cert|enrol(?:l)?ment|licence|license)"
    r"\b\.?"
    r"(?:\s+(?:ka|ki|ke|mera|meri))?"
    r"\s*(?:(?:no\.?|number|num|#)\s*)?(?:[:\-]-?\s*)?)"
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


class TokenScope:
    """One request's placeholder numbering, shareable across several ``pseudonymize`` calls.

    THE DEFAULT IS UNCHANGED: ``pseudonymize(text)`` creates a fresh scope per call, so every
    existing caller gets exactly the per-call numbering it always had. A caller passes ONE scope
    to several calls only when the model must correlate entities across separately masked
    strings — the companion edit parser (ADR-0046), which masks the worker's message and each
    stored value one by one. With a scope per value, "Tata Motors Ltd" and "Bajaj Auto Ltd" both
    came out ``[EMPLOYER_1]``, and the message's ``[EMPLOYER_1]`` matched every employment row.
    With one scope, the same original gets the same token everywhere in the request and two
    different originals never share one. The token grammar (``[PREFIX_n]``) does not change.

    ONLY THE EGRESSED PASS USES IT. ``pseudonymize`` threads the scope into the READER-view pass
    (the text it returns); the #1738 spaced-view pass is a detector that never egresses and keeps
    its own private numbering, exactly as before.

    IT HOLDS NO ORIGINAL TEXT. The registry is keyed by a keyed BLAKE2b MAC of the normalised
    original under a random per-scope key, never by the original itself, so a scope that is
    logged, captured in a trace or kept alive by accident carries no PII — and the same employer
    digests differently in two scopes, so nothing correlates across requests. It cannot be
    pickled or copied, and it has no accessor: the original<->token mapping is still never
    persisted or returned (design rule above). A scope lives for one request and is discarded.
    """

    __slots__ = ("_key", "_tokens", "_counters")

    def __init__(self) -> None:
        self._key: bytes | None = None
        self._tokens: dict[tuple[str, bytes], str] = {}
        self._counters: dict[str, int] = {}

    def token_for(self, original: str, prefix: str) -> str:
        """The placeholder for ``original`` in this scope, minting the next number on first use.

        Equality is on ``original.strip().lower()`` per prefix — byte-for-byte the rule the
        per-call registry always applied.
        """
        if self._key is None:
            self._key = secrets.token_bytes(32)
        # Keyed BLAKE2b is a MAC in one native call. This runs on every gateway call, not only
        # the ones that share a scope. Measured against the plain dict registry it replaced
        # (2026-09-30, on the #1786 gateway): ~+3 us on a typical 4-token line (~22 -> ~25 us)
        # and +10-20% on a 1000-token 18.9k-char input; `hmac.new` had cost ~+20 us per line.
        digest = hashlib.blake2b(
            original.strip().lower().encode("utf-8"), key=self._key, digest_size=32
        ).digest()
        key = (prefix, digest)
        existing = self._tokens.get(key)
        if existing is not None:
            return existing
        self._counters[prefix] = self._counters.get(prefix, 0) + 1
        token = f"[{prefix}_{self._counters[prefix]}]"
        self._tokens[key] = token
        return token

    def __repr__(self) -> str:
        return f"TokenScope(tokens={len(self._tokens)})"

    def __reduce__(self):
        # Pickling and copy/deepcopy all route through here: refused, so a scope can never be
        # written anywhere or outlive the request by being cloned into longer-lived state.
        raise TypeError("TokenScope is request-scoped and cannot be serialized or copied")


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


# The combining-mark blocks that decorate LATIN letters: Combining Diacritical Marks and its
# extension and supplement, the symbol marks and the half marks. Devanagari's own vowel signs,
# nukta and virama live inside U+0900-U+097F and are never touched.
_LATIN_COMBINING_BLOCKS = (
    (0x0300, 0x036F),
    (0x1AB0, 0x1AFF),
    (0x1DC0, 0x1DFF),
    (0x20D0, 0x20FF),
    (0xFE20, 0xFE2F),
)
_JOINERS = frozenset({"\u200c", "\u200d"})  # ZWNJ, ZWJ


def _is_devanagari(ch: str) -> bool:
    return "\u0900" <= ch <= "\u097f"


class _View:
    """One normalisation of the input plus, per emitted character, the SOURCE index (offset in
    the original ``text``) it came from. ``src[i]`` is the source offset of ``text[i]``."""

    __slots__ = ("text", "src")

    def __init__(self, text: str, src: list[int]) -> None:
        self.text = text
        self.src = src


def _build_views(text: str) -> tuple[_View, _View]:
    """``(reader, spaced)`` computed in ONE pass over the characters (#1738 F1).

    Each view carries a SOURCE-index map (``_View.src``): for every character it emits, the
    offset of the original-``text`` character it came from. ``pseudonymize`` reconciles the two
    passes by SOURCE offset, never by string content (a global content compare is unsound - a
    concealed name whose text is a substring of a DIFFERENT co-masked token would look covered).

    ``reader`` is the view every rule runs on and the gateway returns - exactly the
    normalisation ``_normalised_view`` documents: a Unicode FORMAT character (category Cf) or a
    Latin-block combining mark is DELETED, fullwidth letters and digits are folded to ASCII, and
    a ZWJ / ZWNJ right after a Devanagari character (a conjunct shaper, part of the word) is kept.

    ``spaced`` is identical EXCEPT that each character ``reader`` DELETES becomes a single SPACE
    that maps to the REMOVED character's source offset. Folding and the Devanagari-joiner
    exception are the same in both.

    Why two views. Deleting an invisible character also deletes the WORD BOUNDARY it stood for:
    when an invisible is the ONLY separator between two tokens ("Mera<ZWSP>naam Ramesh"), the
    reader view merges them ("Meranaam Ramesh") and a ``\\b``-anchored rule stops firing, so PII
    the reader view no longer masks would egress. The spaced view keeps that boundary, so
    ``pseudonymize`` can mask both and fail closed when the spaced view masks identity over source
    offsets the reader view did not.
    """
    if text.isascii():
        idx = list(range(len(text)))
        return _View(text, idx), _View(text, list(idx))
    reader: list[str] = []
    reader_src: list[int] = []
    spaced: list[str] = []
    spaced_src: list[int] = []
    for i, ch in enumerate(text):
        code = ord(ch)
        if 0xFF10 <= code <= 0xFF19 or 0xFF21 <= code <= 0xFF3A or 0xFF41 <= code <= 0xFF5A:
            folded = chr(code - 0xFEE0)
            reader.append(folded)
            reader_src.append(i)
            spaced.append(folded)
            spaced_src.append(i)
            continue
        category = unicodedata.category(ch)
        if category == "Cf":
            if ch in _JOINERS and reader and _is_devanagari(reader[-1]):
                reader.append(ch)
                reader_src.append(i)
                spaced.append(ch)
                spaced_src.append(i)
            else:
                spaced.append(" ")  # DELETED in the reader view, a SPACE (same source) in spaced
                spaced_src.append(i)
            continue
        if category in ("Mn", "Me") and any(lo <= code <= hi for lo, hi in _LATIN_COMBINING_BLOCKS):
            spaced.append(" ")
            spaced_src.append(i)
            continue
        reader.append(ch)
        reader_src.append(i)
        spaced.append(ch)
        spaced_src.append(i)
    return _View("".join(reader), reader_src), _View("".join(spaced), spaced_src)


#: Fail-closed reason for the #1738 F1 path. PII-FREE by construction - it names the
#: CLASS of bypass, never the input that tripped it.
_INVISIBLE_BYPASS_REASON = "invisible or combining characters concealed an identity token"


def _is_covered(region: set[int], reader_masked: set[int], reader_kept: set[int]) -> bool:
    """Whether the reader pass masked a spaced-view ``region`` (#1738 F1, CONTAINMENT per #1890).

    Covered means every offset of ``region`` that the reader view KEPT (``reader_kept``, the source
    offsets of the reader view's characters) lies inside a reader mask (``reader_masked``).
    The offsets the reader view DELETED (the invisibles, a space in the spaced view) are exempt:
    a phone split by an invisible masks the same digits in both views, but its spaced span also
    holds the separator, which no reader mask can hold. Mere OVERLAP is not enough (R49): in
    "my name is<ZWSP>Ramesh Kumar Steel" the reader view merges "isRamesh", masks only "Kumar
    Steel", and the spaced view's "Ramesh Kumar" overlaps it on "Kumar" while "Ramesh" egresses.

    The region must ALSO overlap a reader mask, as before #1890, so a region of deleted offsets
    alone still blocks: this check only ever blocks MORE than the overlap check it replaced.
    """
    return bool(region & reader_masked) and (region & reader_kept) <= reader_masked


def _apply(
    regex: re.Pattern[str],
    replace: Callable[[re.Match[str]], str],
    masked_group: int,
    text: str,
    src: list[int | None],
    regions: list[set[int]],
) -> tuple[str, list[int | None]]:
    """Run one masking rule, byte-for-byte like ``regex.sub(replace, text)``, while recording which
    SOURCE offsets each mask covered.

    Rebuilds ``text`` and a parallel source-index list (a masked token's characters map to
    ``None``). When a match actually masks (its replacement differs from the matched text), the
    set of source offsets under group ``masked_group`` - group 1 for the cue/leading/credential
    rules that keep a cue and tokenise only the value, group 0 for the whole-match rules - is
    appended to ``regions`` as ONE region. Keeping regions per-match (not one flat set) is what
    lets the caller judge each spaced-view region on its own (``_is_covered``): a phone split by
    an invisible masks the same digits in both views, but its spaced span also covers the
    separator's source offset, so the two spans are not equal - yet every offset the reader view
    kept is reader-masked, which is coverage. Matches are non-overlapping and left-to-right,
    exactly as ``re.sub`` scans.
    """
    out: list[str] = []
    out_src: list[int | None] = []
    pos = 0
    for match in regex.finditer(text):
        start, end = match.span(0)
        out.append(text[pos:start])
        out_src.extend(src[pos:start])
        replacement = replace(match)
        out.append(replacement)
        if replacement == match.group(0):
            # A callback that VETOES (returns the match as it is) masked nothing: the characters
            # keep their source offsets, so a later rule that masks them records its region (#1892
            # fourth review — with Nones here, the spaced view's later mask went unrecorded and an
            # invisible could hide a firm the visible text masks).
            out_src.extend(src[start:end])
            pos = end
            continue
        out_src.extend([None] * len(replacement))
        group_start, group_end = match.span(masked_group)
        region = {src[i] for i in range(group_start, group_end) if src[i] is not None}
        if region:
            regions.append(region)
        pos = end
    out.append(text[pos:])
    out_src.extend(src[pos:])
    return "".join(out), out_src


def _normalised_view(text: str) -> str:
    """``text`` as a READER sees it — the one view every rule below runs on (#1738).

    THE BYPASS. Every identity rule here is written against visible characters. An invisible
    format character or a combining mark in the right place switched rules off without changing
    what a reader sees: "\\u200bRamesh, welding" and "Ramesh\\u0301, welding" were not masked,
    "my name is \\u200bRamesh" slipped the cue rule, "mera naam Ra\\u200bmesh" masked only
    "Ra", and a released leading city could not see "Pu\\u200bne". Each of those also passed
    the clean-or-withhold certification, which reads this gateway's output.

    WHAT IS REMOVED, AND WHY IT IS SAFE:
      - every Unicode FORMAT character (category Cf): zero-width space, BOM, soft hyphen, bidi
        controls, word joiner, tag characters. None of them is visible text. The one exception
        is a ZWJ / ZWNJ right after a Devanagari character, where it shapes a conjunct and is
        part of the word; it cannot hide a Latin name, which is all the name rules read.
      - a COMBINING MARK from the Latin blocks above. Devanagari's vowel signs are marks too, but
        from its own block, so Hindi text is untouched.
      - FULLWIDTH LETTERS AND DIGITS are folded to ASCII ("Ｒａｍｅｓｈ" reads as "Ramesh"), so the
        same rules see them. Fullwidth PUNCTUATION is left alone: the phone rule deliberately
        accepts "：" as a separator while it excludes the ASCII ":", and folding one into the
        other would unmask "98765：43210".

    FAIL-CLOSED BY CONSTRUCTION FOR THE CERTIFIERS. A label containing any of these comes back
    ALTERED, and `is_certified_clean` / `certify_value` / `certified_clean_skill_labels` withhold
    any label the gateway altered. A label is never certified on a view it does not match.

    This is the READER view of ``_build_views`` (the spaced view lives there too); the char
    logic is kept in one place so the two views can never drift.
    """
    return _build_views(text)[0]


def _mask(
    view: _View, track: bool = False, scope: TokenScope | None = None
) -> tuple[PseudonymizationResult, list[set[int]]]:
    """Run every identity rule over ``view`` with a PRIVATE registry and token counter.

    Pure over ``view``: it owns its registry, counters and token list, so nothing it does
    is visible to another call. That is what lets ``pseudonymize`` run it TWICE (#1738 F1) -
    once on the reader view it returns, once on a view where each removed invisible became a
    space - without the two passes sharing tokens. The one exception is a caller's ``scope``
    (see :class:`TokenScope`), which ``pseudonymize`` passes to the READER pass only, so the
    numbering it egresses is shared across the request while the detector pass stays private.

    When ``track`` is True, returns a list of masked REGIONS - one per masking match, each the set
    of SOURCE offsets (indices into the original ``text``) that match covered - so ``pseudonymize``
    can reconcile the two views by position, never by string content: a concealed name is judged
    covered only when reader-pass regions CONTAIN every source offset of it the reader view kept
    (``_is_covered``, #1890). When ``track`` is False the
    output text is byte-identical but no regions are recorded (the fast ``regex.sub`` path, taken
    for the common case where the two views coincide). The original<->token mapping never leaves.
    """
    tokens = scope if scope is not None else TokenScope()
    tokens_used: list[str] = []
    # A set beside the ordered list: a 20k-char input can carry thousands of tokens, and a
    # list membership scan per token would make masking quadratic in them.
    tokens_seen: set[str] = set()
    regions: list[set[int]] = []

    def token_for(original: str, prefix: str) -> str:
        tok = tokens.token_for(original, prefix)
        # Per-call bookkeeping. With a fresh scope a token is new exactly when it is not yet
        # in this list, so this is the old append-on-mint rule; with a shared scope it also
        # records a token this text REUSED from an earlier call in the same request.
        if tok not in tokens_seen:
            tokens_seen.add(tok)
            tokens_used.append(tok)
        return tok

    def replace_group1(match: re.Match[str], prefix: str) -> str:
        """Replace only capture group 1 inside the full match (keeps the cue)."""
        name = match.group(1)
        if name.strip().lower() in _NAME_STOPLIST:
            return match.group(0)
        return match.group(0).replace(name, token_for(name, prefix))

    def replace_leading_name(match: re.Match[str]) -> str:
        """The leading-name heuristic, with two carve-outs: a city, and a trade word.

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

        A TRADE WORD IS NOT A NAME EITHER (issue #1728, owner ruling 2026-09-25). The same
        guess masked ordinary vocabulary that opens a list. Measured before this carve-out:

            pseudonymize("Welding, grinding").text   -> "[PERSON_1], grinding"
            pseudonymize("Fanuc, tool offset").text  -> "[PERSON_1], tool offset"

        On the payer side the job-posting chat then stored the masked text, so the skills
        answer on the draft lost the trade; on the worker side the model saw [PERSON_1]
        instead of the trade the worker named. So a leading word that the ONE curated
        trade/education vocabulary positively recognises (``_is_known_trade_vocabulary``,
        the set pinned by checksum in tests/test_lexicon_parity.py) is kept — but only at
        ``_LEADING_VOCABULARY_MIN_LEN``+ characters, because the 3-letter vocabulary tokens
        ("Max", "Arc", "Gas") are exactly the shape this guess exists for. The vocabulary
        check FAILS CLOSED: any error consulting it returns False and the word is masked.

        THE RELEASE IS THE LEADING WORD, NOT THE STRING. A consumer that passes a string raw
        when this function masked nothing ("clean or withhold") would otherwise release
        whatever follows the kept word — "Welding, Anil Kumar" used to mint an incidental
        [PERSON_1] and be withheld whole. `is_certified_clean` closes that: it reads the SAME
        regex and the SAME predicate (`_is_leading_trade_word`) to tell that the vocabulary
        carve-out released the word, and then requires the WHOLE label to be vocabulary.

        What neither carve-out does: the cue-based rule keeps its own replacer untouched.
        "Mera naam X" is explicit evidence of a name and stays masked whatever X is — a
        city, a trade word, anything; only the no-cue guess defers. Employers, phones,
        emails, ID tokens and the residual-digit net are not consulted and do not move. It
        is also not a route, flag or principal exemption (ADR-0035 §2/§3): the rule is the
        same for a worker's turn and a payer's.
        """
        candidate = _leading_candidate(match)
        if _is_leading_city(candidate) or _is_leading_trade_word(candidate):
            return match.group(0)
        return replace_group1(match, "PERSON")

    def replace_credential(match: re.Match[str]) -> str:
        """Keep the roll/registration cue, tokenise only the id (group 1). Its own replacer, not
        `replace_group1`: the NAME stoplist has no business vetoing an ID mask."""
        return match.group(0).replace(match.group(1), token_for(match.group(1), "ID"))

    def replace_ms_firm(match: re.Match[str]) -> str:
        """Keep the M/S cue, tokenise the firm after it (group 1, which ends the match).

        A firm an earlier rule half-masked ("M/[EMPLOYER_1] Traders") keeps that token and takes
        the firm word right after it (a joiner may come between) into it, minting nothing; name
        words between stay raw, as on main ("M/[EMPLOYER_1] Om Sai Traders"). Two tokens under one
        cue are left as they are: folding them would drop a minted token from the text. A "firm"
        made of nothing but curated trade vocabulary is a skill, not a firm ("M/S PIPING
        SYSTEMS", "M/S TOOL TECH"): the match is left as it is, so no region is recorded for it,
        and "M/S <label>" certifies as the label does. A sector word is not enough ("M/s
        Precision Components" is a firm)."""
        tokens = _EMPLOYER_TOKEN_RE.findall(match.group(1))
        if len(tokens) > 1:
            return match.group(0)
        if not tokens and (
            _is_known_trade_vocabulary(match.group(1)) or _is_ms_trade_talk(match.group(1))
        ):
            return match.group(0)
        firm = tokens[0] if tokens else token_for(match.group(1), "EMPLOYER")
        return match.group(0)[: match.start(1) - match.start(0)] + firm

    def absorb_into_employer(match: re.Match[str]) -> str:
        """Fold a trailing corporate form, or a name word before a joiner, into the token beside
        it. Mints nothing. A lead of trade or sector words ("Welding & [EMPLOYER_1]", "Oil &
        [EMPLOYER_1]") is a skill or an industry, not a name: the whole match is left as it is,
        so no region is recorded for it."""
        token = _EMPLOYER_TOKEN_RE.search(match.group(0))
        assert token is not None  # both alternatives of the regex contain one
        lead = _ABSORB_LEAD_SEPARATOR_RE.sub(" ", match.group(0)[: token.start()]).strip()
        if lead and _is_sector_phrase(lead):
            return match.group(0)
        return token.group(0)

    def replace_lower_case_firm(match: re.Match[str]) -> str:
        """Tokenise a lower-case firm, unless its name words name a kind of company: before a weak
        form every one a sector word or curated vocabulary ("auto ancillary industries", "water
        tech industries"), before a strong form every one a sector word ("automobile pvt ltd
        company me job chahiye"; a brand is a firm: "siemens ltd"), or a lone generic adjective
        ("korean pvt ltd company"). Left as it is, with its source offsets (`_apply`)."""
        weak = match.start("weak")
        form = weak if weak != -1 else match.start("strong")
        name = _LOWER_FORM_WORD_RE.sub(" ", match.string[match.start() : form])
        words = _PHRASE_WORD_RE.findall(name.lower())
        generic = _is_sector_phrase(name) if weak != -1 else _is_sector_words_only(name)
        if generic or (len(words) == 1 and words[0] in _GENERIC_ADJECTIVES):
            return match.group(0)
        return token_for(match.group(0), "EMPLOYER")

    # Each rule as (regex, replacement callback, group whose SPAN is the masked value): group 0
    # for the whole-match rules, group 1 for the cue/leading/credential rules that keep a cue
    # and tokenise only the value. `_apply` runs them exactly like `regex.sub`, in this order,
    # while recording the SOURCE offsets each mask actually covered. The ORDER is load-bearing
    # (email first; ids before phone; phone before money; the capitals employer rule after both
    # name rules — see the module notes and `_CORPORATE_FORM_CAPS` detail 1).
    rules: list[tuple[re.Pattern[str], Callable[[re.Match[str]], str], int]] = [
        # 0. EMAIL FIRST — the only COMPOSITE pattern (name in the local part, employer in the
        #    domain, sometimes a phone). A rule ahead of it fragments the address. See `_EMAIL_RE`.
        (_EMAIL_RE, lambda m: token_for(m.group(0), "EMAIL"), 0),
        # 1. ID-like tokens (PAN, Aadhaar, cued credential IDs) so phone matching doesn't eat them.
        (_PAN_RE, lambda m: token_for(m.group(0), "ID"), 0),
        (_AADHAAR_RE, lambda m: token_for(m.group(0), "ID"), 0),
        #    The credential replacer keeps the cue and tokenises group 1.
        (_CREDENTIAL_ID_RE, replace_credential, 1),
        # 2. Phone numbers.
        (_PHONE_RE, lambda m: token_for(m.group(0), "PHONE"), 0),
        # 3. Employers / companies (title case; the capitals rule is 4b below).
        (_EMPLOYER_RE, lambda m: token_for(m.group(0), "EMPLOYER"), 0),
        # 4. Person names (cue-based, then the leading-name heuristic); both keep the cue / prefix
        #    and tokenise group 1.
        (_NAME_CUE_RE, lambda m: replace_group1(m, "PERSON"), 1),
        (_LEADING_NAME_RE, replace_leading_name, 1),
        # 4a. Five or six name words before a strong form (#1892) — AHEAD of 4b, whose four-word
        #    window would otherwise take the last four words and leave the first raw. It neither
        #    holds nor ends inside a word where 4b or 4c would end, so it takes a capitals span
        #    whole or not at all — at worst leaving a separator or a bare form word between two
        #    tokens (module notes, TWO VIEWS).
        (_EMPLOYER_LONG_RE, lambda m: token_for(m.group(0), "EMPLOYER"), 0),
        # 4b. Employers written in CAPITALS (#1875). Runs AFTER the title-case rule and both name
        #    rules, on their output, so each of them reads exactly main's input: it never shortens
        #    a title-case match, never eats a name cue ("MY NAME IS CO Ramesh" stays "MY NAME IS
        #    [PERSON_1]"), and within this view only masks what they left raw (and what 4a did
        #    not take whole). It never takes a 7+ digit run (detail 4), so money and the residual
        #    net below see main's digits. Across the two views of `pseudonymize` there was one
        #    pre-existing exception, R49, closed by #1890 (`_is_covered`).
        (_EMPLOYER_CAPS_RE, lambda m: token_for(m.group(0), "EMPLOYER"), 0),
        # 4c-4f. The rest of #1892, each on the output of the rules above, each only masking what
        #    they left raw: title-case forms, lower and sentence case, the M/S cue (keeps the
        #    cue, tokenises the firm), and the absorb pass, LAST because it folds into
        #    a token what the passes above left beside it. See `_EMPLOYER_STOPWORDS`.
        (_EMPLOYER_TITLE_FORM_RE, lambda m: token_for(m.group(0), "EMPLOYER"), 0),
        (_EMPLOYER_LOWER_RE, replace_lower_case_firm, 0),
        (_EMPLOYER_MS_CUE_RE, replace_ms_firm, 1),
        (_EMPLOYER_ABSORB_RE, absorb_into_employer, 0),
        # 5. (removed) CITY / STATE masking — owner ruling 2026-07-31, Master Context DEAD LIST:
        #    "✗ cities as PII (→ a 20-point matching input; never redact)". Every IDENTITY class
        #    above and every fail-closed path below is untouched; this narrowed the DEFINITION of
        #    PII by two non-identity classes, it did not relax the gate.
        # 6. D-1 money-amount carve-out: a 7-8 digit run that reads as an in-range salary is MASKED
        #    to [AMOUNT_n] (digits never reach the LLM) but the turn is not blocked; out-of-range /
        #    zero-led runs are left for the residual net below (fail closed).
        (_MONEY_RUN_RE, _mask_money_amount(token_for), 0),
    ]

    result = view.text
    if track:
        # SPAN-TRACKING path (only when the two views differ): record masked source regions so
        # `pseudonymize` can reconcile by position. `_apply` reproduces `regex.sub` exactly.
        result_src: list[int | None] = list(view.src)
        for regex, replace, masked_group in rules:
            if _gate_is_shut(regex, result):
                continue
            result, result_src = _apply(regex, replace, masked_group, result, result_src, regions)
    else:
        # FAST path: plain `regex.sub`, byte-identical output, no region bookkeeping. ASCII input
        # (the overwhelming majority) takes this path, so its cost is exactly as before the fix.
        for regex, replace, _masked_group in rules:
            # `_gate_is_shut`, inlined: this loop runs on every call, and the call cost ~1 us.
            gated = _RULE_GATES.get(id(regex))
            if gated is not None and gated[0] is regex and gated[1].search(result) is None:
                continue
            result = regex.sub(replace, result)

    # Distinct entities in THIS text. Equal to the old `sum(counters.values())` under a fresh
    # scope (one list entry per mint); under a shared scope it excludes entities that only
    # appeared in other calls of the request.
    replaced = len(tokens_used)

    # Fail-closed safety net: any remaining long digit run is potential un-masked numeric PII.
    if _RESIDUAL_DIGITS_RE.search(result):
        return (
            PseudonymizationResult(
                result, True, "residual numeric sequence detected", replaced, tokens_used
            ),
            regions,
        )

    return PseudonymizationResult(result, False, None, replaced, tokens_used), regions


def pseudonymize(
    text: str,
    max_length: int = DEFAULT_MAX_LENGTH,
    *,
    scope: TokenScope | None = None,
) -> PseudonymizationResult:
    """Replace likely PII in ``text`` with placeholder tokens.

    Returns a :class:`PseudonymizationResult`. When ``blocked`` is True the caller
    MUST NOT send the text to an LLM.

    ``scope`` (keyword-only, default a fresh one per call) shares placeholder numbering
    across several calls in ONE request — see :class:`TokenScope`. It changes numbering
    only: every rule, every fail-closed path and the token grammar are identical. The
    result's ``placeholder_tokens`` / ``replaced_entities`` describe THIS call's text
    (tokens it minted or reused), never the scope's running total. Only the reader pass
    (the egressed text) uses it; the spaced detector pass below keeps a private numbering.

    TWO VIEWS, ONE OUTPUT (#1738 F1). Every rule reads the text as a READER sees it -
    invisible format characters and Latin combining marks removed (`_normalised_view`). But
    DELETING an invisible also deletes the word boundary it created, so an invisible used as
    the SOLE separator between two tokens ("Mera<ZWSP>naam Ramesh") merges them and a
    ``\\b``-anchored rule stops firing - PII the reader view no longer masks would egress. So
    the gateway ALSO masks a SPACED view (each removed character becomes a space) and FAILS
    CLOSED when that view either trips its own residual guard OR masks identity over SOURCE
    offsets the reader view left unmasked - i.e. an invisible was hiding PII.

    RECONCILED BY SOURCE POSITION, never by string content. Each pass reports the set of
    original-``text`` offsets it masked; a spaced-masked offset is "covered" only when the
    reader pass masked that SAME offset, and a spaced region passes only when every offset of it
    the reader view kept is covered (``_is_covered``; before #1890 one overlap sufficed, R49). A
    content compare is unsound: a concealed name whose text is a substring of a DIFFERENT
    co-masked token ("Ramesh" inside a masked "Ramesh Steel Industries", an email local part,
    or an earlier masked occurrence) would look covered while the reader view actually left it
    raw. Position keeps a merely RE-SEGMENTED token safe (spaced "Ra" sits on the same offsets
    the reader masked as "Ramesh") while blocking the laundering case (the concealed name
    occupies offsets no reader mask covers). The reader view is what is returned; the spaced
    view is a detector only, never egressed.
    """
    try:
        if not isinstance(text, str):
            return PseudonymizationResult("", True, "input is not a string", 0, [])
        if len(text) > max_length:
            return PseudonymizationResult("", True, f"input exceeds {max_length} characters", 0, [])

        reader_view, spaced_view = _build_views(text)

        # No character was removed => the spaced view is identical => nothing new can show up, so
        # the reader pass needs no region bookkeeping. ASCII input (the overwhelming majority) and
        # fold-only / visible-separator input take this fast path at exactly the pre-fix cost.
        if spaced_view.text == reader_view.text:
            return _mask(reader_view, scope=scope)[0]

        reader_result, reader_regions = _mask(reader_view, track=True, scope=scope)

        # The reader view is the OUTPUT; its own fail-closed paths win unchanged (a residual
        # digit run keeps the exact block shape it had before this fix).
        if reader_result.blocked:
            return reader_result

        spaced_result, spaced_regions = _mask(spaced_view, track=True)

        # FAIL CLOSED if separating the invisibles trips the spaced view's own residual guard, or
        # if any masked region the spaced view found is not COVERED by the reader view's masks -
        # an uncovered offset is identity the reader view left raw once the boundary was restored.
        reader_masked = set().union(*reader_regions) if reader_regions else set()
        reader_kept = set(reader_view.src)
        if spaced_result.blocked or not all(
            _is_covered(region, reader_masked, reader_kept) for region in spaced_regions
        ):
            return PseudonymizationResult("", True, _INVISIBLE_BYPASS_REASON, 0, [])

        return reader_result

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

    Two consumers. `certified_clean_skill_labels` keeps a label the gateway masked as an
    EMPLOYER. `pseudonymize`'s `replace_leading_name` keeps a 4+ letter leading trade word
    the no-cue name guess would have masked (issue #1728, via `_is_leading_trade_word`), and
    `is_certified_clean` then asks it about the WHOLE label before a clean-or-withhold gate
    may pass that label raw.

    Any failure to consult the vocabulary returns False — the label is DROPPED, the leading
    word is MASKED, the clean-or-withhold gate WITHHOLDS: the pre-existing behaviour in each.
    Only a positive recognition can keep anything; no caller can widen a gate by failing.
    """
    try:
        from .profiling.signals import is_curated_vocabulary_label

        return is_curated_vocabulary_label(label)
    except Exception:  # defensive; degrade to the pre-carve-out behaviour (fail closed)
        return False


def _leading_candidate(match: re.Match[str]) -> str:
    """The word `_LEADING_NAME_RE` captured, normalised the way both carve-outs look it up."""
    return match.group(1).strip().lower()


def _is_leading_city(candidate: str) -> bool:
    """The CITY carve-out of the no-cue leading-name guess (owner ruling 2026-07-31)."""
    return candidate in KNOWN_CITIES or candidate in CITY_ALIASES


def _is_leading_trade_word(candidate: str) -> bool:
    """The TRADE-VOCABULARY carve-out of the no-cue leading-name guess (#1728, 2026-09-25).

    ONE predicate, read by BOTH `replace_leading_name` (to keep the word) and
    `is_certified_clean` (to know this carve-out released the word and so demand the whole
    label be vocabulary). Two copies of this condition could disagree — e.g. a floor lowered in
    one — and the gate would stop recognising what the gateway released.
    """
    return len(candidate) >= _LEADING_VOCABULARY_MIN_LEN and _is_known_trade_vocabulary(candidate)


def _rest_after_a_released_leading_word(label: str) -> str | None:
    """What follows a leading "<Word>," that a CARVE-OUT released — else None.

    Called only on a label the gateway left UNTOUCHED, so a "<Word>," it matched survived for one
    of exactly three reasons: a known city (ruling 2026-07-31), the trade-vocabulary carve-out
    (#1728), or the name stoplist ("Hello, ..."). The first two are carve-outs, and a released
    word must never vouch for what follows it (#1729 for trade words, #1730 for cities): before
    either ruling that leading word minted an incidental [PERSON_n] and the gate withheld the
    whole label, name and all.

    Decided STRUCTURALLY — never by asking the vocabulary "was it released?", because a lookup
    that failed after the gateway's own succeeded read as "no" and passed the label raw (#1729
    review round 2). The stoplist is left exactly as on main: it predates both carve-outs, and
    tightening it would reject real parse values such as "Yes, anywhere" (a stated residual).
    """
    match = _LEADING_NAME_RE.match(label)
    if match is None or _leading_candidate(match) in _NAME_STOPLIST:
        return None
    return label[match.end() :]


# Every gazetteer name, whole and word-bounded, longest first ("navi mumbai" before "mumbai"):
# what may follow a released leading word besides trade vocabulary ("Pune, Mumbai").
_CITY_NAME_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    + "|".join(
        r"\s+".join(re.escape(word) for word in name.split())
        for name in sorted(set(KNOWN_CITIES) | set(CITY_ALIASES), key=lambda n: (-len(n), n))
    )
    + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_PRINTABLE_ASCII_TEXT_RE = re.compile(r"[\x20-\x7e]*")
# The closed set of connecting words a location list is written with ("Pune, ya Mumbai", "Pune,
# anywhere", "Pune, Mumbai etc") plus the country itself. None is a name; withholding them cost
# a whole `preferred_locations` field at /profile/parse gate 6 (PR #1734 security review).
_REST_CLOSED_WORDS_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:and|or|ya|aur|etc|anywhere|near|nearby|india)(?![A-Za-z0-9])",
    re.IGNORECASE,
)


def _without_state_names(text: str) -> str:
    """State and region names blanked out, through the detector's own tables (deferred import:
    `signals` imports this module). FAILS CLOSED: any error strips nothing, so a state name is
    left for the vocabulary test, which it fails — the label is withheld."""
    try:
        from .profiling.signals import without_region_or_state_names

        return without_region_or_state_names(text)
    except Exception:  # defensive; degrade to withholding
        return text


def _is_closed_vocabulary(rest: str) -> bool:
    """True when ``rest`` is nothing but closed vocabulary — printable ASCII end to end:
    curated trade/education words, whole gazetteer city names, state / region names and a few
    connecting words. "grinding", "Mumbai", "Maharashtra", "ya Mumbai", "CNC operator, Pune" and
    an empty rest pass; "Ramesh Kumar" and "Chakan" (a locality in no closed list) do not. Any
    error consulting a closed list withholds the label."""
    if not _PRINTABLE_ASCII_TEXT_RE.fullmatch(rest):
        return False
    # States and regions BEFORE connecting words: "south india" is a region only while "india" is
    # still in it.
    remaining = _REST_CLOSED_WORDS_RE.sub(" ", _without_state_names(_CITY_NAME_RE.sub(" ", rest)))
    if not re.search(r"[A-Za-z0-9]", remaining):
        return True  # nothing but places, connecting words and punctuation
    return _is_known_trade_vocabulary(remaining)


# ---------------------------------------------------------------------------
# CONTROL CHARACTERS — the output walls WITHHOLD them (issue #1984, R59)
# ---------------------------------------------------------------------------

#: Every Unicode CONTROL character (category Cc): C0 ``\x00-\x1f``, DEL ``\x7f`` and C1
#: ``\x80-\x9f``. Cc is a closed, stable category of exactly these 65 code points, which
#: `tests/test_output_walls_control_chars.py` checks against `unicodedata` over all of Unicode.
#:
#: WHY THE WALLS WITHHOLD RATHER THAN READ THROUGH ONE. No rule in this module sees through a
#: control character, so one inside an identifier split it past every wall: measured on main,
#: `contains_hard_identifier("call 9876\x00543210")` and `("anil\x00@example.com")` were None,
#: and `certified_clean_skill_labels` KEPT both, plus "W\x01elding, Anil Kumar" and
#: "W\x85elding, Anil Kumar" (the leading-word name rule never saw "Welding,"). Deleting the
#: character before matching was the alternative and is rejected: it would certify a value
#: that differs from the one stored, and a C1 such as NEL renders as a line break, so the
#: matched text is not what a reader sees. No clean label carries a control character, so
#: withholding costs nothing honest.
#:
#: NOT category Cf (ZWJ / ZWNJ and the other format characters). The gateway already reads
#: through those (`_normalised_view`), and a ZWJ / ZWNJ after a Devanagari letter shapes a
#: conjunct, so withholding Cf would drop real Hindi labels. That is a separate decision.
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

#: The same set minus TAB, LF and CR — the layout whitespace a FREE-TEXT value legitimately
#: carries (a multi-line résumé summary, a quoted résumé line, a chat reply). The G1 floor
#: reads those three as a plain space (`_LAYOUT_WHITESPACE_RE`), which every pattern here
#: already treats as a separator, so they can split nothing a typed space could not. Same
#: carve-out as the TypeScript companion walls (R57).
_NON_LAYOUT_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_LAYOUT_WHITESPACE_RE = re.compile(r"[\t\n\r]")

#: What `contains_hard_identifier` returns for a value carrying a non-layout control
#: character. NOT one of `HARD_IDENTIFIER_CLASSES` (the shared TypeScript fixture pins that
#: set): like "scanner_error", it is a fail-closed refusal of its own.
CONTROL_CHARACTER_REFUSAL = "control_character"


def has_control_character(text: str) -> bool:
    """True when ``text`` carries any Unicode Cc character, layout whitespace included.

    The CERTIFIER's test: a label or scalar is one line, so even a tab or newline in one is
    not clean (`certified_clean_skill_labels`, `is_certified_clean`, `certify_value`)."""
    return _CONTROL_CHAR_RE.search(text) is not None


def _certifies_clean(label: str, result: PseudonymizationResult) -> bool:
    """`is_certified_clean` over an already-computed ``result = pseudonymize(label)``.

    Split out only so `certified_clean_skill_labels` can reuse the one gateway pass it also
    needs for the EMPLOYER rescue; every clean-or-withhold decision still goes through here.
    A label carrying a control character never certifies (#1984; `_CONTROL_CHAR_RE`).
    """
    if has_control_character(label):
        return False
    if result.blocked or result.replaced_entities != 0 or result.text != label:
        return False
    rest = _rest_after_a_released_leading_word(label)
    return rest is None or _is_closed_vocabulary(rest)


def is_certified_clean(label: str) -> bool:
    """May a CLEAN-OR-WITHHOLD consumer pass ``label`` to the model / the page RAW?

    The predicate the clean-or-withhold WALLS use: `certified_clean_skill_labels` (profile
    extraction + the résumé boundary), the work-history polish role gate, and gate 6 of
    /profile/parse (through `certify_value`). NOT `parse_masking._publishable_normalized`, which
    only decides whether a deterministic value is shown to the model as a hint: the transcript it
    sits beside is masked by the same gateway and already carries the same text, so withholding
    the hint would protect nothing. True only when ``pseudonymize(label)``:

    (a) did not block, (b) masked nothing, (c) returned the label byte-identical, AND
    (d) if the label opens "<Word>," and a CARVE-OUT released that word — a known city (ruling
        2026-07-31) or a trade-vocabulary word (#1728) — everything after it is closed
        vocabulary: curated trade/education words and whole gazetteer city names
        (`_rest_after_a_released_leading_word`, `_is_closed_vocabulary`).

    WHY (d) EXISTS (PR #1729 review round 1 for trade words, issue #1730 for cities, both
    measured). Each ruling stops the gateway masking a leading word; neither licenses a consumer
    that passes a string raw "because nothing was masked" to release what FOLLOWS the word.
    Before the rulings, "Welding, Anil Kumar", "Pune, Ramesh Kumar" and the polish role "Operator,
    Ramesh sir ke under" all minted an incidental [PERSON_1] and were withheld whole; without (d)
    they passed verbatim — to the persisted profile, the résumé, and the model. With (d):
    "Welding, grinding", "Pune, welding" and "Pune, Mumbai" pass; those do not. A leading
    stoplisted greeting ("Hello, ...") is not a carve-out and is certified exactly as on main.

    Never raises (every step is fail-closed by construction), never logs, never returns text.
    """
    return _certifies_clean(label, pseudonymize(label))


# What `certify_value` hands back for a value it WITHHOLDS although the gateway masked nothing:
# never equal to any input (a NUL cannot survive into a certified value), so a wall that
# compares "certified == value" reads it as altered.
_WITHHELD = "\x00withheld\x00"


def certify_value(text: str) -> tuple[bool, str]:
    """``(blocked, certified)`` for a wall that accepts a value only when ``certified == text``.

    The `is_certified_clean` semantics in the masker-shaped contract gate 6 of /profile/parse
    uses (`parse_gates.certify`): blocked when the gateway blocks; otherwise the gateway's text,
    EXCEPT that a value the gateway left untouched but `is_certified_clean` withholds ("Welding,
    Ramesh Kumar" — condition (d)) comes back as a withheld marker that equals no input, so the
    wall reports it altered and rejects it, exactly as it did before the #1728 carve-out.
    """
    result = pseudonymize(text)
    if result.blocked:
        return True, result.text
    if result.text == text and not _certifies_clean(text, result):
        return False, _WITHHELD
    return False, result.text


def certified_clean_skill_labels(labels: list[str]) -> list[str]:
    """Keep only labels this gateway certifies CLEAN (Q14/ADR-0030 OQ#3 — SG-2).

    A label passes when `is_certified_clean` holds: ``pseudonymize(label)`` (a) does not
    block, (b) masks nothing (``replaced_entities == 0``), (c) returns the label
    byte-identical, and (d) a leading word released by the #1728 trade-vocabulary carve-out
    comes with a label that is vocabulary WHOLE. Anything else — blocked, masked, altered,
    a name behind a leading trade word, or an internal gateway error (which returns
    ``blocked=True``) — is DROPPED (fail-closed: over-drop, never keep a suspect label).
    Purely additive certification: it never relaxes the gateway, never returns masked text
    or the token mapping, and never logs. Used to certify ``DraftProfile.skill_labels`` AT
    REST when populated (profile extraction) and to RE-certify at the résumé boundary.

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

    A LABEL CARRYING A CONTROL CHARACTER (Unicode Cc: C0, DEL, C1, layout whitespace
    included) IS DROPPED before either path, the rescue included (#1984; `_CONTROL_CHAR_RE`).
    """
    kept: list[str] = []
    for label in labels:
        if has_control_character(label):
            continue
        result = pseudonymize(label)
        if result.blocked:
            continue
        if _certifies_clean(label, result):
            kept.append(label)
            continue
        if _is_employer_only_mask(result) and _is_known_trade_vocabulary(label):
            kept.append(label)
    return kept


# ---------------------------------------------------------------------------
# HARD IDENTIFIERS — the floor that no ruling has moved
# ---------------------------------------------------------------------------

#: The identifier classes that may never reach a stored value, an event, a log or the
#: résumé sheet — whatever a ruling permits into a PROMPT.
#:
#: WHY THIS EXISTS, AND WHY IT IS NOT `pseudonymize`. ADR-0041 D5 sends an uploaded
#: résumé to the model FULLY UNMASKED, and §3.3 spells out the consequence: the model
#: can now return a real name, phone or PAN inside a parsed VALUE. Gate 6 in
#: `profiling/parse_gates.py` is what stops such a value being stored — so on that route
#: gate 6 stops being a formality and becomes the thing that decides what is persisted.
#:
#: It cannot use the full gateway to do it. `pseudonymize` masks employer names, person
#: names and money amounts as well, and D5 EXPLICITLY authorises employer names into
#: `employer_name_enc`. Worse, `_EMPLOYER_RE` over-fires on ordinary trade vocabulary —
#: "Stainless Steel" and "Diploma Mechanical Engineering" both come back as
#: `[EMPLOYER_1]` (see `certified_clean_skill_labels`, which exists to rescue exactly
#: that). Certifying résumé values with the full gateway would therefore reject nearly
#: every honest value while the ruling says to keep them.
#:
#: So this is a NARROWING of gate 6 for one route, not a disabling of it: the identity
#: classes a signed ruling moved are permitted, and the classes it did not move are
#: refused. Nothing here is affected by `RESUME_PARSE_RAW_TEXT_ENABLED` — that flag
#: governs what reaches the MODEL, and this governs what reaches the DATABASE. Two
#: different questions, and collapsing them into one masker is the single most likely
#: way to turn the raw-input flag into a silent PII leak.
HARD_IDENTIFIER_CLASSES: tuple[str, ...] = (
    "pan",
    "aadhaar",
    "phone",
    "email",
    "credential_id",
    # ADDED AFTER A SECURITY REVIEW MEASURED THE FIRST DRAFT WRONG. That draft's docstring
    # claimed "_PHONE_RE still catches 9-13 digit runs, and Aadhaar has its own shape, so no
    # identifier escapes through that exclusion - only amounts pass." Measured false:
    # `_PHONE_RE` is bounded ABOVE at 13 digits by construction, and the residual-digit net
    # that used to catch everything longer is the thing this function deliberately excludes.
    # So a bank account (9-18 digits) and an ESIC number (17) walked straight through.
    "long_digit_run",
    # A GSTIN embeds a PAN with no word boundary either side, so `_PAN_RE` misses it.
    "gstin",
)


#: FOURTEEN OR MORE, which is the floor that cannot collide with money. The D-1 carve-out
#: exists because a salary is 7-8 digits, and `SALARY_INR_PER_MONTH_MAX` is six. Nothing a
#: worker earns is 14 digits, and a bank account, an ESIC number and a PF number all are.
#: Separators are tolerated for the same reason `_PHONE_RE` tolerates them: an identifier
#: split on a dot or a slash is still an identifier.
#: FOURTEEN OR MORE, which is the floor that cannot collide with money. The D-1 carve-out
#: exists because a salary is 7-8 digits, and `SALARY_INR_PER_MONTH_MAX` is six figures.
#: Nothing a worker earns is 14 digits; a bank account (9-18), an ESIC number (17) and a PF
#: number all are. Separators are tolerated for the same reason `_PHONE_RE` tolerates them:
#: an identifier split on a dot or a slash is still an identifier.
_LONG_DIGIT_RUN_RE = re.compile(r"(?<!\d)\d(?:[" + _PHONE_SEPARATORS + r"]*\d){13,}(?!\d)")

#: A GSTIN is `27ABCDE1234F1Z5` — two state digits, a PAN, then three more characters. The
#: PAN sits INSIDE a longer alphanumeric run, so `_PAN_RE`'s word boundaries never match it.
_GSTIN_RE = re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b")

#: Zero-width and invisible characters, REMOVED BEFORE MATCHING rather than tolerated as
#: separators. `_PHONE_SEPARATORS` already lists them, but that only ever helped the patterns
#: built from it — stripping helps PAN, Aadhaar and email too, and `ABCDE<ZWJ>1234F` was never
#: a legitimate value. The TypeScript wall strips the same set, so the shared fixture keeps
#: pinning one behaviour rather than two that happen to agree on the cases written down.
_INVISIBLE_RE = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")

#: Identifiers this route must refuse that the interview's `_CREDENTIAL_ID_RE` does not name.
#:
#: KEPT SEPARATE from that pattern rather than merged into it. Widening the shared one would
#: change what the INTERVIEW masks, and this is a résumé-only narrowing of gate 6 — not a
#: change to the gateway every other route depends on.
#:
#: CUE-BASED, NOT SHAPE-BASED, because these shapes are ambiguous in a way Aadhaar and PAN are
#: not. A passport number `M1234567` is indistinguishable from a part number; a date of birth
#: `12/05/1988` is indistinguishable from the date range `01/2019-03/2023` that a résumé prints
#: on every line of its work history. The cue is what separates them.
#:
#: THE VALUE MUST CONTAIN A DIGIT — the lookahead, copied from `_CREDENTIAL_ID_RE` and load
#: bearing for the same reason. Without it `\baccount\b` plus the next word refuses
#: "Account Manager", which is a job title a real worker holds. Bounded at 24 characters so
#: the lookahead's work stays bounded per character rather than per input.
#: `re.IGNORECASE` OVER THE WHOLE PATTERN, not an inline `(?i:...)` around the cue alone.
#: The first version scoped the flag to the cue and then required a LOWERCASE connector, so
#: "Passport No: M1234567" and "Voter ID: ABC1234567" — the two forms a real résumé actually
#: prints — both slipped through while their lowercase equivalents were caught. A flag that
#: covers half an expression measures as coverage and is not.
#: THE CONNECTOR AFTER THE CUE IS `_CREDENTIAL_ID_RE`'s LINEAR ONE (issue #1933, R54; the note
#: there). Main's `\s*(?:no\.?|number|num|id|#)?\s*[:\-]?\s*` was O(k^3) on a whitespace run:
#: `contains_hard_identifier("passport" + " " * 800 + "!")` took 3.5-9.1 s. Same spans on every
#: input.
#: THE DOT AFTER THE CUE AND THE ":-" SEPARATOR ARE READ, as in `_CREDENTIAL_ID_RE` (issue #1950,
#: R56; the note there): "Passport.No: K1234567" and "A/c. No. 12345678" were admitted.
_RESUME_CUED_ID_RE = re.compile(
    r"\b(?:passport|voter|gstin|uan|esic|provident\s+fund|ifsc|"
    r"a/c|account|dob|date\s+of\s+birth)\b\.?"
    r"\s*(?:(?:no\.?|number|num|id|#)\s*)?(?:[:\-]-?\s*)?"
    r"(?=[A-Za-z0-9/\-]{0,24}\d)"
    r"[A-Za-z0-9][A-Za-z0-9/\-]{4,}",
    re.IGNORECASE,
)


def contains_hard_identifier(text: str) -> str | None:
    """Which class of hard identifier appears in ``text``, or ``None``. Never raises.

    DELIBERATELY EXCLUDES the residual-digit net at SEVEN, which the full gateway applies.
    A salary is seven or eight digits and is a legitimate résumé value — a fact the D-1
    money carve-out above already had to establish once, after that net blocked workers who
    typed an annual figure.

    THE FIRST DRAFT STOPPED THERE AND WAS WRONG. It reasoned that `_PHONE_RE` covers 9-13
    digits and Aadhaar has its own
    shape, so no identifier escapes through that exclusion — only amounts pass.

    A PERSON NAME IS KNOWINGLY NOT IN THIS SET. RULED 2026-09-11 (Prakash), and ADR-0041
    section 3.3 now says so in those words rather than the opposite.
    Phone and PAN are covered here; a name is not, so `role_label = "Ramesh Kumar - CNC
    Turner"` passes, and that is the recorded, signed posture rather than a gap nobody saw.

    The obvious fix — certify with the full gateway and permit only employer-and-amount masks
    — was MEASURED before being rejected, and it does neither of the things it appears to:

        pseudonymize("Ramesh Kumar")            -> "Ramesh Kumar"      (unchanged)
        pseudonymize("My name is Ramesh Kumar") -> "My name is [PERSON_1]"
        pseudonymize("1200000")                 -> "[AMOUNT_1]"

    The gateway's name detection is CUE-based (`_NAME_CUE_RE`, `_LEADING_NAME_RE`), and a
    résumé prints a bare name with no cue in front of it. So that route would refuse a
    worker's stated salary while still admitting the name it was supposed to catch. The
    gazetteer that would have caught a bare name is recorded as measured-dead (R32: 487
    probes, 348 leaks).

    So there is no reliable person-name detector in this codebase to narrow to, and shipping
    one that misses the common case while breaking salaries would be worse than the gap. The
    two honest options were put to the owner — amend 3.3, or gate the launch on building a
    detector — and 2026-09-11 ruled the first: the name a worker sees is his own, on his own
    record, going to a model that already receives the whole document under D5.

    DO NOT "FIX" THIS by pointing gate 6 at the full gateway without re-running the
    measurement above. If a real name detector is ever built, HERE is where it gets wired in
    — one new class in this function — and nothing else has to change.

    Order is cheapest-first and the classes do overlap (a 12-digit Aadhaar also matches
    the phone net); the first match names it, and which label wins never changes the
    decision, only the counter it lands in.

    A CONTROL CHARACTER FAILS CLOSED FIRST (#1984, R59). Any Cc character other than tab, LF
    and CR returns `CONTROL_CHARACTER_REFUSAL`, so every caller drops the value: no pattern
    below sees through one ("9876\\x00543210" read as no phone). Tab, LF and CR are read as a
    space, which every pattern already treats as a separator. Cf is untouched (see
    `_CONTROL_CHAR_RE`).
    """
    try:
        if _NON_LAYOUT_CONTROL_CHAR_RE.search(text):
            return CONTROL_CHARACTER_REFUSAL
        text = _LAYOUT_WHITESPACE_RE.sub(" ", text)
        text = _INVISIBLE_RE.sub("", text)
        if _PAN_RE.search(text):
            return "pan"
        if _AADHAAR_RE.search(text):
            return "aadhaar"
        if _PHONE_RE.search(text):
            return "phone"
        if _EMAIL_RE.search(text):
            return "email"
        if _CREDENTIAL_ID_RE.search(text) or _RESUME_CUED_ID_RE.search(text):
            return "credential_id"
        if _GSTIN_RE.search(text):
            return "gstin"
        if _LONG_DIGIT_RUN_RE.search(text):
            return "long_digit_run"
    except Exception:  # pragma: no cover - defensive; a scanner error must fail CLOSED
        return "scanner_error"
    return None
