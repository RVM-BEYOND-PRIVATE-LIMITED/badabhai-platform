"""Job-posting interview engine — the DETERMINISTIC core (ADR-0035).

Tracks which topics the payer has answered and chooses the next question. The
assistant reply IS the engine-chosen question: no model is consulted about WHAT to
ask, in what order, or whether the draft is ready (invariant #4 — LLMs assist, they
never decide). The only place a model may ever appear on this path is rephrasing an
already-chosen question, and that seam is documented in ``prompts.py``.

Answer detection reads the payer's message LOCALLY via :mod:`answers` (no network),
so the engine sees a city or a pay figure that is correctly masked before any LLM
call would happen.

A SIBLING of ``app/profiling/interview_engine.py``, not a parameterization of it —
same proven shape (topic bank, strict ``_next_topic`` priority, MAX_ASKS_PER_TOPIC,
a MAX_ENGINE_ASKS ceiling counted in ASKS, a bounded ``clarify_turn``), zero shared
code, and no import of ``app.profiling``.
"""

from __future__ import annotations

from ..contracts import JobPostingChatState, JobPostingDraft
from . import answers
from .question_bank import (
    Topic,
    opening_message_for,
    options_for,
    topic_by_id,
    topics_for,
)

# Professional, two words, no praise. The payer is a customer filling a form, not a
# candidate being encouraged.
_ACK = "Got it. "
_WRAP_UP = (
    "That's everything I need. Your job posting draft is ready — review it and "
    "publish when it looks right."
)

# Topics that MUST be ANSWERED before the draft is offered as ready. These are the
# three the publish path genuinely cannot do without:
#
# - role_title  — REQUIRED by PayerCreateJobPostingSchema.
# - vacancy     — REQUIRED by PayerCreateJobPostingSchema (as a band; ADR-0012).
# - location_label — optional in the DTO, essential in PRACTICE: a posting with no
#   city cannot be shown usefully to a worker, and the whole point of the chat is to
#   stop a payer shipping a blank field they would have skipped on the form.
ESSENTIAL_TOPICS: tuple[str, ...] = ("role_title", "location_label", "vacancy")

# Topics that must at least have been ASKED (asked-or-answered) before the draft is
# offered as ready. This is the issue-#424 lesson from the worker engine, pointed the
# other way: pay/shift/benefits are exactly what a WORKER filters on, so a payer must
# be ASKED for them — but forcing an answer would block a posting on a field the DTO
# does not even carry. The ask is the obligation; the answer stays the payer's to give.
#
# `description` is last in the bank AND must-ask on purpose: making the final topic
# must-ask means readiness cannot be reached until the bank drains, which is what
# stops a fluent payer being wrapped up before the optional half is ever raised.
MUST_ASK_TOPICS: tuple[str, ...] = (
    "skills",
    "pay_range",
    "shift",
    "benefits",
    "requirements",
    "description",
)

# THE SAFETY PROPERTY of the re-ask. "Answered" is judged by a local parser, and a
# parser can be wrong; an UNBOUNDED re-ask would loop a payer who is answering
# perfectly well in a phrasing we cannot read. So a topic is asked at most this many
# times, counted in ``JobPostingChatState.ask_counts`` — the bound holds even if
# detection is TOTALLY BLIND (the test suite locks that with a stubbed detector).
MAX_ASKS_PER_TOPIC = 2

# Final backstop, counted in ENGINE ASKS — deliberately NOT in turns, because
# ``clarify_turn`` advances ``turn_count`` while serving no new topic, so a
# turn-based budget would let a confused payer silently delete topics from the TAIL
# of the interview. ``sum(ask_counts.values())`` only ever grows where a question is
# actually served, so it is clarify-immune by construction.
#
# Sized with real headroom over the bank's worst-case blind run: 3 essentials x
# MAX_ASKS_PER_TOPIC (= 6) + 6 ask-once topics = 12. The test suite pins that budget
# against this constant, so the zero-margin coupling cannot silently reappear if the
# bank grows.
MAX_ENGINE_ASKS = 16

# Max CONSECUTIVE re-serves of one question. ``needs_rephrase`` has false-positive
# classes, so an unbounded re-serve could loop forever; past this the turn falls
# through to :func:`next_turn` and the interview moves on.
_MAX_CONSECUTIVE_CLARIFIES = 2

