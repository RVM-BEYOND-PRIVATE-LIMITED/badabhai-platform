"""The free-chat classifier's LANGUAGE labelled set (ADR-0051 §11 R42, #2240): a BASELINE only.

R42 has the classifier name the language of the worker's last message, and the API sends that
label back as the reply's language, with its word lists only as the backup. This set measures the
label. The staging CLI (``python -m app.free_chat.eval_cli --base-url ... --language``) posts each
line to ``POST /free-chat/classify`` in free mode and prints the accuracy overall, per language,
per script and on Latin-letter Marathi, with every miss. Nothing fails on accuracy (R18/R20).

WHY THESE LINES. The owner's device test (2026-10-14) sent "cam programmer kitee kamai karato?"
and got Hinglish back: "kitee" and "karato" are spellings the word lists did not carry, so the
code detector found no Marathi word and fell to its default. The set therefore leans on what a
word list misses: Latin Marathi as workers type it, misspelt; each regional language in Latin
letters AND in its own script; the same question in Devanagari Marathi and in Devanagari Hindi
(one script, two labels); regional lines carrying English trade words; and the short, unsure
lines the owner's rule sends to Hinglish.

THE LABELS ARE THE OWNER'S RULES (R42, 2026-10-14): Hindi in Latin letters or Devanagari is
``hinglish``; a regional language mixed with English trade words is that regional language; plain
English is ``english``; too short or unsure (a greeting word, a bare "ok", an emoji) is
``hinglish``. Each line is judged ALONE, as the label is: no recent turns are sent.

THE LINES ARE NOT THE PROMPT'S EXAMPLES. The classify prompt quotes "hello" and "yes" for the
short rule; the short lines here are other words, pinned by a test, so the set measures the rule
rather than an echo. ``as_json`` gives the set as ``[{"text", "language"}]`` rows, so the API's
word-list detector can be scored on the very same lines.

TEST DATA ONLY: every line is fabricated except the three device-test lines, which the owner
typed as test messages; none carries PII.
"""

from __future__ import annotations

import json
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, NamedTuple, get_args

from ..contracts import FreeChatReplyLanguage

#: Every label a line may carry, in the contract's order (`FREE_CHAT_REPLY_LANGUAGES`, pinned).
LANGUAGES: tuple[str, ...] = get_args(FreeChatReplyLanguage)

Script = Literal["latin", "native"]
SCRIPTS: tuple[str, ...] = get_args(Script)

#: What a prediction is when the service gave none the API could act on (a failure, a mock, a
#: late or blocked answer) or the label was null. Scored as a miss, reported under its own name.
UNAVAILABLE = "<none>"

#: The owner's device-test lines (2026-10-14), with the labels the owner gave them.
DEVICE_LINES: tuple[tuple[str, str], ...] = (
    ("cam programmer kitee kamai karato?", "marathi"),
    ("mala adhik utpanna denara ekhada navin vyavsay shikayacha aahe.", "marathi"),
    ("cnc turner kitna kamata hai yana", "hinglish"),
)


class Case(NamedTuple):
    text: str
    language: str


def script_of(text: str) -> Script:
    """``native`` when the line carries any letter outside the Latin script (Devanagari, Gujarati,
    Kannada, Telugu, Tamil), else ``latin``. An emoji or a "?" is no letter at all: ``latin``."""
    for ch in text:
        if ch.isalpha() and not unicodedata.name(ch, "").startswith("LATIN"):
            return "native"
    return "latin"


@dataclass(frozen=True)
class LanguageScore:
    total: int
    correct: int
    accuracy: float
    #: language -> (correct, total), in :data:`LANGUAGES` order.
    per_language: dict[str, tuple[int, int]]
    #: (language, script) -> (correct, total), only the pairs the set carries.
    per_script: dict[tuple[str, str], tuple[int, int]]
    #: predicted label -> count, for the "what did it say instead" view.
    predicted: dict[str, int]
    #: expected -> {predicted: count} for the misses only.
    confusion: dict[str, dict[str, int]]
    misses: list[str]


