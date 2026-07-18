"""SYNTHETIC worker-answer corpus for measuring the deterministic profiling parser.

MEASUREMENT ONLY. Nothing in this module is imported by runtime code — it exists
so ``signals.detect_answered_topics`` can be scored against realistic input and
the gaps reported as DATA (see ``tests/analysis_parser_coverage.py`` and
``docs/ai/profiling-parser-coverage.md``).

PROVENANCE — every string here is INVENTED for this harness. No real worker text,
no real phone numbers, no real employer names, no real addresses. The registers are
imitated from how CNC/VMC shop-floor workers in India actually type (Hindi,
Hinglish, Devanagari, English, misspellings, spelled-out numerals, digit shorthand,
partial answers, units and idiom), but every sample is fabricated. A hygiene test
(``test_profiling_parser_coverage.py::test_corpus_carries_no_pii_shaped_text``)
locks that: no 7+ digit run, no ``+91``/10-digit phone shape, no e-mail, no
Aadhaar/PAN shape, no company-suffix token.

``expected`` is a HUMAN judgement recorded BEFORE running the parser:

- ``"accept"`` — a human reading this reply to that question would say the worker
  answered it. The parser failing here is a PARSER GAP.
- ``"reject"`` — the reply carries no usable value for the topic (a refusal, a
  "don't know", an off-topic deflection). The parser marking the topic answered
  here is a FALSE POSITIVE, which is worse than a miss: a topic marked answered is
  never re-asked (``interview_engine._next_topic``), so the value is lost for good.

``expected`` is deliberately NOT "what the parser does" — the whole point is the
delta between the two.
"""

from __future__ import annotations

from dataclasses import dataclass

# The eleven topics the CNC/VMC bank can ask, in bank order
# (app/profiling/question_bank.py::_CNC_VMC_TOPICS).
TOPIC_ORDER: tuple[str, ...] = (
    "role",
    "machines",
    "experience",
    "skills",
    "current_location",
    "preferred_locations",
    "controllers",
    "salary_current",
    "salary_expected",
    "availability",
    "education",
)


@dataclass(frozen=True)
class AnswerFixture:
    """One synthetic worker reply, tagged with the topic that was ASKED."""

    topic: str
    text: str
    expected: str = "accept"  # "accept" | "reject" (human judgement, see module doc)
    register: str = ""  # language/idiom label, for slicing the results
    note: str = ""


F = AnswerFixture

# --- role -----------------------------------------------------------------
# Asked: "Aap kaunsa kaam karte hain — CNC, VMC, HMC operator, setter ya programmer?"
_ROLE: list[AnswerFixture] = [
    F("role", "CNC", register="english", note="verbatim first option in the question"),
    F("role", "CNC operator", register="hinglish", note="the canonical shop-floor answer"),
    F("role", "VMC operator", register="hinglish"),
    F("role", "vmc chalata hu", register="hinglish"),
    F("role", "setter hu", register="hinglish"),
    F("role", "CNC programmer", register="english"),
    F("role", "lathe operator", register="hinglish"),
    F("role", "operator", register="english", note="verbatim option in the question"),
    F("role", "machine operator hu", register="hinglish"),
    F("role", "CNC machine chalata hoon", register="hinglish"),
    F("role", "turner", register="english"),
    F("role", "programmer hu, mastercam pe kaam karta hu", register="hinglish"),
    F("role", "main CNC operator ka kaam karta hu", register="hinglish"),
    F("role", "hmc operator", register="hinglish"),
    F("role", "grinding operator", register="hinglish"),
    F("role", "cnc oprator", register="misspelling"),
    F("role", "seter ka kaam", register="misspelling"),
    F("role", "V M C operator", register="spaced"),
    F("role", "मैं वीएमसी ऑपरेटर हूँ", register="devanagari"),
    F("role", "प्रोग्रामर", register="devanagari"),
    F("role", "helper hu, machine seekh raha hu", register="hinglish",
      note="real shop-floor role, out of the CNC/VMC gazetteer"),
    F("role", "fitter", register="english", note="adjacent trade"),
    F("role", "supervisor", register="english", note="adjacent role"),
    F("role", "abhi kuch nahi kar raha, kaam dhundh raha hu",
      expected="reject", register="hinglish", note="states no role"),
]

