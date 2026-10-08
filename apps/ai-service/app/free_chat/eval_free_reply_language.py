"""The free-chat reply-language set and scorer (ADR-0051 §11, #2181): a MEASUREMENT, not a gate.

§9 asked the reply model to pick its own language, and on the production model it would not:
regional questions got Hinglish, "marathi mai jawab do" got the previous answer word for word, and
replies slipped into "tum" forms. §11 (R39, R40) has the API decide the language and send it as
``reply_language``. This set measures whether a reply follows it. The staging CLI
(``python -m app.free_chat.eval_reply_language_cli --base-url ...``) runs it twice: the BASELINE
omits ``reply_language`` (today's prompt choosing for itself), the REVISED run sends it.

WHAT A CASE IS. The worker's message, the recent turns the API would send with it, the reply
category the classifier would have picked, and the ``reply_language`` the API's detector (or the
worker's kept choice, R41) would send. Three kinds:
- ``message``: the language is the message's own (English; Hinglish in Latin letters and Hindi in
  Devanagari; each of the five regional languages in Latin letters and in its own script);
- ``request``: a bare language request after an earlier answer ("marathi mai jawab do"), which
  must re-answer the earlier question in that language, never repeat it;
- ``kept``: the worker chose to keep a language (R41 "Haan"), so the reply follows it even when
  the message is written in another one.

WHAT IS SCORED, PER REPLY (lines for the language, lines AND chips for the walls the API runs
over both):
(a) LANGUAGE: marker words per language, counted over the reply lines. The target must lead with
    at least :data:`MIN_MARKERS` markers and no tie. English means no Hindi or regional marker at
    all, and at least :data:`MIN_MARKERS` English function words.
(b) LATIN LETTERS ONLY, the API's ``non_latin`` wall (a regional script serves the fallback).
(c) PERSONA SLIPS: the Hinglish "tum" forms of :data:`HINGLISH_TUM_WORDS` and
    :data:`HINGLISH_TUM_PHRASES` (on a reply that is Hinglish, or should be Hinglish or English),
    and the regional familiar address and informal "you" of §9 (on every reply, as the API's
    regional wall runs on every reply).
(d) A VERBATIM REPEAT: a sentence of :data:`REPEAT_MIN_WORDS` or more words that an earlier
    assistant turn already said, word for word or with a word or two swapped
    (:data:`REPEAT_MIN_RATIO`).

A HEURISTIC, AND STATED AS ONE. Marker words are the frequent function words, pronouns and verb
endings of each language as romanized by a model; a word two languages share ("kaam", "nahi",
"ka", "che", "pani", "illa") is left out of both, so a reply is read by what only its language
says. A refusal is not a language miss (the API serves reviewed copy for it); it is counted on its
own. The scorer reads text only: it never decides anything, and a run is reported, never gated.

TEST DATA ONLY: every line is fabricated. No worker typed one, and none carries PII.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Literal, get_args

from ..contracts import FreeChatReplyCategory, FreeChatReplyLanguage
from .prompts import REGIONAL_PERSONA_TOKENS

#: Every reply language, in the contract's order (`FREE_CHAT_REPLY_LANGUAGES`, pinned by a test).
LANGUAGES: tuple[str, ...] = get_args(FreeChatReplyLanguage)
REGIONAL: tuple[str, ...] = ("marathi", "gujarati", "kannada", "telugu", "tamil")

Script = Literal["latin", "native"]
Kind = Literal["message", "request", "kept"]
KINDS: tuple[str, ...] = get_args(Kind)

#: One recent turn as the API sends it: (role, text), role "worker" or "bada_bhai".
Turn = tuple[str, str]
BOT = "bada_bhai"
WORKER = "worker"

#: What the scorer calls a reply whose markers name no single language.
MIXED = "<mixed>"

#: A language leads a reply only with at least this many of its markers (and more than any other).
MIN_MARKERS = 2
#: A shorter sentence ("Theek hai.") is not counted as a repeat: it is ordinary talk.
REPEAT_MIN_WORDS = 4
#: How alike two sentences' word runs must be to count as a repeat (difflib's ratio): 1.0 is
#: word for word; 0.8 still catches one word swapped in a ten-word sentence.
REPEAT_MIN_RATIO = 0.8

# ── the fixed lines a free chat opens with (ADR-0051 §5.1, verbatim) ─────────────────────────

GREETING_LINE = (
    "Namaste, main Bada Bhai hoon. Aapka resume banane mein madad karunga. Shuru karein?"
)
LATER_ACK_LINE = "Theek hai. Jab mann ho, resume bana lenge. Tab tak kuch bhi poochhiye."
#: The free chat as it starts after the worker says "Baad mein" to the greeting (§3.1). These
#: Hinglish turns are what pulled §9's replies back to Hinglish, so most message cases carry them.
OPENING: tuple[Turn, ...] = ((BOT, GREETING_LINE), (WORKER, "Baad mein"), (BOT, LATER_ACK_LINE))


def kept(language_name: str) -> tuple[Turn, ...]:
    """The three turns after a worker keeps a language (§11 R41): the ask, "Haan", the yes line."""
    return (
        (BOT, f"Kya aage ki saari baat {language_name} mein karein?"),
        (WORKER, f"Haan, {language_name} mein"),
        (BOT, f"Theek hai, ab se {language_name} mein baat karenge."),
    )


@dataclass(frozen=True)
class Case:
    id: str
    reply_language: FreeChatReplyLanguage
    #: The script the WORKER wrote in ("native" is Devanagari for Hindi and Marathi, else the
    #: language's own). A reply is always expected in Latin letters.
    script: Script
    kind: Kind
    category: FreeChatReplyCategory
    text: str
    #: The recent turns sent with the message, oldest first (the contract allows six).
    turns: tuple[Turn, ...] = ()


# ── the earlier answers a language request follows (fabricated bot turns) ───────────────────

#: The 2026-10-08 device turn's shape: a Marathi question answered in Hinglish with "tum" forms.
PLUMBING_Q_MR = (
    "mala plumbing che kaam shikayche aahe, pan mala kahich mahiti nahi. lavkar paise "
    "kamavnyasathi suruvat kashi karu?"
)
PLUMBING_A_TUM = (
    "Plumbing seekhne ke liye kisi experienced plumber ke saath helper ban jao.\n"
    "Teen se chhe mahine mein basic kaam seekh jaoge, phir chhote kaam se kamana shuru kar "
    "sakte ho."
)
CNC_Q = "CNC operator ki salary kitni hoti hai"
CNC_A = (
    "Aam taur par CNC operator ko ₹15,000 se ₹25,000 mahina milta hai.\n"
    "Shehar, machine aur tajurbe par depend karta hai."
)
ELEC_Q = "electrician ka kaam seekhne mein kitna time lagta hai"
ELEC_A = (
    "ITI ka electrician course do saal ka hota hai.\n"
    "Saath mein kisi senior ke saath kaam karke jaldi seekh sakte hain."
)
WELD_Q = "welding mein kaun sa certificate kaam aata hai"
WELD_A = (
    "ITI welder ya NSDC ka welding certificate kaafi kaam aata hai.\n"
    "Saath mein practical kaam dikhana bhi zaroori hai."
)
FITTER_Q = "fitter ko kaun se tools chalane aane chahiye"
FITTER_A = (
    "Fitter ko measuring tape, vernier caliper aur spanner set chalana aana chahiye.\n"
    "Drawing padhna bhi seekhiye, isse kaam aasaan hota hai."
)
HOLIDAY_Q = "aaj chhutti hai, kya karun"
HOLIDAY_A = "Chhutti ke din aaram kijiye, parivaar ke saath samay bitaiye."
FORKLIFT_Q = "How do I become a forklift operator?"
FORKLIFT_A = (
    "You can join a short forklift training course at a training centre.\n"
    "After that, a warehouse helper job gives you daily practice."
)

# fmt: off
CASES: list[Case] = [
    # English in, English out (R40).
    Case("en-1", "english", "latin", "message", "career",
         "Which welding certificate helps to get a better salary?", OPENING),
    Case("en-2", "english", "latin", "message", "career",
         "How can I learn CNC programming? Is there any short course?"),
    Case("en-3", "english", "latin", "message", "casual",
         "Good morning, how are you today?", OPENING),
    Case("en-4", "english", "latin", "message", "career",
         "What safety checks should an electrician do before starting work?"),
    Case("en-5", "english", "latin", "message", "casual",
         "I am very tired after the night shift today", OPENING),

    # Hindi or Hinglish, either script: Hinglish.
    Case("hi-1", "hinglish", "latin", "message", "career",
         "fitter ke kaam mein aage badhne ke liye kya seekhna chahiye", OPENING),
    Case("hi-2", "hinglish", "latin", "message", "career",
         "plumber ka kaam shuru karna hai, kahan se seekhun"),
    Case("hi-3", "hinglish", "latin", "message", "casual",
         "aaj bahut garmi hai, kaam karna mushkil ho gaya", OPENING),
    Case("hi-4", "hinglish", "native", "message", "career",
         "इलेक्ट्रीशियन बनने के लिए कौन सा कोर्स करूँ?", OPENING),
    Case("hi-5", "hinglish", "native", "message", "casual",
         "आज मन ठीक नहीं है, घर की याद आ रही है"),

    # Marathi, Latin and Devanagari.
    Case("mr-1", "marathi", "latin", "message", "career", PLUMBING_Q_MR, OPENING),
    Case("mr-2", "marathi", "latin", "message", "career",
         "welding shikayla kiti divas lagtat ani course kuthe karu?"),
    Case("mr-3", "marathi", "latin", "message", "casual",
         "aaj khup thakva aala aahe, kaam jast hota", OPENING),
    Case("mr-4", "marathi", "native", "message", "career",
         "मला इलेक्ट्रिशियनचे काम शिकायचे आहे, कुठून सुरुवात करू?", OPENING),
    Case("mr-5", "marathi", "native", "message", "casual",
         "आज खूप पाऊस आहे, कामावर जायला उशीर झाला"),

    # Gujarati, Latin and Gujarati script.
    Case("gu-1", "gujarati", "latin", "message", "career",
         "mare electrician nu kaam shikhvu chhe, kevi rite sharu karu?", OPENING),
    Case("gu-2", "gujarati", "latin", "message", "casual",
         "aaje kaam ma bahu thaak lagyo chhe"),
    Case("gu-3", "gujarati", "native", "message", "career",
         "મારે વેલ્ડિંગ શીખવું છે, કયો કોર્સ કરું?", OPENING),
    Case("gu-4", "gujarati", "native", "message", "casual",
         "આજે ઘરની બહુ યાદ આવે છે"),

    # Kannada, Latin and Kannada script.
    Case("kn-1", "kannada", "latin", "message", "career",
         "nanage CNC machine kelasa kalibeku, hege shuru maadali?", OPENING),
    Case("kn-2", "kannada", "latin", "message", "casual",
         "ivattu tumba kelasa ittu, tumba sustaagide"),
    Case("kn-3", "kannada", "native", "message", "career",
         "ನನಗೆ ಎಲೆಕ್ಟ್ರಿಷಿಯನ್ ಆಗಬೇಕು, ಯಾವ ಕೋರ್ಸ್ ಮಾಡಬೇಕು?", OPENING),
    Case("kn-4", "kannada", "native", "message", "casual",
         "ಇವತ್ತು ಮನೆಯ ನೆನಪು ತುಂಬಾ ಬರ್ತಿದೆ"),

    # Telugu, Latin and Telugu script.
    Case("te-1", "telugu", "latin", "message", "career",
         "naaku welding nerchukovali, ela start cheyali?", OPENING),
    Case("te-2", "telugu", "latin", "message", "casual",
         "ivala chala pani undi, chala alasipoyanu"),
    Case("te-3", "telugu", "native", "message", "career",
         "నాకు ప్లంబింగ్ పని నేర్చుకోవాలి, ఎక్కడ మొదలు పెట్టాలి?", OPENING),
    Case("te-4", "telugu", "native", "message", "casual",
         "ఈరోజు ఇంటి గుర్తు చాలా వస్తోంది"),

    # Tamil, Latin and Tamil script.
    Case("ta-1", "tamil", "latin", "message", "career",
         "enakku plumbing velai kathukanum, eppadi aarambikkaradhu?", OPENING),
    Case("ta-2", "tamil", "latin", "message", "casual",
         "inniki romba velai, romba tired ah irukku"),
    Case("ta-3", "tamil", "native", "message", "career",
         "எனக்கு எலக்ட்ரீஷியன் வேலை கத்துக்கணும், எந்த கோர்ஸ் பண்ணணும்?", OPENING),
    Case("ta-4", "tamil", "native", "message", "casual",
         "இன்னைக்கு வீட்டு ஞாபகம் ரொம்ப வருது"),

    # A bare language request (R41): the earlier question again, in the language asked for.
    Case("rq-mr", "marathi", "latin", "request", "career", "marathi mai jawab do",
         ((BOT, LATER_ACK_LINE), (WORKER, PLUMBING_Q_MR), (BOT, PLUMBING_A_TUM))),
    Case("rq-en", "english", "latin", "request", "career", "reply in English please",
         ((WORKER, CNC_Q), (BOT, CNC_A))),
    Case("rq-ta", "tamil", "latin", "request", "career", "Tamil-la sollunga",
         ((WORKER, ELEC_Q), (BOT, ELEC_A))),
    Case("rq-gu", "gujarati", "latin", "request", "career", "gujarati ma javab aapo",
         ((WORKER, WELD_Q), (BOT, WELD_A))),
    Case("rq-te", "telugu", "latin", "request", "career", "telugu lo cheppandi",
         ((WORKER, FITTER_Q), (BOT, FITTER_A))),
    Case("rq-kn", "kannada", "latin", "request", "casual", "kannadadalli heli",
         ((WORKER, HOLIDAY_Q), (BOT, HOLIDAY_A))),
    Case("rq-hi", "hinglish", "latin", "request", "career", "hindi mein batao",
         ((WORKER, FORKLIFT_Q), (BOT, FORKLIFT_A))),

    # A kept language (R41 "Haan"): the reply follows it, whatever the message is written in.
    Case("kept-mr", "marathi", "latin", "kept", "career",
         "fitter ka kaam kaise seekhun", kept("Marathi")),
    Case("kept-ta", "tamil", "latin", "kept", "career",
         "What is the salary of a welder in Chennai?", kept("Tamil")),
]
# fmt: on

# ── (a) the language markers ───────────────────────────────────────────────────────────────

#: Hindi words no Latin regional reply uses (so a Marathi or Gujarati reply that borrows "kaam"
#: or "nahi" is not read as Hindi). Shared words are deliberately absent.
HINDI_MARKERS = frozenset(
    {
        "hai", "hain", "mein", "kya", "liye", "bhi", "aur", "sakte", "sakta", "sakti",
        "chahiye", "kariye", "kijiye", "karein", "achha", "accha", "acha", 
        "bahut", "apna", "apne", "apni", "jaise", "raha", "hoga", "hogi",
        "honge", "milta", "milti", "milte", "milega", "milegi", "milenge", "dijiye", "lijiye",
        "dekhiye", "seekhiye", "sikhiye", "poochhiye", "puchiye", "rakhiye", 
        "karna", "phir", "aapko", "aapka", "aapki", "aapke", "yeh", "woh",
        "kuch", "zyada", "jyada", "pehle", "baad", "saath", "kaise", "kitna", "kitni", "kaun",
        "abhi", "toh", "se", "ko", "wala", "wali", "wale", "lekin", "sirf", "zaroori",
        "zaruri", "seekhna", "seekhne", "hoon", "jab", "agar", "kyunki", "isliye",
        "tak", "kahan", "gaya", "gayi", "seekh",
    }
)  # fmt: skip
MARATHI_MARKERS = frozenset(
    {
        "aahe", "ahe", "aahet", "ahet", "tumhi", "tumhala", "tumcha", "tumchi", "tumche",
        "tumchya", "mala", "kay", "kasa", "kashi", "kase", "karayla", "karaycha", "karaychi",
        "karayche", "karava", "karavi", "karave", "shakta", "shakto", "shakal", "shakat",
        "pahije", "madhe", "madhye", "sathi", "aani", "khup", "jast",
        "jasta", "kuthe", "lagel", "lagtat", "yeil", "yeto", "yete", "hoil", "asel", "asto",
        "aste", "milel", "shika", "kara", "ghya", "bagha", "mhanje", "kiva", "kinva", "zala",
        "zali", "jhala", "jhali", "kela", "keli", "karun", "gheun", "aamhi", "aapan",
        "tyasathi", "changla", "changle", "chhan", "sagla", "saglya", "pudhe", "nantar",
        "kaahi", "suru", "hoto", "suruvat", "kahich", "lavkar", "kiti", "shikayla", "aala",
        "shikun", 
    }
)  # fmt: skip
GUJARATI_MARKERS = frozenset(
    {
        "chhe", "chho", "tame", "tamne", "tamaru", "tamari", "tamaro", "tamara", "ane",
        "maate", "shu", "kem", "kevi", "shako", "shakay", "shaksho", "shakshe", "joie",
        "joiye", "joishe", "thashe", "hashe", "karvu", "karvanu", "karva", "karjo", "shikhjo",
        "rakhjo", "sathe", "pachhi", "pachi", "vadhu", "ghanu", "nathi", "aavi", "aapo",
        "shikhvu", "shikhi", "shiko", "saru", "majama", "evu", "ema", "malse", "malshe",
        "jaruri", "sharu", "mane", "kharekhar", "aaje", "lagyo", "thay",
    }
)  # fmt: skip
KANNADA_MARKERS = frozenset(
    {
        "neevu", "nimma", "nimage", "nimge", "maadi", "madi", "maadabahudu", "maadbahudu",
        "maadabeku", "idhe", "hege", "yenu", "enu", "kelasa", "kelasakke", "kalitukolli",
        "kaliyiri", "kaliyabahudu", "kalibeku", "beku", "beda", "tumba", "chennagi", "aadare",
        "adare", "mattu", "alli", "inda", "agutte", "aagutte", "aguttade", "aaguttade",
        "nodi", "bahudu", "swalpa", "aagi", "illi", "yaake", "elli", "hosa", 
        "nantara", "ondu", "saku", "sigutte", "sikkuttade", "ashtu", "jothe",
        "ivattu", "nanage", "maadali", "ittu", "barutte",
    }
)  # fmt: skip
TELUGU_MARKERS = frozenset(
    {
        "meeru", "mee", "meeku", "mimmalni", "cheyyandi", "cheyandi", "cheyyali", "cheyali",
        "cheyochu", "cheyyochu", "undi", "unnayi", "untundi", "untayi", "emiti", "ela", "elaa",
        "kavali", "nerchukondi", "nerchukovachu", "nerchukovali", "chaala", "baga", "baaga",
        "ledu", "antey", "chesi", "avutundi", "avvachu", "kosam", "mundu", "tarvata",
        "taruvata", "andi", "enduku", "ekkada", "oka", "matrame", "chudandi", "choodandi",
        "cheppandi", "vachu", "kani", "ippudu", "ivvandi", "pettandi", "dorukutundi",
        "vastundi", "gurinchi", "konchem", "naaku", "ivala",
    }
)  # fmt: skip
TAMIL_MARKERS = frozenset(
    {
        "neenga", "unga", "ungalukku", "ungaloda", "ungal", "enna", "eppadi", "epdi",
        "irukku", "irukkum", "irukkanum", "irunga", "panna", "pannunga", "pannalam",
        "pannanum", "velai", "romba", "kathukonga", "kathukalam", "kathukkalam", "kathukanum",
        "aana", "naan", "sollunga", "theriyum", "mudiyum", "konjam", "appuram", "aprom",
        "ellam", "ellaam", "inga", "seri", "thaan", "dhaan", "oru", "varum", "pogalam",
        "venum", "vendum", "kudukkum", "pathi", "paathu", "maari", "madhiri", "maadhiri",
        "aagum", "edhavadhu", "onnum", "nalla", "vaanga", "ponga", "paarunga", "edunga",
        "kelunga", "kudunga", "inniki", "innaikku",
    }
)  # fmt: skip
#: Word endings only one language makes: Marathi "-sathi" ("karnyasathi") and "-chya"
#: ("kamachya"), Tamil "-kku" ("enakku", "velaikku"), Kannada "-dalli"/"-nalli" ("kelasadalli").
#: Read only on a word at least three letters longer than the ending.
MARKER_ENDINGS: Mapping[str, tuple[str, ...]] = {
    "marathi": ("sathi", "chya"),
    "tamil": ("kku",),
    "kannada": ("dalli", "nalli"),
}
#: The markers per language, in the contract's order (English has none: it is read by absence).
MARKERS: Mapping[str, frozenset[str]] = {
    "hinglish": HINDI_MARKERS,
    "marathi": MARATHI_MARKERS,
    "gujarati": GUJARATI_MARKERS,
    "kannada": KANNADA_MARKERS,
    "telugu": TELUGU_MARKERS,
    "tamil": TAMIL_MARKERS,
}
#: For an ENGLISH reply, any Hindi word at all is a miss (R40: "no Hindi words"), shared ones
#: included.
HINDI_ANY = HINDI_MARKERS | frozenset(
    {
        "aap", "nahi", "nahin", "ka", "ki", "ke", "kaam", "hota", "hoti", "ji", "haan",
        "mahina", "mahine", "saal", "naukri", "karo", "jao", "jaao", "namaste", "shukriya",
        "dhanyavaad", "bhai", "yaar", "chaliye", "chalo", "theek", "thik", "karta", "karte",
        "karne", "shuru", "kafi", "kaafi", "rahe", "rahi",
    }
)  # fmt: skip
#: Common English words: an English reply must carry at least :data:`MIN_MARKERS` of them.
ENGLISH_WORDS = frozenset(
    {
        "the", "you", "your", "is", "are", "can", "to", "and", "for", "of", "in", "it", "this",
        "that", "with", "will", "be", "get", "a", "an", "at", "on", "or", "as", "if", "also",
        "after", "before", "more", "some", "any", "how", "what", "which", "learn", "work",
        "start", "good", "help", "take", "make", "first", "then", "from", "by", "do", "should",
        "please", "try", "many", "much", "very", "well", "better", "rest", "day", "today",
    }
)  # fmt: skip

_WORD = re.compile(r"[a-z]+")


def _tokens(text: str) -> list[str]:
    """Lowercase Latin words, accents dropped (NFKD), so "Kariyé" reads as "kariye"."""
    folded = unicodedata.normalize("NFKD", text.casefold())
    return _WORD.findall("".join(ch for ch in folded if not unicodedata.combining(ch)))


def _is_marker(token: str, language: str) -> bool:
    if token in MARKERS[language]:
        return True
    return any(
        token.endswith(ending) and len(token) >= len(ending) + 3
        for ending in MARKER_ENDINGS.get(language, ())
    )


def marker_counts(text: str) -> dict[str, int]:
    """How many marker words of each non-English language ``text`` carries, word by word."""
    tokens = _tokens(text)
    return {
        language: sum(1 for token in tokens if _is_marker(token, language)) for language in MARKERS
    }


def detect_language(text: str) -> str:
    """The one language ``text`` is written in, by its markers, or :data:`MIXED`.

    A language leads with at least :data:`MIN_MARKERS` markers and more than any other. English
    is read by absence: no marker of any language, no Hindi word at all, and at least
    :data:`MIN_MARKERS` common English words.
    """
    counts = marker_counts(text)
    ranked = sorted(counts.values(), reverse=True)
    for language, count in counts.items():
        if count >= MIN_MARKERS and count == ranked[0] and count > ranked[1]:
            return language
    tokens = _tokens(text)
    if (
        not any(counts.values())
        and not any(token in HINDI_ANY for token in tokens)
        and sum(token in ENGLISH_WORDS for token in tokens) >= MIN_MARKERS
    ):
        return "english"
    return MIXED


# ── (b) Latin letters only ───────────────────────────────────────────────────────────────────

#: The unit symbols the API's `non_latin` wall strips before it looks (µ μ Ω Ω).
_UNIT_SYMBOLS = re.compile("[µμΩΩ]")


def non_latin(texts: Iterable[str]) -> bool:
    """True when any text holds a letter or mark outside the Latin script, or a danda, as the
    API's `non_latin` wall reads it (unit symbols aside)."""
    for text in texts:
        for ch in _UNIT_SYMBOLS.sub("", text):
            if ch in "।॥":
                return True
            kind = unicodedata.category(ch)[0]
            name = unicodedata.name(ch, "")
            if kind == "L" and not name.startswith("LATIN"):
                return True
            if kind == "M" and not name.startswith("COMBINING"):
                return True
    return False


