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

# The topics that MUST be ANSWERED before we offer extraction. Current location
# is essential for matching, so it is required (not just "any N core topics").
# B-4 (context-drift register 2026-07-16 row B-4; owner ruling 2026-07-17):
# location is split — current_location stays answer-essential.
ESSENTIAL_TOPICS: tuple[str, ...] = ("role", "machines", "experience", "current_location")

# B-4: topics that MUST at least have been ASKED (or answered) before extraction
# is offered. preferred_locations gets its own ask per the owner ruling
# ("current AND preferred — do not conflate"), but the schema keeps it optional
# (contracts.py: list, default []) — so a worker with no preference is not
# blocked forever: the ASK satisfies the gate, an answer is not required.
MUST_ASK_TOPICS: tuple[str, ...] = ("preferred_locations",)

# INTERVIEW-1 re-ask bound. THIS CONSTANT IS THE SAFETY PROPERTY of the re-ask
# feature — do not remove it or make it conditional.
#
# Before INTERVIEW-1 a topic was closed the moment it was ASKED, so an essential
# the worker never actually answered silently shipped an incomplete profile. The
# fix re-asks it — but "answered" is judged by ``signals.detect_answered_topics``,
# whose gazetteer is CNC/VMC-only (welding/TIG/MIG are out of scope there). An
# UNBOUNDED re-ask would therefore loop a welder giving a PERFECT answer forever.
# So the re-ask is hard-capped at this many ASKS PER TOPIC, counted in
# ``ConversationState.ask_counts`` — the bound holds even if the detector is
# TOTALLY BLIND (tests/test_interview_engine.py locks that with a stubbed detector).
MAX_ASKS_PER_TOPIC = 2

# Final backstop: the hard ceiling on question-serving turns. Even if a future
# topic set + a detection gap conspired, the interview cannot run past this — turn
# MAX_INTERVIEW_TURNS + 1 wraps up unconditionally. Sized so a fully BLIND run
# still serves every essential its 2 asks and every other topic its 1 ask.
MAX_INTERVIEW_TURNS = 15

# In-flight ConversationStates minted before the B-4/B-5 split may carry the
# retired combined topic ids. Map them to the topic their context-free detection
# actually keyed on (detect() puts the FIRST city in current_city and a cue-less
# amount in current_salary), so the worker is not re-asked what they answered —
# and preferred_locations, never asked under the old bank, now gets its ask.
_LEGACY_TOPIC_IDS: dict[str, str] = {
    "location": "current_location",
    "salary": "salary_current",
}


def _normalize_legacy_ids(ids: list[str]) -> None:
    """In-place rewrite of retired combined topic ids (de-duplicating)."""
    for i, topic_id in enumerate(ids):
        mapped = _LEGACY_TOPIC_IDS.get(topic_id)
        if mapped is not None:
            ids[i] = mapped
    seen: set[str] = set()
    ids[:] = [t for t in ids if not (t in seen or seen.add(t))]


def _extraction_ready(st: ConversationState) -> bool:
    """All ESSENTIAL_TOPICS answered AND every MUST_ASK topic asked-or-answered."""
    if not all(t in st.answered_topics for t in ESSENTIAL_TOPICS):
        return False
    return all(
        t in st.answered_topics or t in st.asked_question_ids for t in MUST_ASK_TOPICS
    )


