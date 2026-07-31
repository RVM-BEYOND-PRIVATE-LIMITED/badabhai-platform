"""Configurable interview question bank.

Phase-1 role family: CNC/VMC manufacturing. Topics are DATA, not code, so more
roles/questions can be added later without touching the engine. Each topic's
``core`` flag drives the ask ORDER (core first); extraction-readiness is the
engine's ``ESSENTIAL_TOPICS`` / ``MUST_ASK_TOPICS``.

Two locked decisions shape this bank (context-drift register 2026-07-16,
owner rulings 2026-07-17):

- **B-5 — ONE question per turn.** Every ``question`` is a single interrogative
  clause with exactly one "?". A question may LIST alternatives ("Fanuc,
  Siemens ya Haas?") but never bundles two asks. Formerly-bundled asks are now
  sequential topics (extra turns are expected and correct).
- **B-4 — current AND preferred location, never conflated.** ``current_location``
  and ``preferred_locations`` are separate topics with their own questions;
  ``signals.detect_answered_topics`` keys each on its own field.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Topic:
    id: str
    label: str
    question: str  # neutral mentor Hinglish phrasing (used directly in mock mode)
    why: str | None = None  # short reason, surfaced if the worker asks "why"
    # Ask PRIORITY: core topics are served before optional ones. Readiness itself
    # is the engine's ESSENTIAL_TOPICS / MUST_ASK_TOPICS, not this flag.
    core: bool = False
    # INTERVIEW-1: wording for the ONE bounded RE-ask of an unanswered ESSENTIAL
    # topic (engine MAX_ASKS_PER_TOPIC = 2). It is a UX rewording — re-serving an
    # identical string reads as broken — and NOT a detection fix.
    #
    # Be precise about that, because earlier drafts of this comment were wrong twice.
    # Rewording cannot make an out-of-scope trade parseable: measured against
    # ``signals.detect_answered_topics``, 'fitter', 'electrician' and 'carpenter' all
    # return {} no matter how they are solicited. What protects those workers is the
    # engine's ASK BOUND, not this string.
    #
    # TAX-WELD-1 UPDATE: welding is NO LONGER one of those trades. 'welder', 'TIG',
    # 'MIG' and 'TIG aur MIG' now resolve — but they resolve ``role`` and ``skills``,
    # NOT ``machines`` (the taxonomy has no welding ``mach_*`` id; the corpus models
    # TIG/MIG/arc as SKILLS). So 'welder' is offered under ``role``, where it is
    # recordable, and TIG/MIG remain absent from the ``machines`` retry — for the new,
    # precise reason that they do not key that field, not the old wrong one.
    #
    # What the wording CAN do is avoid soliciting answers we know fail. Every
    # example offered below was executed against ``detect_answered_topics`` and
    # RESOLVES to its own topic today. Note 'operator' alone does NOT resolve
    # ``role`` (it keys ``skills``), so the role retry keeps a machine/trade-name
    # cue. Same B-5 rule: exactly one "?", <= 20 words, aap-form, no vocative.
    # Only ESSENTIAL topics carry one; optional topics are asked once and never
    # re-asked, so they leave this None.
    retry_question: str | None = None

    # TAP-TO-ANSWER options for THIS topic — short ANSWERS, never questions.
    #
    # THE DEFECT THIS REPLACES, measured on the shipped constant. `suggested_followups`
    # served three hard-coded QUESTIONS, and the worker app sends a tapped chip's label
    # verbatim as the worker's message (`chat_profiling_screen.dart` `_sendText(f)`).
    # Run through the detector:
    #
    #   'Controller kaunsa — Fanuc ya Siemens?' -> {'controllers': ['Fanuc','Siemens']}
    #   'Setting karte hain ya sirf operation?' -> {'skills': ['basic setting']}
    #
    # ONE TAP recorded TWO controllers the worker never named. The list was also
    # identical for every role family (`cnc_vmc` == `welding` == anything), so a
    # welder was offered CNC controllers to fabricate.
    #
    # THE RULE, and it is not a style preference: every option here is executed
    # against ``signals.detect_answered_topics(option, topic.id)`` by
    # ``test_answer_chips.py`` and must resolve THIS topic. An option that does not
    # is worse than no chip at all — the worker taps, sees their words in the
    # transcript, and the field stays empty while the engine burns a bounded re-ask.
    # That is why measured-failing candidates are ABSENT rather than reworded:
    # 'CNC operator' (keys only `skills`), '10th pass'/'12th pass' and 'Koi nahi'
    # all return {} or the wrong key today.
    #
    # EMPTY IS A VALID ANSWER. `current_location` / `preferred_locations` carry none:
    # the city space is open, and any four cities we picked would be four cities we
    # put in the worker's mouth. Free text only, there.
    options: tuple[str, ...] = ()


ROLE_FAMILIES: dict[str, dict] = {
    "cnc_vmc": {
        "label": "CNC / VMC Manufacturing",
        "roles": [
            "CNC Turner/Operator",
            "VMC Operator",
            "HMC Operator",
            "CNC Setter-Operator",
            "CNC Programmer",
            "CAM Programmer",
            "CNC Grinding Operator",
        ],
    },
    "welding": {
        "label": "Welding & Fabrication",
        "roles": ["MIG Welder", "TIG Welder", "Arc Welder", "Gas Cutter"],
    },
    "plumbing": {
        "label": "Plumbing & Piping",
        "roles": ["Plumber", "Pipe Fitter", "Drainage Worker"],
    },
    "carpentry": {
        "label": "Carpentry & Woodworking",
        "roles": ["Carpenter", "Furniture Maker", "Kitchen Fitter", "Shuttering Carpenter"],
    },
    "design": {
        "label": "Design (Graphic / Product / Mechanical)",
        "roles": [
            "Graphic Designer", "Product Designer",
            "Mechanical Designer", "Fashion Designer",
        ],
    },
    "interior_design": {
        "label": "Interior Design & Space Planning",
        "roles": ["Residential Designer", "Commercial Designer", "Retail Designer"],
    },
    # PERSONA v3.2 worked conversation #04 (the tailor) — the UNCOVERED-TRADE family.
    #
    # Before this entry `topics_for()` fell back to `_CNC_VMC_TOPICS` for any family it
    # did not know, so a hotel cook was asked "Kaunsi machine — VMC, CNC lathe, HMC ya
    # grinding?" and offered VMC/Fanuc chips to tap. The persona sheet is explicit:
    # "Same warmth, plainer voice, fewer questions. Never says we don't serve that
    # trade. No faked expertise" — and "faked fluency is worse than plainness".
    #
    # `roles` is deliberately EMPTY. This family exists precisely because we do not
    # know the trade; naming candidate roles here would be the faked expertise the
    # sheet forbids, and any list we invented would leak into copy sooner or later.
    "generic": {
        "label": "Other trades",
        "roles": [],
    },
}

# --- Shared topics (identical across all role families) ---
_SHARED_TOPICS: list[Topic] = [
    Topic(
        "experience",
        "Experience",
        "Kitne saal ka experience hai?",
        core=True,
        retry_question="Kitne saal se yeh kaam kar rahe hain — jaise 2 saal ya 5 saal?",
        options=("1 saal", "3 saal", "5 saal", "10 saal"),
    ),
    Topic(
        "current_location",
        "Current location",
        "Abhi kis sheher mein hain?",
        core=True,
        retry_question="Abhi aap kis sheher mein rehte hain — jaise Pune, Delhi ya Rajkot?",
    ),
    Topic(
        "preferred_locations",
        "Preferred locations",
        # PERSONA v3.2 §4, VERBATIM ("Kaam kahan karna chahte hain?"). Adopted after
        # measuring the string INERT against detect_answered_topics (it self-keys no
        # field, so it cannot fabricate when it lands in the extraction transcript) and
        # confirming the topic's answers still resolve — "Delhi bhi chalega" ->
        # ['Delhi'], "kahin bhi chalega" -> 'flexible' (attribution is context-gated on
        # last_asked, so it does not depend on the question's wording at all).
        "Kaam kahan karna chahte hain?",
        why="Taaki aapke pasand ke sheher ki naukri dhoondh sakein.",
        core=True,
    ),
    Topic(
        "salary_current",
        "Current salary",
        "Abhi salary kitni hai?",
        options=("15 hazar", "20 hazar", "25 hazar", "30 hazar"),
    ),
    Topic(
        "salary_expected",
        "Expected salary",
        # PERSONA v3.2 §4, VERBATIM. Measured inert; the chips and "30000 chahiye" /
        # a bare "25000" still key salary_expected (the B-5 expected-context
        # attribution reads last_asked, not the question text).
        "Kitni salary chahiye?",
        options=("25 hazar", "30 hazar", "35 hazar", "40 hazar"),
    ),
    Topic(
        "availability",
        "Availability",
        # PERSONA v3.2 §4, VERBATIM. Measured inert; every chip still resolves
        # (Turant -> immediate, 15 din / 1 mahina / 2 mahina -> notice_period) and so
        # does "15 din lagenge", because the #424 widening is context-gated on
        # last_asked == "availability".
        "Kab se join kar sakte hain?",
        options=("Turant", "15 din", "1 mahina", "2 mahina"),
    ),
    Topic(
        "education",
        "Education / training",
        "ITI, diploma ya koi aur training li hai?",
        options=("ITI", "Diploma", "ITI nahi kiya"),
    ),
    Topic(
        "education_level",
        "Education level",
        "Aapne kahan tak padhai ki hai — 10th, 12th ya B.Tech?",
    ),
    Topic(
        "education_field",
        "Field of study",
        "Kis field mein padhai ki — jaise Electronics ya Computer Science?",
    ),
    Topic(
        "certifications",
        "Certifications",
        "Koi certificate hai — jaise NCVT, NSQF ya apprenticeship?",
        options=("NCVT", "SCVT", "NSQF", "Apprenticeship"),
    ),
]


def _shared_topics_except(*topic_ids: str) -> list[Topic]:
    """The shared tail MINUS the named ids — for a family that defines its OWN
    version of a shared topic.

    BUG S2, and the reason this helper exists rather than a comment: ``_WELDING_TOPICS``
    declared its own ``certifications`` (the 6G/6GR/AWS wording a welder actually needs)
    and then appended ``_SHARED_TOPICS``, which declares ``certifications`` too. One id,
    two entries. Nothing crashed, because every consumer takes the FIRST match —
    ``topic_by_id`` returns it, ``_next_topic`` serves it — so the shared entry was
    simply unreachable dead data that no test could see. Composing the family
    explicitly makes the exclusion a decision instead of an accident, and
    ``test_no_family_contains_a_duplicate_topic_id`` now fails if one comes back.
    """
    excluded = frozenset(topic_ids)
    return [t for t in _SHARED_TOPICS if t.id not in excluded]


# Ordered interview flow for CNC/VMC. Core topics + family-specific + shared.
_CNC_VMC_TOPICS: list[Topic] = [
    Topic(
        "role",
        "Role / trade",
        "Aap kaunsa kaam karte hain?",
        core=True,
        retry_question=(
            "Machine ya kaam ke naam se bataiye — "
            "VMC operator, CNC turner, setter, programmer ya welder?"
        ),
        options=("VMC operator", "CNC turner", "Setter", "Programmer"),
    ),
    Topic(
        "machines",
        "Machine exposure",
        "Kaunsi machine — VMC, CNC lathe, HMC ya grinding?",
        core=True,
        retry_question="Jis machine par kaam karte hain uska naam kya hai — VMC, lathe ya HMC?",
        options=("VMC", "CNC lathe", "HMC", "Grinding"),
    ),
    Topic(
        "skills",
        "Skills",
        "Setting, tool offset, program edit, drawing reading — inmein se kya aata hai?",
        why="Taaki aapke liye sahi role match kar sakein.",
        core=True,
        options=("Setting", "Tool offset", "Program edit", "Drawing reading"),
    ),
    Topic(
        "controllers",
        "Controller knowledge",
        "Controller kaunsa — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?",
        options=("Fanuc", "Siemens", "Mitsubishi", "Haas"),
    ),
] + _SHARED_TOPICS

# --- Welding ---
_WELDING_TOPICS: list[Topic] = [
    Topic(
        "role",
        "Role / trade",
        "Aap kaunsa kaam karte hain?",
        core=True,
        retry_question="Welding karte hain — MIG, TIG, arc ya gas cutting?",
        options=("MIG welder", "TIG welder", "Arc welder", "Gas cutter"),
    ),
    Topic(
        "equipment",
        "Welding equipment",
        "Kaunsi welding machine use karte hain — MIG, TIG, arc ya plasma?",
        core=True,
        retry_question="Welding machine ka naam bataiye — MIG welder, TIG welder ya gas cutter?",
        options=("MIG welder", "TIG welder", "Arc welder", "Plasma cutter"),
    ),
    Topic(
        "skills_welding",
        "Welding skills",
        "MIG welding, TIG welding, arc welding, grinding — inmein se kya aata hai?",
        core=True,
        options=("MIG welding", "TIG welding", "Arc welding", "Grinding"),
    ),
    Topic(
        "materials",
        "Welding materials",
        "Kaunsi material pe welding karte hain — mild steel, stainless, aluminum?",
        options=("Mild steel", "Stainless", "Aluminum"),
    ),
    Topic(
        "position",
        "Welding position",
        "Kis position mein welding aata hai — flat, vertical, ya overhead bhi?",
        options=("Flat", "Vertical", "Overhead", "Pipe (6G)"),
    ),
    Topic(
        "certifications",
        "Certifications",
        "Koi welding certification hai — 6G, 6GR, ya AWS?",
        options=("6G", "6GR", "AWS", "NCVT"),
    ),
    # S2: welding keeps its OWN certifications topic (6G/6GR/AWS is what a welder is
    # actually asked for), so the shared one is excluded rather than appended dead.
] + _shared_topics_except("certifications")

# --- Plumbing ---
_PLUMBING_TOPICS: list[Topic] = [
    Topic(
        "role",
        "Role / trade",
        "Aap kaunsa kaam karte hain?",
        core=True,
        retry_question="Plumbing karte hain — pipe fitting, drainage ya water supply?",
        options=("Plumber", "Pipe fitter", "Drainage work", "Water supply"),
    ),
    Topic(
        "tools_plumbing",
        "Plumbing tools",
        "Kaunse tools use karte hain — pipe wrench, threading machine ya cutter?",
        core=True,
        retry_question="Tool ka naam bataiye — pipe wrench, threading machine ya pipe cutter?",
        options=("Pipe wrench", "Threading machine", "Pipe cutter", "Pipe bender"),
    ),
    Topic(
        "skills_plumbing",
        "Plumbing skills",
        "Pipe fitting, drainage, water supply — inmein se kya aata hai?",
        core=True,
        options=("Pipe fitting", "Drainage", "Water supply", "Drawing reading"),
    ),
    Topic(
        "specialization_plumbing",
        "Plumbing specialization",
        "Kis type ka plumbing karte hain — residential, commercial ya industrial?",
        options=("Residential", "Commercial", "Industrial"),
    ),
] + _SHARED_TOPICS

# --- Carpentry ---
_CARPENTRY_TOPICS: list[Topic] = [
    Topic(
        "role",
        "Role / trade",
        "Aap kaunsa kaam karte hain?",
        core=True,
        retry_question="Carpentry karte hain — furniture, kitchen ya site shuttering?",
        options=("Furniture maker", "Carpenter", "Kitchen fitter", "Shuttering carpenter"),
    ),
    Topic(
        "tools_carpentry",
        "Carpentry tools",
        "Kaunsi machine use karte hain — circular saw, planer ya router?",
        core=True,
        retry_question="Machine ka naam bataiye — circular saw, planer ya sander?",
        options=("Circular saw", "Planer", "Router", "Sander"),
    ),
    Topic(
        "skills_carpentry",
        "Carpentry skills",
        "Cutting, assembly, polishing, drawing reading — inmein se kya aata hai?",
        core=True,
        options=("Cutting", "Assembly", "Polishing", "Drawing reading"),
    ),
    Topic(
        "specialization_carpentry",
        "Carpentry specialization",
        "Kis type ka kaam karte hain — furniture, kitchen, construction ya finishing?",
        options=("Furniture", "Kitchen", "Construction", "Finishing"),
    ),
] + _SHARED_TOPICS

# --- Design (graphic / product / mechanical) ---
_DESIGN_TOPICS: list[Topic] = [
    Topic(
        "role",
        "Role / trade",
        "Aap kaunsa kaam karte hain?",
        core=True,
        retry_question="Design ka kaam karte hain — graphic, product ya mechanical design?",
        options=("Graphic designer", "Product designer", "Mechanical designer", "Fashion designer"),
    ),
    Topic(
        "software_design",
        "Design software",
        "Kaunsa software use karte hain — AutoCAD, SolidWorks ya Photoshop?",
        core=True,
        retry_question="Software ka naam bataiye — AutoCAD, SolidWorks ya CATIA?",
        options=("AutoCAD", "SolidWorks", "CATIA", "Photoshop"),
    ),
    Topic(
        "skills_design",
        "Design skills",
        "2D drafting, 3D modeling, rendering — inmein se kya aata hai?",
        core=True,
        options=("2D drafting", "3D modeling", "Rendering", "Drawing reading"),
    ),
    Topic(
        "specialization_design",
        "Design specialization",
        "Kis field mein design karte hain — mechanical, architecture ya branding?",
        options=("Mechanical", "Architecture", "Branding", "Fashion"),
    ),
] + _SHARED_TOPICS

# --- Interior design ---
_INTERIOR_DESIGN_TOPICS: list[Topic] = [
    Topic(
        "role",
        "Role / trade",
        "Aap kaunsa kaam karte hain?",
        core=True,
        retry_question="Interior design karte hain — residential, commercial ya retail?",
        options=(
            "Residential designer", "Commercial designer",
            "Retail designer", "Hospitality designer",
        ),
    ),
    Topic(
        "software_interior",
        "Design software",
        "Kaunsa software use karte hain — AutoCAD, SketchUp ya 3ds Max?",
        core=True,
        retry_question="Software ka naam bataiye — AutoCAD, SketchUp ya Revit?",
        options=("AutoCAD", "SketchUp", "3ds Max", "Revit"),
    ),
    Topic(
        "skills_interior",
        "Interior design skills",
        "Space planning, material selection, 3D visualization — inmein se kya aata hai?",
        core=True,
        options=("Space planning", "Material selection", "3D visualization", "Lighting design"),
    ),
    Topic(
        "specialization_interior",
        "Interior specialization",
        "Kis type ka interior karte hain — home, office, showroom ya hotel?",
        options=("Home", "Office", "Showroom", "Hotel"),
    ),
] + _SHARED_TOPICS

# --- Generic (uncovered trades) ---------------------------------------------
# PERSONA v3.2, worked conversation #04. The bank a hotel cook, a tailor or a driver
# gets. Two rules shape every string below and both come straight off the sheet:
#
#   "Same warmth, plainer voice, fewer questions. Never says we don't serve that
#    trade. No faked expertise."
#   "faked fluency is worse than plainness"
#
# So: NO machine names, NO controller names, NO software names — not in a question,
# not in a retry, not in a chip. The role question is the SAME neutral line every
# family opens with (it was never CNC-specific); only the RETRY had to be rewritten,
# because the CNC one lists "VMC operator, CNC turner, setter, programmer ya welder"
# and reading that back to a cook is exactly the faked expertise the sheet forbids.
#
# NO CHIPS on the two trade-specific topics, and this is a hard constraint rather
# than a style choice: every chip in this repo is EXECUTED against
# `signals.detect_answered_topics` by tests/test_answer_chips.py, because the worker
# app sends a tapped chip's label verbatim as the worker's message. The generic trade
# space is open by definition, so no chip we could write is guaranteed to resolve —
# and a chip that does not resolve is worse than no chip at all (the worker taps, sees
# their words in the transcript, and the field stays empty). The SHARED topics keep
# whatever chips they already have: "3 saal", "15 hazar", "Turant", "ITI" are
# trade-independent and still resolve.
#
# OWNER RULING (2026-07-31): keep ALL shared topics, education and certifications
# included. "Fewer questions" is satisfied by dropping the family-specific block
# (4 CNC topics -> 1 generic one), not by cutting a worker's ITI off their resume.
_GENERIC_TOPICS: list[Topic] = [
    Topic(
        "role",
        "Role / trade",
        "Aap kaunsa kaam karte hain?",
        core=True,
        # No trade names offered — we do not know the space, and a wrong example
        # would put words in the worker's mouth. Asking them to say it their own
        # way is the plainer voice the sheet asks for.
        retry_question="Aap kis tarah ka kaam karte hain — apne shabdon mein bataiye?",
    ),
    Topic(
        "daily_tasks",
        "Daily work",
        # VERBATIM from the persona sheet's worked conversation #04.
        "Is kaam mein aap kya-kya karte hain?",
        why="Taaki aapke kaam ka sahi description ban sake.",
        core=True,
    ),
] + _SHARED_TOPICS

_TOPICS_BY_FAMILY: dict[str, list[Topic]] = {
    "cnc_vmc": _CNC_VMC_TOPICS,
    "welding": _WELDING_TOPICS,
    "plumbing": _PLUMBING_TOPICS,
    "carpentry": _CARPENTRY_TOPICS,
    "design": _DESIGN_TOPICS,
    "interior_design": _INTERIOR_DESIGN_TOPICS,
    "generic": _GENERIC_TOPICS,
}

# The family served when the caller's family is unknown/None. Was `cnc_vmc` — which
# is what put CNC machine questions in front of every uncovered trade.
GENERIC_ROLE_FAMILY = "generic"

# --- One-shot opener (owner-approved 2026-07-22) -----------------------------
# An INVITATION to answer everything in one message, for the worker who would
# rather type once than be asked twelve times. It is NOT a Topic and is never
# served as an ask: adding it to the bank would make `_next_topic` serve it as a
# real question, and it is not one.
#
# THE B-5 EXCEPTION, stated so it is not mistaken for a violation: B-5 (owner
# ruling 2026-07-17) says one question mark per served message. This string holds
# exactly one `?` and obeys the letter, but it is a twelve-item menu and plainly
# not what B-5 had in mind. It is the ONE sanctioned exception, because it is an
# invitation the worker may ignore rather than a question they must answer. The
# ≤20-word cap deliberately does not apply — that test iterates `topics_for()`,
# which this constant is correctly not in.
#
# THE COPY RULE: each line is the BANK'S OWN question stem with its example values
# and its `?` stripped. Two reasons, both measured:
#
#   1. Naming example values makes the opener answer its own questions. A draft
#      that listed "VMC, CNC lathe, HMC ya grinding ... Fanuc, Siemens ... ITI,
#      diploma" self-keyed EIGHT profile fields from `profile_extractor.extract`,
#      including `certifications=['NCVT','NSQF','Apprenticeship']` — the exact
#      fabrication shape PR #493 exists to prevent.
#   2. Mirroring the bank's stems is what makes the worker's reply parse. Measured:
#      an opener asking "abhi kitni salary" lost `salary_current` from the reply
#      (10/12 topics, wrap turn 3); the bank's own "abhi salary kitni hai"
#      recovers it (11/12, wrap turn 2).
#
# "No example values" is NOT a sufficient rule on its own — an earlier
# category-only draft still self-keyed `skills` (from "machine chalate hain") and
# `availability` (from "kitne din ka notice"). Inertness is a property of the
# EXACT string, so it is pinned by a test, never argued from the rule.
#
# `certifications` is deliberately NOT named. It is the one topic the local
# detector cannot read context-free (measured: 0 of 5 phrasings), so naming it
# would guarantee the worker answers it here and is then asked it again — the
# most trust-destroying thing a chat product can do. The engine asks it as the
# single follow-up instead.
#
# NEVER POSTED. This string must not enter the extraction transcript. Measured: a
# posted value-naming opener, on the `messages`-absent fallback that PR #493
# documents as its ROLLBACK LEVER, hands the worker four machines, five
# controllers, ITI+Diploma and NCVT+NSQF that they never said. Kept out of the
# transcript entirely, both consumers are safe by construction rather than by the
# role-split holding.
# OWNER CHANGE 2026-07-23: the opener is now a SHORT greeting that asks only the
# first (role) question, replacing the twelve-item invitation menu — the first
# message the worker sees must be short. The inertness rules above STILL apply and
# still matter: this string is never posted to the transcript, holds exactly one
# "?", names no example values, and self-keys NO profile field (it is a greeting +
# the role question, both of which the detector reads as nothing). The engine still
# asks every remaining topic one at a time via next_turn.
# PERSONA v3.2 §3 / §7 (2026-07-31): "Namaste!" -> "Namaste." The sheet bans **any
# exclamation mark** without qualification, and it listed this constant by name as one
# of the two shipped violations (the other is `kChatOpeningText` in
# apps/worker-app/.../chat_bloc.dart). The two MUST stay byte-identical — the app prints
# its copy locally and the service serves this one — so both move together rather than
# recording an exception for a rule the sheet states absolutely. Nothing else in the
# string changed: it still holds exactly one "?", names no example values, self-keys no
# profile field, and mirrors the bank's own role-question stem.
ONE_SHOT_OPENER: str = (
    "Namaste. Main aapka Bada Bhai. Chalo, ab aapka accha sa resume banate hain. "
    "Chaliye shuru karte hain — aap kaunsa kaam karte hain?"
)


def one_shot_opener_for(role_family: str | None) -> str:
    """The one-shot opener for a role family (unknown/None resolves to ``generic``).

    Takes `role_family` so a family can diverge without a caller change; today every
    family — ``generic`` included — shares the same copy, and that is CORRECT rather
    than lazy: the opener is a greeting plus the neutral role question, which names no
    machine, no controller and no software. It was already trade-free, so the
    uncovered-trade worker's first message is identical to everyone else's, which is
    exactly the "same warmth, plainer voice" the persona sheet asks for.
    """
    _ = topics_for(role_family)  # validates the family resolves; copy is shared today
    return ONE_SHOT_OPENER


def options_for(role_family: str | None, topic_id: str | None) -> list[str]:
    """Tap-to-answer options for the topic just asked — ``[]`` when there are none.

    ``[]`` is the correct, common answer and must stay cheap: no topic asked yet,
    a topic with an open answer space (the two location topics), or an id from a
    role family that does not define it. Returning a generic list instead is what
    the old ``_FOLLOWUPS`` constant did, and it fabricated answers.
    """
    if not topic_id:
        return []
    topic = topic_by_id(role_family, topic_id)
    return list(topic.options) if topic else []


def topics_for(role_family: str | None) -> list[Topic]:
    """Topics for a role family. Unknown/None falls back to ``generic``, NOT CNC/VMC.

    THE DEFECT THIS FIXES. The fallback used to be ``_CNC_VMC_TOPICS``, so every trade
    the gazetteer cannot place — cook, tailor, driver, painter — was handed the CNC
    bank and asked "Kaunsi machine — VMC, CNC lathe, HMC ya grinding?", then offered
    VMC/Fanuc chips to tap (and a tapped chip is recorded as the worker's own answer).
    The generic bank asks the plain question instead; the worker is NEVER told their
    trade is unsupported, and their raw phrases still reach extraction unchanged.
    """
    if not role_family:
        return _GENERIC_TOPICS
    return _TOPICS_BY_FAMILY.get(role_family, _GENERIC_TOPICS)


def topic_by_id(role_family: str | None, topic_id: str) -> Topic | None:
    for topic in topics_for(role_family):
        if topic.id == topic_id:
            return topic
    return None
