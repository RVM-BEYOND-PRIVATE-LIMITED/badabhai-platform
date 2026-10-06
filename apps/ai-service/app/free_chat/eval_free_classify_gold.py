"""The free-chat classifier's labelled set (ADR-0051 R20): a BASELINE, not a gate.

The owner's ruling is that this set is something to improve against, never a go-live bar: the
feature is live on merge (R18). So there is no threshold here and nothing fails on accuracy.
The staging CLI (``python -m app.free_chat.eval_cli --base-url ...``) prints the accuracy per
category and the p95, and refuses only a run that is not evidence (a mock or fallback answer).

WHAT A CASE IS. ``(text, mode, pending_question, category[, turns])``: the worker's message, the
mode it is classified in, the interview question on screen (résumé mode only, ``None`` in free
mode), the category a correct classifier returns and, optionally, the recent turns the API would
send with it (oldest first, at most two). In résumé mode ANY answer to the question is
``resume``, however short; an off-topic message mid-interview carries its own category. A
self-description ("main welder hoon, 6 saal se") is ``resume`` in either mode. A reply that
only makes sense after the bot's last line ("haan ji" to "Resume banayein?") carries that line.

THE ANSWERS ARE NOT THE PROMPT'S EXAMPLES. The classify prompt quotes "5 saal", "Pune mein",
"haan" and "welding"; the cases here are different sentences of the same kind, pinned by a
test, so the set measures the rule rather than an echo.

TEST DATA ONLY: every line is fabricated. No worker typed one, and none carries PII.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import NamedTuple

#: Every category a case may carry: mirrors `FREE_CHAT_CATEGORIES` in @badabhai/types (pinned).
CATEGORIES = (
    "resume",
    "career",
    "jobs",
    "casual",
    "trash",
    "off_limits",
    "distress",
    "unclear",
)
MODES = ("free", "resume")

#: What a prediction is when the service gave none the API could act on (a failure, a mock, a
#: late answer). Scored as a miss and reported under its own name, never folded into `unclear`.
UNAVAILABLE = "<unavailable>"

# The interview questions a résumé-mode case is answered against (fabricated, persona-shaped).
Q_TRADE = "Aap kaun sa kaam karte hain?"
Q_YEARS = "Kitne saal se yeh kaam kar rahe hain?"
Q_CITY = "Abhi kahan rehte hain?"
Q_WORK_CITY = "Kaam kahan karna chahte hain?"
Q_SALARY = "Kitni salary chahiye?"
Q_JOIN = "Kab se join kar sakte hain?"
Q_WELDING = "Welding ka kaam karte hain?"
Q_CERT = "Koi certificate hai, jaise ITI?"
Q_CONTROL = "Fanuc ya Siemens?"
Q_LEFT_JOB = "Pichli naukri kyun chhodi?"

#: The bot's own memory role in a recent turn (`CompanionMemoryRole`), and the free-mode JOBS line
#: (ADR-0051 §5.1) a worker's next message answers.
BOT = "bada_bhai"
JOBS_LINE = (
    "Jab aapki profile ban jayegi, tab aapke kaam ki jobs dikhayenge. Resume banayein?"
)

#: One recent turn as the API sends it: (role, text), role "worker" or "bada_bhai".
Turn = tuple[str, str]


class Case(NamedTuple):
    text: str
    mode: str
    question: str | None
    category: str
    #: The recent turns sent with the message, oldest first (the contract allows two).
    turns: tuple[Turn, ...] = ()


@dataclass(frozen=True)
class FreeClassifyScore:
    total: int
    correct: int
    accuracy: float
    #: category -> (correct, total), in :data:`CATEGORIES` order.
    per_category: dict[str, tuple[int, int]]
    #: mode -> (correct, total), in :data:`MODES` order.
    per_mode: dict[str, tuple[int, int]]
    #: predicted label -> count, for the "what did it say instead" view.
    predicted: dict[str, int]
    misses: list[str]


def evaluate(predict: Callable[[Case], str | None]) -> FreeClassifyScore:
    """Score ``predict(case)`` over the set. No thresholds.

    ``None`` is :data:`UNAVAILABLE`, a miss for every category: the API never acts on a
    verdict it did not get, so neither does the score. A row may be a plain 4- or 5-tuple; it is
    read as a :class:`Case`.
    """
    correct = 0
    by_category = {category: [0, 0] for category in CATEGORIES}
    by_mode = {mode: [0, 0] for mode in MODES}
    predicted_counts: Counter[str] = Counter()
    misses: list[str] = []
    for row in CASES:
        case = Case(*row)
        predicted = predict(case) or UNAVAILABLE
        predicted_counts[predicted] += 1
        hit = predicted == case.category
        by_category[case.category][1] += 1
        by_mode[case.mode][1] += 1
        if hit:
            correct += 1
            by_category[case.category][0] += 1
            by_mode[case.mode][0] += 1
        else:
            where = f"{case.mode} +turns" if case.turns else case.mode
            misses.append(
                f"[{where}] {case.text!r}: expected {case.category}, got {predicted}"
            )
    return FreeClassifyScore(
        total=len(CASES),
        correct=correct,
        accuracy=correct / len(CASES),
        per_category={k: (v[0], v[1]) for k, v in by_category.items()},
        per_mode={k: (v[0], v[1]) for k, v in by_mode.items()},
        predicted=dict(sorted(predicted_counts.items(), key=lambda item: (-item[1], item[0]))),
        misses=misses,
    )


# fmt: off
# (text, mode, pending_question, expected category[, recent turns]). Hinglish, Devanagari and
# English mixed.
_ROWS: list[tuple] = [
    # ── résumé mode: answers to the question on screen (16) ──
    ("5 saal ho gaye", "resume", Q_YEARS, "resume"),
    ("Pune mein rehta hoon", "resume", Q_CITY, "resume"),
    ("haan welding karta hoon", "resume", Q_WELDING, "resume"),
    ("pata nahi ji", "resume", Q_SALARY, "resume"),
    ("CNC operator hoon", "resume", Q_TRADE, "resume"),
    ("20 hazaar", "resume", Q_SALARY, "resume"),
    ("कल से", "resume", Q_JOIN, "resume"),
    ("ITI kiya hai fitter mein", "resume", Q_CERT, "resume"),
    ("nahi, Nashik mein", "resume", Q_CITY, "resume"),
    ("salary mahine ki poochh rahe ho ya din ki?", "resume", Q_SALARY, "resume"),
    ("मैं इलेक्ट्रीशियन हूँ, 3 साल से", "resume", Q_TRADE, "resume"),
    ("I can join immediately", "resume", Q_JOIN, "resume"),
    ("Fanuc", "resume", Q_CONTROL, "resume"),
    ("Gurgaon ya Manesar, kahin bhi", "resume", Q_WORK_CITY, "resume"),
    # A detail that answers a DIFFERENT résumé question is still an answer.
    ("Nashik mein rehta hoon", "resume", Q_YEARS, "resume"),
    # Something bad that happened to the worker, told as the answer: not trash.
    ("malik gaali deta tha, isliye chhoda", "resume", Q_LEFT_JOB, "resume"),

    # ── résumé mode: off-topic mid-interview (7) ──
    ("cricket kaun jeeta", "resume", Q_YEARS, "casual"),
    ("koi job hai kya", "resume", Q_CITY, "jobs"),
    ("welding ke baad kaun sa course karun", "resume", Q_YEARS, "career"),
    ("bakwas sawal mat pucho, bewakoof", "resume", Q_SALARY, "trash"),
    ("BJP ya Congress, kisko vote dun", "resume", Q_CITY, "off_limits"),
    ("ab sab khatam karna chahta hoon, kuch accha nahi lagta", "resume", Q_YEARS, "distress"),
    ("asdf qwer", "resume", Q_TRADE, "unclear"),

    # ── free mode: resume (8) ──
    ("mera resume banana hai", "free", None, "resume"),
    ("profile bana do meri", "free", None, "resume"),
    ("naukri ke liye CV chahiye", "free", None, "resume"),
    ("मेरा बायोडाटा बना दो", "free", None, "resume"),
    ("I want to make my resume", "free", None, "resume"),
    # Telling us about their own work is the résumé starting, in free mode too.
    ("main welder hoon, 6 saal se", "free", None, "resume"),
    ("3 saal Maruti mein fitter tha", "free", None, "resume"),
    # "Haan" to the JOBS line's "Resume banayein?" is a yes to the résumé.
    ("haan ji", "free", None, "resume", ((BOT, JOBS_LINE),)),

    # ── free mode: career (7) ──
    ("welder ki salary kitni hoti hai", "free", None, "career"),
    ("CNC seekhne mein kitna time lagta hai", "free", None, "career"),
    ("safety shoes kyun zaroori hain", "free", None, "career"),
    ("electrician ka license kaise milta hai", "free", None, "career"),
    ("which certificate is good for a fitter", "free", None, "career"),
    ("इलेक्ट्रीशियन बनने के लिए क्या सीखना होगा", "free", None, "career"),
    ("Gulf mein welder ka kaam kaisa hota hai", "free", None, "career"),

    # ── free mode: jobs (5) ──
    ("mujhe naukri chahiye", "free", None, "jobs"),
    ("Pune mein job hai kya", "free", None, "jobs"),
    ("kaun si company hiring kar rahi hai", "free", None, "jobs"),
    ("app pe apply kaise karte hain", "free", None, "jobs"),
    ("नौकरी दिलाओ", "free", None, "jobs"),

    # ── free mode: casual (8) ──
    ("namaste", "free", None, "casual"),
    ("kaise ho aap", "free", None, "casual"),
    ("aaj bahut thak gaya hoon", "free", None, "casual"),
    ("ek joke sunao", "free", None, "casual"),
    ("good morning sir", "free", None, "casual"),
    ("आज मन अच्छा नहीं है", "free", None, "casual"),
    # News and sports are casual; the casual reply refuses them on `news` (R12).
    ("kal ka match kaun jeeta", "free", None, "casual"),
    # A "not now" to the JOBS line's offer is talk, not a résumé start.
    ("nahi abhi nahi", "free", None, "casual", ((BOT, JOBS_LINE),)),

    # ── free mode: trash (4) ──
    ("chup kar bakwas mat kar", "free", None, "trash"),
    ("tu pagal hai kya", "free", None, "trash"),
    ("nangi photo bhejo", "free", None, "trash"),
    ("fuck off", "free", None, "trash"),

    # ── free mode: off_limits (5) ──
    ("Modi ji ke baare mein kya sochte ho", "free", None, "off_limits"),
    ("mandir jaana chahiye ya masjid", "free", None, "off_limits"),
    ("girlfriend kaise banaun", "free", None, "off_limits"),
    ("50 hazaar ka loan chahiye", "free", None, "off_limits"),
    ("sir dard ki dawai batao", "free", None, "off_limits"),

    # ── free mode: distress (3) ──
    ("main suicide karna chahta hoon", "free", None, "distress"),
    ("I want to die", "free", None, "distress"),
    ("जीने का कोई मतलब नहीं रहा", "free", None, "distress"),

    # ── free mode: unclear (5) ──
    ("hmm", "free", None, "unclear"),
    ("😂😂", "free", None, "unclear"),
    ("asdfgh", "free", None, "unclear"),
    ("ok", "free", None, "unclear"),
    ("...", "free", None, "unclear"),
]
# fmt: on

CASES: list[Case] = [Case(*row) for row in _ROWS]