# --- machines -------------------------------------------------------------
# Asked: "Kaunsi machine — VMC, CNC lathe, HMC ya grinding?"
_MACHINES: list[AnswerFixture] = [
    F("machines", "VMC", register="english"),
    F("machines", "cnc", register="english", note="verbatim shorthand workers use"),
    F("machines", "CNC lathe", register="english"),
    F("machines", "lathe", register="english"),
    F("machines", "vmc aur lathe dono", register="hinglish"),
    F("machines", "turning machine", register="english"),
    F("machines", "milling machine", register="english"),
    F("machines", "drilling machine", register="english"),
    F("machines", "grinding machine", register="english"),
    F("machines", "surface grinder", register="english"),
    F("machines", "cylindrical grinding", register="english"),
    F("machines", "HMC", register="english"),
    F("machines", "vmc machine par kaam karta hu", register="hinglish"),
    F("machines", "वीएमसी", register="devanagari"),
    F("machines", "vmc, hmc dono chalata hu", register="hinglish"),
    F("machines", "vmc 850", register="english", note="machine size shorthand"),
    F("machines", "sirf lathe", register="hinglish"),
    F("machines", "vtl", register="english", note="vertical turret lathe"),
    F("machines", "boring machine", register="english"),
    F("machines", "shaper machine", register="english"),
    F("machines", "power press", register="english", note="out-of-family machine"),
    F("machines", "welding machine", register="english", note="out-of-family machine"),
    F("machines", "vmc bhi lathe bhi, jo bole", register="hinglish"),
    F("machines", "pata nahi naam kya hai", expected="reject", register="hinglish"),
]

# --- experience -----------------------------------------------------------
# Asked: "Kitne saal ka experience hai?"
_EXPERIENCE: list[AnswerFixture] = [
    F("experience", "4 saal", register="hinglish"),
    F("experience", "4 years", register="english"),
    F("experience", "4 sal", register="misspelling"),
    F("experience", "char saal", register="hinglish", note="numeral as a word"),
    F("experience", "chaar saal ka experience hai", register="hinglish"),
    F("experience", "do saal", register="hinglish", note="numeral as a word"),
    F("experience", "teen saal", register="hinglish", note="numeral as a word"),
    F("experience", "ek saal", register="hinglish", note="numeral as a word"),
    F("experience", "bees saal", register="hinglish", note="numeral as a word"),
    F("experience", "2.5 saal", register="hinglish", note="fractional years"),
    F("experience", "2 saal 6 mahine", register="hinglish"),
    F("experience", "6 mahine", register="hinglish", note="months, not years"),
    F("experience", "10 saal se kaam kar raha hu", register="hinglish"),
    F("experience", "10+ years", register="english"),
    F("experience", "3 yrs", register="english"),
    F("experience", "3 year", register="english"),
    F("experience", "15 saal", register="hinglish"),
    F("experience", "8 saal experience", register="hinglish"),
    F("experience", "1 saal se kam", register="hinglish"),
    F("experience", "5 साल", register="devanagari"),
    F("experience", "पाँच साल का तजुर्बा", register="devanagari"),
    F("experience", "2012 se kaam kar raha hu", register="hinglish", note="start year"),
    F("experience", "fresher hu", register="hinglish", note="zero experience is a value"),
    F("experience", "naya hu, abhi start kiya", register="hinglish"),
    F("experience", "yaad nahi", expected="reject", register="hinglish"),
]

# --- skills ---------------------------------------------------------------
# Asked: "Setting, tool offset, program edit, drawing reading — inmein se kya aata hai?"
_SKILLS: list[AnswerFixture] = [
    F("skills", "setting aata hai", register="hinglish"),
    F("skills", "tool offset kar leta hu", register="hinglish"),
    F("skills", "program edit karta hu", register="hinglish"),
    F("skills", "drawing padh leta hu", register="hinglish"),
    F("skills", "gd&t aata hai", register="english"),
    F("skills", "offset set karta hu", register="hinglish"),
    F("skills", "machine setup karta hu", register="hinglish"),
    F("skills", "fixture lagana aata hai", register="hinglish"),
    F("skills", "g code likh leta hu", register="hinglish"),
    F("skills", "mastercam pe programming", register="hinglish"),
    F("skills", "sab aata hai", register="hinglish", note="blanket yes"),
    F("skills", "sab kaam aata hai setting bhi", register="hinglish"),
    F("skills", "sirf operation", register="hinglish"),
    F("skills", "setting nahi aati, sirf chalata hu", register="hinglish",
      note="negation + a positive"),
    F("skills", "vernier aur micrometer use karta hu", register="hinglish",
      note="inspection is a skill a human would record"),
    F("skills", "quality checking karta hu", register="hinglish"),
    F("skills", "sirf loading unloading", register="hinglish"),
    F("skills", "deburring aur finishing", register="english"),
    F("skills", "cmm operate karta hu", register="hinglish"),
    F("skills", "job setting aur tool change", register="hinglish"),
    F("skills", "बेसिक सेटिंग आती है", register="devanagari"),
    F("skills", "ड्रॉइंग पढ़ लेता हूँ", register="devanagari"),
    F("skills", "counter boring aur tapping", register="english"),
    F("skills", "kuch nahi aata, seekh raha hu", expected="reject", register="hinglish"),
]

