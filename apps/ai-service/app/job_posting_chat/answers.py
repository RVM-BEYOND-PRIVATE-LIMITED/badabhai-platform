"""Local answer detection for the job-posting interview (ADR-0035).

The single source of truth for "what did the payer just tell us", read over the
RAW payer message, LOCALLY, with no network — exactly like ``profiling.signals``
is for the worker side. Reading raw is what lets the engine see a city or a pay
figure that is (correctly) masked before any LLM call; the raw text never leaves
this process except onto the draft the payer is authoring, which is not one of the
five §2 sinks (LLM input, event payloads, ai_jobs, audit_logs, logs).

ATTRIBUTION-FIRST, and that is the one real design difference from the worker
detector. ``profiling.signals`` is a large gazetteer because workers ramble in
Hinglish and their answers must be recognised context-free. A payer is answering a
specific, short, professional question, so the strongest available signal is WHICH
QUESTION IS ON SCREEN: the reply to "which city and area is the workplace in?" IS the
location. So detection is:

1. **Attribution.** ``last_asked``'s own parser reads the message. One attributed
   answer may close TWO topics: the location answer also records ``city`` when it
   names exactly one gazetteer city ("Pune, Chakan"), so the common case costs one
   question.
2. **Five cross-topic extractors**, and only five — ``vacancy``, ``pay_range``,
   ``shift``, ``pay_type`` and ``experience``. Each requires an explicit cue ("5
   openings", "Rs 22,000", "night shift", "in hand", "3 years experience"), so a
   payer who front-loads ("2 welders, night shift, 20-25k in hand") is not re-asked.
   A cue-less cross-topic guess at a role title or a city is how you put words in an
   employer's mouth, so neither is ever read cross-topic — and experience is never
   read from the description answer (see ``_NOT_READ_CROSS_TOPIC_FROM``).

AN ALLOWLIST, NOT A PARSER (#1727 round 3). The four worker-card fields — experience,
needed_by, pay_type and city — are recorded only when the answer (or, read in passing,
one clause of it) FULLY matches one of a small set of known shapes: the chips, and the
plain ways of writing them. Two review rounds of clause-splitting, negation screens and
bound detection still left dozens of free-text answers recording a WRONG value ("Not
less than 3 years" -> "up to 3", "no urgent requirement" -> immediate, a road name as
the city). The long tail of free text is unbounded; the allowlist is not. Anything
outside it records NOTHING — what these fields held before #1726 — so a phrasing we do
not know costs a question, never a wrong card.

FAIL TOWARD ASKING AGAIN. Every parser here returns "no value" rather than a
guess. An unparsed ESSENTIAL is re-asked once (bounded) and then declared in
``unanswered_essentials`` — a visibly incomplete draft the payer can fix is always
better than a confidently wrong one they do not notice.
"""

from __future__ import annotations

import re
from typing import NamedTuple

# The ONE city gazetteer (packages/profiling-lexicon cities.json). Read from the privacy
# module this route already depends on — never from ``app.profiling`` (see __init__).
from ..pseudonymize import CITY_ALIASES, KNOWN_CITIES, phone_shaped_runs

# --- Vacancy bands (ADR-0012) ----------------------------------------------
# The EXACT shipped band strings from packages/types `VACANCY_BANDS`. Mirrored,
# not re-derived: tests/test_job_posting_chat.py pins these against the boundary
# table in packages/validators/src/validators.test.ts.
VACANCY_BANDS: tuple[str, ...] = ("1", "2-5", "6-10", "11-25", "25+")


def band_for_count(n: int) -> str:
    """Map a RAW vacancy count to a band — the Python mirror of ``bandForCount``
    in ``packages/validators/src/index.ts``.

    Boundaries are copied from that function, NOT re-derived::

        n <= 1        -> "1"
        2 <= n <= 5   -> "2-5"
        6 <= n <= 10  -> "6-10"
        11 <= n <= 25 -> "11-25"
        n >= 26       -> "25+"

    Note the 25/26 boundary: "25+" is STRICTLY greater than 25 — 25 itself falls in
    "11-25". The raw count is INTAKE-ONLY: it is derived to a band here and the
    integer is discarded — never stored on a column, never put in an event.

    Fails closed on a non-positive-integer (the TS side raises ``RangeError``; the
    guard exists so a bad value can never silently become the "1" band). ``bool`` is
    rejected explicitly because ``isinstance(True, int)`` is True in Python.
    """
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ValueError(f"vacancy count must be a positive integer, got: {n!r}")
    if n <= 1:
        return "1"
    if n <= 5:
        return "2-5"
    if n <= 10:
        return "6-10"
    if n <= 25:
        return "11-25"
    return "25+"


# --- Shared shapes ---------------------------------------------------------
# Caps mirror apps/api/src/job-postings/job-postings.dto.ts so a draft can never be
# built that the publish DTO would reject: LABEL_MAX 200, DESCRIPTION_MAX 2000,
# skills <= 10 phrases of <= 80 chars each.
LABEL_MAX = 200
DESCRIPTION_MAX = 2000
PHRASE_MAX = 80
MAX_SKILLS = 10
MAX_PHRASES = 10
# The create DTO's `city` (trim, 1..80) and `experienceYearsSchema` (int 0..60).
CITY_MAX = 80
EXPERIENCE_MAX_YEARS = 60
# The closed `jobs.pay_type` / `jobs.needed_by` sets, mirrored by the contract literals.
PAY_TYPES: tuple[str, ...] = ("in_hand", "gross", "ctc")
NEEDED_BY: tuple[str, ...] = ("immediate", "soon", "flexible")

_WS_RE = re.compile(r"\s+")
_PHRASE_SPLIT_RE = re.compile(r"[,;/\n|+&]|\s+and\s+|\s+aur\s+", re.IGNORECASE)
_HAS_ALNUM_RE = re.compile(r"[0-9A-Za-zऀ-ॿ]")
# Square brackets are trimmed only when that breaks no pseudonymization token: they
# are the token's delimiters, and trimming them turned an edge token ("[PERSON_1],
# Chakan") into "PERSON_1], Chakan", which PLACEHOLDER_TOKEN_RE no longer sees — so the
# essential closed on a token and no retype ask was ever raised (#1726). Never trimming
# them left a stray "[PF" / "ESI]" on the published card instead (#1727 F8), so
# `_clean_label` tries the bracket trim and falls back when it cost a token.
_TRIM_PUNCT = " \t\r\n.,;:!\"'`(){}-–—"
_TRIM_PUNCT_WITH_BRACKETS = _TRIM_PUNCT + "[]"
# closer -> its opener, for the unbalanced-bracket sweep in `_clean_label`.
_BRACKET_OPENER: dict[str, str] = {")": "(", "]": "[", "}": "{"}


def cap_utf16(value: str, cap: int) -> str:
    """The longest prefix of ``value`` that is at most ``cap`` UTF-16 code units and
    that never ends INSIDE a placeholder token.

    zod's ``z.string().max(n)`` counts JavaScript string length — UTF-16 units — while
    Python's ``len`` counts code points, so a non-BMP character (an emoji) is 2 units
    there and 1 here. Capping by code points let the service emit a draft the TS
    contract rejects, and that turn then 503'd on every retry (#1727 F15). Equivalent
    to trimming until ``len(s.encode("utf-16-le")) // 2 <= cap``; never splits a
    character.

    A cut that falls inside a token moves to BEFORE it (#1727 R20): "...supervisor
    [PER" no longer matches PLACEHOLDER_TOKEN_RE, so the half-token reached the card and
    the retype ask was never raised. A token wholly past the cap is dropped, as before.
    """
    cut = len(value)
    units = 0
    for index, char in enumerate(value):
        units += 2 if ord(char) > 0xFFFF else 1
        if units > cap:
            cut = index
            break
    for token in PLACEHOLDER_TOKEN_RE.finditer(value):
        if token.start() < cut < token.end():
            return value[: token.start()]
    return value[:cut]


def _drop_unbalanced_brackets(text: str) -> str:
    """``text`` without the bracket characters that have no partner (#1727 R19).

    The edge trim removes a closing "]" or ")" whose opener sits inside the value —
    "Welder [TIG]" became "Welder [TIG" — so every opener without a closer, and every
    closer without an opener, is removed. A placeholder token is never touched, by
    construction: its "[" and "]" enclose no bracket, so the walk always pairs them with
    each other — the retype ask's only handle on the token survives.
    """
    open_at: list[int] = []
    unmatched: set[int] = set()
    for index, char in enumerate(text):
        if char in "([{":
            open_at.append(index)
        elif char in _BRACKET_OPENER:
            if open_at and text[open_at[-1]] == _BRACKET_OPENER[char]:
                open_at.pop()
            else:
                unmatched.add(index)
    unmatched.update(open_at)
    return "".join(char for index, char in enumerate(text) if index not in unmatched)


