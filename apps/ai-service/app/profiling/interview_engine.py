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
#
# Issue #424 (owner ruling 2026-07-18): salary_current / salary_expected /
# availability are the fields payers actually filter on, yet they gated NOTHING —
# a fluent worker whose first message answered role+machines+experience+skills
# could be wrapped up having never been asked about money or notice period. They
# are promoted to MUST_ASK, DELIBERATELY NOT to ESSENTIAL_TOPICS: an essential
# must be ANSWERED, and forcing a worker to disclose their salary before they can
# get a profile is not wanted. The ASK is the obligation; the answer stays theirs
# to give or skip — the same asked-or-answered contract preferred_locations has.
#
# The ids below are the question_bank topic ids VERBATIM (question_bank.py:
# "salary_current", "salary_expected", "availability"). A must-ask id that is not
# in the bank could never be served by _next_topic and would deadlock readiness
# until the ask ceiling tripped — test_every_must_ask_topic_exists_in_the_bank
# pins that.
# Owner ruling 2026-07-22, from a real owner-run session: education and
# certifications were NEVER asked. Not "sometimes skipped" — with a cooperative
# worker they were UNREACHABLE. `education` was the last topic in the bank, and
# readiness was satisfied by the earlier must-asks, so the wrap-up fired before
# _next_topic ever served it. The worker's "ITI kiya hai" was typed and never
# consumed. A worker's ITI could not reach their resume through any path.
#
# Making the LAST bank topic must-ask makes readiness unreachable until the bank
# drains, which is what the owner asked for, and keeps the flip==wrap coupling
# apps/api's autoTriggerExtraction relies on (the snapshot stays complete).
#
# Both stay OUT of ESSENTIAL_TOPICS on purpose, and not for the usual reason: the
# local detector genuinely cannot parse "12th pass" or "NCVT certificate hai", so
# as essentials they would burn the re-ask budget and then ship a FALSE
# unanswered_essentials for a worker who answered perfectly well. The value
# reaches the rich draft via the transcript, which is where it is consumed.
MUST_ASK_TOPICS: tuple[str, ...] = (
    "preferred_locations",
    "salary_current",
    "salary_expected",
    "availability",
    "education",
    "certifications",
)

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

# Final backstop, counted in ENGINE ASKS — deliberately NOT in turns.
#
# The first cut of this ceiling counted ``turn_count`` at 15, with a blind run
# needing EXACTLY 15 asks: zero headroom. ``clarify_turn`` also increments
# ``turn_count`` while serving NO new topic, so every "matlab kya?" deleted one
# topic from the TAIL of the interview — a worker who re-read the same question
# once never got asked ``education``; six times and ``preferred_locations`` (the
# sole MUST_ASK) was never asked either. That is a silent coverage regression, so
# the budget is now spent in ASKS: ``sum(ask_counts.values())`` is monotonic,
# incremented ONLY where a question is actually served, and therefore immune to
# clarify turns by construction.
#
# Sized with real headroom over the current bank's blind-run budget (4 essentials
# x MAX_ASKS_PER_TOPIC + 7 ask-once topics = 15). test_interview_engine.py pins
# that budget against this constant, so the zero-margin coupling cannot silently
# come back if the bank grows.
MAX_ENGINE_ASKS = 20

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


def _served_question(topic: Topic, ask_number: int) -> str:
    """The exact wording served for ``topic`` on its ``ask_number``-th ask.

    Single source of truth for "which string did the worker actually see", so
    :func:`next_turn` (which serves it) and :func:`clarify_turn` (which RE-serves
    it) can never disagree — re-serving the ORIGINAL wording after the retry
    wording was shown reads as the bot going backwards.
    """
    if ask_number > 1 and topic.retry_question:
        return topic.retry_question
    return topic.question