# ── (c) persona slips ────────────────────────────────────────────────────────────────────────

#: The Hinglish "tum" (and "tu") forms (R17 is always "aap"), a CLOSED list: the imperatives, the
#: tum future in "-oge", the informal pronouns, the familiar address persona v3.2 bans, and
#: "karunga", which a reply cannot keep (the bot does nothing after it answers). "Chalo" is
#: persona-sanctioned and absent.
HINGLISH_TUM_WORDS = frozenset(
    {
        "karo", "jao", "jaao", "seekho", "sikho", "dekho", "lo", "lelo", "rakho", "suno",
        "bolo", "batao", "socho", "padho", "likho", "banao", "dhundho", "dhoondho", "poocho",
        "pucho", "milo", "aao", "ruko", "bhejo", "chalao", "pehno", "lagao", "kamao", "raho",
        "karoge", "jaoge", "seekhoge", "sikhoge", "paoge", "kamaoge", "lagoge", "banoge",
        "rahoge", "sakoge", "doge", "loge", "dekhoge", "badhaoge", "samjhoge", "karunga",
        "tu", "tum", "tera", "tere", "teri", "tumhara", "tumhare", "tumhari", "tumhe", "tumko",
        "yaar", "beta", "bhaiya",
    }
)  # fmt: skip
HINGLISH_TUM_PHRASES: tuple[str, ...] = (
    "sakte ho", "karte ho", "rahe ho", "chahte ho", "jaate ho", "jate ho", "lagte ho",
    "de do", "kar do", "bata do", "kar lo", "le lo", "seekh lo",
    "kar le", "le le", "pi le", "de de", "dekh le", "seekh le", "kha le",
    "le lena", "kar lena", "dekh lena", "rakh lena",
)  # fmt: skip
#: §9's familiar address and informal "you", the API's regional persona wall (pinned there).
REGIONAL_SLIP_WORDS = frozenset(REGIONAL_PERSONA_TOKENS)