# A short, explicit "there is nothing to give here". Only honoured for NON-essential
# topics: an essential answered with "no" must stay unanswered so the bounded re-ask
# fires and the gap is declared, rather than silently shipping a draft that the
# publish DTO will reject.
_REFUSAL_RE = re.compile(
    r"^(?:no|none|nope|nothing|nothing else|na|n/a|not applicable|nil|skip|"
    r"no thanks|that'?s all|nahi|kuch nahi)[.!]?$",
    re.IGNORECASE,
)

# Chatter that is NOT a label. A short first-person/greeting line is a payer opening
# a conversation, not a job title or a city — accepting it would stamp "I want to
# post a job" into role_title. Only applied to the two LABEL topics, and only when
# no explicit cue matched.
_CHATTER_RE = re.compile(
    r"^(?:hi|hello|hey|namaste|yes|yeah|yep|ok|okay|sure|thanks|thank you|"
    r"please|let'?s|lets|i |we |can you|i'?m|start|begin)\b",
    re.IGNORECASE,
)


def _clean_label(text: str, max_len: int = LABEL_MAX) -> str | None:
    """Collapse whitespace, strip wrapping punctuation/quotes, cap length.

    "[PF" -> "PF", "[Pune]" -> "Pune" — but a placeholder token at an edge stays whole:
    if the bracket trim leaves FEWER intact tokens than the text had, the bracket-less
    trim is used instead, so every token stays visible to the retype ask. A bracket the
    trim left without its partner is then removed ("Welder [TIG" -> "Welder TIG"), and
    the cap never cuts a token in half (see :func:`cap_utf16`).
    """
    collapsed = _WS_RE.sub(" ", (text or "").strip())
    cleaned = collapsed.strip(_TRIM_PUNCT_WITH_BRACKETS)
    if len(PLACEHOLDER_TOKEN_RE.findall(cleaned)) < len(PLACEHOLDER_TOKEN_RE.findall(collapsed)):
        cleaned = collapsed.strip(_TRIM_PUNCT)
    cleaned = _WS_RE.sub(" ", _drop_unbalanced_brackets(cleaned)).strip()
    capped = cap_utf16(cleaned, max_len).strip()
    if not capped or not _HAS_ALNUM_RE.search(capped):
        return None
    return capped


