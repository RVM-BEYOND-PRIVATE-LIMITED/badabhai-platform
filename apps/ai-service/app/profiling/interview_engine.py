"""Worker interview engine (deterministic core).

Tracks which topics the worker has answered and chooses the next question. In
mock mode the assistant reply IS the next question (a neutral mentor line). In
real mode the same engine-chosen question is handed to the LLM for natural
phrasing — so the model controls tone, the engine controls coverage + cost.

Topic detection reuses ``signals`` (single source of truth) over the RAW worker
message locally (no network), so it sees role/city/etc. even though those are
masked before any external LLM call.
"""

from __future__ import annotations

from ..contracts import ConversationState
from . import signals
from .question_bank import Topic, topic_by_id, topics_for

# A senior's acknowledgement: two words, no praise (persona rule G4).
_ACK = "Theek hai. "
_WRAP_UP = (
    "Itni jaankari kaafi hai. Aapka resume ban raha hai — kuch detail baad mein "
    "confirm karenge."
)

# The topics that MUST be answered before we offer extraction. Location is
# essential for matching, so it is required (not just "any N core topics").
ESSENTIAL_TOPICS: tuple[str, ...] = ("role", "machines", "experience", "location")

# Topic-specific follow-up nudges used as suggested_followups.
_FOLLOWUPS = [
    "Controller kaunsa — Fanuc ya Siemens?",
    "Setting karte hain ya sirf operation?",
    "Kis sheher mein kaam kar sakte hain?",
]

# AI-PERSONA-2: the ai-service NEVER emits a real worker name — only this literal
# placeholder token at the open/close vocative slots. It is NOT PII (safe to reach
# the LLM / event / Langfuse); the real first name is fetched (decrypted) and
# interpolated over it DOWNSTREAM in the NestJS ``ChatService.renderWorkerName`` —
# post-emit, only in the value returned to the client. Personalization is the
# DEFAULT; pass ``worker_name=None`` to opt out (renders no vocative).
WORKER_NAME_PLACEHOLDER = "{{worker_name}}"


def _vocative(worker_name: str | None) -> str:
    """Opening/close vocative — ``"{worker_name} ji, "`` when a name/token is given,
    else empty. Callers default to :data:`WORKER_NAME_PLACEHOLDER`, so the reply
    carries the ``{{worker_name}}`` TOKEN, never a real name.

    SAFETY (CLAUDE.md §2 #2 / G1 / AI-PERSONA-2 SG-1): the ai-service must only ever
    emit the placeholder token — which is NOT PII and is safe to reach the LLM /
    event / Langfuse. The real name is interpolated over the token downstream in the
    NestJS layer, after the event is emitted. Do NOT pass a real worker name here."""
    return f"{worker_name} ji, " if worker_name else ""


def first_question(
    role_family: str = "cnc_vmc",
    worker_name: str | None = WORKER_NAME_PLACEHOLDER,
) -> tuple[str, str]:
    """Return (topic_id, question) for the opening question. The vocative
    (placeholder by default) prefixes the opening only."""
    first = topics_for(role_family)[0]
    return first.id, _vocative(worker_name) + first.question


def next_turn(
    state: ConversationState | None,
    worker_message_raw: str,
    role_family: str = "cnc_vmc",
    worker_name: str | None = WORKER_NAME_PLACEHOLDER,
) -> tuple[str, str | None, ConversationState, bool]:
    """Advance the interview by one turn.

    Returns ``(assistant_message_mock, asked_question_id, updated_state,
    extraction_ready)``. ``worker_message_raw`` is read locally only. The vocative
    (placeholder by default) prefixes the OPEN (turn 1) and the CLOSE only — never
    the mid-interview ack turns.
    """
    topics = topics_for(role_family)
    st = (
        state.model_copy(deep=True)
        if state is not None
        else ConversationState(role_family=role_family)
    )
    st.role_family = role_family
    st.turn_count += 1
    # COST-4 clarify bound: ANY engine advance ends a clarify streak — the counter
    # only ever grows inside clarify_turn (consecutive re-serves of one question).
    st.clarify_count = 0

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
        return _vocative(worker_name) + _WRAP_UP, None, st, True

    if next_topic.id not in st.asked_question_ids:
        st.asked_question_ids.append(next_topic.id)
    # Turn 1 is the OPEN vocative slot: greet by name/token, then the first
    # question (no ack — the greeting IS the opener). Later turns ack only.
    if st.turn_count == 1:
        return _vocative(worker_name) + next_topic.question, next_topic.id, st, extraction_ready
    return _ACK + next_topic.question, next_topic.id, st, extraction_ready


# COST-4 clarify bound: max CONSECUTIVE re-serves of one question. The predicate has
# false-positive classes (short "?"-answers, marker-bearing honest answers with no
# extractable signal), so an unbounded re-serve could loop the interview forever —
# after this many the turn falls through to next_turn and the interview moves on.
_MAX_CONSECUTIVE_CLARIFIES = 2