# --- current_location -----------------------------------------------------
# Asked: "Abhi kis sheher mein hain?"
_CURRENT_LOCATION: list[AnswerFixture] = [
    F("current_location", "Pune", register="english"),
    F("current_location", "pune mein hu", register="hinglish"),
    F("current_location", "Delhi", register="english"),
    F("current_location", "dilli", register="hinglish", note="colloquial alias"),
    F("current_location", "Bombay", register="hinglish", note="colloquial alias"),
    F("current_location", "Rajkot", register="english"),
    F("current_location", "Faridabad", register="english"),
    F("current_location", "gurgaon", register="english"),
    F("current_location", "Noida sector 63", register="hinglish"),
    F("current_location", "Ahmedabad ke paas", register="hinglish"),
    F("current_location", "Hosur", register="english"),
    F("current_location", "Coimbatore", register="english"),
    F("current_location", "Aurangabad", register="english"),
    F("current_location", "Ludhiana", register="english"),
    F("current_location", "Peenya, Bangalore", register="english"),
    F("current_location", "abhi Pune mein rehta hu", register="hinglish"),
    F("current_location", "Chakan", register="english", note="Pune auto belt"),
    F("current_location", "Ranjangaon", register="english", note="MIDC industrial area"),
    F("current_location", "Bhiwadi", register="english", note="Rajasthan industrial belt"),
    F("current_location", "Jamshedpur", register="english"),
    F("current_location", "Kolhapur", register="english", note="foundry cluster"),
    F("current_location", "Bihar", register="hinglish", note="state-only answer"),
    F("current_location", "पुणे", register="devanagari"),
    F("current_location", "ghar pe hu, gaon mein", expected="reject", register="hinglish"),
]

# --- preferred_locations --------------------------------------------------
# Asked: "Kahan kaam kar sakte hain?"
_PREFERRED_LOCATIONS: list[AnswerFixture] = [
    F("preferred_locations", "Pune", register="english"),
    F("preferred_locations", "kahin bhi chalega", register="hinglish"),
    F("preferred_locations", "Delhi ya Noida", register="hinglish"),
    F("preferred_locations", "sirf Pune", register="hinglish"),
    F("preferred_locations", "Maharashtra mein kahin bhi", register="hinglish"),
    F("preferred_locations", "bahar ja sakta hu", register="hinglish"),
    F("preferred_locations", "anywhere in India", register="english"),
    F("preferred_locations", "relocate kar sakta hu", register="hinglish"),
    F("preferred_locations", "Chennai Bangalore dono chalega", register="hinglish"),
    F("preferred_locations", "abhi Pune mein hu, Delhi bhi chalega", register="hinglish",
      note="combined current + preferred"),
    F("preferred_locations", "Rajkot Ahmedabad", register="english"),
    F("preferred_locations", "Mumbai", register="english"),
    F("preferred_locations", "Hyderabad", register="english"),
    F("preferred_locations", "Pune, Chakan, Ranjangaon", register="english",
      note="two of three are off-gazetteer"),
    F("preferred_locations", "apne sheher mein hi", register="hinglish",
      note="wants to stay local — a real preference"),
    F("preferred_locations", "ghar ke paas hi chahiye", register="hinglish"),
    F("preferred_locations", "Gujarat mein", register="hinglish", note="state-level preference"),
    F("preferred_locations", "South India", register="english"),
    F("preferred_locations", "NCR", register="english"),
    F("preferred_locations", "kahi bhi", register="misspelling"),
    F("preferred_locations", "koi bhi jagah", register="hinglish"),
    F("preferred_locations", "जहाँ भी काम मिले", register="devanagari"),
    F("preferred_locations", "Pune se bahar nahi jaunga", register="hinglish",
      note="negated relocation"),
    F("preferred_locations", "abhi soch nahi paya", expected="reject", register="hinglish"),
]

