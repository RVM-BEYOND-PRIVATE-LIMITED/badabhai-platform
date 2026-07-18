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
}

# Ordered interview flow for CNC/VMC. Core topics first.
_CNC_VMC_TOPICS: list[Topic] = [
    Topic(
        "role", "Role / trade",
        "Aap kaunsa kaam karte hain — CNC, VMC, HMC operator, setter ya programmer?",
        core=True,
        # Every option resolves `role`: 'VMC operator', 'CNC turner', 'setter',
        # 'programmer', 'welder'. Bare 'operator' does NOT, so it never stands alone.
        # TAX-WELD-1: 'welder' is offered LAST — CNC/VMC stays the first-class wedge,
        # and welding is the alternative a machining answer never displaces (the same
        # ordering principle as `_ROLES` in signals.py). It is offered here and not
        # under `machines` because it keys `role`, not `machines`. The cue widened
        # from "machine ke saath" to "machine ya kaam ke naam se" so a welder — who
        # names a trade, not a machine — is actually invited by the wording.
        retry_question=(
            "Machine ya kaam ke naam se bataiye — "
            "VMC operator, CNC turner, setter, programmer ya welder?"
        ),
    ),
    Topic(
        "machines", "Machine exposure",
        "Kaunsi machine — VMC, CNC lathe, HMC ya grinding?",
        core=True,
        # 'VMC', 'CNC lathe', 'lathe', 'HMC', 'grinding' all resolve `machines`.
        # TIG/MIG still deliberately NOT offered here, but the REASON changed with
        # TAX-WELD-1: they are no longer unparseable (they resolve `role`+`skills`),
        # yet they do NOT key `machines` — there is no welding `mach_*` id in the
        # taxonomy. Offering them under THIS topic would still solicit an answer that
        # leaves `machines` unanswered and burns the bounded re-ask. A welder is
        # invited by the `role` retry instead, where the answer is recordable.
        retry_question="Jis machine par kaam karte hain uska naam kya hai — VMC, lathe ya HMC?",
    ),
    Topic(
        "experience", "Experience",
        "Kitne saal ka experience hai?",
        core=True,
        # '2 saal' / '5 saal' resolve. ('6 mahine' does NOT — so months are not
        # offered as an example, even though the worker may still answer that way.)
        retry_question="Kitne saal se yeh kaam kar rahe hain — jaise 2 saal ya 5 saal?",
    ),
    Topic(
        "skills", "Skills",
        "Setting, tool offset, program edit, drawing reading — inmein se kya aata hai?",
        why="Taaki aapke liye sahi role match kar sakein.",
        core=True,
    ),
    Topic(
        "current_location", "Current location",
        "Abhi kis sheher mein hain?",
        core=True,
        # City names resolve `current_location` (Pune/Delhi/Rajkot all verified).
        retry_question="Abhi aap kis sheher mein rehte hain — jaise Pune, Delhi ya Rajkot?",
    ),
    Topic(
        "preferred_locations", "Preferred locations",
        "Kahan kaam kar sakte hain?",
        why="Taaki aapke pasand ke sheher ki naukri dhoondh sakein.",
        core=True,
    ),
    Topic(
        "controllers", "Controller knowledge",
        "Controller kaunsa — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?",
    ),
    Topic(
        "salary_current", "Current salary",
        "Abhi salary kitni hai?",
    ),
    Topic(
        "salary_expected", "Expected salary",
        "Kitni salary expect karte hain?",
    ),
    Topic(
        "availability", "Availability",
        "Join karne mein kitne din lagenge?",
    ),
    Topic(
        "education", "Education / training",
        "ITI, diploma ya koi aur training li hai?",
    ),
]

_TOPICS_BY_FAMILY: dict[str, list[Topic]] = {"cnc_vmc": _CNC_VMC_TOPICS}


def topics_for(role_family: str) -> list[Topic]:
    """Topics for a role family (falls back to CNC/VMC)."""
    return _TOPICS_BY_FAMILY.get(role_family, _CNC_VMC_TOPICS)


def topic_by_id(role_family: str, topic_id: str) -> Topic | None:
    for topic in topics_for(role_family):
        if topic.id == topic_id:
            return topic
    return None