def persona_slips(texts: Iterable[str], *, hinglish: bool) -> list[str]:
    """Every slip in ``texts``, in order: the regional words always, and the Hinglish "tum" forms
    when the reply is (or should be) Hinglish. Gujarati "karo" and Telugu "lo" are respectful or
    plain there, so the Hinglish list never reads a reply in those languages. "Bada Bhai" is the
    product's own name and is dropped before the scan, as the API does."""
    found: list[str] = []
    for text in texts:
        folded = f" {' '.join(_tokens(text))} ".replace(" bada bhai ", " ")
        tokens = folded.split()
        for token in tokens:
            if token in REGIONAL_SLIP_WORDS or (hinglish and token in HINGLISH_TUM_WORDS):
                found.append(token)
        if hinglish:
            found.extend(phrase for phrase in HINGLISH_TUM_PHRASES if f" {phrase} " in folded)
    return found


# ── (d) verbatim repeats ─────────────────────────────────────────────────────────────────────

_SENTENCE_END = re.compile(r"[.?!।\n]+")


def _sentences(text: str) -> set[str]:
    """``text``'s sentences of :data:`REPEAT_MIN_WORDS` or more words, as folded word runs."""
    out: set[str] = set()
    for part in _SENTENCE_END.split(text):
        tokens = _tokens(part)
        if len(tokens) >= REPEAT_MIN_WORDS:
            out.add(" ".join(tokens))
    return out