def _may_commit(
    st: ConversationState,
    topic_id: str,
    last_asked: str | None,
    correcting: bool,
) -> bool:
    """P1-1 — THE OVERWRITE RULE. May this detected value be written to
    ``st.collected[topic_id]``?

    THE DEFECT it fixes: every detected value used to be assigned unconditionally,
    so an INCIDENTAL later mention silently replaced an established one. Answer the
    experience question with "10 saal", then answer the EDUCATION question with
    "ITI aur 3 saal apprenticeship", and the ten-year machinist shipped as a
    three-year one — on their resume, with no trace.

    The rule, in priority order:

    1. **The topic being asked always commits.** ``topic_id == last_asked`` is the
       DELIBERATE answer to the question on screen — including the engine's one
       bounded re-ask, where a second, better answer must be able to replace the
       first. (Detection is what makes this attributable: ``detect_answered_topics``
       already takes ``last_asked``.)
    2. **An explicit correction commits.** ``signals.is_correction`` ("nahi nahi,
       10 saal", "galat bola", "sorry, 5 saal") — the worker is overriding on
       purpose, whatever question is on screen.
    3. **Otherwise: first write wins.** A cross-topic signal picked up in passing
       may FILL an empty slot (that is free information) but may never overwrite one
       the worker already established.

    KNOWN LIMIT (stated, not hidden): an unmarked change of mind about a topic that
    is NOT the one being asked ("waise 12 saal ho gaye" while answering education)
    is IGNORED rather than applied. That is the deliberate direction — a stale but
    worker-stated value beats a silently rewritten one, and the confirm step is
    where a worker fixes it.
    """
    if topic_id == last_asked or correcting:
        return True
    return topic_id not in st.collected


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
    correcting = signals.is_correction(worker_message_raw)
    for topic_id, value in signals.detect_answered_topics(
        worker_message_raw, last_asked
    ).items():
        if topic_id not in st.answered_topics:
            st.answered_topics.append(topic_id)
        if value is None:
            # P1-2: a DENIAL ("ITI nahi kiya") answers the ask without producing a
            # value — mark the topic answered, collect nothing.
            continue
        if _may_commit(st, topic_id, last_asked, correcting):
            st.collected[topic_id] = value

    extraction_ready = _extraction_ready(st)
    # INTERVIEW-1 completeness signal: refresh the gap list on EVERY turn, so the
    # state a caller persists always describes the interview as it actually stands.
    st.unanswered_essentials = _unanswered_essentials(st)

    # 2. Choose the next question (essentials first — including their ONE bounded
    #    re-ask — then the ask-once topics). The backstops are the final word: past
    #    either one we wrap up no matter what is still open.
    #
    #    The ASK budget is the meaningful ceiling — it only counts turns on which a
    #    question was actually served, so clarify turns can never consume it and
    #    starve the tail of the interview. MAX_INTERVIEW_TURNS is a second,
    #    deliberately slack guard against a caller looping next_turn forever.
    # Clamped per value for the same reason as _ask_count: a stored negative must
    # not be able to buy extra asks by dragging the total down.
    engine_asks = sum(max(0, n) for n in st.ask_counts.values())
    over_ceiling = engine_asks >= MAX_ENGINE_ASKS or st.turn_count > MAX_INTERVIEW_TURNS
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
    question = _served_question(next_topic, prior_asks + 1)
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

# Slack outer guard against a caller looping next_turn forever. DERIVED, not
# guessed: between two engine asks a worker can spend at most
# _MAX_CONSECUTIVE_CLARIFIES clarify turns (the next one falls through to
# next_turn), so the worst-case turn count is the ask budget times one ask plus its
# clarifies. Writing the relationship down is the point — the previous flat 15 hid
# exactly this coupling and silently truncated the interview.
MAX_INTERVIEW_TURNS = MAX_ENGINE_ASKS * (1 + _MAX_CONSECUTIVE_CLARIFIES)


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
    where the mock reply is the last asked question AS IT WAS SERVED — if that topic
    was on its bounded RE-ask, the worker saw ``retry_question``, so that is what is
    re-served (re-derived from ``ask_counts`` via :func:`_served_question`). Replying
    to "matlab kya?" with the ORIGINAL, earlier wording reads as going backwards. The
    updated state is
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
    # Re-serve the wording the worker ACTUALLY saw. ask_counts is not incremented:
    # a clarify is not a new ask, and the ask budget must stay clarify-immune.
    return (
        _served_question(topic, _ask_count(state, last_id)),
        last_id,
        st,
        _extraction_ready(st),
    )


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

    The value is also CLAMPED at 0. ``contracts.py`` types this as a non-negative
    strict int, but a ``ConversationState`` can be mutated in-process after
    validation (``model_copy`` does not re-validate), and a stored ``-1`` would
    otherwise buy extra asks and defeat the bound outright — the safety property
    must not depend on the caller having validated.
    """
    counted = max(0, st.ask_counts.get(topic_id, 0))
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
       Non-essential topics are asked ONCE and never re-asked — the
       :data:`MUST_ASK_TOPICS` (``preferred_locations``, ``salary_current``,
       ``salary_expected``, ``availability``) only need the ASK to satisfy the
       readiness gate, so one serve each is enough.

    This is also WHY the gate is enforceable: any must-ask topic that is neither
    answered nor asked has ``_ask_count == 0``, so branch 2 or 3 necessarily
    returns it. ``_next_topic`` therefore cannot return None while a must-ask is
    still unraised — only the ask/turn ceiling in :func:`next_turn` can end the
    interview before then, and :data:`MAX_ENGINE_ASKS` is sized above the bank's
    worst-case blind run precisely so that cannot happen.

    Two invariants hold in EVERY branch:

    - **An ANSWERED topic is never returned.** Absolute — every branch tests
      ``topic.id not in st.answered_topics``.
    - **No topic is ever returned once it has been asked**
      :data:`MAX_ASKS_PER_TOPIC` **times**, whatever the detector does. The bound
      is a pure function of :func:`_ask_count` — which clamps at 0, so it holds for
      every input the state can carry, not just validated ones — so a detector that
      never reports an answer (welding today) still terminates the interview.
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
