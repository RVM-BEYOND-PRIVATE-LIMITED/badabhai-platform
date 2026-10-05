"""The companion edit-parser's gold set (ADR-0046 A4) — labelled messages and their exact rows.

THE GATE. The acceptance criterion is >= 90% of cases yielding EXACTLY the expected rows, and 0
rows ever outside the catalogue (phase-1 §4). The bars are for the REAL parser, so this module is
the single source of truth shared by the pytest suite (which checks the set, the catalogue
containment and the scorer deterministically) and the staging CLI.

THE FIXTURE IS FROZEN AND SMALL ON PURPOSE. Every case is parsed against the same catalogue and
snapshot, so an expected row can be checked against the exact ref/field it names. `CATALOGUE`
mirrors `apps/api/src/chat-companion/v2/edit-catalogue.ts` (P1) and `CONTAINMENT` proves every
expected row could have come from it.

TEST DATA ONLY: fabricated lines, no PII.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

#: The bar the real parser must clear (phase-1 §4).
THRESHOLD = 0.90

#: `(op, section, ref, field, value)`; ref is None for add, value is None for delete.
Row = tuple[str, str, str | None, str | None, str | None]

#: (section, field, legal ops) — mirrors the API catalogue's P1 content. Employment is EDIT-ONLY
#: ("Never from chat", owner 2026-10-01: a whole job is removed only on the Profile screen) and so
#: are qualifications (TD151(1) provisional default, 2026-10-05: a whole certificate, education or
#: training is removed only there too), so a model row that deletes one is outside the catalogue
#: and the API drops it.
CATALOGUE: list[tuple[str, str, tuple[str, ...]]] = [
    ("employment", "employer_name", ("edit",)),
    ("employment", "employer_city", ("edit",)),
    ("employment", "employer_state", ("edit",)),
    ("employment", "start_ym", ("edit",)),
    ("employment", "end_ym", ("edit",)),
    ("employment", "role_label", ("edit",)),
    ("employment", "work_done", ("edit",)),
    ("skills", "skill", ("add", "delete")),
    ("languages", "language", ("add", "delete")),
    ("qualifications", "certificate_name", ("edit",)),
    ("qualifications", "certificate_issuer", ("edit",)),
    ("qualifications", "certificate_year", ("edit",)),
    ("qualifications", "education_credential", ("edit",)),
    ("qualifications", "education_field", ("edit",)),
    ("qualifications", "education_council", ("edit",)),
    ("qualifications", "education_year", ("edit",)),
    ("qualifications", "education_institute", ("edit",)),
    ("qualifications", "training_name", ("edit",)),
    ("qualifications", "training_provider", ("edit",)),
    ("qualifications", "training_year", ("edit",)),
    ("occupations", "role_id", ("add", "delete")),
    ("preferences", "shift", ("edit",)),
    ("preferences", "job_type", ("edit",)),
    ("preferences", "willing_to_travel", ("edit",)),
    ("preferences", "willing_to_relocate", ("edit",)),
    ("preferences", "accommodation_needed", ("edit",)),
    ("preferences", "expected_salary", ("edit",)),
    ("preferences", "availability_status", ("edit",)),
    ("preferences", "availability_available_from", ("edit",)),
    ("preferences", "availability_notice_period_days", ("edit",)),
    ("preferences", "preferred_cities", ("add", "delete")),
    ("preferences", "work_types", ("add", "delete")),
    ("preferences", "documents_ready", ("add", "delete")),
]

_CATALOGUE_OPS = {(section, field): ops for section, field, ops in CATALOGUE}
_CATALOGUE_FIELDS = {(section, field) for section, field, _ in CATALOGUE}

#: The closed sections the parser may name (mirrors `COMPANION_V2_EDIT_SECTIONS`).
SECTIONS = ("employment", "skills", "languages", "qualifications", "occupations", "preferences")


@dataclass(frozen=True)
class EditScore:
    total: int
    exact: int
    accuracy: float
    misses: list[str]
    out_of_catalogue: list[str]
    failed: list[str]


def rows_outside_catalogue(rows: list[Row]) -> list[str]:
    """Every row that names a pair/op the catalogue does not offer — must ALWAYS be empty."""
    bad: list[str] = []
    for op, section, _ref, field, _value in rows:
        if section not in SECTIONS:
            bad.append(f"{section}: unknown section")
            continue
        # Named apart from "not in the catalogue": a field-less row is the prompt gap the API
        # drops unseen (every row must name its field, delete included), not a wrong field.
        if field is None:
            bad.append(f"{section}: {op} row names no field")
            continue
        if (section, field) not in _CATALOGUE_FIELDS:
            bad.append(f"{section}:{field}: not in the catalogue")
            continue
        if op not in _CATALOGUE_OPS[(section, field)]:
            bad.append(f"{section}:{field}: op {op} not allowed")
    return bad


def evaluate(predict: Callable[[str], list[Row]]) -> EditScore:
    """Score `predict` over the set. A case is EXACT when its rows match as a multiset."""
    exact = 0
    misses: list[str] = []
    out_of_catalogue: list[str] = []
    for text, expected in CASES:
        predicted = predict(text)
        out_of_catalogue.extend(rows_outside_catalogue(predicted))
        if sorted(predicted) == sorted(expected):
            exact += 1
        else:
            misses.append(f"{text!r}: expected {expected}, got {predicted}")
    accuracy = exact / len(CASES)
    failed = []
    if accuracy < THRESHOLD:
        failed.append(f"exact-row accuracy {accuracy:.1%} < {THRESHOLD:.0%}")
    if out_of_catalogue:
        failed.append(f"rows outside the catalogue: {out_of_catalogue}")
    return EditScore(len(CASES), exact, accuracy, misses, out_of_catalogue, failed)


# fmt: off
# (text, expected rows). `unsupported` is asserted separately by the API's own suites; here the
# rows are what matters. Every case is fabricated.
CASES: list[tuple[str, list[Row]]] = [
    # ── employment ──
    ("Tata ki jagah Mahindra likho", [("edit", "employment", "e1", "employer_name", "Mahindra")]),
    (
        "mera employer Tata Motors nahi, Mahindra hai",
        [("edit", "employment", "e1", "employer_name", "Mahindra")],
    ),
    ("city Pune se Nashik kar do", [("edit", "employment", "e1", "employer_city", "Nashik")]),
    ("मेरा शहर नासिक है", [("edit", "employment", "e1", "employer_city", "Nashik")]),
    ("kaam 2020 me shuru kiya tha", [("edit", "employment", "e1", "start_ym", "2020-01")]),
    ("job 2023 me chhod diya", [("edit", "employment", "e1", "end_ym", "2023-12")]),
    ("mera title welder nahi, fitter tha", [("edit", "employment", "e1", "role_label", "Fitter")]),
    ("kaam me TIG welding likh do", [("edit", "employment", "e1", "work_done", "TIG welding")]),
    # A whole-job delete is never proposed ("Never from chat", 2026-10-01): no row, and the
    # worker is told to use the Profile screen (the parser's `unsupported: ["other"]`).
    ("purana employer hata do", []),
    ("Tata wala kaam delete karo", []),
    # ── skills ──
    ("welding bhi add karo", [("add", "skills", None, "skill", "welding")]),
    ("lathe skill jodo", [("add", "skills", None, "skill", "lathe")]),
    ("MIG welding bhi aata hai", [("add", "skills", None, "skill", "MIG welding")]),
    ("VMC operation add karo", [("add", "skills", None, "skill", "VMC operation")]),
    ("milling hata do", [("delete", "skills", "s1", "skill", None)]),
    ("MIG welding skill nikal do", [("delete", "skills", "s2", "skill", None)]),
    ("welding add karo aur milling hata do", [
        ("add", "skills", None, "skill", "welding"),
        ("delete", "skills", "s1", "skill", None),
    ]),
    ("वेल्डिंग जोड़ दो", [("add", "skills", None, "skill", "welding")]),
    ("घिसाई हटा दो", [("delete", "skills", "s1", "skill", None)]),
    ("add CNC setting as a skill", [("add", "skills", None, "skill", "CNC setting")]),
    # ── languages ──
    ("hindi hata do", [("delete", "languages", "l1", "language", None)]),
    ("english bhi hata do", [("delete", "languages", "l2", "language", None)]),
    ("punjabi add karo", [("add", "languages", None, "language", "punjabi")]),
    ("marathi bhi bolta hoon, add karo", [("add", "languages", None, "language", "marathi")]),
    ("हिंदी हटा दो", [("delete", "languages", "l1", "language", None)]),
    ("bengali jodo", [("add", "languages", None, "language", "bengali")]),
    ("remove hindi from my languages", [("delete", "languages", "l1", "language", None)]),
    # ── qualifications ──
    (
        "certificate ka naam ITI Turner kar do",
        [("edit", "qualifications", "c1", "certificate_name", "ITI Turner")],
    ),
    ("issuer NCVT nahi SCVT hai", [("edit", "qualifications", "c1", "certificate_issuer", "SCVT")]),
    (
        "certificate ka saal 2019 kar do",
        [("edit", "qualifications", "c1", "certificate_year", "2019")],
    ),
    (
        "mera education credential diploma hai",
        [("edit", "qualifications", "q1", "education_credential", "diploma")],
    ),
    (
        "mera field mechanical tha",
        [("edit", "qualifications", "q1", "education_field", "Mechanical")],
    ),
    ("council SCVT hai", [("edit", "qualifications", "q1", "education_council", "scvt")]),
    ("padhai ka saal 2017 tha", [("edit", "qualifications", "q1", "education_year", "2017")]),
    (
        "institute Govt ITI Faridabad tha",
        [("edit", "qualifications", "q1", "education_institute", "Govt ITI Faridabad")],
    ),
    (
        "training ka naam safety kar do",
        [("edit", "qualifications", "t1", "training_name", "Safety")],
    ),
    ("provider RVM nahi NIMI hai", [("edit", "qualifications", "t1", "training_provider", "NIMI")]),
    ("training ka saal 2021 kar do", [("edit", "qualifications", "t1", "training_year", "2021")]),
    # A whole certificate, education or training is never removed from chat (TD151(1),
    # 2026-10-05): no row, and the worker is told to use the Profile screen (`unsupported:
    # ["other"]`), exactly like the job-delete lines above.
    ("certificate hata do", []),
    ("education delete karo", []),
    ("training nikal do", []),
    ("ITI hata do", []),
    ("mera ITI Turner certificate hata do", []),
    ("certificate ka saal 2019 aur institute Govt ITI kar do", [
        ("edit", "qualifications", "c1", "certificate_year", "2019"),
        ("edit", "qualifications", "q1", "education_institute", "Govt ITI"),
    ]),
    # ── occupations ──
    ("welding bhi karta hoon, add karo", [("add", "occupations", None, "role_id", "role_welder")]),
    ("CNC operator bhi hoon", [("add", "occupations", None, "role_id", "role_cnc_operator")]),
    ("welder hata do", [("delete", "occupations", "o1", "role_id", None)]),
    ("mujhe welder ka kaam nahi karna", [("delete", "occupations", "o1", "role_id", None)]),
    ("plumber bhi add karo", [("add", "occupations", None, "role_id", "role_plumber")]),
    # ── preferences ──
    ("shift night kar do", [("edit", "preferences", "pref", "shift", "night")]),
    ("day shift chahiye", [("edit", "preferences", "pref", "shift", "day")]),
    ("job type contract hai", [("edit", "preferences", "pref", "job_type", "contract")]),
    ("travel kar sakta hoon", [("edit", "preferences", "pref", "willing_to_travel", "true")]),
    ("travel nahi karunga", [("edit", "preferences", "pref", "willing_to_travel", "false")]),
    ("relocate kar sakta hoon", [("edit", "preferences", "pref", "willing_to_relocate", "true")]),
    ("rehna-padna chahiye", [("edit", "preferences", "pref", "accommodation_needed", "true")]),
    ("meri salary 30000 kar do", [("edit", "preferences", "pref", "expected_salary", "30000")]),
    ("mujhe 25000 chahiye", [("edit", "preferences", "pref", "expected_salary", "25000")]),
    (
        "immediately join kar sakta hoon",
        [("edit", "preferences", "pref", "availability_status", "immediate")],
    ),
    (
        "15 din ka notice hai",
        [("edit", "preferences", "pref", "availability_notice_period_days", "15")],
    ),
    (
        "2026-04-01 se available hoon",
        [("edit", "preferences", "pref", "availability_available_from", "2026-04-01")],
    ),
    ("Noida bhi add karo city me", [("add", "preferences", None, "preferred_cities", "Noida")]),
    ("Pune hata do", [("delete", "preferences", "pc1", "preferred_cities", None)]),
    ("daily wage bhi theek hai", [("add", "preferences", None, "work_types", "daily_wage")]),
    ("permanent hata do", [("delete", "preferences", "wt1", "work_types", None)]),
    ("PAN document bhi hai", [("add", "preferences", None, "documents_ready", "pan")]),
    ("aadhaar hata do list se", [("delete", "preferences", "dr1", "documents_ready", None)]),
    ("shift night kar do aur salary 28000", [
        ("edit", "preferences", "pref", "shift", "night"),
        ("edit", "preferences", "pref", "expected_salary", "28000"),
    ]),
    ("welding add karo, hindi hata do aur shift night kar do", [
        ("add", "skills", None, "skill", "welding"),
        ("delete", "languages", "l1", "language", None),
        ("edit", "preferences", "pref", "shift", "night"),
    ]),
    # ── nothing to edit / out of scope ──
    ("mera naam badlo", []),
    ("phone number update karo", []),
    ("aadhaar number badal do", []),
    ("kuch samajh nahi aaya", []),
    ("theek hai", []),
    ("job milegi kya", []),
    ("naya resume banao", []),
]
# fmt: on