def evaluate(predict: Callable[[Case], str | None]) -> LanguageScore:
    """Score ``predict(case)`` over the set. No thresholds.

    ``None`` is :data:`UNAVAILABLE`, a miss for every language: the API falls back to its word
    lists then, so the label did not decide anything.
    """
    correct = 0
    by_language = {language: [0, 0] for language in LANGUAGES}
    by_script: dict[tuple[str, str], list[int]] = {}
    predicted_counts: Counter[str] = Counter()
    confusion: dict[str, Counter[str]] = {}
    misses: list[str] = []
    for row in CASES:
        case = Case(*row)
        predicted = predict(case) or UNAVAILABLE
        predicted_counts[predicted] += 1
        key = (case.language, script_of(case.text))
        slot = by_script.setdefault(key, [0, 0])
        by_language[case.language][1] += 1
        slot[1] += 1
        if predicted == case.language:
            correct += 1
            by_language[case.language][0] += 1
            slot[0] += 1
        else:
            confusion.setdefault(case.language, Counter())[predicted] += 1
            misses.append(f"[{key[1]}] {case.text!r}: expected {case.language}, got {predicted}")
    return LanguageScore(
        total=len(CASES),
        correct=correct,
        accuracy=correct / len(CASES),
        per_language={k: (v[0], v[1]) for k, v in by_language.items()},
        per_script={
            key: (by_script[key][0], by_script[key][1])
            for key in sorted(by_script, key=lambda k: (LANGUAGES.index(k[0]), SCRIPTS.index(k[1])))
        },
        predicted=dict(sorted(predicted_counts.items(), key=lambda item: (-item[1], item[0]))),
        confusion={k: dict(v.most_common()) for k, v in confusion.items()},
        misses=misses,
    )


def as_json() -> str:
    """The set as ``[{"text": ..., "language": ...}]``, for scoring another detector on it."""
    rows = [{"text": case.text, "language": case.language} for case in CASES]
    return json.dumps(rows, ensure_ascii=False, indent=1)