def _split_phrases(text: str, max_items: int = MAX_PHRASES) -> list[str]:
    """Split a free-text list answer into short phrases.

    "PF + ESI, canteen" -> ["PF", "ESI", "canteen"]. Case-insensitively deduped,
    each phrase capped at PHRASE_MAX chars, the list capped at ``max_items`` so a
    pasted paragraph can never blow past the publish DTO's array cap.
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in _PHRASE_SPLIT_RE.split(text or ""):
        phrase = _clean_label(raw, PHRASE_MAX)
        if phrase is None:
            continue
        key = phrase.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(phrase)
        if len(out) >= max_items:
            break
    return out


# Explicit ASCII lookarounds, not `\b`: "in-hand" must match as ONE cue, and a `\b`
# sits happily between "in" and "-". Digits count as word characters so "15 days"
# never matches inside "115 days".
def _cue(body: str) -> str:
    return r"(?<![A-Za-z0-9])(?:" + body + r")(?![A-Za-z0-9])"


# Every hyphen/dash code point ("Mumbai–Pune", "1—2 years") is read as "-".
_DASHES_RE = re.compile("[\u2010-\u2015\u2212]")
# Stripped from the ends of a normalised answer. Deliberately NOT "<", ">", "+", "-" or
# "~" — each changes what the answer means ("<2 yrs") — and "." / "," only at the END:
# a leading one is the start of a number (".5 years").
_LEAD_PUNCT = " \t\r\n\"'`()[]{}:;!?"
_TRAIL_PUNCT = _LEAD_PUNCT + ".,"


def _normalise(text: str | None) -> str:
    """The form every allowlist below matches against: lowercase, one kind of dash and
    apostrophe, single spaces, and no surrounding punctuation or trailing ".!?"."""
    lowered = _DASHES_RE.sub("-", (text or "").lower()).replace("’", "'")
    return _WS_RE.sub(" ", lowered).lstrip(_LEAD_PUNCT).rstrip(_TRAIL_PUNCT).strip()


# --- Vacancy ---------------------------------------------------------------
_BAND_ALIAS: dict[str, str] = {
    "1": "1",
    "one": "1",
    "2-5": "2-5",
    "2 to 5": "2-5",
    "6-10": "6-10",
    "6 to 10": "6-10",
    "11-25": "11-25",
    "11 to 25": "11-25",
    "25+": "25+",
    "25 plus": "25+",
    "more than 25": "25+",
    "above 25": "25+",
}
_WORD_NUMBERS: dict[str, int] = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "ek": 1,
    "do": 2,
    "teen": 3,
    "char": 4,
    "paanch": 5,
    "panch": 5,
}
# A number followed by a UNIT is not a head count. Without this, "we need 3 years
# experience" banded a vacancy of 3 — the cue ("need") and the number were both
# there, they just had nothing to do with each other. ONE unit list serves both guards
# below; it also carries the Hinglish units, "exp", an ordinal ("10th pass"), "kg" and
# "age" — each measured banding a head count nobody gave (#1727 R8/R16/R18).
_UNIT_ALT = (
    r"years?|yrs?|saal|months?|mahine|mahina|weeks?|hafte|haftey|hafta|hours?|hrs?|"
    r"ghante?|ghanta|days?|din\b|km|kgs?\b|%|k\b|lakh|lac|thousand|hazaa?r|rs\b|rupees?|"
    r"shifts?|am\b|pm\b|exp\b|age\b|th\b|st\b|nd\b|rd\b"
)
_UNIT_GUARD = r"(?!\s*(?:" + _UNIT_ALT + r"))"
# ...and neither is a number that BEGINS a unit-bearing window: "2-5 years", "2 or 3
# years", "5+ years", "5 plus years", "2 or more years". The unit guard looks only at
# what follows N, which in "need 2-5 years" is "-5 years" — so the cue-verb arm banded
# the 2 and closed the vacancy essential on a count nobody gave (#1727 F7/R17).
_WINDOW_GUARD = (
    r"(?!\s*(?:(?:-|to|se|or)\s*\d{1,4}|\+|plus|or\s+more|and\s+above)\s*(?:" + _UNIT_ALT + r"))"
)
# `(?![\d,.]?\d)`: the digit group can never be CUT SHORT. Without it a guard that
# rejected "10" let the engine backtrack to "1" — whose lookaheads see "0 years" and
# pass — so "need 10-15 years experience" banded a vacancy of 1 (#1727 R8/R16). The
# optional separator also keeps "18,000" and "1.5 lakh" from yielding their first digits.
_NUM = r"(?<![\d,.])(\d{1,4})(?![\d,.]?\d)" + _UNIT_GUARD + _WINDOW_GUARD
_VACANCY_NOUNS = (
    r"vacanc(?:y|ies)|openings?|positions?|seats?|people|persons?|workers?|"
    r"candidates?|hires?|staff"
)
# CROSS-TOPIC vacancy needs the number and the cue to be ADJACENT, not merely
# co-present in the same sentence. Three arms: "5 openings", "need 5", "openings: 5".
_VACANCY_ARMS = (
    re.compile(_NUM + r"\s+(?:\w+\s+){0,2}?(?:" + _VACANCY_NOUNS + r")\b", re.IGNORECASE),
    re.compile(
        r"\b(?:hiring|hire|need|needs|require|requires|looking for|recruiting)\s+" + _NUM,
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:" + _VACANCY_NOUNS + r"|nos\.?)\b\s*(?:of|:|-)?\s*" + _NUM, re.IGNORECASE),
)
_INT_RE = re.compile(_NUM)

# A count that large is not a head count — it is a salary or a pin code that wandered
# into the answer. Refuse rather than band it (fail toward asking again).
_MAX_PLAUSIBLE_VACANCIES = 1000


def _band_from_value(value: int) -> str | None:
    if 1 <= value <= _MAX_PLAUSIBLE_VACANCIES:
        return band_for_count(value)
    return None


def _parse_vacancy(text: str, *, require_cue: bool) -> str | None:
    """Parse a vacancy answer into a BAND (never an integer)."""
    message = (text or "").strip().lower()
    if not message:
        return None
    normalized = _WS_RE.sub(" ", message.replace("–", "-").replace("—", "-"))
    normalized = re.sub(r"\s*-\s*", "-", normalized).strip(_TRIM_PUNCT)
    direct = _BAND_ALIAS.get(normalized)
    if direct is not None:
        return direct
    # A band string embedded in a sentence ("we need 6-10 fitters") — but not one that
    # carries a unit: "2-5 years experience" is an experience window, and read as a
    # band it would close the vacancy essential with a count nobody gave.
    for alias, band in _BAND_ALIAS.items():
        if "-" in alias and re.search(
            rf"(?<!\d){re.escape(alias)}(?!\d)" + _UNIT_GUARD, normalized
        ):
            return band
    if require_cue:
        for arm in _VACANCY_ARMS:
            match = arm.search(normalized)
            if match:
                return _band_from_value(int(match.group(1)))
        return None
    match = _INT_RE.search(normalized)
    if match:
        return _band_from_value(int(match.group(1)))
    for word, value in _WORD_NUMBERS.items():
        if re.search(rf"\b{word}\b", normalized):
            return band_for_count(value)
    return None


# --- Pay -------------------------------------------------------------------
_MONEY_CUE_RE = re.compile(
    r"₹|\brs\.?\b|\binr\b|\brupees?\b|\bsalary\b|\bpay\b|\bwage[s]?\b|\bctc\b|"
    r"\bstipend\b|\bper month\b|\bpm\b|\bmonthly\b|\bp\.m\.?\b|\bmonth\b|\d\s*k\b",
    re.IGNORECASE,
)
_SUFFIX = r"(k|thousand|hazar|hazaar|lakh|lakhs|lac|lacs)?"
# Decimals are allowed because "1.5 lakh" is how the amount is actually written here.
_NUMBER = r"(?<![\d.])(\d[\d,]*(?:\.\d+)?)"
_AMOUNT_RE = re.compile(_NUMBER + r"\s*" + _SUFFIX, re.IGNORECASE)
# A RANGE, matched before anything else. "20-25k" means 20,000 to 25,000: the
# trailing multiplier governs its bare partner — but ONLY inside the range.
#
# THE DEFECT THIS REPLACES, measured: propagating the trailing multiplier across the
# WHOLE message turned "we need 5 MIG welders ... 20-25k" into pay_min 5000, because
# the vacancy count 5 was < 1000 and inherited the "k". The multiplier now travels
# one hop, between the two halves of an actual range, and nowhere else.
_PAY_RANGE_RE = re.compile(
    _NUMBER + r"\s*" + _SUFFIX + r"\s*(?:-|–|—|to|se|and|upto|up to)\s*"
    r"(?:₹|rs\.?|inr)?\s*" + _NUMBER + r"\s*" + _SUFFIX,
    re.IGNORECASE,
)
_MULTIPLIERS: dict[str, int] = {
    "k": 1000,
    "thousand": 1000,
    "hazar": 1000,
    "hazaar": 1000,
    "lakh": 100_000,
    "lakhs": 100_000,
    "lac": 100_000,
    "lacs": 100_000,
}
# Monthly pay we are willing to record. Below the floor a bare number is almost
# always something else ("8 hours", "2 years"); above the ceiling it is not a
# monthly wage for this market. Outside the window we record nothing and re-ask.
_PAY_MIN_INR = 1_000
_PAY_MAX_INR = 10_000_000


def _scale(digits: str, suffix: str | None, partner: str | None) -> int | None:
    """One amount -> rupees. A bare number borrows its PARTNER's multiplier only
    inside a range (``20-25k``), and only when it is too small to be a wage on its
    own — never from an unrelated number elsewhere in the message."""
    try:
        amount = float(digits.replace(",", ""))
    except ValueError:  # pragma: no cover - the regex only ever yields digits
        return None
    if suffix:
        amount *= _MULTIPLIERS[suffix.lower()]
    elif partner and amount < 1000:
        amount *= _MULTIPLIERS[partner.lower()]
    value = int(amount)  # whole rupees — jobs.pay_min / jobs.pay_max are integers
    return value if _PAY_MIN_INR <= value <= _PAY_MAX_INR else None


# The CLAUSE an amount sits in, for the add-on screen below: the shared boundaries plus
# "+", "plus" and " and " — "Salary 20k + 2k bonus" is two statements. A boundary inside
# a RANGE ("between 18000 and 22000", "18,000 - 22,000") is not one.
_PAY_CLAUSE_BOUNDARY_RE = re.compile(
    r"[;\n]|(?<!\d),|,(?!\d)|\+|(?<![A-Za-z])plus(?![A-Za-z])|\s+and\s+", re.IGNORECASE
)
# An amount in a clause about an ADD-ON — overtime, a bonus, an allowance, a statutory
# deduction, a perk — is not the wage. Folded into the band it became the band's
# MINIMUM: "in hand 20k, OT extra 2000" read as Rs 2,000-20,000 (#1727 R34, pre-existing).
_PAY_ADDON_RE = re.compile(
    _cue(
        r"bonus(?:es)?|allowances?|incentives?|overtime|ot|extra|increments?|hikes?|pf|esi|"
        r"esic|gratuity|food|canteen|room|rent|travel|conveyance|da|hra"
    ),
    re.IGNORECASE,
)
# A bare four-digit YEAR is not pay ("Established 1998" became pay_min 1998, R34). It is
# pay only with a currency word before it or a per-month / "/-" after it ("Rs 2000").
_PAY_YEAR_RE = re.compile(r"19[5-9]\d|20\d\d")
_PAY_CURRENCY_BEFORE_RE = re.compile(r"(?:₹|\brs\.?|\binr|\brupees?)\s*$", re.IGNORECASE)
_PAY_CURRENCY_AFTER_RE = re.compile(
    r"\s*(?:/-|rs\b|rupees?\b|inr\b|per\s+month|pm\b|p\.m\b|monthly|/\s*month)", re.IGNORECASE
)
# Every word that names a pay BASIS. Two figures in an answer that also names a basis are
# figures on different bases ("gross 30k, in hand 25k", "CTC 3 lakh, take home 22k"): no
# single band describes both, so the pay answer records nothing rather than a fold.
_PAY_BASIS_KINDS: dict[str, re.Pattern[str]] = {
    "in_hand": re.compile(_cue(r"in\s*-?\s*hand|inhand|take\s*-?\s*home|net|haath"), re.I),
    "gross": re.compile(_cue(r"gross"), re.IGNORECASE),
    "ctc": re.compile(_cue(r"ctc|c\.?t\.?c\.?|cost\s+to\s+company"), re.IGNORECASE),
}


class _PayFigure(NamedTuple):
    """One pay figure a message states: a range, or a single amount, with its span."""

    start: int
    end: int
    low: int
    high: int | None
    from_range: bool


def _is_bare_year(message: str, match: re.Match[str]) -> bool:
    """A four-digit 1950..2099 with no suffix and no currency beside it. (The amount
    regex keeps a trailing comma — "1998, salary" — which is punctuation, not a digit.)"""
    digits, suffix = match.group(1), match.group(2)
    if suffix or not _PAY_YEAR_RE.fullmatch(digits.rstrip(",")):
        return False
    return not (
        _PAY_CURRENCY_BEFORE_RE.search(message[: match.start()])
        or _PAY_CURRENCY_AFTER_RE.match(message, match.end())
    )


def _pay_figures(message: str) -> list[_PayFigure]:
    """Every pay figure ``message`` states, in order. A range is ONE figure; any other
    amount that scales into the monthly window is one more. A figure below the floor
    ("5 welders", "8 hours") or a bare year is not pay and is not a figure."""
    figures: list[_PayFigure] = []
    residue = message
    for match in _PAY_RANGE_RE.finditer(message):
        low_s, low_x, high_s, high_x = match.groups()
        if (
            not (low_x or high_x)
            and _PAY_YEAR_RE.fullmatch(low_s.rstrip(","))
            and _PAY_YEAR_RE.fullmatch(high_s.rstrip(","))
        ):
            continue  # "1998-2005" is a span of years; its halves are screened below
        low = _scale(low_s, low_x, high_x)
        high = _scale(high_s, high_x, low_x)
        if low is not None and high is not None:
            figures.append(
                _PayFigure(match.start(), match.end(), min(low, high), max(low, high), True)
            )
        elif low is not None or high is not None:
            single = low if low is not None else high
            assert single is not None
            figures.append(_PayFigure(match.start(), match.end(), single, None, True))
        else:
            continue  # neither half is pay: its digits stay for the amount scan
        # Blanked with spaces of the same length, so every later span stays true.
        residue = (
            residue[: match.start()] + " " * (match.end() - match.start()) + residue[match.end() :]
        )
    for match in _AMOUNT_RE.finditer(residue):
        value = _scale(match.group(1), match.group(2), None)
        if value is None or _is_bare_year(residue, match):
            continue
        figures.append(_PayFigure(match.start(), match.end(), value, None, False))
    return sorted(figures, key=lambda figure: figure.start)


def _pay_clause(message: str, figure: _PayFigure) -> str:
    """The clause ``figure`` sits in. A boundary INSIDE the figure ("between 18000 and
    22000") is neither before nor after it, so it never splits a range."""
    start, end = 0, len(message)
    for boundary in _PAY_CLAUSE_BOUNDARY_RE.finditer(message):
        if boundary.end() <= figure.start:
            start = boundary.end()
        elif boundary.start() >= figure.end:
            end = boundary.start()
            break
    return message[start:end]


def _parse_pay(text: str, *, require_cue: bool) -> dict[str, int | None] | None:
    """Parse a monthly pay answer into ``{"pay_min": int, "pay_max": int | None}``.

    An amount in an ADD-ON clause (bonus, OT, allowance, PF...) is dropped, and so is a
    bare year; two figures on different bases record nothing (see the regexes above).
    """
    message = text or ""
    if require_cue and not _MONEY_CUE_RE.search(message):
        return None
    figures = _pay_figures(message)
    kept = [f for f in figures if not _PAY_ADDON_RE.search(_pay_clause(message, f))]
    if len(kept) > 1 and any(basis.search(message) for basis in _PAY_BASIS_KINDS.values()):
        return None

    # 1. A RANGE wins outright — it is the one place a multiplier may travel.
    for figure in kept:
        if figure.from_range:
            return {"pay_min": figure.low, "pay_max": figure.high}

    # 2. Otherwise every amount stands alone with its OWN suffix. A bare number
    #    below the floor ("8 hours", "5 welders") was never a figure at all.
    amounts = sorted({figure.low for figure in kept})
    if not amounts:
        return None
    return {"pay_min": amounts[0], "pay_max": amounts[-1] if len(amounts) > 1 else None}


# --- Pay type (#1726; an allowlist since #1727 round 3) ------------------------------
# ANSWERED DIRECTLY — the pay-type question on screen. The WHOLE answer must be one of
# these (optionally "it is ..." / "... salary"). No shape contains a digit, so an answer
# with ANY digit records nothing: a restated figure ("in hand 18k") may describe a
# different band than the one collected (R31). No negation handling exists because none
# is needed — "not CTC" is simply not a shape.
_PAY_TYPE_ANSWER_RES: dict[str, re.Pattern[str]] = {
    kind: re.compile(
        r"(?:(?:it\s+is|its|it's|salary\s+is|pay\s+is)\s*)?(?:" + body + r")(?:\s*(?:salary|pay))?"
    )
    for kind, body in (
        (
            "in_hand",
            r"in\s*-?\s*hand|inhand|take\s*-?\s*home|net|net\s+(?:salary|pay)|haath\s+me(?:in)?",
        ),
        ("gross", r"gross"),
        ("ctc", r"ctc|c\.?t\.?c\.?|cost\s+to\s+company"),
    )
}


def _parse_pay_type(text: str) -> str | None:
    """The answer to "Is that pay in-hand, gross or CTC?" — a whole-answer match only."""
    answer = _normalise(text)
    kinds = [kind for kind, shape in _PAY_TYPE_ANSWER_RES.items() if shape.fullmatch(answer)]
    return kinds[0] if len(kinds) == 1 else None


# READ IN PASSING — usually the pay answer itself ("20-25k in hand"). Recorded only when
# the message states EXACTLY ONE pay figure, that figure is the band this same message
# recorded, and the cue is ATTACHED to it: "<figure>[ per month][,] <cue>" or "<cue>[:]
# [Rs] <figure>". "in hand" the SKILL ("good in hand tools") is not the pay cue.
_IN_HAND_SKILL_NOUNS = r"tools?|work|grinding|skills?|experience|machines?|operations?|job"
_PAY_TYPE_CROSS_CUES: dict[str, str] = {
    "in_hand": (
        r"in\s*-?\s*hand(?![\s-]+(?:" + _IN_HAND_SKILL_NOUNS + r")(?![A-Za-z0-9]))|inhand|"
        r"take\s*-?\s*home|net\s+(?:salary|pay)"
    ),
    "gross": r"gross\s+(?:salary|pay)",
    "ctc": r"ctc|c\.t\.c\.?|cost\s+to\s+company",
}
_PAY_TYPE_AFTER_RES: dict[str, re.Pattern[str]] = {
    kind: re.compile(
        r"\s*,?\s*(?:(?:per\s+month|pm|p\.m\.?|monthly|/\s*month)(?![a-z]))?\s*,?\s*" + _cue(body)
    )
    for kind, body in _PAY_TYPE_CROSS_CUES.items()
}
_PAY_TYPE_BEFORE_RES: dict[str, re.Pattern[str]] = {
    kind: re.compile(_cue(body) + r"\s*[:\-]?\s*(?:(?:rs\.?|₹|inr)\s*)?$")
    for kind, body in _PAY_TYPE_CROSS_CUES.items()
}
# Anything that can NEGATE, QUALIFY or ADD TO the figure the cue is attached to: "20k,
# CTC nhi", "20k in hand before PF", "2000 incentive in hand" (#1727 F9/R30/R32).
_PAY_TYPE_REFUSE_RE = re.compile(
    _cue(
        r"not|no|non|without|nahi|nhi|nahin|nai|ni|na|never|isnt|dont|doesnt|cannot|mat|bina|"
        r"except|excluding|[a-z]+n't|"
        r"bonus(?:es)?|allowances?|incentives?|overtime|ot|extra|increments?|hikes?|"
        r"before|after|including|incl|inclusive|deduct\w*|minus|less"
    ),
    re.IGNORECASE,
)


def _cross_topic_pay_type(text: str, band: object) -> str | None:
    """A pay type stated in passing, for the ``band`` this same message recorded."""
    message = _WS_RE.sub(" ", _DASHES_RE.sub("-", (text or "").lower()))
    if _PAY_TYPE_REFUSE_RE.search(message):
        return None
    figures = _pay_figures(message)
    if len(figures) != 1:
        return None
    figure = figures[0]
    # The type describes the band THIS message recorded — never a figure that recorded
    # nothing (an allowance, a bonus, a cue-less amount) and never another band (R30).
    if band != {"pay_min": figure.low, "pay_max": figure.high}:
        return None
    attached = {
        kind
        for kind in _PAY_TYPE_CROSS_CUES
        if _PAY_TYPE_AFTER_RES[kind].match(message, figure.end)
        or _PAY_TYPE_BEFORE_RES[kind].search(message[: figure.start])
    }
    named = {kind for kind, basis in _PAY_BASIS_KINDS.items() if basis.search(message)}
    if len(attached) != 1 or named != attached:
        return None
    return attached.pop()


# --- Shift -----------------------------------------------------------------
_SHIFT_DAY_RE = re.compile(r"\b(?:day|general|morning|gen)\b(?:\s*shift)?", re.IGNORECASE)
_SHIFT_NIGHT_RE = re.compile(r"\bnight\b(?:\s*shift)?", re.IGNORECASE)
_SHIFT_ROTATIONAL_RE = re.compile(
    r"\brotat(?:ional|ing|ion|e)\b|\b(?:2|3|two|three)\s*shift", re.IGNORECASE
)


def _parse_shift(text: str, *, require_cue: bool) -> str | None:
    """Map a shift answer onto the closed ``jobs.shift`` enum.

    ``require_cue`` (the cross-topic path) demands the word "shift" somewhere in the
    message. Without it "candidates need general knowledge" and "6 days a week"
    would set a shift the employer never stated — bare "day"/"morning"/"general" are
    only trustworthy as the answer to the shift question itself.
    """
    message = text or ""
    if _SHIFT_ROTATIONAL_RE.search(message):
        return "rotational"
    if require_cue and not re.search(r"\bshifts?\b", message, re.IGNORECASE):
        return None
    day = bool(_SHIFT_DAY_RE.search(message))
    night = bool(_SHIFT_NIGHT_RE.search(message))
    if day and night:
        return "rotational"  # "day and night shifts" is a rotation
    if night:
        return "night"
    if day:
        return "day"
    return None


# --- Experience (#1726; an allowlist since #1727 round 3) --------------------------
# Stored as ``{"min": int | None, "max": int | None}`` — "5+ years" has no max, "up to
# 2 years" has no min. The answer to the experience question is recorded only when the
# WHOLE normalised answer is one of the shapes below; read in passing, only a CLAUSE that
# is wholly one of them AND names experience counts. The clause-splitting, age/tenure
# screens and bound detector this replaces still recorded "Not less than 3 years" as "up
# to 3" and "6 months to 1 year" as "1+" — a shape list cannot be surprised that way.
_Window = dict[str, int | None]


def _years_num(name: str) -> str:
    """A whole number of years: never half of "1.5", never the "22" of "22,000"."""
    return rf"(?<![\d.])(?<!\d,)(?P<{name}>\d{{1,2}})(?![\d.])(?!,\d)"


_YEAR_UNIT = r"(?:years?|yrs?|saal|sal)(?![a-z])"
_EXP_WORD = r"(?:of\s+)?(?:experience|experienced|exp)(?![a-z])"
_EXP_WORD_RE = re.compile(_cue(r"experience|experienced|exp"))
# What may wrap a shape: "need 3 years", "experience: 2-5 years", "3 years experience
# required". The lead is captured so a "minimum experience" lead can never front a MAX.
_EXP_LEAD = (
    r"(?P<lead>(?:we\s+need|need|required|require|looking\s+for|candidates?\s+with|"
    r"should\s+have|must\s+have|minimum\s+experience|experience(?:\s+required)?|exp)"
    r"(?![a-z])\s*[:\-]?\s*)?"
)
_EXP_TRAIL = r"(?:\s*" + _EXP_WORD + r")?(?:\s+(?:required|needed|preferred|chahiye))?"
_EXP_SHAPE_BODIES: tuple[tuple[str, str], ...] = (
    # "2-5 years", "2 to 5 yrs", Hinglish "2 se 5 saal" -> (a, b), only when a <= b.
    ("span", _years_num("a") + r"\s*(?:-|to|se)\s*" + _years_num("b") + r"\s*" + _YEAR_UNIT),
    # Floors -> min.
    ("floor", _years_num("a") + r"\s*(?:\+|plus)(?:\s*" + _YEAR_UNIT + r")?"),
    ("floor", _years_num("a") + r"\s*" + _YEAR_UNIT + r"\s*(?:\+|plus|or\s+more|and\s+above)"),
    (
        "floor",
        r"(?:minimum|min|at\s*least|atleast|kam\s+se\s+kam)\s*"
        + _years_num("a")
        + r"\s*"
        + _YEAR_UNIT,
    ),
    ("floor", _years_num("a") + r"\s*" + _YEAR_UNIT + r"\s*(?:minimum|min)"),
    # Ceilings -> max. A strict comparative is the payer's own number, inclusive: "less
    # than 3 years" records max 3 (pinned), never an invented 2.
    (
        "ceiling",
        r"(?:up\s*to|upto|maximum|max|at\s+most|less\s+than|under|below)\s*"
        + _years_num("b")
        + r"\s*"
        + _YEAR_UNIT,
    ),
    ("ceiling", _years_num("b") + r"\s*" + _YEAR_UNIT + r"\s*(?:maximum|max|tak)"),
    # A bare "3 years" -> min.
    ("floor", _years_num("a") + r"\s*" + _YEAR_UNIT),
    # Freshers welcome -> (0, None). A refusal ("no freshers", "fresher nhi chahiye") is
    # simply not one of these shapes.
    (
        "fresher",
        r"freshers?(?:\s+(?:ok|okay|welcome|can\s+apply|also|chalega|chalenge))?|"
        r"no\s+experience(?:\s+(?:needed|required))?|experience\s+not\s+required",
    ),
    # "fresher or up to 2 years" -> (0, 2).
    (
        "fresher",
        r"freshers?\s+(?:or|to|-)\s*(?:up\s*to\s*)?" + _years_num("b") + r"\s*" + _YEAR_UNIT,
    ),
)
_EXP_SHAPES: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (kind, re.compile(_EXP_LEAD + r"(?:" + body + r")" + _EXP_TRAIL))
    for kind, body in _EXP_SHAPE_BODIES
)
# The answer that is ONLY a number ("3") -> min. No lead, no trail: "need 3" may be people.
_EXP_ONLY_NUMBER_RE = re.compile(_years_num("a"))