# --- controllers ----------------------------------------------------------
# Asked: "Controller kaunsa — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?"
_CONTROLLERS: list[AnswerFixture] = [
    F("controllers", "Fanuc", register="english"),
    F("controllers", "fanuc aur siemens", register="hinglish"),
    F("controllers", "Siemens", register="english"),
    F("controllers", "Mitsubishi", register="english"),
    F("controllers", "Haas", register="english"),
    F("controllers", "Heidenhain", register="english"),
    F("controllers", "fanuc oi mate", register="english"),
    F("controllers", "fanuc series 0i", register="english"),
    F("controllers", "FANUC", register="english"),
    F("controllers", "siemens 828d", register="english"),
    F("controllers", "Mitsubishi M70", register="english"),
    F("controllers", "fanuc, mitsubishi dono", register="hinglish"),
    F("controllers", "fanuc system hai machine mein", register="hinglish"),
    F("controllers", "fanuk", register="misspelling"),
    F("controllers", "phanuc", register="misspelling"),
    F("controllers", "फैनुक", register="devanagari"),
    F("controllers", "sinumerik", register="english", note="Siemens control, brand name"),
    F("controllers", "Mazatrol", register="english", note="Mazak control"),
    F("controllers", "Syntec", register="english"),
    F("controllers", "GSK", register="english"),
    F("controllers", "Hurco", register="english"),
    F("controllers", "Delta controller", register="english"),
    F("controllers", "controller ka naam nahi pata", expected="reject", register="hinglish"),
    F("controllers", "pata nahi konsa hai", expected="reject", register="hinglish"),
]

# --- salary_current -------------------------------------------------------
# Asked: "Abhi salary kitni hai?"
_SALARY_CURRENT: list[AnswerFixture] = [
    F("salary_current", "22000", register="english"),
    F("salary_current", "22k", register="english"),
    F("salary_current", "22 hazar", register="hinglish"),
    F("salary_current", "15 hazaar", register="hinglish", note="the commoner spelling"),
    F("salary_current", "18000 rupaye", register="hinglish"),
    F("salary_current", "₹20,000", register="english"),
    F("salary_current", "20 thousand", register="english"),
    F("salary_current", "monthly 25000", register="english"),
    F("salary_current", "25000 per month", register="english"),
    F("salary_current", "abhi 19500 milta hai", register="hinglish"),
    F("salary_current", "12 hazar", register="hinglish"),
    F("salary_current", "salary 30k hai", register="hinglish"),
    F("salary_current", "haath mein 21000 aata hai", register="hinglish"),
    F("salary_current", "8500", register="english"),
    F("salary_current", "15,000", register="english"),
    F("salary_current", "18 se 20 hazar", register="hinglish"),
    F("salary_current", "20000 + PF", register="english"),
    F("salary_current", "13 thousand", register="english"),
    F("salary_current", "sallery 17000", register="misspelling"),
    F("salary_current", "1.5 lakh saal ka", register="hinglish", note="annual figure"),
    F("salary_current", "daily 700 rupaye", register="hinglish", note="daily wage"),
    F("salary_current", "pandrah hazaar", register="hinglish", note="numeral as a word"),
    F("salary_current", "पंद्रह हज़ार", register="devanagari"),
    F("salary_current", "batana nahi chahta", expected="reject", register="hinglish"),
]

# --- salary_expected ------------------------------------------------------
# Asked: "Kitni salary expect karte hain?"
_SALARY_EXPECTED: list[AnswerFixture] = [
    F("salary_expected", "25000", register="english", note="bare amount, expected context"),
    F("salary_expected", "25k chahiye", register="hinglish"),
    F("salary_expected", "30 hazar expect karta hu", register="hinglish"),
    F("salary_expected", "35000 chahiye", register="hinglish"),
    F("salary_expected", "kam se kam 25000", register="hinglish"),
    F("salary_expected", "30-35k", register="english", note="a range"),
    F("salary_expected", "40000", register="english"),
    F("salary_expected", "1 lakh", register="hinglish"),
    F("salary_expected", "22k se upar", register="hinglish"),
    F("salary_expected", "28000 minimum", register="english"),
    F("salary_expected", "35 thousand", register="english"),
    F("salary_expected", "30k plus rehna", register="hinglish"),
    F("salary_expected", "24000 chahiye ghar ke liye", register="hinglish"),
    F("salary_expected", "25 hazaar chahiye", register="hinglish"),
    F("salary_expected", "abhi se 5000 zyada", register="hinglish", note="relative demand"),
    F("salary_expected", "double chahiye", register="hinglish", note="relative demand"),
    F("salary_expected", "jo aap theek samjhe", register="hinglish", note="deferential"),
    F("salary_expected", "aapke hisab se", register="hinglish", note="deferential"),
    F("salary_expected", "company jo de", register="hinglish", note="deferential"),
    F("salary_expected", "jitna aap de sako", register="hinglish", note="deferential"),
    F("salary_expected", "salary aapki marzi", register="hinglish", note="deferential"),
    F("salary_expected", "negotiable", register="english"),
    F("salary_expected", "जो भी मिले", register="devanagari"),
    F("salary_expected", "koi fix nahi", expected="reject", register="hinglish"),
]