# Slack outer guard against a caller looping next_turn forever. DERIVED, not guessed:
# between two engine asks a payer can spend at most _MAX_CONSECUTIVE_CLARIFIES
# clarify turns, so the worst case is the ask budget times one ask plus its clarifies.
MAX_INTERVIEW_TURNS = MAX_ENGINE_ASKS * (1 + _MAX_CONSECUTIVE_CLARIFIES)

# The opener (question_bank.OPENING_MESSAGE) already asks the bank's FIRST question,
# so the payer's first message is attributed to that topic. It is NOT marked asked —
# attribution only. If the answer does not parse, the topic is still served normally
# with its full ask budget, exactly as if the opener had never run.
#
# The worker engine's opener "records nothing" for a measured reason (seeding
# asked_question_ids wrapped the interview on turn 1 with every must-ask silently
# unraised). Attribution-without-recording keeps that property: nothing is marked
# asked or answered here, only READ.
def _opener_topic_id(trade_hint: str | None) -> str:
    return topics_for(trade_hint)[0].id


def opening_message(trade_hint: str | None = None) -> str:
    """The opening line. Pure: takes no state and returns none.

    Carries no vocative, no payer name and no organisation name — which is what
    makes the opening endpoint PII-free by construction, not by convention.
    """
    return opening_message_for(trade_hint)


def _ask_count(st: JobPostingChatState, topic_id: str) -> int:
    """How many times ``topic_id`` has been ASKED.

    CLAMPED at 0: a state can be mutated in-process after validation (``model_copy``
    does not re-validate) and arrives as jsonb from the database, so a stored ``-1``
    would otherwise buy extra asks and defeat the bound outright. The safety property
    must not depend on the caller having validated. A topic already present in
    ``asked_question_ids`` floors at 1, so a state persisted before ``ask_counts``
    existed cannot hand a topic a fresh budget — the bound errs toward asking LESS.
    """
    counted = max(0, st.ask_counts.get(topic_id, 0))
    if counted == 0 and topic_id in st.asked_question_ids:
        return 1
    return counted


def _served_question(topic: Topic, ask_number: int) -> str:
    """The exact wording served for ``topic`` on its ``ask_number``-th ask.

    One source of truth for "which string did the payer actually see", so
    :func:`next_turn` (which serves it) and :func:`clarify_turn` (which RE-serves it)
    can never disagree — re-serving the ORIGINAL wording after the retry wording was
    shown reads as the assistant going backwards.
    """
    if ask_number > 1 and topic.retry_question:
        return topic.retry_question
    return topic.question


def _may_commit(
    st: JobPostingChatState, topic_id: str, last_asked: str | None, correcting: bool
) -> bool:
    """THE OVERWRITE RULE. May this detected value be written to ``collected``?

    1. **The topic being asked always commits** — it is the deliberate answer to the
       question on screen, including the bounded re-ask where a second, better answer
       must be able to replace the first.
    2. **An explicit correction commits** ("actually, make that 5") — the payer is
       overriding on purpose, whatever question is on screen.
    3. **Otherwise: first write wins.** A cross-topic signal picked up in passing may
       FILL an empty slot (free information) but may never overwrite one the payer
       already established. Without this, mentioning "we pay night shift allowance"
       while answering the benefits question would rewrite an established shift.
    """
    if topic_id == last_asked or correcting:
        return True
    return topic_id not in st.collected


def _unanswered_essentials(st: JobPostingChatState) -> list[str]:
    """Which ESSENTIAL topics the payer never actually answered, in a stable order.

    The EXPLICIT completeness signal. Topic ids only, never values.
    """
    return [t for t in ESSENTIAL_TOPICS if t not in st.answered_topics]


def _draft_ready(st: JobPostingChatState) -> bool:
    """All ESSENTIAL topics answered AND every MUST_ASK topic asked-or-answered."""
    if not all(t in st.answered_topics for t in ESSENTIAL_TOPICS):
        return False
    return all(t in st.answered_topics or t in st.asked_question_ids for t in MUST_ASK_TOPICS)