# READ IN PASSING. Clauses end at , ; newline and a sentence break ". ".
_EXP_CLAUSE_SPLIT_RE = re.compile(r"[,;\n]|\.\s")
# A clause that is NOT itself a qualifying shape but could change what one means: a
# bound, a negation, a year/month figure or an experience/fresher word. "3 years
# experience, max" and "3 years experience. Not more than that" must never become min 3.
_EXP_SIBLING_RE = re.compile(
    _cue(
        r"years?|yrs?|saal|sal|months?|mahin[ae]|max|maximum|min|minimum|least|atleast|most|"
        r"up\s*to|upto|less|lesser|more|above|below|under|over|within|tak|kam|kum|zyada|upar|"
        r"neeche|niche|andar|plus|limit|exceed\w*|not|no|non|nahi|nahin|nhi|nai|never|"
        r"cannot|[a-z]+n't|dont|freshers?|experience|experienced|exp"
    )
    + r"|[+<>]"
)
# The employer's OWN history, anywhere in the message: "Established in 1995, 28 years
# experience, need welders" is the company's tenure, not the candidate's (#1727 F0/R4).
_EXP_TENURE_RE = re.compile(
    _cue(
        r"established|estd|founded|since|company|companies|firm|industry|business|"
        r"manufacturer|manufacturing|organi[sz]ation|we\s+are|we\s+have|we've|we're|our|"
        r"hamar\w*|humar\w*|has|having"
    )
)
# ...and a requirement read in passing above this is far likelier to be tenure or an age
# ("ABC Forgings, 30 years experience") than a blue-collar requirement. Skipping it costs
# nothing: experience is a must-ask, so the question is then served.
_CROSS_TOPIC_MAX_YEARS = 15