# --- availability ---------------------------------------------------------
# Asked: "Join karne mein kitne din lagenge?"
_AVAILABILITY: list[AnswerFixture] = [
    F("availability", "abhi turant", register="hinglish"),
    F("availability", "immediate", register="english"),
    F("availability", "15 din", register="hinglish"),
    F("availability", "30 din", register="hinglish"),
    F("availability", "7 din", register="hinglish"),
    F("availability", "20 din lagenge", register="hinglish"),
    F("availability", "10 days", register="english"),
    F("availability", "ek mahina", register="hinglish"),
    F("availability", "do mahine baad", register="hinglish"),
    F("availability", "notice period hai", register="english"),
    F("availability", "notice de diya hai", register="hinglish"),
    F("availability", "next month", register="english"),
    F("availability", "1 week", register="english"),
    F("availability", "2 hafte", register="hinglish"),
    F("availability", "ek hafte mein", register="hinglish"),
    F("availability", "abhi free hu", register="hinglish"),
    F("availability", "abhi available hu", register="hinglish"),
    F("availability", "turant join kar sakta hu", register="hinglish"),
    F("availability", "aaj se ready hu", register="hinglish"),
    F("availability", "kal se", register="hinglish"),
    F("availability", "abhi job kar raha hu, 1 mahina lagega", register="hinglish"),
    F("availability", "जल्दी जॉइन कर सकता हूँ", register="devanagari"),
    F("availability", "पंद्रह दिन", register="devanagari"),
    F("availability", "jab bolo tab", register="hinglish"),
]

# --- education ------------------------------------------------------------
# Asked: "ITI, diploma ya koi aur training li hai?"
_EDUCATION: list[AnswerFixture] = [
    F("education", "ITI kiya hai", register="hinglish"),
    F("education", "iti", register="english"),
    F("education", "ITI fitter", register="english"),
    F("education", "ITI turner trade", register="english"),
    F("education", "ITI electrician", register="english"),
    F("education", "diploma mechanical", register="english"),
    F("education", "polytechnic diploma", register="english"),
    F("education", "B.Tech mechanical", register="english"),
    F("education", "B.E. mechanical", register="english"),
    F("education", "NSDC certificate", register="english"),
    F("education", "RVM CAD course kiya", register="hinglish"),
    F("education", "ITI + 3 saal apprenticeship", register="hinglish"),
    F("education", "10th pass", register="english"),
    F("education", "12th pass", register="english"),
    F("education", "8th pass", register="english"),
    F("education", "graduation kiya hai", register="hinglish"),
    F("education", "BA pass", register="english"),
    F("education", "apprentice kiya tha", register="hinglish"),
    F("education", "CNC ka course kiya private institute se", register="hinglish"),
    F("education", "आईटीआई किया है", register="devanagari"),
    F("education", "डिप्लोमा किया है", register="devanagari"),
    F("education", "iti nahi kiya, kaam se hi seekha", expected="reject",
      register="hinglish", note="negated ITI"),
    F("education", "diploma nahi hai", expected="reject", register="hinglish",
      note="negated diploma"),
    F("education", "school chhod diya tha", expected="reject", register="hinglish"),
]

CORPUS: tuple[AnswerFixture, ...] = tuple(
    _ROLE
    + _MACHINES
    + _EXPERIENCE
    + _SKILLS
    + _CURRENT_LOCATION
    + _PREFERRED_LOCATIONS
    + _CONTROLLERS
    + _SALARY_CURRENT
    + _SALARY_EXPECTED
    + _AVAILABILITY
    + _EDUCATION
)


def fixtures_for(topic: str) -> list[AnswerFixture]:
    return [f for f in CORPUS if f.topic == topic]
