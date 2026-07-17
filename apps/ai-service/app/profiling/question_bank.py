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
    ),
    Topic(
        "machines", "Machine exposure",
        "Kaunsi machine — VMC, CNC lathe, HMC ya grinding?",
        core=True,
    ),
    Topic(
        "experience", "Experience",
        "Kitne saal ka experience hai?",
        core=True,
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