def _near(sentence: str, other: str) -> bool:
    words, other_words = sentence.split(), other.split()
    return SequenceMatcher(None, words, other_words, autojunk=False).ratio() >= REPEAT_MIN_RATIO


def verbatim_repeat(lines: Iterable[str], turns: Iterable[Turn]) -> bool:
    """True when a reply sentence is, word for word, one an earlier assistant turn already said,
    or that sentence with a word or two swapped (the 2026-10-08 baseline answered "gujarati ma
    javab aapo" with the earlier answer, "ka" changed to "na")."""
    earlier: set[str] = set()
    for role, text in turns:
        if role == BOT:
            earlier |= _sentences(text)
    return any(
        _near(sentence, said) for line in lines for sentence in _sentences(line) for said in earlier
    )


# ── scoring ──────────────────────────────────────────────────────────────────────────────────

ANSWER = "answer"
REFUSE = "refuse"
UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class CaseResult:
    case: Case
    #: "answer", "refuse" or "unavailable" (a failed, mocked or unreadable call).
    status: str
    detected: str | None = None
    adhered: bool = False
    non_latin: bool = False
    slips: tuple[str, ...] = ()
    repeat: bool = False
    counts: Mapping[str, int] = field(default_factory=dict)


def _strings(value: object) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def score_reply(case: Case, payload: Mapping | None) -> CaseResult:
    """One case's reply, scored on (a)-(d). ``payload`` is the route's body, or None."""
    if not isinstance(payload, Mapping) or payload.get("status") not in (ANSWER, REFUSE):
        return CaseResult(case, UNAVAILABLE)
    if payload["status"] == REFUSE:
        return CaseResult(case, REFUSE)
    lines = _strings(payload.get("lines"))
    chips = _strings(payload.get("followup_chips"))
    if not lines:
        return CaseResult(case, UNAVAILABLE)
    text = "\n".join(lines)
    detected = detect_language(text)
    hinglish = case.reply_language in ("hinglish", "english") or detected == "hinglish"
    return CaseResult(
        case,
        ANSWER,
        detected=detected,
        adhered=detected == case.reply_language,
        non_latin=non_latin(lines + chips),
        slips=tuple(persona_slips(lines + chips, hinglish=hinglish)),
        repeat=verbatim_repeat(lines, case.turns),
        counts=marker_counts(text),
    )