def _experience_shape(text: str) -> tuple[_Window, bool] | None:
    """The window ``text`` states when it is WHOLLY one known shape, and whether it names
    experience itself (an experience word, or a fresher form). None otherwise."""
    only = _EXP_ONLY_NUMBER_RE.fullmatch(text)
    if only is not None:
        low = int(only.group("a"))
        return ({"min": low, "max": None}, False) if low <= EXPERIENCE_MAX_YEARS else None
    for kind, shape in _EXP_SHAPES:
        match = shape.fullmatch(text)
        if match is None:
            continue
        found = match.groupdict()
        low = int(found["a"]) if found.get("a") else (0 if kind == "fresher" else None)
        high = int(found["b"]) if found.get("b") else None
        if any(v > EXPERIENCE_MAX_YEARS for v in (low, high) if v is not None):
            return None
        if low is not None and high is not None and low > high:
            return None
        if kind == "ceiling" and "minimum" in (match.group("lead") or ""):
            return None  # "minimum experience up to 3 years" contradicts itself
        named = kind == "fresher" or bool(_EXP_WORD_RE.search(text))
        return {"min": low, "max": high}, named
    return None


def _parse_experience(text: str, *, require_cue: bool) -> _Window | None:
    """Parse a years-of-experience window.

    Attributed (the experience question on screen): the WHOLE normalised answer must be
    one shape. Cross-topic (``require_cue``): exactly one DISTINCT window from the clauses
    that are wholly a shape AND name experience ("3 years experience", "experience: 2-5
    years", "freshers welcome"); nothing when another clause could modify it, when the
    message speaks of the employer's own history, or when the window is implausibly high.
    """
    message = _normalise(text)
    if not message:
        return None
    if not require_cue:
        read = _experience_shape(message)
        return read[0] if read is not None else None
    if _EXP_TENURE_RE.search(message):
        return None
    windows: set[tuple[int | None, int | None]] = set()
    for raw_clause in _EXP_CLAUSE_SPLIT_RE.split(message):
        clause = _normalise(raw_clause)
        if not clause:
            continue
        read = _experience_shape(clause)
        if read is not None and read[1]:
            windows.add((read[0]["min"], read[0]["max"]))
        elif _EXP_SIBLING_RE.search(clause):
            return None
    if len(windows) != 1:
        return None
    low, high = windows.pop()
    if any(v > _CROSS_TOPIC_MAX_YEARS for v in (low, high) if v is not None):
        return None
    return {"min": low, "max": high}


