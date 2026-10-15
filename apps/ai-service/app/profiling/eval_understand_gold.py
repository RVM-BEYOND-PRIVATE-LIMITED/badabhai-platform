"""The profiling turn's understanding — gold set and scorer (ADR-0057 §6, #2309).

THE GATE (owner ruling 2026-10-16, the §6 bar confirmed as proposed). A run passes only when:
  - intent accuracy >= 90% (a case may accept more than one intent where both are honest);
  - fill precision >= 95% (of every fill the model proposed, the share that is right);
  - 0 keys outside the schema (fills and edits alike);
  - 0 false-positive deletes (a delete the case did not ask for is a value the worker loses).
Fill RECALL and edit exactness are reported, not gated: a missed fill costs one question the
interview asks anyway, while a wrong fill or a wrong delete writes something the worker never said.

THE FIXTURE IS FROZEN AND SMALL ON PURPOSE. Every case is read against the same base schema (with
per-case overrides of a scalar's status and value), so an expected key or ref can be checked
against exactly what the model was shown. `SCHEMA` mirrors the in-scope fields of ADR-0057 §3.1;
`check_set` proves every expected key, ref and mention could have come from it.

The single source of truth for both the pytest suite (set shape, containment, scorer capability)
and the staging CLI (`eval_understand_cli`). TEST DATA ONLY: fabricated lines, no PII.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

#: The bars the real model must clear (ADR-0057 §6).
INTENT_THRESHOLD = 0.90
FILL_PRECISION_THRESHOLD = 0.95

AVAILABILITY_OPTIONS = ("Immediately", "Within a week", "Within a month", "Serving notice")
LANGUAGE_OPTIONS = ("Hindi", "English", "Marathi", "Gujarati", "Bengali", "Tamil")
WORK_TYPE_OPTIONS = ("Permanent", "Contract", "Apprenticeship", "Daily wage")
SALARY_PERIOD_OPTIONS = ("per month", "per day", "per year")

#: The base schema every case is read against: the chat-captured fields of the old interview.
SCHEMA: tuple[dict, ...] = (
    {"key": "primary_trade", "label": "Kaam", "kind": "text", "status": "missing"},
    {
        "key": "experience_years",
        "label": "Kaam ka tajurba (saal)",
        "kind": "duration",
        "status": "answered",
        "value": "5",
    },
    {
        "key": "current_city",
        "label": "Abhi ka sheher",
        "kind": "city",
        "status": "answered",
        "value": "Mumbai",
    },
    {
        "key": "availability",
        "label": "Kab se kaam shuru",
        "kind": "single_select",
        "options": list(AVAILABILITY_OPTIONS),
        "status": "missing",
    },
    {
        "key": "languages",
        "label": "Bhasha",
        "kind": "multi_select",
        "options": list(LANGUAGE_OPTIONS),
        "status": "answered",
        "value": "Hindi",
    },
    {
        "key": "work_types",
        "label": "Kaam ka prakar",
        "kind": "multi_select",
        "options": list(WORK_TYPE_OPTIONS),
        "status": "missing",
    },
    {"key": "commute_max_km", "label": "Roz kitne km", "kind": "number", "status": "missing"},
    {
        "key": "willing_to_travel",
        "label": "Kaam ke liye bahar jaana",
        "kind": "boolean",
        "status": "missing",
    },
    {"key": "notice_period_days", "label": "Notice (din)", "kind": "number", "status": "missing"},
    {
        "key": "salary_period",
        "label": "Salary kis hisaab se",
        "kind": "single_select",
        "options": list(SALARY_PERIOD_OPTIONS),
        "status": "missing",
    },
    {"key": "training_name", "label": "Training", "kind": "text", "status": "missing"},
    {
        "key": "skills",
        "label": "Skills",
        "kind": "list",
        "status": "answered",
        "entries": [{"ref": "s1", "value": "Welding"}, {"ref": "s2", "value": "Grinding"}],
    },
)
SCHEMA_KEYS = frozenset(row["key"] for row in SCHEMA)
REFS_BY_KEY = {row["key"]: {e["ref"] for e in row.get("entries", [])} for row in SCHEMA}

#: The Profile-page facts, by name only (ADR-0057 R2).
PAGE_OWNED = (
    "expected_salary",
    "preferred_cities",
    "shift",
    "education",
    "certificates",
    "employer_details",
)

AVAIL_Q = {
    "key": "availability",
    "text": "Aap kab se kaam shuru kar sakte hain?",
    "options": list(AVAILABILITY_OPTIONS),
}
TRAVEL_Q = {
    "key": "willing_to_travel",
    "text": "Kya aap kaam ke liye doosre sheher ja sakte hain?",
    "options": ["Haan", "Nahi"],
}
COMMUTE_Q = {"key": "commute_max_km", "text": "Roz kitne km tak aa-ja sakte hain?", "options": []}
TRAINING_Q = {
    "key": "training_name",
    "text": "Koi training ki hai? Uska naam bataiye.",
    "options": [],
}
HOW_ARE_YOU = {"key": None, "text": "Namaste. Kaise hain aap?", "options": []}
MODEL_Q = {"key": None, "text": "Aap kis machine pe kaam karte hain?", "options": []}

#: Accepted spellings of one value (compared after `normalise`).
Values = tuple[str, ...]
#: `(op, key, ref, accepted values)` — values None means the edit must carry no value.
Edit = tuple[str, str, str | None, Values | None]


@dataclass(frozen=True)
class Case:
    text: str
    intents: tuple[str, ...]
    on_screen: dict | None = None
    #: Fills the model must propose: key -> accepted values.
    fills: dict[str, Values] = field(default_factory=dict)
    #: Fills that are honest but not required — never a false positive.
    allowed: dict[str, Values] = field(default_factory=dict)
    edits: tuple[Edit, ...] = ()
    mentions: tuple[str, ...] = ()
    #: Page-owned names the model may mention without being wrong.
    allowed_mentions: tuple[str, ...] = ()
    #: Scalar overrides of the base schema: key -> (status, value).
    overrides: dict[str, tuple[str, str | None]] = field(default_factory=dict)

    def schema_rows(self) -> list[dict]:
        rows = []
        for row in SCHEMA:
            override = self.overrides.get(row["key"])
            if override is None:
                rows.append(dict(row))
            else:
                status, value = override
                rows.append({**row, "status": status, "value": value})
        return rows

    def request(self) -> dict:
        return {
            "text": self.text,
            "on_screen": self.on_screen,
            "schema_rows": self.schema_rows(),
            "page_owned": list(PAGE_OWNED),
        }


#: An empty trade and empty years — the owner's example reads into a fresh interview.
FRESH = {"primary_trade": ("missing", None), "experience_years": ("missing", None)}

TURNER: Values = ("CNC Turner", "Turner", "CNC Turner Operator")
WELDER: Values = ("Welder", "Welding")

# fmt: off
CASES: list[Case] = [
    # ── several fields in one message (ADR-0057's own example and its kin) ──
    Case("CNC turner hoon, paanch saal ka experience, Delhi ya Delhi se bahar bhi chalega",
         ("statement",), HOW_ARE_YOU,
         fills={"primary_trade": TURNER, "experience_years": ("5",),
                "willing_to_travel": ("true",)},
         allowed_mentions=("preferred_cities",), overrides=FRESH),
    Case("main welder hoon, 8 saal se kaam kar raha hoon, Pune mein rehta hoon",
         ("statement",), HOW_ARE_YOU,
         fills={"primary_trade": WELDER, "experience_years": ("8",), "current_city": ("Pune",)},
         overrides={**FRESH, "current_city": ("missing", None)}),
    Case("Hindi aur Marathi bol leta hoon, contract wala kaam bhi chalega",
         ("statement", "answer"), MODEL_Q,
         fills={"languages": ("Hindi, Marathi", "Marathi, Hindi"), "work_types": ("Contract",)},
         overrides={"languages": ("missing", None)}),
    Case("badhiya, 5 saal se welding kar raha hun", ("statement", "answer"), HOW_ARE_YOU,
         fills={"experience_years": ("5",)}, allowed={"primary_trade": WELDER},
         overrides=FRESH),
    Case("I am an electrician with 4 years of experience", ("statement",), HOW_ARE_YOU,
         fills={"primary_trade": ("Electrician",), "experience_years": ("4",)}, overrides=FRESH),
    Case("मैं फिटर हूँ, मुंबई में रहता हूँ", ("statement",), HOW_ARE_YOU,
         fills={"primary_trade": ("Fitter",)}),
    Case("VMC operator hoon 3 saal se", ("statement",), MODEL_Q,
         fills={"primary_trade": ("VMC Operator", "VMC Machine Operator"),
                "experience_years": ("3",)},
         overrides=FRESH),
    Case("main CNC turner hoon", ("statement", "answer"), MODEL_Q,
         fills={"primary_trade": TURNER}, overrides=FRESH),
    # ── answers to the question on screen ──
    Case("kal se join kar sakta hoon", ("answer",), AVAIL_Q,
         fills={"availability": ("Immediately",)}),
    Case("ek mahine baad", ("answer",), AVAIL_Q, fills={"availability": ("Within a month",)}),
    Case("abhi notice pe hoon", ("answer",), AVAIL_Q, fills={"availability": ("Serving notice",)},
         allowed={"notice_period_days": ()}),
    Case("haan ja sakta hoon", ("answer",), TRAVEL_Q, fills={"willing_to_travel": ("true",)}),
    Case("nahi, yahin rehna hai", ("answer",), TRAVEL_Q, fills={"willing_to_travel": ("false",)}),
    Case("10 km tak", ("answer",), COMMUTE_Q, fills={"commute_max_km": ("10",)}),
    Case("ITI se welding ki training li thi", ("answer",), TRAINING_Q,
         fills={"training_name": ("Welding", "ITI Welding", "Welding Training",
                                  "ITI Welding Training")}),
    Case("nahi, koi training nahi ki", ("answer",), TRAINING_Q),
    Case("turant, aur night shift bhi kar lunga", ("answer",), AVAIL_Q,
         fills={"availability": ("Immediately",)}, allowed_mentions=("shift",)),
    Case("15 din ka notice hai", ("answer",), AVAIL_Q,
         fills={"notice_period_days": ("15",)}, allowed={"availability": ("Serving notice",)}),
    # ── edits WITH the new value ──
    Case("nahi nahi, experience 5 nahi 2 saal hai", ("edit",), AVAIL_Q,
         edits=(("edit", "experience_years", None, ("2",)),)),
    Case("galat likha, main Mumbai nahi Thane mein rehta hoon", ("edit",), AVAIL_Q,
         edits=(("edit", "current_city", None, ("Thane",)),)),
    Case("actually mera experience 7 saal ka hai", ("edit",), AVAIL_Q,
         edits=(("edit", "experience_years", None, ("7",)),)),
    Case("मेरा अनुभव 5 नहीं 3 साल है", ("edit",), AVAIL_Q,
         edits=(("edit", "experience_years", None, ("3",)),)),
    Case("experience 5 nahi 6 saal hai, aur roz 15 km tak aa sakta hoon", ("edit",), AVAIL_Q,
         fills={"commute_max_km": ("15",)},
         edits=(("edit", "experience_years", None, ("6",)),)),
    # ── edits WITHOUT the new value: the API asks ──
    Case("experience galat likha hai", ("edit",), AVAIL_Q,
         edits=(("edit", "experience_years", None, None),)),
    Case("sheher wala galat hai", ("edit",), AVAIL_Q,
         edits=(("edit", "current_city", None, None),)),
    # ── deletes ──
    Case("welding skill hata do", ("delete",), AVAIL_Q, edits=(("delete", "skills", "s1", None),)),
    Case("grinding wala skill nikal do", ("delete",), AVAIL_Q,
         edits=(("delete", "skills", "s2", None),)),
    Case("remove grinding from my skills", ("delete",), AVAIL_Q,
         edits=(("delete", "skills", "s2", None),)),
    # ── a statement is a fill, never an edit (#2304's lesson) ──
    Case("main welding ka kaam karta hoon", ("statement", "answer"), MODEL_Q,
         allowed={"primary_trade": WELDER}, overrides=FRESH),
    Case("Mumbai mein hi rehta hoon", ("statement", "answer"), AVAIL_Q),
    Case("5 saal ka experience hai mera", ("statement", "answer"), AVAIL_Q),
    Case("welding aur grinding dono aata hai", ("statement", "answer"), MODEL_Q),
    # ── progress ──
    Case("aur kitna bacha hai", ("progress",), AVAIL_Q),
    Case("kitne sawaal aur hain?", ("progress",), AVAIL_Q),
    Case("how much is left?", ("progress",), AVAIL_Q),
    Case("kab khatam hoga ye", ("progress",), MODEL_Q),
    # ── chat ──
    Case("aap kaun ho?", ("chat",), AVAIL_Q),
    Case("job kab tak milegi?", ("chat",), AVAIL_Q),
    Case("thank you bhai", ("chat",), MODEL_Q),
    Case("aaj bahut garmi hai", ("chat",), AVAIL_Q),
    Case("is kaam mein salary kitni milti hai?", ("chat",), AVAIL_Q,
         allowed_mentions=("expected_salary",)),
    Case("hmm", ("unclear", "chat"), MODEL_Q),
    # ── page-owned facts: mentioned, never filled ──
    Case("mujhe 25000 chahiye", ("statement", "chat"), AVAIL_Q, mentions=("expected_salary",)),
    Case("Pune ya Nashik mein kaam chahiye", ("statement",), AVAIL_Q,
         mentions=("preferred_cities",)),
    Case("12th pass hoon", ("statement",), MODEL_Q, mentions=("education",)),
    Case("night shift chahiye", ("statement",), MODEL_Q, mentions=("shift",)),
]
# fmt: on

_SPACES = re.compile(r"\s+")


def normalise(value: str) -> str:
    """Compare-form of a value: case-folded, single-spaced, and a number in canonical form."""
    folded = _SPACES.sub(" ", value.strip().casefold())
    try:
        number = float(folded)
    except ValueError:
        return folded
    return str(int(number)) if number.is_integer() else str(number)


def _accepts(accepted: Values, value: str) -> bool:
    return normalise(value) in {normalise(a) for a in accepted}


#: What one prediction is: `(intent, fills [(key, value)], edits [(op, key, ref, value)],
#: mentions)` — None when the service gave no answer the API would act on.
Prediction = tuple[
    str, list[tuple[str, str]], list[tuple[str, str, str | None, str | None]], list[str]
]


@dataclass(frozen=True)
class UnderstandScore:
    total: int
    intent_correct: int
    intent_accuracy: float
    fills_proposed: int
    fills_correct: int
    fill_precision: float
    fills_required: int
    fills_found: int
    edits_exact: int
    out_of_schema: list[str]
    false_deletes: list[str]
    misses: list[str]
    failed: list[str]


def check_set() -> list[str]:
    """Every expected key, ref and mention is one the fixture offers; texts are unique."""
    problems: list[str] = []
    texts = [case.text for case in CASES]
    if len(set(texts)) != len(texts):
        problems.append("duplicate case text")
    for case in CASES:
        for key in [*case.fills, *case.allowed, *case.overrides]:
            if key not in SCHEMA_KEYS:
                problems.append(f"{case.text!r}: key {key} not in the schema")
        for op, key, ref, _value in case.edits:
            if key not in SCHEMA_KEYS:
                problems.append(f"{case.text!r}: edit key {key} not in the schema")
            elif REFS_BY_KEY[key] and ref not in REFS_BY_KEY[key]:
                problems.append(f"{case.text!r}: ref {ref} not an entry of {key}")
            elif not REFS_BY_KEY[key] and ref is not None:
                problems.append(f"{case.text!r}: scalar {key} edit carries a ref")
            if op not in ("edit", "delete"):
                problems.append(f"{case.text!r}: op {op}")
        for name in [*case.mentions, *case.allowed_mentions]:
            if name not in PAGE_OWNED:
                problems.append(f"{case.text!r}: mention {name} not page-owned")
    return problems


def _edit_matches(expected: Edit, predicted: tuple[str, str, str | None, str | None]) -> bool:
    op, key, ref, accepted = expected
    p_op, p_key, p_ref, p_value = predicted
    if (op, key, ref) != (p_op, p_key, p_ref):
        return False
    if accepted is None:
        return p_value is None
    return p_value is not None and _accepts(accepted, p_value)


def evaluate(predict: Callable[[Case], Prediction | None]) -> UnderstandScore:
    """Score ``predict`` over the set. No answer is a miss on intent and finds no fill."""
    intent_correct = 0
    fills_proposed = fills_correct = fills_required = fills_found = edits_exact = 0
    out_of_schema: list[str] = []
    false_deletes: list[str] = []
    misses: list[str] = []
    for case in CASES:
        fills_required += len(case.fills)
        prediction = predict(case)
        if prediction is None:
            misses.append(f"{case.text!r}: no answer")
            continue
        intent, fills, edits, mentions = prediction
        reasons: list[str] = []
        if intent in case.intents:
            intent_correct += 1
        else:
            reasons.append(f"intent {intent} (expected {'/'.join(case.intents)})")

        found: set[str] = set()
        for key, value in fills:
            fills_proposed += 1
            if key not in SCHEMA_KEYS:
                out_of_schema.append(f"{case.text!r}: fill {key}")
                continue
            accepted = case.fills.get(key)
            if accepted is not None and _accepts(accepted, value):
                fills_correct += 1
                found.add(key)
            elif key in case.allowed and (
                not case.allowed[key] or _accepts(case.allowed[key], value)
            ):
                fills_correct += 1
            else:
                reasons.append(f"wrong fill {key}={value!r}")
        fills_found += len(found)
        missing = sorted(set(case.fills) - found)
        if missing:
            reasons.append(f"missed fills {missing}")

        for edit in edits:
            if edit[1] not in SCHEMA_KEYS:
                out_of_schema.append(f"{case.text!r}: edit {edit[1]}")
            if edit[0] == "delete" and not any(_edit_matches(e, edit) for e in case.edits):
                false_deletes.append(f"{case.text!r}: delete {edit[1]} {edit[2]}")
        # Mentions are reported, not gated: a missed one costs a pointer line, a stray one costs
        # the same line where it was not needed — neither writes anything.
        missed_mentions = sorted(set(case.mentions) - set(mentions))
        stray_mentions = sorted(set(mentions) - set(case.mentions) - set(case.allowed_mentions))
        if missed_mentions or stray_mentions:
            reasons.append(f"mentions missed {missed_mentions} stray {stray_mentions}")

        exact = len(edits) == len(case.edits) and all(
            any(_edit_matches(expected, predicted) for predicted in edits)
            for expected in case.edits
        )
        if exact:
            edits_exact += 1
        else:
            reasons.append(f"edits {edits} (expected {list(case.edits)})")
        if reasons:
            misses.append(f"{case.text!r}: " + "; ".join(reasons))

    total = len(CASES)
    intent_accuracy = intent_correct / total
    fill_precision = fills_correct / fills_proposed if fills_proposed else 1.0
    failed: list[str] = []
    if intent_accuracy < INTENT_THRESHOLD:
        failed.append(f"intent accuracy {intent_accuracy:.1%} < {INTENT_THRESHOLD:.0%}")
    if fill_precision < FILL_PRECISION_THRESHOLD:
        failed.append(f"fill precision {fill_precision:.1%} < {FILL_PRECISION_THRESHOLD:.0%}")
    if out_of_schema:
        failed.append(f"keys outside the schema: {out_of_schema}")
    if false_deletes:
        failed.append(f"false-positive deletes: {false_deletes}")
    return UnderstandScore(
        total,
        intent_correct,
        intent_accuracy,
        fills_proposed,
        fills_correct,
        fill_precision,
        fills_required,
        fills_found,
        edits_exact,
        out_of_schema,
        false_deletes,
        misses,
        failed,
    )
