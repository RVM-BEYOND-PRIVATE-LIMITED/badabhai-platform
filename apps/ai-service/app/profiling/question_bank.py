"""Configurable interview question bank.

Phase-1 role family: CNC/VMC manufacturing. Topics are DATA, not code, so more
roles/questions can be added later without touching the engine. Each topic's
``core`` flag drives extraction-readiness.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Topic:
    id: str
    label: str
    question: str  # neutral mentor Hinglish phrasing (used directly in mock mode)
    why: str | None = None  # short reason, surfaced if the worker asks "why"
    core: bool = False  # required to consider the profile ready for extraction


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
        "Setting khud karte hain ya sirf operation? Tool offset, program edit, "
        "drawing reading — kya aata hai?",
        why="Taaki aapke liye sahi role match kar sakein.",
        core=True,
    ),
    Topic(
        "location", "Location",
        "Abhi kis sheher mein hain, aur kahan kaam kar sakte hain?",
        core=True,
    ),
    Topic(
        "controllers", "Controller knowledge",
        "Controller kaunsa — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?",
    ),
    Topic(
        "salary", "Salary",
        "Abhi salary kitni hai, aur kitni expect karte hain?",
    ),
    Topic(
        "availability", "Availability",
        "Join karne mein kitne din — abhi free hain ya notice chal raha hai?",
    ),
    Topic(
        "education", "Education / training",
        "ITI ya diploma kiya hai? Koi training li hai?",
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