# --- Needed by (#1726; an allowlist since #1727 round 3) ---------------------------
# The WHOLE normalised answer must be one of these, optionally led by "joining" / "need"
# / "start"... and trailed by "joining" / "only" / "please" / "se". Negation, contrast,
# uncertainty and per-period frequency ("6 days a week") are simply not shapes, so none of
# them needs handling — each negation screen the earlier rounds added was one more place
# for "no urgent requirement" to become "immediate". Attributed only.
_NEEDED_LEAD = (
    r"(?:(?:joining\s+date|joining|join|we\s+need\s+them|needed|need|required|can\s+join|"
    r"should\s+join|starting|start)(?![a-z])\s*[:\-]?\s*)?"
)
_NEEDED_TRAIL = r"(?:\s*(?:joining|only|please|se)(?![a-z]))?"
_NEEDED_SHAPE_BODIES: tuple[tuple[str, str], ...] = (
    (
        "immediate",
        r"immediate(?:ly)?(?:\s+joining)?|asap|as\s+soon\s+as\s+possible|urgent(?:ly)?|"
        r"urgent\s+requirement|right\s+(?:away|now)|today|tomorrow|this\s+week|turant|abhi|"
        r"jaldi\s+se\s+jaldi",
    ),
    (
        "soon",
        r"soon|within\s+(?:a|one|1)\s+(?:week|month)|next\s+(?:week|month)|this\s+month|"
        r"(?:a|one|1|ek)\s+(?:month|mahina|mahine|hafta|hafte)|(?:a\s+)?few\s+(?:days|weeks)|"
        r"jaldi",
    ),
    (
        "flexible",
        r"flexible|no\s+hurry|no\s+rush|no\s+urgency|any\s*time|whenever|not\s+urgent|"
        r"not\s+in\s+a\s+hurry|koi\s+jaldi\s+nahi|jaldi\s+nahi|urgent\s+nahi",
    ),
)
_NEEDED_SHAPES: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (kind, re.compile(_NEEDED_LEAD + r"(?:" + body + r")" + _NEEDED_TRAIL))
    for kind, body in _NEEDED_SHAPE_BODIES
)
# A COUNTED timeline is "soon" only inside the bounds: 1..59 days, 1..7 weeks. Two months
# or more ("2 months", "60 days", "8 weeks") fits no enum value, so it is not a shape.
_NEEDED_COUNTED_RES: tuple[re.Pattern[str], ...] = (
    re.compile(
        _NEEDED_LEAD
        + r"(?:(?:in|within|next)\s*)?(?P<n>\d{1,2})\s*(?P<unit>days?|weeks?|din|hafte|haftey)"
        + _NEEDED_TRAIL
    ),
    re.compile(
        _NEEDED_LEAD + r"(?P<n>\d{1,2})\s*-\s*(?P<m>\d{1,2})\s*(?P<unit>days|weeks)" + _NEEDED_TRAIL
    ),
)
_NEEDED_MAX_DAYS = 59
_NEEDED_MAX_WEEKS = 7


def _counted_soon(answer: str) -> bool:
    """Is ``answer`` wholly a counted timeline inside the "soon" bounds?"""
    for shape in _NEEDED_COUNTED_RES:
        match = shape.fullmatch(answer)
        if match is None:
            continue
        counts = [int(match.group("n"))]
        if "m" in match.groupdict():
            counts.append(int(match.group("m")))
        limit = _NEEDED_MAX_DAYS if match.group("unit").startswith("d") else _NEEDED_MAX_WEEKS
        return all(1 <= count <= limit for count in counts) and counts == sorted(counts)
    return False


def _parse_needed_by(text: str) -> str | None:
    """Map a joining-timeline answer onto the closed ``jobs.needed_by`` set."""
    answer = _normalise(text)
    kinds = [kind for kind, shape in _NEEDED_SHAPES if shape.fullmatch(answer)]
    if _counted_soon(answer):
        kinds.append("soon")
    return kinds[0] if len(set(kinds)) == 1 else None


# --- Role title / location -------------------------------------------------
_ROLE_CUE_RE = re.compile(
    r"\b(?:hiring|hire|need|needs|require|requires|looking for|want|wanted|"
    r"recruiting|opening for|vacancy for|post(?:ing)? for)\b\s+"
    r"(?:\d+\s+)?(?:a|an|some|few|the)?\s*"
    r"([A-Za-z][\w./&+-]*(?:\s+[A-Za-z][\w./&+-]*){0,4})",
    re.IGNORECASE,
)
# Where a captured label phrase stops. "5 CNC operators in Pune at 20k" must yield
# "CNC operators", and "the plant is in Chakan for a client" must yield "Chakan".
_LABEL_TAIL_RE = re.compile(
    r"\s+\b(?:in|at|for|with|on|near|from|starting|salary|pay|shift|urgently|"
    r"immediately|asap)\b.*$",
    re.IGNORECASE,
)
_LOCATION_CUE_RE = re.compile(
    r"\b(?:in|at|near|based in|located in|location is|city is|plant is in|site is in)\s+"
    r"([A-Za-z][\w.-]*(?:[,\s]+[A-Za-z][\w.-]*){0,2})",
    re.IGNORECASE,
)
# A label answer longer than this is a sentence, not a title/city. We would rather
# re-ask than stamp a paragraph into `role_title`.
_MAX_LABEL_WORDS = 8
# What a CUE-EXTRACTED label may not be. "I want to post a job" satisfies the role
# cue ("want ...") and yields "to post a job" — a grammatical capture that is not a
# job title. Rejecting it sends the topic back to the normal ask instead. So does a
# capture that starts with a UNIT or a connector: the cue skips a number, so "Welder,
# need 5 years experience" captured the role title "years experience" (#1727 R17).
_LABEL_REJECT_RE = re.compile(
    r"^(?:to|that|this|it|some|any|your|our|my)\b|^(?:job|jobs|posting|post|role|work)$|"
    r"^(?:years?|yrs?|saal|months?|mahine|weeks?|days?|hours?|hrs?|or|plus|and|se|"
    r"experience|exp)\b",
    re.IGNORECASE,
)


def _parse_label(text: str, cue: re.Pattern[str] | None, *, allow_bare: bool) -> str | None:
    """Cue-first, then (only when the topic was actually ASKED) the bare answer.

    ``allow_bare=False`` is the cross-topic posture: without the cue we record
    nothing rather than guessing that a passing phrase is a job title or a city.
    """
    message = (text or "").strip()
    if not message:
        return None
    if cue is not None:
        match = cue.search(message)
        if match:
            label = _clean_label(_LABEL_TAIL_RE.sub("", match.group(1)))
            if label and not _LABEL_REJECT_RE.match(label):
                return label
    if not allow_bare:
        return None
    if _CHATTER_RE.match(message):
        return None
    if len(message.split()) > _MAX_LABEL_WORDS:
        return None
    return _clean_label(message)


# --- City (#1726; the closed gazetteer ONLY since #1727 round 3) -------------------
# A card city is recorded only when it IS a gazetteer city — the same closed vocabulary
# the worker side filters on. There is no free-text fallback: a bare label ("Chakan",
# "Thane-West", "mentioned above", "Gujarat") matches no worker's city filter while NULL
# matches all, and two review rounds of denylists never closed the non-answers. An
# unmatched city stays unanswered — the bounded re-ask, then NULL; the API reports it in
# `unset_card_fields` and the payer fills it on the edit form at publish.
_CITY_TOKENS: frozenset[str] = frozenset(
    _WS_RE.sub(" ", token.lower()) for token in (*KNOWN_CITIES, *CITY_ALIASES)
)
# Words that frame a place without being part of its name: "near Pune", "Pune city",
# "Nashik district", "Pune only". Stripped from the ENDS of a part, never its middle.
_CITY_FILLERS: frozenset[str] = frozenset(
    {"near", "in", "city", "district", "dist", "dt", "the", "only"}
)
# The city question's own lead-in ("It is in Pune").
_CITY_ANSWER_LEAD_RE = re.compile(r"^(?:it\s+is|it's|its)\s+in\s+")
# Anything that makes a named city something OTHER than "the workplace is here": a
# negation or exclusion ("Not Mumbai, Thane"), an alternative ("Pune, or Mumbai"),
# uncertainty ("Pune, not sure", "Pune, maybe") or a spread ("Pune, all areas").
_CITY_QUALIFIER_RE = re.compile(
    _cue(
        r"not|nahi|nahin|nhi|nai|except|excluding|instead|other\s+than|alawa|chhod\w*|or|ya|"
        r"either|and|aur|maybe|shayad|probably|perhaps|possibly|tentative\w*|sure|decided|"
        r"final|fixed|confirm\w*|tb[ad]|later|depends|pata|idea|multiple|many|various|"
        r"several|any\w*|all"
    )
)
# The ROLE a place plays. Two roles ("Office in Delhi, factory in Manesar", "Interview in
# Pune, job at Satara") are two places even when only one is in the gazetteer — the one
# that is may be the office, not the job (#1727 F4/R22/R28). So is one role beside a
# second comma part ("Satara, interview in Pune").
_CITY_ROLE_RE = re.compile(
    _cue(
        r"head\s+office|office|ho|hq|headquarters?|registered|corporate|company|plant|factory|"
        r"site|unit|branch|warehouse|godown|workshop|facility|work|job|kaam|duty|interview|"
        r"joining|posting"
    )
)