def _next_topic(topics: list[Topic], st: JobPostingChatState) -> Topic | None:
    """Pick the next topic to serve, in STRICT priority order.

    1. An UNANSWERED **essential** under :data:`MAX_ASKS_PER_TOPIC` — its first ask
       or its single bounded re-ask.
    2. Any other unanswered **core** topic never asked (ask-once).
    3. Any other unanswered **optional** topic never asked (ask-once).

    Two invariants hold in EVERY branch:

    - **An ANSWERED topic is never returned.** Every branch tests
      ``topic.id not in st.answered_topics``.
    - **No topic is returned once asked** :data:`MAX_ASKS_PER_TOPIC` **times**,
      whatever detection does — the bound is a pure function of :func:`_ask_count`,
      which clamps at 0, so it holds for every state, not just validated ones.

    This is also why the must-ask gate is enforceable: a must-ask topic that is
    neither answered nor asked has ``_ask_count == 0``, so branch 2 or 3 necessarily
    returns it. ``_next_topic`` therefore cannot return None while a must-ask is
    unraised; only the ask ceiling can end the interview first, and
    :data:`MAX_ENGINE_ASKS` is sized above the bank's worst-case blind run so it does
    not.
    """
    for topic in topics:
        if (
            topic.id in ESSENTIAL_TOPICS
            and topic.id not in st.answered_topics
            and _ask_count(st, topic.id) < MAX_ASKS_PER_TOPIC
        ):
            return topic
    for topic in topics:
        if topic.core and topic.id not in st.answered_topics and _ask_count(st, topic.id) == 0:
            return topic
    for topic in topics:
        if topic.id not in st.answered_topics and _ask_count(st, topic.id) == 0:
            return topic
    return None


def next_turn(
    state: JobPostingChatState | None,
    payer_message_raw: str,
    trade_hint: str | None = None,
    draft_text: str | None = None,
) -> tuple[str, str | None, JobPostingChatState, bool]:
    """Advance the interview by one turn.

    Returns ``(assistant_message, asked_question_id, updated_state, draft_ready)``.

    ``draft_text`` is the text the DRAFT is allowed to keep — identical to
    ``payer_message_raw`` unless this turn's pseudonymization masked an
    identity-class entity, in which case the caller passes the masked text
    (``answers.safe_draft_text``) and that is what gets recorded. It defaults to the
    raw message so the engine stays usable as a pure unit.
    """
    topics = topics_for(trade_hint)
    st = (
        state.model_copy(deep=True)
        if state is not None
        else JobPostingChatState(trade_hint=trade_hint)
    )
    st.trade_hint = trade_hint
    st.turn_count += 1
    # Any engine advance ends a clarify streak — the counter only grows inside
    # clarify_turn (consecutive re-serves of one question).
    st.clarify_count = 0

    recorded_text = payer_message_raw if draft_text is None else draft_text

    # 1. Update progress from what the payer just said. The last ASKED topic is
    #    passed so the answer is attributed to the question actually on screen. On the
    #    very first turn nothing has been asked yet but the OPENER asked the bank's
    #    first question, so that topic is the attribution target (read-only — it is
    #    not marked asked).
    last_asked = st.asked_question_ids[-1] if st.asked_question_ids else None
    if last_asked is None and st.turn_count == 1:
        last_asked = _opener_topic_id(trade_hint)
    correcting = answers.is_correction(payer_message_raw)
    for topic_id, value in answers.detect_answers(recorded_text, last_asked).items():
        if topic_id not in st.answered_topics:
            st.answered_topics.append(topic_id)
        if value is None:
            # An explicit refusal ("no benefits") answers the ask without producing a
            # value — the topic is closed, nothing is collected.
            continue
        may_commit = _may_commit(st, topic_id, last_asked, correcting)
        existing = st.collected.get(topic_id)
        if isinstance(value, list) and isinstance(existing, list):
            # Successive partial answers ACCUMULATE ("PF, ESI" then "canteen"); a
            # correction REPLACES. Deduped case-insensitively, first spelling wins.
            if may_commit and correcting:
                st.collected[topic_id] = value
            else:
                union = list(existing)
                seen = {str(item).strip().lower() for item in union}
                for item in value:
                    key = str(item).strip().lower()
                    if key not in seen:
                        seen.add(key)
                        union.append(item)
                st.collected[topic_id] = union
        elif may_commit:
            st.collected[topic_id] = value

    draft_ready = _draft_ready(st)
    # Refresh the completeness signal on EVERY turn, so a persisted state always
    # describes the interview as it actually stands.
    st.unanswered_essentials = _unanswered_essentials(st)

    # 2. Choose the next question. The backstops are the final word: past either one
    #    we wrap up no matter what is still open. Clamped per value for the same
    #    reason as _ask_count — a stored negative must not buy extra asks by dragging
    #    the total down.
    engine_asks = sum(max(0, n) for n in st.ask_counts.values())
    over_ceiling = engine_asks >= MAX_ENGINE_ASKS or st.turn_count > MAX_INTERVIEW_TURNS
    next_topic = None if over_ceiling else _next_topic(topics, st)
    if next_topic is None or draft_ready:
        # draft_ready means "the interview is over". It can be True with essentials
        # still unanswered ONLY via the ceiling path; the gap is then declared in
        # st.unanswered_essentials, and the publish step re-validates against
        # PayerCreateJobPostingSchema, so an incomplete draft cannot become a posting.
        return _WRAP_UP, None, st, True

    # Read the prior count BEFORE touching asked_question_ids — _ask_count floors at 1
    # for anything already in that list, so appending first would score a topic's
    # FIRST ask as its second.
    prior_asks = _ask_count(st, next_topic.id)
    st.ask_counts[next_topic.id] = prior_asks + 1
    if next_topic.id not in st.asked_question_ids:
        st.asked_question_ids.append(next_topic.id)
    question = _served_question(next_topic, prior_asks + 1)
    if st.turn_count == 1:
        return question, next_topic.id, st, draft_ready
    return _ACK + question, next_topic.id, st, draft_ready


