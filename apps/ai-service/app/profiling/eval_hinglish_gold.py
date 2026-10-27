# ruff: noqa: E501 — the cases are natural-language Hinglish sentences; splitting them would
# change the text the model reads. Code and comments stay under the line limit.
"""The D4 blind Hinglish extraction set — 100 fabricated turns, five facts, one scorer.

WHY THIS EXISTS. The model move (D4) must not be decided on price alone: the scenario sheet's
blind test asks whether a cheaper model still reads the five facts a worker actually says —
trade, level, controller, salary and location — from Hinglish. The work order names those five
fields exactly. The approved source is fabricated rewrites until D12 consent lands, so every
line below is invented. No real worker, no PII.

WHAT IT MEASURES. One call per case to the production understanding route, with all five
fields empty. A fact the line states must come back as a fill with a matching value; a fact the
line does not state must NOT be invented. That second half is the point: a model that guesses a
controller or a city is worse than one that stays quiet.

THE SCORER IS MODEL-AGNOSTIC. It takes `(key, value)` pairs and compares them with the ground
truth; it never sees a model name. The CLI prints the same numbers for any model, so Flash-Lite,
Haiku 4.5 and Haiku 5.5 are compared on one set. This is the "blind" part: the score does not
know which model produced the answer.

TEST DATA ONLY: fabricated lines, fabricated personas.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

#: The five fields the work order names, all empty when the message arrives.
SCHEMA: tuple[dict, ...] = (
    {"key": "primary_trade", "label": "Kaam", "kind": "text", "status": "missing"},
    {
        "key": "experience_years",
        "label": "Kaam ka tajurba (saal)",
        "kind": "duration",
        "status": "missing",
    },
    {
        "key": "controller",
        "label": "Machine ka control (Fanuc, Siemens, Mazak...)",
        "kind": "text",
        "status": "missing",
    },
    {
        "key": "expected_salary",
        "label": "Expected salary (mahine ka, INR)",
        "kind": "number",
        "status": "missing",
    },
    {"key": "current_city", "label": "Abhi ka sheher", "kind": "city", "status": "missing"},
)
SCHEMA_KEYS = frozenset(row["key"] for row in SCHEMA)

#: No trade question is on screen: the worker is describing himself, not answering a chip.
ON_SCREEN = {"key": None, "text": "Apne kaam ke baare mein bataiye", "options": []}

#: Accepted spellings of one value (compared after `normalise`).
Values = tuple[str, ...]


@dataclass(frozen=True)
class Case:
    text: str
    #: Every fact the line states, keyed by schema field. An absent key must NOT be filled.
    expected: dict[str, Values] = field(default_factory=dict)

    def request(self) -> dict:
        return {
            "text": self.text,
            "on_screen": ON_SCREEN,
            "schema_rows": [dict(row) for row in SCHEMA],
            "page_owned": [],
        }


TURNER: Values = ("CNC Turner", "Turner", "CNC Turner Operator", "CNC Operator", "CNC Turning")
VMC: Values = ("VMC Operator", "VMC Machine Operator", "VMC")
WELDER: Values = ("Welder", "Welding Operator", "MIG Welder", "Arc Welder", "Welding")
FITTER: Values = ("Fitter", "Mechanical Fitter")
ELECTRICIAN: Values = ("Electrician", "Electrical Technician")
MACHINIST: Values = ("Machinist", "Machine Operator")
GRINDER: Values = ("Surface Grinder", "Grinder", "Surface Grinding Operator")
PROGRAMMER: Values = ("CNC Programmer", "Programmer", "CNC Programmer Operator")
MAINTENANCE: Values = ("Maintenance Technician", "Maintenance Fitter", "Maintenance")
MOULDER: Values = ("Moulder", "Molding Operator", "Moulding Operator")

FANUC: Values = ("Fanuc", "Fanuc Control", "Fanuc System")
SIEMENS: Values = ("Siemens", "Siemens Sinumerik", "Sinumerik")
MAZAK: Values = ("Mazak", "Mazatrol", "Mazak Control")
HAAS: Values = ("Haas", "Haas Control")
MITSUBISHI: Values = ("Mitsubishi", "Mitsubishi Control")


def _c(
    text: str,
    *,
    trade: Values | None = None,
    years: str | None = None,
    controller: Values | None = None,
    salary: str | None = None,
    city: str | None = None,
) -> Case:
    expected: dict[str, Values] = {}
    if trade is not None:
        expected["primary_trade"] = trade
    if years is not None:
        expected["experience_years"] = (years,)
    if controller is not None:
        expected["controller"] = controller
    if salary is not None:
        expected["expected_salary"] = (salary,)
    if city is not None:
        expected["current_city"] = (city,)
    return Case(text=text, expected=expected)


# fmt: off
CASES: list[Case] = [
    # ── all five facts ─────────────────────────────────────────────────────────────────────
    _c("Main CNC turner hoon, 5 saal se Fanuc control par kaam kar raha hoon, salary 35000 chahiye, Pune mein rehta hoon.",
       trade=TURNER, years="5", controller=FANUC, salary="35000", city="Pune"),
    _c("VMC operator hoon, 7 saal ka experience hai, Siemens control chalata hoon, 40000 salary chahiye, Mumbai mein rehta hoon.",
       trade=VMC, years="7", controller=SIEMENS, salary="40000", city="Mumbai"),
    _c("CNC turner hoon, das saal se Mazak control par kaam kar raha hoon, 45000 salary chahiye, Delhi mein rehta hoon.",
       trade=TURNER, years="10", controller=MAZAK, salary="45000", city="Delhi"),
    _c("VMC operator hoon, 4 saal se Haas control par kaam karta hoon, salary 30000 chahiye, Bengaluru mein rehta hoon.",
       trade=VMC, years="4", controller=HAAS, salary="30000", city="Bengaluru"),
    _c("Main CNC turner hoon, 8 saal ka tajurba hai, Mitsubishi control chalata hoon, 38000 salary chahiye, Chennai mein rehta hoon.",
       trade=TURNER, years="8", controller=MITSUBISHI, salary="38000", city="Chennai"),
    _c("CNC programmer hoon, 6 saal se Fanuc control par programming karta hoon, salary 42000 chahiye, Pune mein rehta hoon.",
       trade=PROGRAMMER, years="6", controller=FANUC, salary="42000", city="Pune"),
    _c("Machinist hoon, 12 saal se Siemens control par kaam kar raha hoon, 45000 salary chahiye, Ahmedabad mein rehta hoon.",
       trade=MACHINIST, years="12", controller=SIEMENS, salary="45000", city="Ahmedabad"),
    _c("Surface grinder operator hoon, 9 saal se Mazak control par kaam karta hoon, salary 32000 chahiye, Nashik mein rehta hoon.",
       trade=GRINDER, years="9", controller=MAZAK, salary="32000", city="Nashik"),
    _c("CNC turner hoon, do saal se Haas control par kaam kar raha hoon, salary 22000 chahiye, Jaipur mein rehta hoon.",
       trade=TURNER, years="2", controller=HAAS, salary="22000", city="Jaipur"),
    _c("VMC operator hoon, 5 saal se Fanuc control chalata hoon, 28000 salary chahiye, Hyderabad mein rehta hoon.",
       trade=VMC, years="5", controller=FANUC, salary="28000", city="Hyderabad"),
    _c("Main welder hoon, 6 saal se MIG welding kar raha hoon, salary 30000 chahiye, Pune mein rehta hoon.",
       trade=WELDER, years="6", salary="30000", city="Pune"),
    _c("Fitter hoon, 8 saal ka experience hai, salary 32000 chahiye, Mumbai mein rehta hoon.",
       trade=FITTER, years="8", salary="32000", city="Mumbai"),
    _c("Electrician hoon, 4 saal se kaam kar raha hoon, salary 26000 chahiye, Delhi mein rehta hoon.",
       trade=ELECTRICIAN, years="4", salary="26000", city="Delhi"),
    _c("Welder hoon, 10 saal se arc welding karta hoon, salary 35000 chahiye, Chennai mein rehta hoon.",
       trade=WELDER, years="10", salary="35000", city="Chennai"),
    _c("Mechanical fitter hoon, 3 saal se kaam kar raha hoon, salary 24000 chahiye, Nashik mein rehta hoon.",
       trade=FITTER, years="3", salary="24000", city="Nashik"),
    _c("Maintenance technician hoon, 7 saal se machine maintain karta hoon, salary 30000 chahiye, Bengaluru mein rehta hoon.",
       trade=MAINTENANCE, years="7", salary="30000", city="Bengaluru"),
    _c("Moulder hoon, 5 saal se moulding ka kaam karta hoon, salary 25000 chahiye, Ahmedabad mein rehta hoon.",
       trade=MOULDER, years="5", salary="25000", city="Ahmedabad"),
    _c("Machinist hoon, 11 saal se Siemens control par kaam kar raha hoon, salary 40000 chahiye, Surat mein rehta hoon.",
       trade=MACHINIST, years="11", controller=SIEMENS, salary="40000", city="Surat"),
    _c("CNC turner hoon, 6 saal se Fanuc control par kaam karta hoon, 33000 salary chahiye, Jaipur mein rehta hoon.",
       trade=TURNER, years="6", controller=FANUC, salary="33000", city="Jaipur"),
    _c("VMC operator hoon, 9 saal se Mazak control par kaam kar raha hoon, salary 36000 chahiye, Hyderabad mein rehta hoon.",
       trade=VMC, years="9", controller=MAZAK, salary="36000", city="Hyderabad"),

    # ── four facts (one omitted on purpose) ───────────────────────────────────────────────
    _c("CNC turner hoon, 5 saal se Fanuc control par kaam kar raha hoon, salary 35000 chahiye.",
       trade=TURNER, years="5", controller=FANUC, salary="35000"),
    _c("VMC operator hoon, 7 saal ka experience hai, Siemens control chalata hoon, Mumbai mein rehta hoon.",
       trade=VMC, years="7", controller=SIEMENS, city="Mumbai"),
    _c("CNC turner hoon, das saal se Mazak control par kaam karta hoon, 45000 salary chahiye.",
       trade=TURNER, years="10", controller=MAZAK, salary="45000"),
    _c("VMC operator hoon, 4 saal se Haas control par kaam karta hoon, Bengaluru mein rehta hoon.",
       trade=VMC, years="4", controller=HAAS, city="Bengaluru"),
    _c("CNC turner hoon, 8 saal ka tajurba hai, 38000 salary chahiye, Chennai mein rehta hoon.",
       trade=TURNER, years="8", salary="38000", city="Chennai"),
    _c("CNC programmer hoon, 6 saal se Fanuc control par kaam karta hoon, salary 42000 chahiye.",
       trade=PROGRAMMER, years="6", controller=FANUC, salary="42000"),
    _c("Machinist hoon, 12 saal ka experience hai, 45000 salary chahiye, Ahmedabad mein rehta hoon.",
       trade=MACHINIST, years="12", salary="45000", city="Ahmedabad"),
    _c("Surface grinder hoon, 9 saal se Mazak control par kaam karta hoon, Nashik mein rehta hoon.",
       trade=GRINDER, years="9", controller=MAZAK, city="Nashik"),
    _c("CNC turner hoon, do saal se Haas control par kaam kar raha hoon, 22000 salary chahiye.",
       trade=TURNER, years="2", controller=HAAS, salary="22000"),
    _c("VMC operator hoon, 5 saal se Fanuc control chalata hoon, Hyderabad mein rehta hoon.",
       trade=VMC, years="5", controller=FANUC, city="Hyderabad"),
    _c("Welder hoon, 6 saal se MIG welding karta hoon, salary 30000 chahiye.",
       trade=WELDER, years="6", salary="30000"),
    _c("Fitter hoon, 8 saal ka experience hai, Mumbai mein rehta hoon.",
       trade=FITTER, years="8", city="Mumbai"),
    _c("Electrician hoon, 4 saal se kaam kar raha hoon, 26000 salary chahiye.",
       trade=ELECTRICIAN, years="4", salary="26000"),
    _c("Welder hoon, 10 saal se arc welding karta hoon, Chennai mein rehta hoon.",
       trade=WELDER, years="10", city="Chennai"),
    _c("Fitter hoon, 3 saal se kaam kar raha hoon, 24000 salary chahiye, Nashik mein rehta hoon.",
       trade=FITTER, years="3", salary="24000", city="Nashik"),
    _c("Maintenance technician hoon, 7 saal se machine maintain karta hoon, Bengaluru mein rehta hoon.",
       trade=MAINTENANCE, years="7", city="Bengaluru"),
    _c("Moulder hoon, 5 saal se moulding ka kaam karta hoon, 25000 salary chahiye.",
       trade=MOULDER, years="5", salary="25000"),
    _c("Machinist hoon, 11 saal se Siemens control par kaam karta hoon, Surat mein rehta hoon.",
       trade=MACHINIST, years="11", controller=SIEMENS, city="Surat"),
    _c("CNC turner hoon, 6 saal se Fanuc control par kaam karta hoon, 33000 salary chahiye.",
       trade=TURNER, years="6", controller=FANUC, salary="33000"),
    _c("VMC operator hoon, 9 saal se Mazak control par kaam kar raha hoon, Hyderabad mein rehta hoon.",
       trade=VMC, years="9", controller=MAZAK, city="Hyderabad"),
    _c("CNC turner hoon, 12 saal se kaam kar raha hoon, salary 45000 chahiye, Pune mein rehta hoon.",
       trade=TURNER, years="12", salary="45000", city="Pune"),
    _c("VMC operator hoon, 3 saal se Haas control par kaam karta hoon, salary 25000 chahiye, Mumbai mein rehta hoon.",
       trade=VMC, years="3", controller=HAAS, salary="25000", city="Mumbai"),
    _c("Machinist hoon, 7 saal se Mitsubishi control par kaam karta hoon, 32000 salary chahiye, Delhi mein rehta hoon.",
       trade=MACHINIST, years="7", controller=MITSUBISHI, salary="32000", city="Delhi"),
    _c("CNC programmer hoon, 4 saal se Siemens control par programming karta hoon, salary 40000 chahiye, Bengaluru mein rehta hoon.",
       trade=PROGRAMMER, years="4", controller=SIEMENS, salary="40000", city="Bengaluru"),
    _c("Grinder hoon, 6 saal se surface grinding kar raha hoon, 28000 salary chahiye, Chennai mein rehta hoon.",
       trade=GRINDER, years="6", salary="28000", city="Chennai"),
    _c("Welder hoon, 2 saal se MIG welding kar raha hoon, salary 20000 chahiye, Jaipur mein rehta hoon.",
       trade=WELDER, years="2", salary="20000", city="Jaipur"),
    _c("Electrician hoon, 8 saal se wiring ka kaam karta hoon, 30000 salary chahiye, Ahmedabad mein rehta hoon.",
       trade=ELECTRICIAN, years="8", salary="30000", city="Ahmedabad"),
    _c("Maintenance fitter hoon, 10 saal se machine repair karta hoon, 35000 salary chahiye, Surat mein rehta hoon.",
       trade=MAINTENANCE, years="10", salary="35000", city="Surat"),
    _c("CNC turner hoon, 1 saal se Fanuc control par kaam kar raha hoon, 18000 salary chahiye, Hyderabad mein rehta hoon.",
       trade=TURNER, years="1", controller=FANUC, salary="18000", city="Hyderabad"),

    # ── three facts ───────────────────────────────────────────────────────────────────────
    _c("CNC turner hoon, 5 saal se Fanuc control par kaam kar raha hoon.", trade=TURNER, years="5", controller=FANUC),
    _c("VMC operator hoon, 7 saal ka experience hai, Siemens control chalata hoon.", trade=VMC, years="7", controller=SIEMENS),
    _c("CNC turner hoon, das saal se Mazak control par kaam karta hoon.", trade=TURNER, years="10", controller=MAZAK),
    _c("VMC operator hoon, 4 saal se Haas control par kaam karta hoon.", trade=VMC, years="4", controller=HAAS),
    _c("CNC turner hoon, 38000 salary chahiye, Chennai mein rehta hoon.", trade=TURNER, salary="38000", city="Chennai"),
    _c("CNC programmer hoon, 42000 salary chahiye, Pune mein rehta hoon.", trade=PROGRAMMER, salary="42000", city="Pune"),
    _c("Machinist hoon, 45000 salary chahiye, Ahmedabad mein rehta hoon.", trade=MACHINIST, salary="45000", city="Ahmedabad"),
    _c("Surface grinder hoon, 9 saal se kaam karta hoon, Nashik mein rehta hoon.", trade=GRINDER, years="9", city="Nashik"),
    _c("CNC turner hoon, do saal se Haas control par kaam kar raha hoon.", trade=TURNER, years="2", controller=HAAS),
    _c("VMC operator hoon, 5 saal se Fanuc control chalata hoon.", trade=VMC, years="5", controller=FANUC),
    _c("Welder hoon, 6 saal se MIG welding karta hoon.", trade=WELDER, years="6"),
    _c("Fitter hoon, 8 saal ka experience hai, salary 32000 chahiye.", trade=FITTER, years="8", salary="32000"),
    _c("Electrician hoon, 26000 salary chahiye, Delhi mein rehta hoon.", trade=ELECTRICIAN, salary="26000", city="Delhi"),
    _c("Welder hoon, 10 saal se arc welding karta hoon, 35000 salary chahiye.", trade=WELDER, years="10", salary="35000"),
    _c("Fitter hoon, 24000 salary chahiye, Nashik mein rehta hoon.", trade=FITTER, salary="24000", city="Nashik"),
    _c("Maintenance technician hoon, 7 saal se machine maintain karta hoon.", trade=MAINTENANCE, years="7"),
    _c("Moulder hoon, 5 saal se moulding ka kaam karta hoon.", trade=MOULDER, years="5"),
    _c("Machinist hoon, 11 saal se Siemens control par kaam karta hoon.", trade=MACHINIST, years="11", controller=SIEMENS),
    _c("CNC turner hoon, 6 saal se kaam karta hoon, 33000 salary chahiye.", trade=TURNER, years="6", salary="33000"),
    _c("VMC operator hoon, Mazak control chalata hoon, Hyderabad mein rehta hoon.", trade=VMC, controller=MAZAK, city="Hyderabad"),
    _c("CNC turner hoon, 12 saal se kaam kar raha hoon, Pune mein rehta hoon.", trade=TURNER, years="12", city="Pune"),
    _c("VMC operator hoon, Haas control par kaam karta hoon, 25000 salary chahiye.", trade=VMC, controller=HAAS, salary="25000"),
    _c("Machinist hoon, 7 saal ka experience hai, 32000 salary chahiye.", trade=MACHINIST, years="7", salary="32000"),
    _c("CNC programmer hoon, Siemens control par programming karta hoon, Bengaluru mein rehta hoon.", trade=PROGRAMMER, controller=SIEMENS, city="Bengaluru"),
    _c("Grinder hoon, 6 saal se surface grinding kar raha hoon, 28000 salary chahiye.", trade=GRINDER, years="6", salary="28000"),
    _c("Welder hoon, 2 saal se MIG welding kar raha hoon, Jaipur mein rehta hoon.", trade=WELDER, years="2", city="Jaipur"),
    _c("Electrician hoon, 8 saal se wiring ka kaam karta hoon, 30000 salary chahiye.", trade=ELECTRICIAN, years="8", salary="30000"),
    _c("Maintenance fitter hoon, 10 saal se machine repair karta hoon, Surat mein rehta hoon.", trade=MAINTENANCE, years="10", city="Surat"),
    _c("CNC turner hoon, Fanuc control par kaam karta hoon, 18000 salary chahiye.", trade=TURNER, controller=FANUC, salary="18000"),
    _c("VMC operator hoon, 3 saal se kaam karta hoon, 25000 salary chahiye, Mumbai mein rehta hoon.", trade=VMC, years="3", salary="25000", city="Mumbai"),

    # ── two facts ────────────────────────────────────────────────────────────────────────
    _c("CNC turner hoon, 5 saal se kaam kar raha hoon.", trade=TURNER, years="5"),
    _c("VMC operator hoon, Siemens control chalata hoon.", trade=VMC, controller=SIEMENS),
    _c("Welder hoon, 30000 salary chahiye.", trade=WELDER, salary="30000"),
    _c("Fitter hoon, Mumbai mein rehta hoon.", trade=FITTER, city="Mumbai"),
    _c("Electrician hoon, 4 saal se kaam kar raha hoon.", trade=ELECTRICIAN, years="4"),
    _c("CNC turner hoon, Fanuc control par kaam karta hoon.", trade=TURNER, controller=FANUC),
    _c("Maintenance technician hoon, Bengaluru mein rehta hoon.", trade=MAINTENANCE, city="Bengaluru"),
    _c("Moulder hoon, 25000 salary chahiye.", trade=MOULDER, salary="25000"),
    _c("Machinist hoon, 11 saal se kaam karta hoon.", trade=MACHINIST, years="11"),
    _c("CNC programmer hoon, 40000 salary chahiye.", trade=PROGRAMMER, salary="40000"),
    _c("Grinder hoon, Chennai mein rehta hoon.", trade=GRINDER, city="Chennai"),
    _c("Welder hoon, 10 saal se kaam kar raha hoon.", trade=WELDER, years="10"),
    _c("Fitter hoon, 24000 salary chahiye.", trade=FITTER, salary="24000"),
    _c("Electrician hoon, Delhi mein rehta hoon.", trade=ELECTRICIAN, city="Delhi"),
    _c("CNC turner hoon, 12 saal se kaam kar raha hoon.", trade=TURNER, years="12"),

    # ── one fact ─────────────────────────────────────────────────────────────────────────
    _c("Sirf salary 25000 chahiye.", salary="25000"),
    _c("Pune mein rehta hoon.", city="Pune"),
    _c("5 saal se CNC turning kar raha hoon.", trade=TURNER, years="5"),
    _c("Fanuc control aata hai.", controller=FANUC),
    _c("Welder hoon.", trade=WELDER),
    _c("Mera experience 8 saal hai.", years="8"),
    _c("Mumbai mein kaam karna hai.", city="Mumbai"),
    _c("Salary 30000 chahiye.", salary="30000"),
    _c("Siemens control par kaam kiya hai.", controller=SIEMENS),
    _c("CNC programmer hoon.", trade=PROGRAMMER),
    _c("3 saal ka experience hai.", years="3"),
    _c("Nashik mein rehta hoon.", city="Nashik"),
    _c("40000 salary chahiye.", salary="40000"),
    _c("Mazak control chalata hoon.", controller=MAZAK),
    _c("Main fitter hoon.", trade=FITTER),

    # ── Devanagari: the same facts, a different script ────────────────────────────────────
    _c("मैं सीएनसी टर्नर हूँ, 5 साल का अनुभव है, फैनुक कंट्रोल चलाता हूँ, 35000 सैलरी चाहिए, पुणे में रहता हूँ।",
       trade=TURNER, years="5", controller=FANUC, salary="35000", city="Pune"),
    _c("मैं वेल्डर हूँ, 6 साल से काम कर रहा हूँ, 30000 सैलरी चाहिए।",
       trade=WELDER, years="6", salary="30000"),

    # ── no facts: nothing may be invented ─────────────────────────────────────────────────
    _c("Kaam dhoondh raha hoon, koi accha mauka batayein."),
    _c("Aap kaun ho bhai?"),
    _c("Salary kab milegi?"),
    _c("Namaste, kaise hain?"),
    _c("Mujhe night shift pasand hai."),
]
# fmt: on

_SPACES = re.compile(r"\s+")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")


def normalise(value: str) -> str:
    """Compare-form of a text value: case-folded and single-spaced."""
    return _SPACES.sub(" ", value.strip().casefold())


def _number(value: str) -> float | None:
    """The number a duration or salary string names, in its own unit.

    Handles the ways Hinglish writes them: `5`, `5 saal`, `5 years`, `35,000`, `35k`,
    `35 hazar`, `1.5 lakh`. Returns None when there is no number at all.
    """
    cleaned = normalise(value).replace(",", "")
    match = _NUMBER.search(cleaned)
    if match is None:
        return None
    number = float(match.group())
    tail = cleaned[match.end() :].strip()
    if "lakh" in tail or "lac" in tail:
        number *= 100_000
    elif re.match(r"k\b", tail) or "hazar" in tail or "hazaar" in tail:
        number *= 1_000
    return number


def _matches(field_name: str, accepted: Values, value: str) -> bool:
    if field_name in ("experience_years", "expected_salary"):
        got = _number(value)
        if got is None:
            return False
        return any(got == _number(candidate) for candidate in accepted)
    got = normalise(value)
    if field_name == "current_city":
        # The model may carry the state ("Pune, Maharashtra") or append it ("Pune Maharashtra").
        head = got.split(",")[0].strip()
        words = set(got.split())
        return any(
            normalise(candidate) == head or normalise(candidate) in words for candidate in accepted
        )
    return any(got == normalise(candidate) for candidate in accepted)


@dataclass
class FieldScore:
    expected: int = 0
    correct: int = 0


@dataclass
class HinglishScore:
    total: int
    exact: int
    expected_fields: int
    correct_fields: int
    proposed_fills: int
    correct_fills: int
    per_field: dict[str, FieldScore]
    misses: list[str] = field(default_factory=list)
    wrong_fills: list[str] = field(default_factory=list)

    @property
    def field_accuracy(self) -> float:
        return self.correct_fields / self.expected_fields if self.expected_fields else 1.0

    @property
    def fill_precision(self) -> float:
        return self.correct_fills / self.proposed_fills if self.proposed_fills else 1.0

    @property
    def exact_rate(self) -> float:
        return self.exact / self.total if self.total else 1.0


def evaluate(predict: Callable[[Case], list[tuple[str, str]] | None]) -> HinglishScore:
    """Score one model's answers over the set.

    `predict` returns the fills the service produced for one case, or None when the service
    gave no answer the API would act on (a mock, a failure, a timeout).
    """
    per_field = {row["key"]: FieldScore() for row in SCHEMA}
    misses: list[str] = []
    wrong_fills: list[str] = []
    exact = 0
    expected_fields = 0
    correct_fields = 0
    proposed_fills = 0
    correct_fills = 0

    for index, case in enumerate(CASES, start=1):
        fills = predict(case)
        if fills is None:
            fills = []
        proposed_fills += len(fills)
        case_wrong: list[str] = []
        case_correct = 0

        for field_name, accepted in case.expected.items():
            expected_fields += 1
            per_field[field_name].expected += 1
            if any(
                key == field_name and _matches(field_name, accepted, value) for key, value in fills
            ):
                per_field[field_name].correct += 1
                correct_fields += 1
                case_correct += 1
            else:
                misses.append(f"case {index} {field_name}: {case.text!r}")

        for key, value in fills:
            expected = case.expected.get(key)
            if expected is not None and _matches(key, expected, value):
                correct_fills += 1
            elif expected is None:
                wrong_fills.append(f"case {index} extra {key}={value!r}: {case.text!r}")
                case_wrong.append(key)
            else:
                wrong_fills.append(f"case {index} wrong {key}={value!r}: {case.text!r}")
                case_wrong.append(key)

        if not case_wrong and case_correct == len(case.expected):
            exact += 1

    return HinglishScore(
        total=len(CASES),
        exact=exact,
        expected_fields=expected_fields,
        correct_fields=correct_fields,
        proposed_fills=proposed_fills,
        correct_fills=correct_fills,
        per_field=per_field,
        misses=misses,
        wrong_fills=wrong_fills,
    )


def check_set() -> list[str]:
    """Every problem that would make a staging run meaningless. Empty means the set is sound."""
    problems: list[str] = []
    if len(CASES) < 100:
        problems.append(f"only {len(CASES)} cases; the work order asks for 100 minimum")
    if len({case.text for case in CASES}) != len(CASES):
        problems.append("duplicate case text")
    for index, case in enumerate(CASES, start=1):
        if not case.text.strip():
            problems.append(f"case {index}: empty text")
        for field_name in case.expected:
            if field_name not in SCHEMA_KEYS:
                problems.append(f"case {index}: key {field_name!r} is not in the schema")
        if not case.expected and index <= len(CASES) - 5:
            problems.append(f"case {index}: a fact-bearing case expects nothing")
    for field_name in SCHEMA_KEYS:
        if not any(field_name in case.expected for case in CASES):
            problems.append(f"no case expects {field_name!r}")
    if sum(1 for case in CASES if not case.expected) < 5:
        problems.append("fewer than 5 no-fact cases; invented facts cannot be caught")
    return problems