@dataclass
class Tally:
    cases: int = 0
    answered: int = 0
    refused: int = 0
    unavailable: int = 0
    adhered: int = 0
    non_latin: int = 0
    #: Answers with at least one persona slip.
    slipped: int = 0
    repeated: int = 0

    def add(self, result: CaseResult) -> None:
        self.cases += 1
        if result.status == REFUSE:
            self.refused += 1
        elif result.status == UNAVAILABLE:
            self.unavailable += 1
        else:
            self.answered += 1
            self.adhered += result.adhered
            self.non_latin += result.non_latin
            self.slipped += bool(result.slips)
            self.repeated += result.repeat


@dataclass(frozen=True)
class LanguageScore:
    results: list[CaseResult]
    #: language -> tally, in :data:`LANGUAGES` order.
    per_language: dict[str, Tally]
    #: kind -> tally, in :data:`KINDS` order.
    per_kind: dict[str, Tally]
    overall: Tally
    misses: list[str]


def _miss(result: CaseResult) -> str | None:
    """Why one answered case missed, or None. Names counts and words, never the reply text."""
    reasons: list[str] = []
    if result.status != ANSWER:
        return None
    if not result.adhered:
        counts = ", ".join(f"{lang} {n}" for lang, n in result.counts.items() if n)
        reasons.append(f"language {result.detected} ({counts or 'no markers'})")
    if result.non_latin:
        reasons.append("non-Latin")
    if result.slips:
        reasons.append("slips " + ", ".join(result.slips))
    if result.repeat:
        reasons.append("verbatim repeat")
    if not reasons:
        return None
    case = result.case
    return f"[{case.reply_language}/{case.script}/{case.kind}] {case.id}: " + "; ".join(reasons)


def evaluate(
    predict: Callable[[Case], Mapping | None], cases: list[Case] | None = None
) -> LanguageScore:
    """Score ``predict(case)`` (the route's body, or None) over the set. No thresholds."""
    results = [score_reply(case, predict(case)) for case in (CASES if cases is None else cases)]
    per_language = {language: Tally() for language in LANGUAGES}
    per_kind = {kind: Tally() for kind in KINDS}
    overall = Tally()
    for result in results:
        per_language[result.case.reply_language].add(result)
        per_kind[result.case.kind].add(result)
        overall.add(result)
    misses = [miss for result in results if (miss := _miss(result)) is not None]
    misses += [
        f"[{r.case.reply_language}/{r.case.script}/{r.case.kind}] {r.case.id}: {r.status}"
        for r in results
        if r.status != ANSWER
    ]
    return LanguageScore(results, per_language, per_kind, overall, misses)