def clarify_turn(
    state: JobPostingChatState | None,
    payer_message_raw: str,
    trade_hint: str | None = None,
) -> tuple[str, str, JobPostingChatState, bool] | None:
    """RE-SERVE the last asked question instead of advancing.

    A clarifying message ("what do you mean?") is not an answer — running
    :func:`next_turn` on it would advance the engine (the confusing topic lands in
    ``asked_question_ids`` and ``_next_topic`` then skips it FOREVER, essentials
    included).

    TWO guards keep this path from EATING answers, because ``needs_rephrase`` has
    false-positive classes:

    - **Answer-trumps-clarify**: if :func:`answers.detect_answers` finds any
      extractable signal (the same detector and the same ``last_asked`` attribution
      :func:`next_turn` uses), this returns None — a short "?"-suffixed answer
      ("Night?", "2-5?") always advances the engine.
    - **Bounded clarifies**: at most :data:`_MAX_CONSECUTIVE_CLARIFIES` consecutive
      re-serves, so the interview can never loop on one question.

    Returns the SAME tuple shape as :func:`next_turn`, where the reply is the last
    asked question AS IT WAS SERVED (re-derived from ``ask_counts``, so a topic on its
    bounded re-ask re-serves the retry wording, not the older original). The state
    advances ``turn_count`` + ``clarify_count`` ONLY — the topic stays re-askable and
    answerable, and ``ask_counts`` is untouched so the ask budget stays clarify-immune.
    Returns None when there is nothing re-servable; the caller falls through to
    :func:`next_turn`.
    """
    if state is None or not state.asked_question_ids:
        return None
    last_id = state.asked_question_ids[-1]
    if answers.detect_answers(payer_message_raw, last_id):
        return None
    if state.clarify_count >= _MAX_CONSECUTIVE_CLARIFIES:
        return None
    topic = topic_by_id(last_id, trade_hint)
    if topic is None:
        return None
    st = state.model_copy(deep=True)
    st.turn_count += 1  # progress advances; the topic itself remains re-askable
    st.clarify_count += 1
    return (
        _served_question(topic, _ask_count(state, last_id)),
        last_id,
        st,
        _draft_ready(st),
    )


def needs_rephrase(message: str) -> bool:
    """Local, network-free predicate: is the payer asking us to clarify?"""
    return answers.needs_rephrase(message)


def suggested_answers(asked_question_id: str | None, trade_hint: str | None = None) -> list[str]:
    """Tap-to-answer chips for the question being served THIS turn.

    ANSWERS to ``asked_question_id``, never questions — a tapped chip is sent
    verbatim as the payer's message, which makes the label their answer of record.
    ``None`` (the wrap-up turn) yields ``[]``: nothing was asked, so there is nothing
    to offer options for.
    """
    return options_for(asked_question_id, trade_hint)


