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
QUESTION IS ON SCREEN: the reply to "which city is this job in?" IS the location.
So detection is:

1. **Attribution.** ``last_asked``'s own parser reads the message. One attributed
   answer may close TWO topics: the location answer also records ``city`` when it
   names a gazetteer city ("Pune, Chakan"), so the common case costs one question.
2. **Five cross-topic extractors**, and only five — ``vacancy``, ``pay_range``,
   ``shift``, ``pay_type`` and ``experience``. Each requires an explicit cue ("5
   openings", "Rs 22,000", "night shift", "in hand", "3 years experience"), so a
   payer who front-loads ("2 welders, night shift, 20-25k in hand") is not re-asked.
   A cue-less cross-topic guess at a role title or a city is how you put words in an
   employer's mouth, so neither is ever read cross-topic.

FAIL TOWARD ASKING AGAIN. Every parser here returns "no value" rather than a
guess. An unparsed ESSENTIAL is re-asked once (bounded) and then declared in
``unanswered_essentials`` — a visibly incomplete draft the payer can fix is always
better than a confidently wrong one they do not notice.
"""

from __future__ import annotations

import re

# The ONE city gazetteer (packages/profiling-lexicon cities.json). Read from the privacy
# module this route already depends on — never from ``app.profiling`` (see __init__).
from ..pseudonymize import CITY_ALIASES, KNOWN_CITIES

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
# No square brackets, deliberately: they are the pseudonymization token's delimiters.
# Trimming them turned an edge token ("[PERSON_1], Chakan") into "PERSON_1], Chakan",
# which PLACEHOLDER_TOKEN_RE no longer sees — so the essential closed on a token and
# no retype ask was ever raised. Measured, not hypothetical (#1726).
_TRIM_PUNCT = " \t\r\n.,;:!\"'`(){}-–—"

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
    """Collapse whitespace, strip wrapping punctuation/quotes, cap length."""
    cleaned = _WS_RE.sub(" ", (text or "").strip()).strip(_TRIM_PUNCT)
    if not cleaned or not _HAS_ALNUM_RE.search(cleaned):
        return None
    return cleaned[:max_len].strip()


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
# there, they just had nothing to do with each other.
_UNIT_GUARD = (
    r"(?!\s*(?:years?|yrs?|saal|months?|mahine|weeks?|hours?|hrs?|days?|km|%|k\b|"
    r"lakh|lac|thousand|rs\b|rupees?|shifts?|am\b|pm\b))"
)
_NUM = r"(?<![\d,.])(\d{1,4})" + _UNIT_GUARD
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


def _parse_pay(text: str, *, require_cue: bool) -> dict[str, int | None] | None:
    """Parse a monthly pay answer into ``{"pay_min": int, "pay_max": int | None}``."""
    message = text or ""
    if require_cue and not _MONEY_CUE_RE.search(message):
        return None

    # 1. A RANGE wins outright — it is the one place a multiplier may travel.
    span = _PAY_RANGE_RE.search(message)
    if span:
        low_s, low_x, high_s, high_x = span.groups()
        low = _scale(low_s, low_x, high_x)
        high = _scale(high_s, high_x, low_x)
        if low is not None and high is not None:
            return {"pay_min": min(low, high), "pay_max": max(low, high)}
        single = low if low is not None else high
        if single is not None:
            return {"pay_min": single, "pay_max": None}

    # 2. Otherwise every amount stands alone with its OWN suffix. A bare number
    #    below the floor ("8 hours", "5 welders") is dropped, not rescaled.
    amounts: list[int] = []
    for match in _AMOUNT_RE.finditer(message):
        value = _scale(match.group(1), match.group(2), None)
        if value is not None and value not in amounts:
            amounts.append(value)
    if not amounts:
        return None
    amounts.sort()
    if len(amounts) == 1:
        return {"pay_min": amounts[0], "pay_max": None}
    return {"pay_min": amounts[0], "pay_max": amounts[-1]}


# --- Pay type (#1726) --------------------------------------------------------
# Explicit ASCII lookarounds, not `\b`: "in-hand" must match as ONE cue, and a `\b`
# sits happily between "in" and "-". Digits count as word characters so "15 days"
# never matches inside "115 days".
def _cue(body: str) -> str:
    return r"(?<![A-Za-z0-9])(?:" + body + r")(?![A-Za-z0-9])"


# The MULTI-WORD cues — trusted cross-topic ("20-25k in hand" answered to the pay
# question closes pay_type too). "ctc" rides with them as the acronym of one.
_PAY_TYPE_CUES: dict[str, re.Pattern[str]] = {
    "in_hand": re.compile(
        _cue(r"in[\s-]*hand|take[\s-]*home|net\s+(?:pay|salary)|haath\s+me(?:in)?"),
        re.IGNORECASE,
    ),
    "gross": re.compile(_cue(r"gross\s+(?:pay|salary)"), re.IGNORECASE),
    "ctc": re.compile(_cue(r"ctc|c\.t\.c\.?|cost\s+to\s+company"), re.IGNORECASE),
}
# Bare single words, trusted ONLY as the answer to the pay-type question itself: "net"
# and "gross" are too ordinary to read out of an unrelated sentence.
_PAY_TYPE_BARE: dict[str, re.Pattern[str]] = {
    "in_hand": re.compile(_cue(r"net"), re.IGNORECASE),
    "gross": re.compile(_cue(r"gross"), re.IGNORECASE),
}


def _parse_pay_type(text: str, *, require_cue: bool) -> str | None:
    """Map a pay-type answer onto the closed ``jobs.pay_type`` set.

    Cross-topic (``require_cue``) also needs a money cue in the same message: "skilled
    in hand grinding" contains "in hand" and says nothing about pay. Two DIFFERENT
    types in one message ("gross 30k, in hand 25k") records nothing — picking one
    would be a guess about which figure the band describes.
    """
    message = text or ""
    if require_cue and not _MONEY_CUE_RE.search(message):
        return None
    found = {kind for kind, cue in _PAY_TYPE_CUES.items() if cue.search(message)}
    if not require_cue:
        found |= {kind for kind, cue in _PAY_TYPE_BARE.items() if cue.search(message)}
    return found.pop() if len(found) == 1 else None


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


# --- Experience (#1726) ------------------------------------------------------
# Stored as ``{"min": int | None, "max": int | None}`` — "5+ years" has no max, "up to
# 2 years" has no min. The same shapes serve both paths; only the tail after a number
# differs: cross-topic demands a year unit, an attributed answer may omit it.
_EXP_UNIT = r"(?:years?|yrs?|saal)(?![A-Za-z])"
_EXP_NUM = r"(?<![\d.])(\d{1,2})(?![\d.])"
# Without a unit, a number must END the answer or meet punctuation, an experience word,
# or the other half of a window ("minimum 2 maximum 5 years"). That is what keeps "6
# months" and "20k" from becoming years.
_EXP_BARE_END = (
    r"(?=\s*(?:$|[,;.!?/)]|(?:of\s+)?(?:experience|exp)(?![A-Za-z])|"
    r"(?:and\s+)?(?:max|maximum|up\s*to)(?![A-Za-z])))"
)
_EXP_CUE_RE = re.compile(_cue(r"experience|experienced|exp"), re.IGNORECASE)
_FRESHER_CROSS_RE = re.compile(_cue(r"freshers?"), re.IGNORECASE)
_FRESHER_ATTRIBUTED_RE = re.compile(
    _cue(r"freshers?|no\s+experience|experience\s+not\s+required"), re.IGNORECASE
)
# "No freshers" names the word and means the opposite.
_NO_FRESHER_RE = re.compile(
    _cue(r"(?:no|not|non)[\s-]+(?:for\s+)?freshers?|freshers?\s+(?:not|nahi|nahin)"),
    re.IGNORECASE,
)
# A clause boundary — but not the point inside "1.5".
_CLAUSE_SPLIT_RE = re.compile(r"[,;\n]|\.(?!\d)")


class _ExperienceShapes:
    """The compiled window shapes for one posture (unit required, or optional)."""

    def __init__(self, *, unit_required: bool) -> None:
        unit = _EXP_UNIT if unit_required else f"(?:{_EXP_UNIT})?"
        end = rf"\s*{_EXP_UNIT}" if unit_required else rf"(?:\s*{_EXP_UNIT}|{_EXP_BARE_END})"
        flags = re.IGNORECASE
        self.span = re.compile(_EXP_NUM + r"\s*(?:-|to)\s*" + _EXP_NUM + end, flags)
        self.at_least = (
            re.compile(
                _cue(r"at\s*least|minimum|min") + r"\.?\s*(?:of\s+)?" + _EXP_NUM + end, flags
            ),
            re.compile(_EXP_NUM + r"\s*\+" + end, flags),
            re.compile(_EXP_NUM + r"\s*" + unit + r"\s*or\s+more(?![A-Za-z])", flags),
            re.compile(_EXP_NUM + r"\s*or\s+more\s*" + _EXP_UNIT, flags),
        )
        self.up_to = re.compile(_cue(r"up\s*to|max|maximum") + r"\.?\s*" + _EXP_NUM + end, flags)
        self.bare = re.compile(_EXP_NUM + end, flags)


_EXP_STRICT = _ExperienceShapes(unit_required=True)
_EXP_ATTRIBUTED = _ExperienceShapes(unit_required=False)


def _experience_window(
    text: str, shapes: _ExperienceShapes, fresher: bool
) -> dict[str, int | None] | None:
    low: int | None = None
    high: int | None = None
    span = shapes.span.search(text)
    if span:
        a, b = int(span.group(1)), int(span.group(2))
        low, high = min(a, b), max(a, b)
    else:
        for shape in shapes.at_least:
            match = shape.search(text)
            if match:
                low = int(match.group(1))
                break
        cap = shapes.up_to.search(text)
        if cap:
            high = int(cap.group(1))
    if fresher:
        low = 0  # "freshers or up to 2 years" is 0..2
    elif low is None and high is None:
        bare = shapes.bare.search(text)
        if bare:
            low = int(bare.group(1))
    if low is None and high is None:
        return None
    if any(v > EXPERIENCE_MAX_YEARS for v in (low, high) if v is not None):
        return None
    return {"min": low, "max": high}


def _parse_experience(text: str, *, require_cue: bool) -> dict[str, int | None] | None:
    """Parse a years-of-experience window.

    Cross-topic (``require_cue``) reads a clause only when it carries an experience
    word AND a figure with a year unit, or the word "fresher(s)" — so "3 years
    experience, ITI" answered to the requirements question fills this, while "we need
    3" and "6 days a week" never do. The cue and the figure must share a CLAUSE:
    "experienced candidates only, 1 year contract" is a contract length.
    """
    message = _WS_RE.sub(" ", (text or "").replace("–", "-").replace("—", "-")).strip()
    if not message:
        return None
    if not require_cue:
        fresher = bool(_FRESHER_ATTRIBUTED_RE.search(message)) and not _NO_FRESHER_RE.search(
            message
        )
        return _experience_window(message, _EXP_ATTRIBUTED, fresher)
    for clause in _CLAUSE_SPLIT_RE.split(message):
        fresher = bool(_FRESHER_CROSS_RE.search(clause)) and not _NO_FRESHER_RE.search(clause)
        if not fresher and not _EXP_CUE_RE.search(clause):
            continue
        window = _experience_window(clause, _EXP_STRICT, fresher)
        if window is not None:
            return window
    return None


# --- Needed by (#1726) -------------------------------------------------------
# FLEXIBLE IS CHECKED FIRST, so "not urgent" is never read as "urgent". A negated
# immediate ("not immediately", "abhi nahi") is removed before the immediate check.
_NEEDED_FLEXIBLE_RE = re.compile(
    _cue(r"flexible|no\s+hurry|no\s+rush|any\s*time|whenever|not\s+urgent"), re.IGNORECASE
)
_NEEDED_NEGATED_RE = re.compile(
    _cue(
        r"(?:not|no)\s+(?:so\s+)?(?:immediate(?:ly)?|urgent(?:ly)?|asap|right\s+(?:away|now)|"
        r"today|tomorrow)|(?:abhi|turant)\s+(?:nahi|nahin|not)"
    ),
    re.IGNORECASE,
)
_NEEDED_IMMEDIATE_RE = re.compile(
    _cue(
        r"immediate(?:ly)?|asap|as\s+soon\s+as\s+possible|urgent(?:ly)?|right\s+(?:away|now)|"
        r"today|tomorrow|this\s+week|turant|abhi"
    ),
    re.IGNORECASE,
)
_NEEDED_SOON_RE = re.compile(
    _cue(
        r"soon|within\s+(?:a|1|one)\s+month|(?:next|this)\s+month|next\s+week|"
        r"(?:with)?in\s+\d{1,2}\s+(?:days?|weeks?)|(?:a\s+)?few\s+weeks|15\s+days|jaldi"
    ),
    re.IGNORECASE,
)


def _parse_needed_by(text: str) -> str | None:
    """Map a joining-timeline answer onto the closed ``jobs.needed_by`` set."""
    message = _WS_RE.sub(" ", text or "")
    if _NEEDED_FLEXIBLE_RE.search(message):
        return "flexible"
    message = _NEEDED_NEGATED_RE.sub(" ", message)
    if _NEEDED_IMMEDIATE_RE.search(message):
        return "immediate"
    if _NEEDED_SOON_RE.search(message):
        return "soon"
    return None


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
# job title. Rejecting it sends the topic back to the normal ask instead.
_LABEL_REJECT_RE = re.compile(
    r"^(?:to|that|this|it|some|any|your|our|my)\b|^(?:job|jobs|posting|post|role|work)$",
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


# --- City (#1726) ------------------------------------------------------------
# Canonical names + aliases, LONGEST FIRST — the ordering signals.py and gazetteer.ts
# use. The leftmost match already keeps "Navi Mumbai" whole; the ordering is what keeps
# a token that PREFIXES another at the same position from winning, if the data grows one.
_CITY_TOKENS: tuple[str, ...] = tuple(
    sorted(set(KNOWN_CITIES) | set(CITY_ALIASES), key=lambda t: (-len(t), t))
)
_CITY_RE = re.compile(
    r"(?<![A-Za-z0-9])("
    + "|".join(r"\s+".join(re.escape(w) for w in t.split()) for t in _CITY_TOKENS)
    + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
# A bare city answer longer than this is a sentence or an address, not a city.
_MAX_CITY_WORDS = 3
_HAS_LETTER_RE = re.compile(r"[A-Za-zऀ-ॿ]")
_NOT_A_CITY_RE = re.compile(
    _cue(r"same|as\s+above|don'?t\s+know|not\s+sure|pata\s+nahin?|any\s*where|all\s+india"),
    re.IGNORECASE,
)


def _title_case(value: str) -> str:
    """The TypeScript gazetteer's ``titleCase``, character for character."""
    return re.sub(r"[A-Za-z]+", lambda m: m[0][0].upper() + m[0][1:].lower(), value)


def _gazetteer_city(text: str) -> str | None:
    """The first gazetteer city named in ``text``, canonical and title-cased."""
    match = _CITY_RE.search(text or "")
    if match is None:
        return None
    token = _WS_RE.sub(" ", match.group(1)).lower()
    return _title_case(CITY_ALIASES.get(token, token))


def _parse_city(text: str) -> str | None:
    """The answer to the city question: a gazetteer city, else a SHORT bare label.

    The bare fallback exists because the hand-filled forms accept a free-text city, and
    the chat must not be stricter than the form ("Chakan" is not in the gazetteer). It
    refuses anything with a digit — which also means a placeholder token can never
    become a city — and anything longer than a place name.
    """
    canonical = _gazetteer_city(text)
    if canonical is not None:
        return canonical
    label = _parse_label(text, _LOCATION_CUE_RE, allow_bare=True)
    if label is None:
        return None
    label = label.rstrip("?").strip()
    if (
        not label
        or len(label.split()) > _MAX_CITY_WORDS
        or not _HAS_LETTER_RE.search(label)
        or re.search(r"\d", label)
        or _REFUSAL_RE.match(label)
        or _LABEL_REJECT_RE.match(label)
        or _NOT_A_CITY_RE.search(label)
    ):
        return None
    return label[:CITY_MAX].strip()


# --- Topic dispatch --------------------------------------------------------
# Topics whose value must be PARSED to count as answered. A refusal ("no") on one of
# these leaves it unanswered on purpose — see _REFUSAL_RE.
_VALUE_REQUIRED: frozenset[str] = frozenset({"role_title", "location_label", "city", "vacancy"})

# The ONLY topics read cross-topic (i.e. when a DIFFERENT question was on screen).
# Each needs an explicit cue. Everything else is attribution-only.
_CROSS_TOPIC: tuple[str, ...] = ("vacancy", "pay_range", "shift", "pay_type", "experience")


def _parse_topic(topic_id: str, text: str, *, attributed: bool) -> object | None:
    """Parse ``text`` as an answer to ``topic_id``. ``None`` = nothing recorded."""
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
        return _parse_pay_type(text, require_cue=not attributed)
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

    # 1b. The location answer names the city too ("Pune, Chakan"). A closed-vocabulary
    #     read of THIS answer — gazetteer only, no bare fallback — and never a read of a
    #     stored location_label, which the worker feed deliberately does not see.
    if (
        last_asked == "location_label"
        and found.get("location_label") is not None
        and "city" not in found
    ):
        city = _gazetteer_city(text)
        if city is not None:
            found["city"] = city

    # 2. The cue-gated cross-topic extractors.
    for topic_id in _CROSS_TOPIC:
        if topic_id in found or topic_id == last_asked:
            continue
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


def safe_draft_text(raw: str, pseudonymized: str, placeholder_tokens: list[str] | None) -> str:
    """The text the DRAFT is allowed to keep for this turn.

    Raw by default — the draft is the payer's own business copy, and a masked city
    or pay figure would make it useless. Masked when the turn carried identity-class
    content, so the phone number a payer typed into a description cannot reach the
    stored draft or the published posting. The payer sees the token and is asked
    (via ``clarification_questions``) to retype the field.
    """
    return pseudonymized if carries_identity(placeholder_tokens) else raw