def _unanswered_essentials(st: ConversationState) -> list[str]:
    """INTERVIEW-1: which ESSENTIAL topics the worker never actually answered.

    This is the EXPLICIT completeness signal. ``extraction_ready`` deliberately
    stays "the interview is over — run extraction" (its frozen v1 meaning, and the
    sole gate on extraction downstream), so this list — not that flag — is how an
    incomplete profile is declared. Empty list = every essential answered.

    Returned in ESSENTIAL_TOPICS order, so it is stable/comparable across turns.
    Topic ids only, never PII.
    """
    return [t for t in ESSENTIAL_TOPICS if t not in st.answered_topics]

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
    # B-4/B-5 compat: states minted under the old bank carry the retired combined
    # topic ids ("location"/"salary") — map them before progress/readiness logic.
    _normalize_legacy_ids(st.answered_topics)
    _normalize_legacy_ids(st.asked_question_ids)

    # 1. Update progress from what the worker just said. The last ASKED topic is
    #    passed so the detector attributes the answer to the question actually
    #    asked (B-4: a city answering the preferred-locations question is a
    #    preference, not a current location).
    last_asked = st.asked_question_ids[-1] if st.asked_question_ids else None
    for topic_id, value in signals.detect_answered_topics(
        worker_message_raw, last_asked
    ).items():
        if topic_id not in st.answered_topics:
            st.answered_topics.append(topic_id)
        if value is not None:
            st.collected[topic_id] = value

    extraction_ready = _extraction_ready(st)
    # INTERVIEW-1 completeness signal: refresh the gap list on EVERY turn, so the
    # state a caller persists always describes the interview as it actually stands.
    st.unanswered_essentials = _unanswered_essentials(st)

    # 2. Choose the next question (essentials first — including their ONE bounded
    #    re-ask — then the ask-once topics). MAX_INTERVIEW_TURNS is the final
    #    backstop: past it we wrap up no matter what is still open.
    over_ceiling = st.turn_count > MAX_INTERVIEW_TURNS
    next_topic = None if over_ceiling else _next_topic(topics, st)
    if next_topic is None or extraction_ready:
        # extraction_ready keeps its ORIGINAL v1 meaning here: "the interview is
        # OVER — run extraction". It is deliberately True even when essentials are
        # still unanswered, for two reasons:
        #
        # 1. It is the SOLE gate on the profile.extraction_ready event downstream
        #    (chat.service.ts), so returning False would mean an incomplete
        #    interview yields NO profile and NO resume at all — strictly worse than
        #    the bug INTERVIEW-1 fixes, and it would hit hardest exactly the worker
        #    the detector fails (a welder whose "TIG aur MIG" cannot be parsed).
        # 2. Changing WHEN a frozen v1 signal fires is a behavioural change to a
        #    shipped contract (CLAUDE.md §2 #8), even with the payload untouched.
        #
        # Incompleteness is instead reported EXPLICITLY and additively via
        # st.unanswered_essentials, so a role: null resume is a KNOWN, inspectable
        # outcome rather than a silent surprise.
        return _vocative(worker_name) + _WRAP_UP, None, st, True

    # Read the prior count BEFORE touching asked_question_ids — _ask_count floors at
    # 1 for anything already in that list (the pre-INTERVIEW-1 back-compat path), so
    # appending first would score a topic's FIRST ask as its second.
    prior_asks = _ask_count(st, next_topic.id)
    st.ask_counts[next_topic.id] = prior_asks + 1
    if next_topic.id not in st.asked_question_ids:
        st.asked_question_ids.append(next_topic.id)
    # A RE-ask uses the narrower, more concrete wording — re-serving the identical
    # string reads as broken (and the concrete examples help the detector).
    question = (
        next_topic.retry_question
        if prior_asks and next_topic.retry_question
        else next_topic.question
    )
    # Turn 1 is the OPEN vocative slot: greet by name/token, then the first
    # question (no ack — the greeting IS the opener). Later turns ack only.
    if st.turn_count == 1:
        return _vocative(worker_name) + question, next_topic.id, st, extraction_ready
    return _ACK + question, next_topic.id, st, extraction_ready


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
    last_id = state.asked_question_ids[-1]
    # Answer-trumps-clarify (#238 HIGH layer 1): an extractable answer must NEVER be
    # eaten by a clarify false positive — fall through to next_turn, which runs the
    # same detector (with the same last-asked attribution) and records the topic.
    if signals.detect_answered_topics(worker_message_raw, last_id):
        return None
    # Bounded clarifies (#238 HIGH layer 2): refuse past the consecutive budget.
    if state.clarify_count >= _MAX_CONSECUTIVE_CLARIFIES:
        return None
    topic = topic_by_id(role_family, last_id)
    if topic is None:
        return None
    st = state.model_copy(deep=True)
    st.turn_count += 1  # progress advances; the topic itself remains re-askable
    st.clarify_count += 1  # the consecutive-streak counter (next_turn resets it)
    return topic.question, last_id, st, _extraction_ready(st)


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


def _ask_count(st: ConversationState, topic_id: str) -> int:
    """How many times ``topic_id`` has been ASKED, safe for pre-INTERVIEW-1 states.

    In-flight states minted before ``ask_counts`` existed have a populated
    ``asked_question_ids`` and an EMPTY ``ask_counts``. Reading 0 there would hand
    such a topic a fresh full budget (up to 3 asks total), so a topic already in
    ``asked_question_ids`` floors at 1 — the bound errs toward asking LESS, never
    more, which is the safe direction for an anti-loop guard.
    """
    counted = st.ask_counts.get(topic_id, 0)
    if counted == 0 and topic_id in st.asked_question_ids:
        return 1
    return counted


def _next_topic(topics: list[Topic], st: ConversationState) -> Topic | None:
    """Pick the next topic to serve, in STRICT priority order.

    1. An UNANSWERED **essential** under :data:`MAX_ASKS_PER_TOPIC` — first ask or
       the single bounded re-ask. This is the INTERVIEW-1 fix: before it, a topic
       was closed forever the moment it was asked, so an essential the worker never
       answered silently shipped an incomplete profile.
    2. Any other unanswered topic that has NEVER been asked (core before optional).
       Non-essential topics are asked ONCE and never re-asked —
       ``preferred_locations`` in particular only needs the ASK to satisfy
       :data:`MUST_ASK_TOPICS`.

    Two invariants hold in EVERY branch:

    - **An ANSWERED topic is never returned.** Absolute — every branch tests
      ``topic.id not in st.answered_topics``.
    - **No topic is ever returned once it has been asked**
      :data:`MAX_ASKS_PER_TOPIC` **times**, whatever the detector does. The bound
      is a pure function of ``ask_counts``, so a detector that never reports an
      answer (welding today) still terminates the interview.
    """
    # 1. Unanswered ESSENTIAL topics — the only re-askable class.
    for topic in topics:
        if (
            topic.id in ESSENTIAL_TOPICS
            and topic.id not in st.answered_topics
            and _ask_count(st, topic.id) < MAX_ASKS_PER_TOPIC
        ):
            return topic
    # 2. Unanswered core topics we haven't already asked (ask-once).
    for topic in topics:
        is_open = topic.id not in st.answered_topics and _ask_count(st, topic.id) == 0
        if topic.core and is_open:
            return topic
    # 3. Unanswered optional topics we haven't already asked (ask-once).
    for topic in topics:
        if topic.id not in st.answered_topics and _ask_count(st, topic.id) == 0:
            return topic
    return None