# --- Draft assembly --------------------------------------------------------
def _as_str(value: object, cap: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text[:cap] if text else None


def _as_phrases(value: object, cap: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip()[:80])
        if len(out) >= cap:
            break
    return out


def _as_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def build_draft(
    state: JobPostingChatState | None, trade_hint: str | None = None
) -> JobPostingDraft:
    """Project the collected answers onto the publishable draft shape.

    DEFENSIVE BY CONTRACT, not by taste: ``collected`` round-trips through a jsonb
    column, so every value is treated as untrusted — a malformed stored state yields
    an emptier draft, never an exception. A 500 here would strand a payer's whole
    session.

    There is no ``org_label``: it is stamped server-side at publish from
    ``payers.orgNameEnc`` and is never asked for (ADR-0035 §Decision 3).
    """
    st = state or JobPostingChatState(trade_hint=trade_hint)
    collected = st.collected if isinstance(st.collected, dict) else {}

    pay = collected.get("pay_range")
    pay_min = _as_int(pay.get("pay_min")) if isinstance(pay, dict) else None
    pay_max = _as_int(pay.get("pay_max")) if isinstance(pay, dict) else None
    if pay_min is not None and pay_max is not None and pay_max < pay_min:
        pay_min, pay_max = pay_max, pay_min

    band = collected.get("vacancy")
    shift = collected.get("shift")
    draft = JobPostingDraft(
        role_title=_as_str(collected.get("role_title"), answers.LABEL_MAX),
        skills=_as_phrases(collected.get("skills"), answers.MAX_SKILLS),
        location_label=_as_str(collected.get("location_label"), answers.LABEL_MAX),
        vacancy_band=band if band in answers.VACANCY_BANDS else None,  # type: ignore[arg-type]
        pay_min=pay_min,
        pay_max=pay_max,
        shift=shift if shift in ("day", "night", "rotational") else None,  # type: ignore[arg-type]
        benefits=_as_phrases(collected.get("benefits"), answers.MAX_PHRASES),
        requirements=_as_phrases(collected.get("requirements"), answers.MAX_PHRASES),
        description=_as_str(collected.get("description"), answers.DESCRIPTION_MAX),
    )

    topics = topics_for(trade_hint)
    filled = {
        "role_title": draft.role_title is not None,
        "skills": bool(draft.skills),
        "location_label": draft.location_label is not None,
        "vacancy": draft.vacancy_band is not None,
        "pay_range": draft.pay_min is not None,
        "shift": draft.shift is not None,
        "benefits": bool(draft.benefits),
        "requirements": bool(draft.requirements),
        "description": draft.description is not None,
    }
    draft.missing_fields = [t.id for t in topics if not filled.get(t.id, False)]
    # A deterministic coverage ratio — NOT a model score, and never an input to
    # ranking or to the publish decision (invariant #4).
    draft.confidence = round(sum(1 for t in topics if filled.get(t.id, False)) / len(topics), 2)
    draft.clarification_questions = _clarification_questions(st, draft, trade_hint)
    return draft


_MAX_CLARIFICATION_QUESTIONS = 4


def _clarification_questions(
    st: JobPostingChatState, draft: JobPostingDraft, trade_hint: str | None
) -> list[str]:
    """What the payer still needs to fix, in their own UI.

    Two sources, both derived — nothing extra is stored on the state:

    1. Essentials the interview could not fill (the bank's retry wording).
    2. Any field whose stored value carries a pseudonymization placeholder — the
       payer typed identity-shaped content there, so the masked text was stored and
       they must retype it. Derived by SCANNING the draft, so it can never drift out
       of sync with what was actually recorded. Names the FIELD, never the content.
    """
    questions: list[str] = []
    for topic_id in _unanswered_essentials(st):
        topic = topic_by_id(topic_id, trade_hint)
        if topic is not None:
            questions.append(topic.retry_question or topic.question)

    redacted: list[str] = []
    for topic in topics_for(trade_hint):
        value = st.collected.get(topic.id)
        texts = value if isinstance(value, list) else [value]
        if any(
            isinstance(t, str) and answers.PLACEHOLDER_TOKEN_RE.search(t) for t in texts
        ):
            redacted.append(topic.label.lower())
    if redacted:
        questions.append(
            "Please rewrite the "
            + ", ".join(redacted)
            + " without personal contact details (names, phone numbers)."
        )
    return questions[:_MAX_CLARIFICATION_QUESTIONS]
