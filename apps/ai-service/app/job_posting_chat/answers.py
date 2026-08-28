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

1. **Attribution.** ``last_asked``'s own parser reads the message.
2. **Three cross-topic extractors**, and only three — ``vacancy``, ``pay_range``
   and ``shift``. Each requires an explicit cue ("5 openings", "Rs 22,000",
   "night shift"), so a payer who front-loads ("2 welders, night shift, 20-25k")
   is not re-asked. They are deliberately the only three: a cue-less cross-topic
   guess at a role title or a city is how you put words in an employer's mouth.

FAIL TOWARD ASKING AGAIN. Every parser here returns "no value" rather than a
guess. An unparsed ESSENTIAL is re-asked once (bounded) and then declared in
``unanswered_essentials`` — a visibly incomplete draft the payer can fix is always
better than a confidently wrong one they do not notice.
"""

from __future__ import annotations

import re

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

_WS_RE = re.compile(r"\s+")
_PHRASE_SPLIT_RE = re.compile(r"[,;/\n|+&]|\s+and\s+|\s+aur\s+", re.IGNORECASE)
_HAS_ALNUM_RE = re.compile(r"[0-9A-Za-zऀ-ॿ]")
_TRIM_PUNCT = " \t\r\n.,;:!\"'`()[]{}-–—"

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
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "ek": 1, "do": 2, "teen": 3, "char": 4, "paanch": 5, "panch": 5,
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
    re.compile(
        r"\b(?:" + _VACANCY_NOUNS + r"|nos\.?)\b\s*(?:of|:|-)?\s*" + _NUM, re.IGNORECASE
    ),
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
    # A band string embedded in a sentence ("we need 6-10 fitters").
    for alias, band in _BAND_ALIAS.items():
        if "-" in alias and re.search(rf"(?<!\d){re.escape(alias)}(?!\d)", normalized):
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
    "k": 1000, "thousand": 1000, "hazar": 1000, "hazaar": 1000,
    "lakh": 100_000, "lakhs": 100_000, "lac": 100_000, "lacs": 100_000,
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


# --- Topic dispatch --------------------------------------------------------
# Topics whose value must be PARSED to count as answered. A refusal ("no") on one of
# these leaves it unanswered on purpose — see _REFUSAL_RE.
_VALUE_REQUIRED: frozenset[str] = frozenset({"role_title", "location_label", "vacancy"})

# The ONLY topics read cross-topic (i.e. when a DIFFERENT question was on screen).
# Each needs an explicit cue. Everything else is attribution-only.
_CROSS_TOPIC: tuple[str, ...] = ("vacancy", "pay_range", "shift")


def _parse_topic(topic_id: str, text: str, *, attributed: bool) -> object | None:
    """Parse ``text`` as an answer to ``topic_id``. ``None`` = nothing recorded."""
    if topic_id == "role_title":
        return _parse_label(text, _ROLE_CUE_RE, allow_bare=attributed)
    if topic_id == "location_label":
        return _parse_label(text, _LOCATION_CUE_RE, allow_bare=attributed)
    if topic_id == "vacancy":
        return _parse_vacancy(text, require_cue=not attributed)
    if topic_id == "pay_range":
        return _parse_pay(text, require_cue=not attributed)
    if topic_id == "shift":
        return _parse_shift(text, require_cue=not attributed)
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

    # 2. The three cue-gated cross-topic extractors.
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
    detector (see :func:`safe_draft_text`), and masking also hides cities. Storing
    "[CITY_1]" as ``location_label`` — and marking the topic ANSWERED, closing it —
    would be strictly worse than recording nothing: the payer would never be asked
    again and the posting would publish with a token as its city. Only the
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
