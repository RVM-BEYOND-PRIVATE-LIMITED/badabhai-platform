"""Worker interview engine (deterministic core).

Tracks which topics the worker has answered and chooses the next question. In
mock mode the assistant reply IS the next question (a warm bada-bhai line). In
real mode the same engine-chosen question is handed to the LLM for natural
phrasing — so the model controls tone, the engine controls coverage + cost.

Topic detection reuses ``signals`` (single source of truth) over the RAW worker
message locally (no network), so it sees role/city/etc. even though those are
masked before any external LLM call.
"""

from __future__ import annotations

from ..contracts import ConversationState
from . import signals
from .question_bank import Topic, topics_for

_ACK = "Badhiya bhai. "
_WRAP_UP = (
    "Bahut badhiya bhai \U0001f44d itni jaankari kaafi hai — main aapka profile bana "
    "deta hoon. Kuch chhoti detail baad me confirm kar lenge."
)

# The topics that MUST be answered before we offer extraction. Location is
# essential for matching, so it is required (not just "any N core topics").
ESSENTIAL_TOPICS: tuple[str, ...] = ("role", "machines", "experience", "location")

# Topic-specific follow-up nudges used as suggested_followups.
_FOLLOWUPS = [
    "Controller kaunsa — Fanuc ya Siemens?",
    "Setting karte ho ya sirf operation?",
    "Kis city me kaam karna pasand karoge?",
]


def first_question(role_family: str = "cnc_vmc") -> tuple[str, str]:
    """Return (topic_id, question) for the opening question."""
    first = topics_for(role_family)[0]
    return first.id, first.question


def next_turn(
    state: ConversationState | None,
    worker_message_raw: str,
    role_family: str = "cnc_vmc",
) -> tuple[str, str | None, ConversationState, bool]:
    """Advance the interview by one turn.

    Returns ``(assistant_message_mock, asked_question_id, updated_state,
    extraction_ready)``. ``worker_message_raw`` is read locally only.
    """
    topics = topics_for(role_family)
    st = (
        state.model_copy(deep=True)
        if state is not None
        else ConversationState(role_family=role_family)
    )
    st.role_family = role_family
    st.turn_count += 1

    # 1. Update progress from what the worker just said.
    for topic_id, value in signals.detect_answered_topics(worker_message_raw).items():
        if topic_id not in st.answered_topics:
            st.answered_topics.append(topic_id)
        if value is not None:
            st.collected[topic_id] = value

    extraction_ready = all(t in st.answered_topics for t in ESSENTIAL_TOPICS)

    # 2. Choose the next question (core first, then optional, don't re-nag).
    next_topic = _next_topic(topics, st)
    if next_topic is None or extraction_ready:
        return _WRAP_UP, None, st, True

    if next_topic.id not in st.asked_question_ids:
        st.asked_question_ids.append(next_topic.id)
    return _ACK + next_topic.question, next_topic.id, st, extraction_ready


def suggested_followups(role_family: str = "cnc_vmc") -> list[str]:
    return list(_FOLLOWUPS)


def _next_topic(topics: list[Topic], st: ConversationState) -> Topic | None:
    # Unanswered core topics we haven't already asked.
    for topic in topics:
        is_open = topic.id not in st.answered_topics and topic.id not in st.asked_question_ids
        if topic.core and is_open:
            return topic
    # Unanswered optional topics we haven't already asked.
    for topic in topics:
        if topic.id not in st.answered_topics and topic.id not in st.asked_question_ids:
            return topic
    return None