def _title_case(value: str) -> str:
    """The TypeScript gazetteer's ``titleCase``, character for character."""
    return re.sub(r"[A-Za-z]+", lambda m: m[0][0].upper() + m[0][1:].lower(), value)


def _city_of_part(part: str) -> str | None:
    """The canonical city ``part`` IS — once its framing fillers are stripped — or None.
    "near Pune" is Pune; "Old Delhi Road" and "Delhi-Jaipur highway" are not Delhi."""
    words = _normalise(part).split()
    while words and words[0] in _CITY_FILLERS:
        words.pop(0)
    while words and words[-1] in _CITY_FILLERS:
        words.pop()
    token = " ".join(words)
    if token not in _CITY_TOKENS:
        return None
    return _title_case(CITY_ALIASES.get(token, token))


def _one_city(parts: list[str]) -> str | None:
    """The ONE distinct gazetteer city among ``parts``; none, or several, is None."""
    cities = {city for part in parts if (city := _city_of_part(part)) is not None}
    return cities.pop() if len(cities) == 1 else None


def _city_ambiguous(message: str) -> bool:
    """Does ``message`` name a place in a way that is not simply "the workplace"?"""
    text = _normalise(message)
    roles = len(_CITY_ROLE_RE.findall(text))
    parts = [part for part in text.split(",") if part.strip()]
    return bool(_CITY_QUALIFIER_RE.search(text)) or roles > 1 or (roles == 1 and len(parts) > 1)


def _parse_city(text: str) -> str | None:
    """The answer to the city question: a gazetteer city, or nothing.

    The whole answer (its lead-in and fillers stripped) must BE a gazetteer city; a
    comma list is read part by part and must name exactly one.
    """
    if _city_ambiguous(text):
        return None
    answer = _CITY_ANSWER_LEAD_RE.sub("", _normalise(text))
    if "," in answer:
        return _one_city(answer.split(","))
    return _city_of_part(answer)


# --- Topic dispatch --------------------------------------------------------
# Topics whose value must be PARSED to count as answered. A refusal ("no") on one of
# these leaves it unanswered on purpose — see _REFUSAL_RE.
_VALUE_REQUIRED: frozenset[str] = frozenset({"role_title", "location_label", "city", "vacancy"})

# The ONLY topics read cross-topic (i.e. when a DIFFERENT question was on screen).
# Each needs an explicit cue. Everything else is attribution-only.
_CROSS_TOPIC: tuple[str, ...] = ("vacancy", "pay_range", "shift", "pay_type", "experience")

# Cross-topic reads SKIPPED for one question's answer. The DESCRIPTION is prose about
# the employer — exactly where a company's own tenure lives ("25 years in forging, we
# make gears") — and by the time it is asked the experience question has already been
# served, so a figure there is far likelier to be tenure than a requirement the payer
# forgot to give. Measured recording min 25 / min 20 from description prose (#1727 F0).
_NOT_READ_CROSS_TOPIC_FROM: dict[str, frozenset[str]] = {
    "description": frozenset({"experience"}),
}


def _parse_topic(topic_id: str, text: str, *, attributed: bool) -> object | None:
    """Parse ``text`` as an answer to ``topic_id``. ``None`` = nothing recorded.

    ``pay_type`` read in passing is not dispatched here: it needs the band the same
    message recorded (see :func:`detect_answers`).
    """
    if topic_id == "role_title":
        return _parse_label(text, _ROLE_CUE_RE, allow_bare=attributed)
    if topic_id == "location_label":
        return _parse_label(text, _LOCATION_CUE_RE, allow_bare=attributed)
    if topic_id == "city":
        return _parse_city(text) if attributed else None
    if topic_id == "vacancy":
        return _parse_vacancy(text, require_cue=not attributed)
    if topic_id == "pay_range":
        return _parse_pay(text, require_cue=not attributed)
    if topic_id == "pay_type":
        return _parse_pay_type(text) if attributed else None
    if topic_id == "experience":
        return _parse_experience(text, require_cue=not attributed)
    if topic_id == "shift":
        return _parse_shift(text, require_cue=not attributed)
    if topic_id == "needed_by":
        return _parse_needed_by(text) if attributed else None
    if topic_id == "skills":
        phrases = _split_phrases(text, MAX_SKILLS)
        return phrases or None
    if topic_id in ("benefits", "requirements"):
        phrases = _split_phrases(text)
        return phrases or None
    if topic_id == "description":
        return _clean_label(text, DESCRIPTION_MAX)
    return None


def detect_answers(message: str, last_asked: str | None) -> dict[str, object | None]:
    """What did the payer just answer?

    Returns ``{topic_id: value}``. A value of ``None`` means ANSWERED WITH NOTHING
    (an explicit refusal on a non-essential topic) — the topic is closed but nothing
    is recorded. A topic absent from the mapping was not answered at all.

    Local only. Never calls the network, never mutates its inputs.
    """
    text = (message or "").strip()
    if not text or not _HAS_ALNUM_RE.search(text):
        return {}
    # A QUESTION back is never an answer. Without this the attribution rule records
    # "what do you mean?" as the location and closes the topic — and it also defeats
    # the clarify path, whose answer-trumps-clarify guard would see a "detected
    # answer" and refuse to re-serve. Deliberately NOT the whole of
    # `needs_rephrase`: a short "?"-suffixed reply ("Pune?", "2-5?") is an uncertain
    # ANSWER and must still advance the engine.
    if _is_question_shaped(text):
        return {}

    found: dict[str, object | None] = {}

    # 1. Attribution — the question that was actually on screen.
    if last_asked:
        if _REFUSAL_RE.match(text):
            if last_asked not in _VALUE_REQUIRED:
                found[last_asked] = None
        else:
            value = _parse_topic(last_asked, text, attributed=True)
            if value is not None and _is_recordable(last_asked, value):
                found[last_asked] = value

    # 1b. The location answer names the city too ("Pune, Chakan"). Read from the location
    #     label the parser CHOSE, part by part: a comma part counts only when it IS a
    #     gazetteer city ("Old Delhi Road, Gurgaon" is Gurugram — "Old Delhi Road" is a
    #     road), and exactly one distinct city must remain. Never when the message names
    #     a place ambiguously ("Office in Delhi, factory in Manesar"), and never a read of
    #     a stored location_label, which the worker feed deliberately does not see.
    location = found.get("location_label")
    if (
        last_asked == "location_label"
        and isinstance(location, str)
        and "city" not in found
        and not _city_ambiguous(text)
    ):
        city = _one_city(location.split(","))
        if city is not None:
            found["city"] = city

    # 2. The cue-gated cross-topic extractors. A pay TYPE read in passing must describe
    #    the band this same message recorded — never a bonus, an allowance or a figure
    #    that recorded nothing (#1727 R30).
    skipped = _NOT_READ_CROSS_TOPIC_FROM.get(last_asked or "", frozenset())
    for topic_id in _CROSS_TOPIC:
        if topic_id in found or topic_id == last_asked or topic_id in skipped:
            continue
        if topic_id == "pay_type":
            value = _cross_topic_pay_type(text, found.get("pay_range"))
        else:
            value = _parse_topic(topic_id, text, attributed=False)
        if value is not None and _is_recordable(topic_id, value):
            found[topic_id] = value
    return found


_QUESTION_SHAPED_RE = re.compile(
    r"^(?:what|why|how|which|who|whom|when|where|can you|could you|do you|are you|"
    r"is this|kya|matlab)\b",
    re.IGNORECASE,
)