def clarify_turn(
    state: ConversationState | None,
    worker_message_raw: str,
    role_family: str = "cnc_vmc",
) -> tuple[str, str, ConversationState, bool] | None:
    """COST-4 clarify fix: RE-SERVE the last asked question instead of advancing.

    A clarifying message ("matlab kya?") is not an answer — running :func:`next_turn`
    on it would advance the engine (the confused topic lands in ``asked_question_ids``
    and ``_next_topic`` skips it FOREVER, ``ESSENTIAL_TOPICS`` included) and hand the
    NEXT question to the rephrase branch instead of the confusing one.

    TWO guards keep the clarify path from EATING answers (the #238 review HIGH —
    ``needs_rephrase`` has false-positive classes):

    - **Answer-trumps-clarify**: if :func:`signals.detect_answered_topics` finds ANY
      extractable signal in ``worker_message_raw`` (the same detector + args
      :func:`next_turn` runs), this returns None — a short "?"-suffixed answer
      ("Fanuc?", "2 saal?", "Pune?") or a marker-bearing honest answer ("program edit
      samajh nahi aata, baaki sab aata hai") always advances the engine.
    - **Bounded clarifies**: at most ``_MAX_CONSECUTIVE_CLARIFIES`` consecutive
      re-serves (``state.clarify_count``, reset by every :func:`next_turn`); past the
      bound this returns None so the interview can never loop on one question.

    Returns the SAME tuple shape as :func:`next_turn` —
    ``(assistant_message_mock, asked_question_id, updated_state, extraction_ready)`` —
    where the mock reply is the LAST asked question verbatim and the updated state is
    a deep copy advanced by ``turn_count`` + ``clarify_count`` ONLY
    (``asked_question_ids`` / ``answered_topics`` / ``collected`` unchanged, so the
    topic stays re-askable and answerable). Returns None when there is nothing
    re-servable (no state, nothing asked yet, an unknown question id, an extractable
    answer, or a spent clarify budget) — the caller falls through to
    :func:`next_turn`. Reads no network; never sees raw PII beyond the local state.
    """
    if state is None or not state.asked_question_ids:
        return None
    # Answer-trumps-clarify (#238 HIGH layer 1): an extractable answer must NEVER be
    # eaten by a clarify false positive — fall through to next_turn, which runs the
    # same detector and records the topic.
    if signals.detect_answered_topics(worker_message_raw):
        return None
    # Bounded clarifies (#238 HIGH layer 2): refuse past the consecutive budget.
    if state.clarify_count >= _MAX_CONSECUTIVE_CLARIFIES:
        return None
    last_id = state.asked_question_ids[-1]
    topic = topic_by_id(role_family, last_id)
    if topic is None:
        return None
    st = state.model_copy(deep=True)
    st.turn_count += 1  # progress advances; the topic itself remains re-askable
    st.clarify_count += 1  # the consecutive-streak counter (next_turn resets it)
    extraction_ready = all(t in st.answered_topics for t in ESSENTIAL_TOPICS)
    return topic.question, last_id, st, extraction_ready


# COST-4: clarification markers — each is an INTERROGATIVE phrase, never a bare word
# that also occurs in a straight answer. Kept deliberately TIGHT because the false-
# positive cost is asymmetric: a false positive spends a real LLM call, while a false
# negative just serves the safe templated question. So filler "matlab" ("matlab main
# VMC chalata hu") does NOT trip it (only "matlab kya"/"kya matlab" do); and the
# say-again markers carry their verb ("repeat kar", "phir se bol") so CNC/VMC domain
# terms — "repeat order", "repeatability", "company chhodi phir se dusri join ki" —
# do NOT match.
_REPHRASE_MARKERS = (
    "matlab kya",
    "kya matlab",
    "samajh nahi",
    "samjha nahi",
    "nahi samjha",
    "samajh nhi",
    "phir se bol",
    "phir se bata",
    "phir se samjha",
    "dobara bol",
    "dubara bol",
    "dobara bata",
    "repeat kar",  # "repeat karo/karna/kariye" — NOT "repeat order" (a domain term)
    "repeat kijiye",
    "kya bola",
    "kya kaha",
    "samjhao",
    "samjha do",
)

# A clarification is SHORT — a worker asking back, not describing their work. A long
# message ending in "?" is an uncertain ANSWER, not a request to rephrase; treating it
# as clarification would waste a real call, so the bare trailing-"?" rule is gated on
# a short word count.
_MAX_CLARIFY_QUESTION_WORDS = 4


def needs_rephrase(message: str) -> bool:
    """COST-4: conservative LOCAL predicate — True only when the worker seems to be
    asking for clarification (a SHORT question back / an explicit confusion phrase),
    the narrow case where a real-mode LLM rephrase of the templated question helps.

    Never calls the network. Kept tight on purpose: the straight-line answer path must
    stay templated-only (zero chat LLM call, zero output tokens), so a false positive
    here is a wasted real call. The rephrase branch is additionally gated by
    ``settings.ai_profiling_rephrase_enabled`` (off by default) + the master real-call
    flag, so this predicate alone never causes a real call.
    """
    m = (message or "").strip().lower()
    if not m:
        return False
    # A SHORT question back ("matlab?", "Fanuc kya?") — not a long answer that happens
    # to end uncertainly ("...5 saal chala hu, theek hai kya?").
    if m.endswith("?") and len(m.split()) <= _MAX_CLARIFY_QUESTION_WORDS:
        return True
    return any(marker in m for marker in _REPHRASE_MARKERS)


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