# fmt: off
# (text, expected language). Grouped by what each block measures.
_ROWS: list[tuple[str, str]] = [
    # ── the device test (3) ──
    *DEVICE_LINES,

    # ── Marathi in Latin letters, as typed: misspelt, short forms, no listed marker (14) ──
    ("welder la mahina kiti pagar milto?", "marathi"),
    ("mi fitter aahe, mala navin kam pahije", "marathi"),
    ("electrician honyasathi konta course karava lagel", "marathi"),
    ("majhi shift khup lamb aste, ghari yeun thakun jato", "marathi"),
    ("turner cha kaam kasa shikaycha?", "marathi"),
    ("mla CNC operator vhaycha ahe", "marathi"),
    ("kiti varsh lagtil welding shikayla", "marathi"),
    ("aaj kamavar jaycha kantala ala", "marathi"),
    ("plumber la kitee pagar bhetato", "marathi"),
    ("malaa nokri badlaychi aahe, kay karu", "marathi"),
    ("tumhi resume banvun deta ka?", "marathi"),
    ("fitter kamasathi ITI garjecha ahe ka", "marathi"),
    ("kahi samjat nahi, punha sanga", "marathi"),
    ("ghari baslo aahe, kaam nahi milala ajun", "marathi"),

    # ── Marathi in Devanagari, then the same questions in Hindi (one script, two labels) (10) ──
    ("मला वेल्डिंग शिकायचे आहे", "marathi"),
    ("सीएनसी ऑपरेटरला किती पगार मिळतो?", "marathi"),
    ("आज खूप काम होतं, थकलो आहे", "marathi"),
    ("माझं रेझ्युमे बनवून द्या", "marathi"),
    ("इलेक्ट्रिशियन होण्यासाठी काय करावं लागेल?", "marathi"),
    ("मुझे वेल्डिंग सीखनी है", "hinglish"),
    ("सीएनसी ऑपरेटर को कितनी सैलरी मिलती है?", "hinglish"),
    ("आज बहुत काम था, थक गया हूँ", "hinglish"),
    ("मेरा रिज्यूमे बना दीजिए", "hinglish"),
    ("इलेक्ट्रीशियन बनने के लिए क्या करना होगा?", "hinglish"),

    # ── Hinglish in Latin letters (9) ──
    ("mujhe fitter ka kaam seekhna hai", "hinglish"),
    ("kal se kaam pe nahi gaya, tabiyat kharab thi", "hinglish"),
    ("koi accha course batao CNC ke liye", "hinglish"),
    ("kitne din mein welding aa jayegi", "hinglish"),
    ("aaj mann nahi lag raha kaam mein", "hinglish"),
    ("turner ka kaam karta hoon 4 saal se", "hinglish"),
    ("resume bana do mera please", "hinglish"),
    ("kya main bina ITI ke electrician ban sakta hoon", "hinglish"),
    ("salary kab tak badhegi is line mein", "hinglish"),

    # ── plain English (7) ──
    ("How much does a CNC operator earn per month?", "english"),
    ("I want to learn welding, where should I start?", "english"),
    ("Is ITI necessary to become an electrician?", "english"),
    ("I am feeling very tired after work today", "english"),
    ("Please make my resume for a fitter job", "english"),
    ("What tools should a fitter know how to use?", "english"),
    ("Can you suggest a good course for plumbing?", "english"),

    # ── too short or unsure: Hinglish by the owner's rule (6) ──
    ("hmm", "hinglish"),
    ("👍", "hinglish"),
    ("hi", "hinglish"),
    ("thanks", "hinglish"),
    ("??", "hinglish"),
    ("k", "hinglish"),

    # ── Gujarati: Latin letters (with "kya", Gujarati for "where"), then its script (9) ──
    ("mare welding shikhvu chhe, kya thi sharu karu?", "gujarati"),
    ("CNC operator ne mahine ketlo pagar male?", "gujarati"),
    ("aaje bahu kaam hatu, thaki gayo chhu", "gujarati"),
    ("maru resume banavi aapo", "gujarati"),
    ("fiter nu kam kevi rite shikhay", "gujarati"),
    ("મારે વેલ્ડિંગ શીખવું છે", "gujarati"),
    ("સીએનસી ઓપરેટરનો પગાર કેટલો હોય?", "gujarati"),
    ("આજે બહુ થાક લાગ્યો છે", "gujarati"),
    ("મારો બાયોડેટા બનાવી આપો", "gujarati"),

    # ── Kannada: Latin letters, then its script (9) ──
    ("nanage welding kalibeku, elli shuru maadali?", "kannada"),
    ("CNC operator ge sambala eshtu sigutte?", "kannada"),
    ("ivattu tumba kelasa ittu, sustaagide", "kannada"),
    ("nanna resume maadi kodi", "kannada"),
    ("fitter kelsa hege kaltkolodu", "kannada"),
    ("ನನಗೆ ವೆಲ್ಡಿಂಗ್ ಕಲಿಯಬೇಕು", "kannada"),
    ("CNC ಆಪರೇಟರ್ ಸಂಬಳ ಎಷ್ಟು?", "kannada"),
    ("ಇವತ್ತು ತುಂಬಾ ಸುಸ್ತಾಗಿದೆ", "kannada"),
    ("ನನ್ನ ರೆಸ್ಯೂಮೆ ಮಾಡಿ ಕೊಡಿ", "kannada"),

    # ── Telugu: Latin letters, then its script (9) ──
    ("naaku welding nerchukovali, ekkada start cheyali?", "telugu"),
    ("CNC operator ki jeetham entha untundi?", "telugu"),
    ("ivala chala pani chesanu, alasipoyanu", "telugu"),
    ("naa resume chesi pettandi", "telugu"),
    ("fiter pani ela nerchukovalo cheppandi", "telugu"),
    ("నాకు వెల్డింగ్ నేర్చుకోవాలి", "telugu"),
    ("CNC ఆపరేటర్ కి జీతం ఎంత?", "telugu"),
    ("ఈరోజు చాలా అలసిపోయాను", "telugu"),
    ("నా రెజ్యూమ్ చేసి పెట్టండి", "telugu"),

    # ── Tamil: Latin letters, then its script (9) ──
    ("enakku welding kathukkanum, enga aarambikkanum?", "tamil"),
    ("CNC operator ku sambalam evvalavu?", "tamil"),
    ("inniki romba velai, tired ah irukku", "tamil"),
    ("en resume panni kudunga", "tamil"),
    ("fiter velai epdi kathukradhu", "tamil"),
    ("எனக்கு வெல்டிங் கத்துக்கணும்", "tamil"),
    ("CNC ஆபரேட்டருக்கு சம்பளம் எவ்வளவு?", "tamil"),
    ("இன்னைக்கு ரொம்ப களைப்பா இருக்கு", "tamil"),
    ("என் ரெஸ்யூம் பண்ணி குடுங்க", "tamil"),

    # ── a regional language carrying English trade words: still that language (6) ──
    ("CNC programming course online ahe ka, fees kiti?", "marathi"),
    ("welding certificate sathi ITI admission kadhi suru hote?", "marathi"),
    ("forklift license mate kaya documents joie?", "gujarati"),
    ("company safety shoes helmet kodutte na?", "kannada"),
    ("night shift allowance company ivvatledu, ela adagali?", "telugu"),
    ("overtime salary company kudukkala, enna pannalam?", "tamil"),
]
# fmt: on

CASES: list[Case] = [Case(*row) for row in _ROWS]