def _is_question_shaped(text: str) -> bool:
    """The payer is asking US something, so there is nothing to record."""
    lowered = text.lower()
    return bool(_QUESTION_SHAPED_RE.match(lowered)) or any(
        marker in lowered for marker in _REPHRASE_MARKERS
    )


def _is_recordable(topic_id: str, value: object) -> bool:
    """Reject a value that is nothing but a pseudonymization placeholder.

    When a turn carried identity-shaped content the MASKED text is what reaches this
    detector (see :func:`safe_draft_text`). Storing "[PERSON_1], Chakan" as
    ``location_label`` — and marking the topic ANSWERED, closing it — would be
    strictly worse than recording nothing: the payer would never be asked again and
    the posting would publish with a token as its location. Only the
    value-required topics are guarded; on the free-text topics the visible token is
    the POINT, since ``clarification_questions`` then tells the payer to retype it.
    """
    if topic_id not in _VALUE_REQUIRED:
        return True
    return not (isinstance(value, str) and PLACEHOLDER_TOKEN_RE.search(value))


# --- Turn-shape predicates -------------------------------------------------
_CORRECTION_RE = re.compile(
    r"\b(?:no no|sorry|actually|correction|i meant|i mean|change that|scratch that|"
    r"make that|instead|not that|galat|nahi nahi)\b",
    re.IGNORECASE,
)


def is_correction(message: str) -> bool:
    """True when the payer is explicitly overriding an earlier answer.

    Lets a deliberate correction overwrite an established value (see the engine's
    ``_may_commit`` rule 2) without letting an incidental later mention do so.
    """
    return bool(_CORRECTION_RE.search(message or ""))


# Clarification markers — INTERROGATIVE phrases, never a bare word that also occurs
# in a straight answer. Kept tight because the cost is asymmetric: a false positive
# re-serves a question the payer already answered.
_REPHRASE_MARKERS = (
    "what do you mean",
    "what does that mean",
    "i don't understand",
    "i dont understand",
    "not clear",
    "unclear",
    "can you repeat",
    "please repeat",
    "say that again",
    "come again",
    "explain that",
    "can you explain",
    "what is this",
    "matlab kya",
    "samajh nahi",
)
_MAX_CLARIFY_QUESTION_WORDS = 4


def needs_rephrase(message: str) -> bool:
    """Conservative LOCAL predicate: is the payer asking us to clarify?

    Never calls the network. A SHORT question back ("which shift?") counts; a long
    answer that happens to end uncertainly does not — treating that as a clarify
    request would eat a real answer.
    """
    text = (message or "").strip().lower()
    if not text:
        return False
    if text.endswith("?") and len(text.split()) <= _MAX_CLARIFY_QUESTION_WORDS:
        return True
    return any(marker in text for marker in _REPHRASE_MARKERS)


# --- Draft-text safety -----------------------------------------------------
# Placeholder classes that mean the payer typed IDENTITY-shaped content. The masked
# text is used for the draft in that case, so a personal name, an email address, a
# phone number, a credential id or a company name can never be carried into the
# persisted draft (and from there into a published posting). CITY / STATE / AMOUNT
# are deliberately NOT here: a job's city and its pay are the whole point of the
# posting, and the raw value is what the payer must see.
#
# EMAIL WAS MISSING FROM THIS LIST AND THAT WAS AN OMISSION, NOT A DECISION — every
# other class here is argued for or against by name in this comment and email was
# simply absent. An email address is the same class as a phone: a direct contact
# channel that routes around the unlock, and the one thing a published posting must
# not carry. Found by the ai-engineer review of the leading-name city carve-out
# (R6): masking a leading city used to mint a [PERSON_n] token INCIDENTALLY, which
# armed this gate and masked the email beside it. That accident is gone, so the gap
# it was hiding is now the only thing standing between a typed address and a
# published posting. It was never a real mitigation — any message not starting
# "Word," already drafted the address raw.
#
# This REUSES the shipped gateway's own classification rather than adding a second,
# oppositely-tuned mask profile — which ADR-0035 §Decision 3 explicitly rejects.
_IDENTITY_TOKEN_RE = re.compile(r"^\[(?:PHONE|PERSON|EMPLOYER|EMAIL|ID)_\d+\]$")
# Matches ANY placeholder token, used to tell the payer which field to retype.
PLACEHOLDER_TOKEN_RE = re.compile(r"\[[A-Z]+_\d+\]")


def carries_identity(placeholder_tokens: list[str] | None) -> bool:
    """True when this turn's pseudonymization masked an identity-class entity."""
    return any(_IDENTITY_TOKEN_RE.match(token or "") for token in (placeholder_tokens or []))


# A dashed PAY RANGE the phone rule claims (#1731). "20000-25000" is ten digits joined by one
# separator — to the gateway's shape-only phone rule (R30, owner-accepted) it IS a phone, and a
# real one ("98765-43210") has exactly that shape, so the GATEWAY cannot tell them apart and is
# not asked to: it still masks every such run before anything leaves the process. What changes is
# only what the job chat's own DRAFT keeps (this route makes no model call). A run counts as a
# money range when it is exactly two amounts joined by a dash, ascending, the upper at most
# `_MONEY_RANGE_MAX_RATIO` times the lower, both round to `_MONEY_RANGE_ROUNDING` rupees, and
# inside the pay band. A real mobile number is descending half the time and round in both halves
# essentially never; the residual (a round, ascending vanity number typed AS the pay) is recorded
# as the payer's own pay figure on the payer's own posting.
_RANGE_DASHES = "-‐‑‒–—―−"
_MONEY_RANGE_AMOUNT = r"(\d{1,3}(?:,\d{2,3})+|\d{4,6})"
_MONEY_RANGE_RE = re.compile(
    r"\s*" + _MONEY_RANGE_AMOUNT + r"\s*[" + _RANGE_DASHES + r"]\s*" + _MONEY_RANGE_AMOUNT + r"\s*"
)
_MONEY_RANGE_MAX_RATIO = 5
_MONEY_RANGE_ROUNDING = 100


def is_money_range(run: str) -> bool:
    """Is this phone-shaped run a round, ascending rupee range ("20,000-25,000")?"""
    match = _MONEY_RANGE_RE.fullmatch(run or "")
    if match is None:
        return False
    low, high = (int(group.replace(",", "")) for group in match.groups())
    return (
        _PAY_MIN_INR <= low < high <= _PAY_MAX_INR
        and high <= low * _MONEY_RANGE_MAX_RATIO
        and low % _MONEY_RANGE_ROUNDING == 0
        and high % _MONEY_RANGE_ROUNDING == 0
    )


def _only_pay_ranges_were_masked(raw: str, placeholder_tokens: list[str] | None) -> bool:
    """True when every identity token this turn minted is a PHONE and every phone-shaped run in
    ``raw`` is a money range — i.e. the gateway's only identity finding was a pay range.

    PHONE-only matters: the gateway masks emails and ids BEFORE phones and names/employers after,
    so with no other identity token the phone rule saw ``raw`` itself, and the runs listed here
    are exactly the runs it masked. Any other identity class, or any run that is not a money
    range (a real phone), keeps the masked text.
    """
    identity = [t for t in (placeholder_tokens or []) if _IDENTITY_TOKEN_RE.match(t or "")]
    if not identity or not all(t.startswith("[PHONE_") for t in identity):
        return False
    runs = phone_shaped_runs(raw)
    return bool(runs) and all(is_money_range(run) for run in runs)


def safe_draft_text(
    raw: str,
    pseudonymized: str,
    placeholder_tokens: list[str] | None,
    *,
    pay_question: bool = False,
) -> str:
    """The text the DRAFT is allowed to keep for this turn.

    Raw by default — the draft is the payer's own business copy, and a masked city
    or pay figure would make it useless. Masked when the turn carried identity-class
    content, so the phone number a payer typed into a description cannot reach the
    stored draft or the published posting. The payer sees the token and is asked
    (via ``clarification_questions``) to retype the field.

    ONE EXCEPTION (#1731): when the only identity the gateway found was a dashed pay RANGE
    (`_only_pay_ranges_were_masked`) AND the turn is about pay — the answer to the pay question
    (``pay_question``) or a message that names money — the raw text is kept, so "20000-25000"
    becomes the payer's pay band instead of a token. Without the pay context the masked text
    stands: "call 98000-99000" in a description is a number, whatever its shape.
    """
    if not carries_identity(placeholder_tokens):
        return raw
    about_pay = pay_question or bool(_MONEY_CUE_RE.search(raw or ""))
    if about_pay and _only_pay_ranges_were_masked(raw, placeholder_tokens):
        return raw
    return pseudonymized
