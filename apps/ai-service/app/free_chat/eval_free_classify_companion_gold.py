"""The free-chat classifier's COMPANION-surface labelled set (ADR-0055, #2285): a BASELINE only.

WHY A THIRD SET. ADR-0055 (#2275) put the free chat's brain on the Bada Bhai chat (the companion):
the same ``profiling_free_classify`` task, asked with ``surface: "companion"``, which swaps in the
companion classify prompt. That prompt says the résumé is ALREADY MADE, renders "Mode: companion"
in place of the interview's mode and question, and asks for a fourth key, ``resume_action``
(``edit`` / ``new`` / ``download`` / null), which picks the companion's résumé handler. None of it
had been measured, and the route's 80-token output cap was an estimate. This set measures it.

WHAT A CASE IS. ``(text, category, resume_action, language[, turns])``: the worker's message, the
category a correct classifier returns, the résumé action on a ``resume`` line (``None`` is the
"ask with the résumé menu" answer, and every non-résumé line carries ``None``), the language label
(ADR-0051 R42's owner rules: Hindi in either script is ``hinglish``, a regional language with
English work words is that language, plain English is ``english``, too short or unsure is
``hinglish``) and, optionally, the companion memory's last two turns. Every case is posted as the
companion brain posts it (``companion-brain.ts``): mode ``free``, no question on screen, surface
``companion`` (:func:`request_body`), so the route renders "Mode: companion".

THE LABELS ARE ADR-0055's. On this screen ``resume`` is anything about the worker's own résumé or
profile, a new detail about their own work included (an edit); seeing jobs, openings or their own
applications in the app is ``jobs``; and with no résumé offer ever made here, a bare
acknowledgement is ``unclear``. The rest are ADR-0051's: R37 (only clear abuse is trash), a
jobs word inside a career question or a crisis is career or distress (§9 R2 classifies those typed
messages first), and a greeting is casual (§9 R3 sends greetings to the brain).

THE LINES ARE NOT THE PROMPT'S EXAMPLES, with one named exception: "hello" is the greeting §9 R3
routes to the brain, and the prompt quotes it for the language rule. Pinned by a test.

TEST DATA ONLY: every line is fabricated. No worker typed one, and none carries PII.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import NamedTuple, get_args

from ..contracts import FreeChatReplyLanguage, FreeChatResumeAction
from .eval_free_classify_gold import BOT, CATEGORIES, UNAVAILABLE, WORKER, Turn

#: The surface every case is classified on, and the mode the companion brain always sends.
SURFACE = "companion"
MODE = "free"

#: The closed sets a case's labels come from (pinned to the contract by a test).
RESUME_ACTIONS: tuple[str, ...] = get_args(FreeChatResumeAction)
LANGUAGES: tuple[str, ...] = get_args(FreeChatReplyLanguage)

#: How a ``None`` résumé action is named in the report: the companion's résumé menu asks.
NO_ACTION = "null"
#: How a missing language label is reported (the API's word lists decide then).
NO_LANGUAGE = "<none>"

# The companion's fixed lines a worker's next message may follow, verbatim from the API's copy
# (`apps/api/src/chat-companion/companion-replies.ts`, pinned by a test).
V3_JOBS_LINE = "Aapke kaam ki jobs Jobs screen par hain. Neeche button dabakar dekhiye."
V3_DOWNLOAD_READY_LINE = "Aapka resume taiyaar hai. Neeche button se download kar lijiye."
COMPANION_FALLBACK_LINE = (
    "Main aapke resume, applications aur naye jobs mein madad kar sakta hoon. Neeche se chunein."
)
COMPANION_CLARIFY_LINE = "Samajh nahi aaya. Aap inme se kya karna chahte hain?"

#: A fabricated career answer the brain's reply could have served (a memory turn).
VMC_ANSWER = "VMC operator machine set karta hai aur part ka size check karta hai."


class Case(NamedTuple):
    text: str
    category: str
    resume_action: str | None
    language: str
    #: The companion memory's last turns, oldest first (the classify contract allows two).
    turns: tuple[Turn, ...] = ()


class Prediction(NamedTuple):
    """What the API would act on: the category after its floor, the action, the language."""

    category: str
    resume_action: str | None
    language: str | None


def request_body(case: Case) -> dict:
    """The body the companion brain posts for ``case`` (``FreeChatClassifyInput``)."""
    return {
        "text": case.text,
        "recent_turns": [{"role": role, "text": text} for role, text in case.turns],
        "mode": MODE,
        "pending_question": None,
        "surface": SURFACE,
    }


def action_name(action: str | None) -> str:
    return NO_ACTION if action is None else action


@dataclass(frozen=True)
class CompanionClassifyScore:
    total: int
    correct: int
    accuracy: float
    #: category -> (correct, total), in :data:`CATEGORIES` order.
    per_category: dict[str, tuple[int, int]]
    #: expected language -> (category correct, total): the category accuracy by language.
    category_by_language: dict[str, tuple[int, int]]
    #: predicted category -> count.
    predicted: dict[str, int]
    #: The résumé lines: a hit needs the category ``resume`` AND the expected action.
    action_correct: int
    action_total: int
    #: expected action ("edit", "new", "download", "null") -> (correct, total).
    per_action: dict[str, tuple[int, int]]
    #: Among the résumé lines whose category came back ``resume``: (action correct, total).
    action_given_resume: tuple[int, int]
    #: The language label over every line (a missing label is a miss).
    language_correct: int
    language_total: int
    #: expected language -> (label correct, total), in :data:`LANGUAGES` order.
    per_language: dict[str, tuple[int, int]]
    category_misses: list[str]
    action_misses: list[str]
    language_misses: list[str]


def _where(case: Case) -> str:
    return "companion +turns" if case.turns else "companion"


def evaluate(predict: Callable[[Case], Prediction | None]) -> CompanionClassifyScore:
    """Score ``predict(case)`` over the set: the category, the résumé action, the language. No
    thresholds. ``None`` is :data:`UNAVAILABLE` (a miss everywhere): the API never acts on a
    verdict it did not get.
    """
    correct = 0
    by_category = {category: [0, 0] for category in CATEGORIES}
    by_language_category = {language: [0, 0] for language in LANGUAGES}
    by_action = {action_name(a): [0, 0] for a in (*RESUME_ACTIONS, None)}
    given_resume = [0, 0]
    by_language = {language: [0, 0] for language in LANGUAGES}
    predicted_counts: Counter[str] = Counter()
    category_misses: list[str] = []
    action_misses: list[str] = []
    language_misses: list[str] = []
    for row in CASES:
        case = Case(*row)
        prediction = predict(case)
        category = prediction.category if prediction is not None else UNAVAILABLE
        action = prediction.resume_action if prediction is not None else None
        language = (prediction.language if prediction is not None else None) or NO_LANGUAGE
        predicted_counts[category] += 1

        by_category[case.category][1] += 1
        by_language_category[case.language][1] += 1
        if category == case.category:
            correct += 1
            by_category[case.category][0] += 1
            by_language_category[case.language][0] += 1
        else:
            category_misses.append(
                f"[{_where(case)}] {case.text!r}: expected {case.category}, got {category}"
            )

        if case.category == "resume":
            expected = action_name(case.resume_action)
            by_action[expected][1] += 1
            hit = category == "resume" and action == case.resume_action
            if category == "resume":
                given_resume[1] += 1
                given_resume[0] += hit
            if hit:
                by_action[expected][0] += 1
            else:
                got = f"resume/{action_name(action)}" if category == "resume" else category
                action_misses.append(
                    f"[{_where(case)}] {case.text!r}: expected resume/{expected}, got {got}"
                )

        by_language[case.language][1] += 1
        if language == case.language:
            by_language[case.language][0] += 1
        else:
            language_misses.append(
                f"[{_where(case)}] {case.text!r}: expected {case.language}, got {language}"
            )

    action_total = sum(total for _c, total in by_action.values())
    return CompanionClassifyScore(
        total=len(CASES),
        correct=correct,
        accuracy=correct / len(CASES),
        per_category={k: (v[0], v[1]) for k, v in by_category.items()},
        category_by_language={k: (v[0], v[1]) for k, v in by_language_category.items()},
        predicted=dict(sorted(predicted_counts.items(), key=lambda item: (-item[1], item[0]))),
        action_correct=sum(c for c, _t in by_action.values()),
        action_total=action_total,
        per_action={k: (v[0], v[1]) for k, v in by_action.items()},
        action_given_resume=(given_resume[0], given_resume[1]),
        language_correct=sum(v[0] for v in by_language.values()),
        language_total=len(CASES),
        per_language={k: (v[0], v[1]) for k, v in by_language.items()},
        category_misses=category_misses,
        action_misses=action_misses,
        language_misses=language_misses,
    )


# fmt: off
# (text, category, resume_action, language[, recent turns]). Hinglish, Devanagari, English and the
# five regional languages, each regional one in its own script and in Latin letters.
_ROWS: list[tuple] = [
    # ── resume, edit: change, add or remove something, or a new detail about their work (9) ──
    ("resume mein welding add karo", "resume", "edit", "hinglish"),
    ("skills mein Marathi jod do", "resume", "edit", "hinglish"),
    ("mera city Pune kar do", "resume", "edit", "hinglish"),
    ("maine forklift chalana bhi seekh liya hai", "resume", "edit", "hinglish"),
    ("pichli company wala kaam resume se hata do", "resume", "edit", "hinglish"),
    ("रिज़्यूमे में मेरी सैलरी 22 हज़ार कर दो", "resume", "edit", "hinglish"),
    ("please add AutoCAD to my skills", "resume", "edit", "english"),
    ("nanna resume ge TIG welding serisi", "resume", "edit", "kannada"),
    ("મારા રિઝ્યુમમાં શહેર સુરત કરી દો", "resume", "edit", "gujarati"),

    # ── resume, new: a fresh résumé from the start (4) ──
    ("naya resume banana hai", "resume", "new", "hinglish"),
    ("resume dobara banao", "resume", "new", "hinglish"),
    ("I want to make a fresh resume from scratch", "resume", "new", "english"),
    ("mala navin resume banvaycha aahe", "resume", "new", "marathi"),

    # ── resume, download: get, send, share or print the file (7) ──
    ("resume ka pdf bhejo", "resume", "download", "hinglish"),
    ("mujhe resume phone mein chahiye", "resume", "download", "hinglish"),
    ("send me my resume file", "resume", "download", "english"),
    ("माझा रिझ्युमे डाउनलोड करायचा आहे", "resume", "download", "marathi"),
    ("என் ரெஸ்யூம் PDF அனுப்புங்க", "resume", "download", "tamil"),
    # After the download line: the button is not where they look, so they ask to be sent it.
    ("button nahi dikh raha, whatsapp pe bhej do", "resume", "download", "hinglish",
     ((WORKER, "resume chahiye"), (BOT, V3_DOWNLOAD_READY_LINE))),
    # After the clarify line: the worker says what they meant.
    ("arre resume ki file chahiye thi", "resume", "download", "hinglish",
     ((WORKER, "woh wala"), (BOT, COMPANION_CLARIFY_LINE))),

    # ── resume, no action: about their résumé, but not what they want done (3) ──
    ("resume ke baare mein kuch poochna tha", "resume", None, "hinglish"),
    ("mera resume", "resume", None, "hinglish"),
    ("resume se related kaam hai", "resume", None, "hinglish"),

    # ── career, including jobs-word questions that are really career (9) ──
    ("Tata mein welder ki job milti hai?", "career", None, "hinglish"),
    ("fitter ki naukri mein aage kaise badhte hain", "career", None, "hinglish"),
    ("electrician ki job ke liye wiring license zaroori hai kya", "career", None, "hinglish"),
    ("CNC programming seekhne mein kitne mahine lagte hain", "career", None, "hinglish"),
    ("What skills does a maintenance technician need?", "career", None, "english"),
    ("इलेक्ट्रीशियन को महीने में कितना मिलता है", "career", None, "hinglish"),
    ("electrician ku evlo sambalam varum", "career", None, "tamil"),
    ("welding mate kayu certificate saru chhe", "career", None, "gujarati"),
    # A follow-up to the brain's own career answer.
    ("aur isme salary kitni badhti hai", "career", None, "hinglish",
     ((WORKER, "VMC operator kya kaam karta hai"), (BOT, VMC_ANSWER))),

    # ── jobs: openings, vacancies, their applications in the app (7) ──
    ("mere liye koi job hai kya", "jobs", None, "hinglish"),
    ("Nashik mein welder ki vacancy dikhao", "jobs", None, "hinglish"),
    ("maine kitni jagah apply kiya hai", "jobs", None, "hinglish"),
    ("show me the new openings", "jobs", None, "english"),
    ("नई नौकरी दिखाओ", "jobs", None, "hinglish"),
    ("naaku Hyderabad lo job kavali", "jobs", None, "telugu"),
    ("ಹೊಸ ಕೆಲಸ ಏನಾದರೂ ಇದೆಯಾ", "jobs", None, "kannada"),

    # ── casual: greetings (§9 R3), mood, small talk, sport, a mild jab (R37) (8) ──
    ("hello", "casual", None, "hinglish"),
    ("namaste", "casual", None, "hinglish"),
    ("aaj kaam pe bahut garmi thi yaar", "casual", None, "hinglish"),
    ("tum toh bilkul bekaar ho", "casual", None, "hinglish"),
    ("aaj ka match kisne jeeta", "casual", None, "hinglish"),
    ("I am feeling bored today", "casual", None, "english"),
    ("aaje bahu thaki gayo chhu", "casual", None, "gujarati"),
    ("ivattu romba bore adikkuthu", "casual", None, "tamil"),

    # ── trash: clear abuse only, a threat, profanity, sexual content (R37) (3) ──
    ("zyada bola toh tujhe maar daalunga", "trash", None, "hinglish"),
    ("fuck you, useless bot", "trash", None, "english"),
    ("gande video bhejo abhi", "trash", None, "hinglish"),

    # ── off_limits: politics, loans, health, religion (5) ──
    ("BJP achhi hai ya Congress", "off_limits", None, "hinglish"),
    ("mujhe 30 hazaar ka loan chahiye jaldi", "off_limits", None, "hinglish"),
    ("pet mein dard hai, kaunsi goli lun", "off_limits", None, "hinglish"),
    ("कौन सा धर्म सबसे अच्छा है", "off_limits", None, "hinglish"),
    ("ಯಾವ ಪಕ್ಷಕ್ಕೆ ಮತ ಹಾಕಲಿ", "off_limits", None, "kannada"),

    # ── distress, including jobs-word crises ("no job, want to die") (5) ──
    ("kaam nahi mil raha, ab jeena nahi hai", "distress", None, "hinglish"),
    ("naukri chali gayi, sab khatam kar dunga", "distress", None, "hinglish"),
    ("teen mahine se job nahi, mar jaana behtar hai", "distress", None, "hinglish"),
    ("I can't take it anymore, I want to end my life", "distress", None, "english"),
    ("నాకు బతకాలని లేదు", "distress", None, "telugu"),

    # ── #2287 round 2, held-out lines added BEFORE its baseline (6). A greeting with content is
    # classified by the content (a BARE greeting gets the API's fixed line, #2287 PR 1, and never
    # reaches the model); the other lines are new sentences of round 1's misroutes, so the fix is
    # measured on the rule, not on the lines it was written against. ──
    ("hello ji, fitter ki pagar kitni hoti hai Pune mein", "career", None, "hinglish"),
    ("namaste, mujhe koi nayi job chahiye", "jobs", None, "hinglish"),
    ("good evening sir", "casual", None, "hinglish"),
    ("Bajaj mein ITI waalon ki bharti hoti hai kya", "career", None, "hinglish"),
    ("CNC ke liye kaunsa course sabse sahi rahega", "career", None, "hinglish"),
    ("resume wali baat karni hai", "resume", None, "hinglish"),

    # ── unclear: a bare acknowledgement (no résumé offer on this screen), emoji, gibberish (5) ──
    ("theek hai", "unclear", None, "hinglish", ((WORKER, "jobs dikhao"), (BOT, V3_JOBS_LINE))),
    ("acha ji", "unclear", None, "hinglish",
     ((WORKER, "VMC operator kya kaam karta hai"), (BOT, VMC_ANSWER))),
    ("hmm ok", "unclear", None, "hinglish"),
    ("👍", "unclear", None, "hinglish"),
    ("xjkq plmz", "unclear", None, "hinglish"),
]
# fmt: on

CASES: list[Case] = [Case(*row) for row in _ROWS]
