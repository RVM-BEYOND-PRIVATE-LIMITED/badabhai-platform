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

import re

from ..contracts import ConversationState
from . import signals
from .question_bank import (
    GENERIC_ROLE_FAMILY,
    Topic,
    one_shot_opener_for,
    options_for,
    topic_by_id,
    topics_for,
)

# A senior's acknowledgement: two words, no praise (persona rule G4). One of §3's
# closed acknowledgement set ("Theek hai. · Achha. · Samajh gaya. · Note kar liya. ·
# Chalo. · Bilkul. — nothing else").
_ACK = "Theek hai. "

# --- §5 acknowledgement variants (persona v3.2) ------------------------------
# Each is a DETERMINISTIC string on a detected condition. No LLM, no cost, and — the
# part that makes them legal under §4's "character is a REWRITE of a line, never an
# ADDITION to it" — none of them adds a turn or a sentence. They occupy the ack slot
# the turn already had, so the served turn is still `[ack] + [ONE question]`.
#
# All four are §3-compliant by construction and are swept by the neutrality nets:
# aap-form, no vocative, no exclamation, no emoji, no praise.

# "Says 'nahi pata' -> 'Koi baat nahi.' -> next question. No teaching, no re-ask, no
# disappointment. No appreciation on this turn." (The engine emits no appreciations at
# all, so the last clause holds trivially — see the persona tests.)
_ACK_DONT_KNOW = "Koi baat nahi. "

# "Says work has been hard -> One line, <=8 words, no advice: 'Samajh sakta hoon.'"
# Three words. It must fire on hardship and NEVER on achievement — that discipline
# lives in signals.is_hardship, which is a phrase list, not a keyword list.
_ACK_HARDSHIP = "Samajh sakta hoon. "

# "Is abusive -> One neutral line, continues. Never mirrors tone, never moralises."
#
# The sheet does not supply the string, and inventing a sentence for this row is how a
# bot ends up moralising. So the "neutral line" is "Chalo." — a member of §3's CLOSED
# acknowledgement set whose whole meaning is *moving on*. It neither mirrors nor
# lectures, and it is visibly not the warm "Theek hai." the worker would otherwise get,
# which is the only thing the row actually asks for. A distinct sentence here is a copy
# decision for the owner, not something to guess at.
_ACK_ABUSIVE = "Chalo. "

# "Asks 'job milegi?' -> 'Guarantee nahi de sakta — profile poora hoga toh companies
#  dekhengi.' -> back to the open question. No reassurance, no promise."
#
# VERBATIM from §5 and worked conversation 06. It is served by `clarify_turn`, not by
# `next_turn`, because the sheet requires going BACK TO THE OPEN QUESTION rather than
# advancing — the worker asked us something instead of answering, so the question on
# screen is still owed. Re-serving is explicitly "not counted as re-asking": ask_counts
# is untouched, so it costs the worker none of their bounded re-ask budget.
#
# WHY THIS ROW MATTERS MORE THAN ITS SIZE: before it, a worker asking a direct, anxious
# question got SILENCE — the engine detected nothing, advanced, and served the next
# topic. Silence is not neutrality at the moment a person is most exposed; it reads as
# being ignored. §2 Law 9 (never promise) is satisfied by the line itself, which
# refuses the guarantee in its first three words.
_GUARANTEE_LINE = "Guarantee nahi de sakta — profile poora hoga toh companies dekhengi. "
_WRAP_UP = (
    "Itni jaankari kaafi hai. Aapka resume ban raha hai — kuch detail baad mein confirm karenge."
)

# The topics that MUST be ANSWERED before we offer extraction, PER ROLE FAMILY.
# Current location is essential for matching, so it is required (not just "any N core
# topics"). B-4 (context-drift register 2026-07-16 row B-4; owner ruling 2026-07-17):
# location is split — current_location stays answer-essential.
#
# BUG S1, and it was a silent one. This used to be ONE module-level tuple containing
# ``machines`` — a topic id that exists ONLY in the ``cnc_vmc`` bank. For welding,
# plumbing, carpentry, design and interior_design there is no ``machines`` topic, so
# ``_next_topic`` could never SERVE it and ``detect_answered_topics`` could only ever
# mark it answered by accident (a welder who happened to say "lathe"). The readiness
# gate therefore could not be satisfied on purpose in five of six families: those
# interviews drained the entire bank and then ended on the ASK CEILING rather than on
# the worker's answers, and every one of them shipped ``unanswered_essentials`` with a
# permanently-unanswerable ``machines`` in it.
#
# Each family now names its OWN equipment/tools/software topic, taken VERBATIM from
# question_bank.py. ``generic`` (the uncovered-trade family) names none: its one
# trade-specific topic is ``daily_tasks``, which the local detector cannot key — as an
# essential it would burn the re-ask budget and then ship a false gap for a worker who
# answered perfectly well, the same reasoning that keeps education/certifications out.
#
# ``test_bank_integrity`` pins that every id here exists in that family's own bank, so
# an S1-shaped typo can never come back silently.
ESSENTIALS_BY_FAMILY: dict[str, tuple[str, ...]] = {
    "cnc_vmc": ("role", "machines", "experience", "current_location"),
    "welding": ("role", "equipment", "experience", "current_location"),
    "plumbing": ("role", "tools_plumbing", "experience", "current_location"),
    "carpentry": ("role", "tools_carpentry", "experience", "current_location"),
    "design": ("role", "software_design", "experience", "current_location"),
    "interior_design": ("role", "software_interior", "experience", "current_location"),
    GENERIC_ROLE_FAMILY: ("role", "experience", "current_location"),
}

# The CNC/VMC essentials, kept under the ORIGINAL module-level name. Not a leftover:
# it is the cross-language contract. ``packages/ai-contracts/src/__fixtures__/
# interview-gate.json`` pins this exact ordered list and BOTH suites assert against
# it (tests/test_interview_gate_parity.py here, mock-interview.test.ts there), and
# apps/api's mock interview — which is what actually runs on staging under TD81 —
# serves the CNC/VMC bank. Renaming or re-pointing this would silently break that
# pairing, so per-family resolution goes through ``essentials_for`` instead.
ESSENTIAL_TOPICS: tuple[str, ...] = ESSENTIALS_BY_FAMILY["cnc_vmc"]


def essentials_for(role_family: str | None) -> tuple[str, ...]:
    """The answer-essential topic ids for a role family.

    Unknown/None resolves to ``generic``, matching ``question_bank.topics_for`` — the
    two must agree or the gate would demand an id the served bank cannot produce,
    which is bug S1 in its general form.
    """
    if not role_family:
        return ESSENTIALS_BY_FAMILY[GENERIC_ROLE_FAMILY]
    return ESSENTIALS_BY_FAMILY.get(role_family, ESSENTIALS_BY_FAMILY[GENERIC_ROLE_FAMILY])

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
#
# S1 NOTE — why this one did NOT need the per-family treatment ESSENTIAL_TOPICS got:
# every id below is a SHARED topic (question_bank._SHARED_TOPICS), so it is present in
# every family's bank by construction, including `generic` (owner ruling: keep all
# shared topics) and `welding` (which excludes the shared `certifications` only to
# substitute its OWN topic under the SAME id). There is deliberately no
# `must_ask_for()` helper: a filtered gate would silently WEAKEN readiness for a family
# missing an id, where the bank-integrity test makes the same situation fail loudly.
MUST_ASK_TOPICS: tuple[str, ...] = (
    "preferred_locations",
    "salary_current",
    "salary_expected",
    "availability",
    "education",
    # TD-EDU (owner 2026-07-23): two dedicated academic-education asks. Like
    # `education`/`certifications` they are non-essential must-asks — the local
    # detector cannot parse "12th"/"Electronics", so requiring an ANSWER would burn
    # the re-ask budget; the ASK satisfies the gate and the LLM reads the value.
    "education_level",
    "education_field",
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
# Sized with real headroom over the WORST FAMILY's blind-run budget, not CNC/VMC's.
# CNC/VMC: 4 essentials x MAX_ASKS_PER_TOPIC (=8) + 10 ask-once topics (skills,
# preferred_locations, controllers, salary_current, salary_expected, availability,
# education, education_level, education_field, certifications) = 18. WELDING is the
# worst: 15 topics, 4 essentials => 8 + 11 = 19. `generic` is the cheapest (12 topics,
# 3 essentials => 6 + 9 = 15), which is the "fewer questions" the persona sheet asks
# for falling out of the bank rather than being special-cased.
# test_interview_engine.py pins the budget PER FAMILY against this constant, so the
# zero-margin coupling cannot silently come back if any bank grows. (Was 20 for a
# 16-ask bank; TD-EDU added two ask-once education topics -> 22; the S1 per-family
# gate made welding's 19-ask blind run the binding case -> 24, keeping >=4 headroom.)
MAX_ENGINE_ASKS = 24

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


# TD-EDU (owner 2026-07-23): a SCHOOL-level education answer (10th / 12th) has no
# "field of study", so the education_field question is skipped for it. A higher
# qualification (ITI / Diploma / B.Tech / degree / …) still gets asked its field.
_SCHOOL_LEVEL_RE = re.compile(
    r"(?<!\d)(10|12)(?!\d)|10th|12th|dasv|barv|baarv|matric|\bssc\b|\bhsc\b|"
    r"high\s*school|inter",
    re.IGNORECASE,
)
_HIGHER_ED_RE = re.compile(
    r"iti|diploma|polytechnic|\bpoly\b|b\.?\s*tech|btech|\bb\.?\s*e\b|\bbe\b|degree|"
    r"graduat|engineer|b\.?\s*sc|\bbsc\b|\bb\.?\s*a\b|b\.?\s*com|\bbcom\b|m\.?\s*tech|"
    r"\bmtech\b|\bmba\b|\bmca\b|\bbca\b",
    re.IGNORECASE,
)


def _is_school_only_education(message: str) -> bool:
    """True when an ``education_level`` answer is school-only (10th / 12th) and names
    NO higher qualification — so there is no field of study to ask about. Any
    ITI/Diploma/B.Tech/degree cue returns False, so those still get their field."""
    m = message or ""
    if _HIGHER_ED_RE.search(m):
        return False
    return bool(_SCHOOL_LEVEL_RE.search(m))


def _extraction_ready(st: ConversationState, role_family: str | None = None) -> bool:
    """All of the family's essentials answered AND every MUST_ASK topic asked-or-answered.

    ``role_family`` defaults to the one carried on the state (``next_turn`` stamps it
    every turn). Callers that hold the authoritative family — ``clarify_turn``, which
    deliberately does NOT mutate the state it was handed — pass it explicitly.
    """
    essentials = essentials_for(role_family or st.role_family)
    if not all(t in st.answered_topics for t in essentials):
        return False
    return all(t in st.answered_topics or t in st.asked_question_ids for t in MUST_ASK_TOPICS)


def _acknowledgement(worker_message_raw: str) -> str:
    """The ack slot for THIS turn — §5's rows, resolved in a fixed priority order.

    Priority, and each step is a decision rather than an accident:

    1. **Hardship** outranks everything. A message can carry hardship AND a don't-know
       ("nahi pata, ghar chalana mushkil hai"); "Samajh sakta hoon." is the right line
       there and "Koi baat nahi." would answer the smaller half of what was said.
    2. **Abuse** outranks the don't-know so an abusive turn never receives the warm
       "Koi baat nahi.".
    3. **Don't-know** -> "Koi baat nahi.".
    4. Otherwise the neutral "Theek hai.".

    Detection is local and conservative (see the three predicates in ``signals``); when
    none of them is confident the worker gets the neutral ack, which is the sheet's own
    preference — a misfired softener is worse than no softener.
    """
    if signals.is_hardship(worker_message_raw):
        return _ACK_HARDSHIP
    if signals.is_abusive(worker_message_raw):
        return _ACK_ABUSIVE
    if signals.is_dont_know(worker_message_raw):
        return _ACK_DONT_KNOW
    return _ACK


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
    inferred_fills: frozenset[str] | set[str] = frozenset(),
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
    # 3.5 An INFERRED value is not "established" and may be replaced by a real one.
    #     A topic that is in `collected` but NOT in `answered_topics` can only have
    #     got there by inference — every deliberate answer marks its topic answered
    #     in the same loop that fills the slot, and only inferred topics are held
    #     back (signals.detect_inferred_topics). So this is exactly the "a placeholder
    #     is sitting in the slot" case, and first-write-wins must not protect it.
    #
    #     Without this, the owner-reported defect only half-fixed: withholding the
    #     ANSWERED mark got the skills question asked again, but the inferred
    #     "machine operation" still occupied `collected["skills"]` and the worker's
    #     real "setting aur tool offset aata hai" was discarded by rule 3 anyway.
    #
    #     Back-compatible by construction: on any state persisted before inference
    #     was held back, every collected topic is also an answered topic, so this
    #     branch cannot fire and behaviour is unchanged.
    if topic_id in inferred_fills:
        return True
    return topic_id not in st.collected


def _unanswered_essentials(st: ConversationState, role_family: str | None = None) -> list[str]:
    """INTERVIEW-1: which ESSENTIAL topics the worker never actually answered.

    This is the EXPLICIT completeness signal. ``extraction_ready`` deliberately
    stays "the interview is over — run extraction" (its frozen v1 meaning, and the
    sole gate on extraction downstream), so this list — not that flag — is how an
    incomplete profile is declared. Empty list = every essential answered.

    Returned in the family's essentials order, so it is stable/comparable across
    turns. Topic ids only, never PII.

    S1: read from ``essentials_for``, so a welder's gap list can only ever name topics
    a welder was actually able to answer. Before the per-family split this list
    reported ``machines`` — a topic that does not exist in the welding bank — as
    "unanswered", permanently and for every non-CNC worker.
    """
    return [t for t in essentials_for(role_family or st.role_family) if t not in st.answered_topics]


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


def _role_ask_budget_just_spent(st: ConversationState) -> bool:
    """True on the ONE turn that answers the LAST permitted ``role`` ask while ``role``
    is still unplaced — the engine's own "we asked what you do, twice, in this family's
    own words, and could not place you" signal.

    Three conjuncts, and each is load-bearing:

    - ``asked_question_ids[-1] == "role"`` makes this a ONE-SHOT event rather than a
      standing condition. Without it the predicate stays true for the rest of the
      interview and a worker who is recovered onto a real family by rule 1 is dragged
      back to ``generic`` on their very next signal-free turn — an oscillation that
      would re-serve banks turn after turn.
    - ``_ask_count(...) >= MAX_ASKS_PER_TOPIC`` means the family's OWN wording, retry
      included, has already been spent. Firing earlier would reclassify "the finite
      gazetteer failed this worker" (which the ask bound exists to absorb) as "this is
      an uncovered trade", and cost a real CNC worker the machines/skills/controllers
      questions for one fumbled reply.
    - ``role not in answered_topics`` — a placed role is not a give-up.
    """
    return (
        bool(st.asked_question_ids)
        and st.asked_question_ids[-1] == "role"
        and "role" not in st.answered_topics
        and _ask_count(st, "role") >= MAX_ASKS_PER_TOPIC
    )


def resolve_role_family(
    state: ConversationState | None,
    worker_message_raw: str,
    caller_family: str | None = "cnc_vmc",
) -> str:
    """Which question bank this turn should be served from.

    Replaces the endpoint's old one-liner ``detect_role_family(msg) or body.role_family``,
    which could NEVER reach ``generic``: apps/api sends ``priorState?.role_family ??
    "cnc_vmc"``, so an undetected trade fell back to CNC/VMC and a hotel cook was asked
    "Kaunsi machine — VMC, CNC lathe, HMC ya grinding?" and offered VMC/Fanuc chips to
    tap. Three rules, in order:

    1. **A positive detection always wins.** ``signals.detect_role_family`` reads the raw
       message locally (no network, before pseudonymization). Unchanged behaviour, and
       it is what moves a worker onto the right bank mid-interview — including moving
       them BACK OUT of ``generic`` the moment they name something placeable.
    2. **The role ask budget just ran out with nothing placed -> ``generic``.** A
       one-shot, one-way handover (see :func:`_role_ask_budget_just_spent`).
    3. **Otherwise keep what we already had** — the state's family (which apps/api
       round-trips as ``priorState.role_family``) or the caller's. The default stays
       whatever apps/api sends.

    WHY RULE 2 WAITS FOR THE BUDGET rather than firing on the first unplaceable reply:
    "the detector could not read this worker" and "this worker is an uncovered trade"
    are DIFFERENT things, and this module already has a bound for the first one. Firing
    on the first reply drops a CNC worker who typed "operator hu" (which keys ``skills``,
    not ``role``) out of the CNC bank, losing them the ``machines``, ``skills`` and
    ``controllers`` questions — a real data loss in the launch trade, for one fumble.
    Waiting one bounded re-ask costs the uncovered-trade worker nothing that matters:
    they see the family's role question and its retry, never its MACHINE question,
    because ``machines`` is the essential served AFTER ``role`` and the handover lands
    first.

    THE RECOVERY PATH is why ``generic`` is a safe waypoint and not a dead end: its own
    ``daily_tasks`` question ("Is kaam mein aap kya-kya karte hain?") invites exactly the
    vocabulary that re-detects a family, and at that point ``machines`` / ``skills`` /
    ``controllers`` are still UNASKED, so rule 1 hands the worker back a complete CNC
    interview.

    Pure: reads the state, never mutates it. ``next_turn`` stamps the result onto
    ``ConversationState.role_family``, which is an EXISTING field — no contract change.
    """
    detected = signals.detect_role_family(worker_message_raw)
    if detected is not None:
        return detected
    if state is not None:
        if _role_ask_budget_just_spent(state):
            return GENERIC_ROLE_FAMILY
        if state.role_family:
            return state.role_family
    return caller_family or GENERIC_ROLE_FAMILY


def first_question(
    role_family: str = "cnc_vmc",
    worker_name: str | None = WORKER_NAME_PLACEHOLDER,
) -> tuple[str, str]:
    """Return (topic_id, question) for the opening question. The vocative
    (placeholder by default) prefixes the opening only."""
    first = topics_for(role_family)[0]
    return first.id, _vocative(worker_name) + first.question


def opening_message(role_family: str = "cnc_vmc") -> str:
    """The ONE-SHOT opener: an invitation to answer everything in one message.

    Pure. Takes no ``ConversationState`` and returns none, and that is the whole
    safety property of this function — read the next paragraph before "improving" it.

    IT RECORDS NOTHING. The intuition "we just asked them all twelve things, so mark
    them asked" is WRONG and was measured: seeding ``asked_question_ids`` with the
    twelve topic ids, then letting a worker answer the four ESSENTIALs, wraps the
    interview on turn 1 having served ZERO questions — every MUST_ASK topic
    (preferred_locations, salary_current, salary_expected, availability, education,
    certifications) silently never raised. That is exactly the issue-#424 defect the
    MUST_ASK gate exists to prevent, re-created from the other direction. Unseeded,
    the same worker gets 8 asks and wraps on turn 9.

    So the opener is an INVITATION, not an ask. Whatever the worker volunteers is
    detected normally by ``next_turn``; whatever they leave out is still asked for.

    No vocative, deliberately: ``next_turn`` already prefixes ``{{worker_name}} ji,``
    on turn 1 and again at the wrap-up, so a name here would be the third in a
    two-bubble exchange. Serving it name-less also keeps the endpoint PII-free.
    """
    return one_shot_opener_for(role_family)


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
    # Topics whose value was INFERRED from a different topic's answer. They FILL
    # their slot but do not close their question, so the worker still gets asked and
    # their own words can replace the inference (see signals.detect_inferred_topics
    # for the defect this fixes — a real skills answer being discarded in favour of
    # "machine operation" derived from the word "operator").
    inferred = signals.detect_inferred_topics(worker_message_raw, last_asked)
    # Snapshot BEFORE the loop: a slot filled by inference on an earlier turn. Taken
    # up front because the loop marks a topic answered before deciding whether to
    # commit it, which would otherwise erase the very distinction being tested.
    inferred_fills = {t for t in st.collected if t not in st.answered_topics}
    for topic_id, value in signals.detect_answered_topics(worker_message_raw, last_asked).items():
        if topic_id not in st.answered_topics and topic_id not in inferred:
            st.answered_topics.append(topic_id)
        if value is None:
            # P1-2: a DENIAL ("ITI nahi kiya") answers the ask without producing a
            # value — mark the topic answered, collect nothing.
            continue
        may_commit = _may_commit(st, topic_id, last_asked, correcting, inferred_fills)
        existing = st.collected.get(topic_id)

        if isinstance(value, list) and isinstance(existing, list):
            # TD103: Union lists instead of overwriting them. If correcting or replacing
            # an inferred placeholder, REPLACE instead of accumulating.
            if may_commit and (correcting or topic_id in inferred_fills):
                st.collected[topic_id] = value
            else:
                # Accumulate cross-topic signals or successive partial answers
                union = list(existing)
                for item in value:
                    if item not in union:
                        union.append(item)
                st.collected[topic_id] = union
        else:
            if may_commit:
                st.collected[topic_id] = value

    # TD-EDU: if education_level was just answered school-only (10th/12th), there is
    # no field of study — skip the education_field ask. Marking it ANSWERED (not
    # asked) satisfies the must-ask gate (asked-or-answered), so _next_topic never
    # serves it and the interview does not wait on it. A higher qualification still
    # gets its field. Read from the RAW message (the detector cannot parse levels).
    if (
        last_asked == "education_level"
        and _is_school_only_education(worker_message_raw)
        and "education_field" not in st.answered_topics
    ):
        st.answered_topics.append("education_field")

    extraction_ready = _extraction_ready(st, role_family)
    # INTERVIEW-1 completeness signal: refresh the gap list on EVERY turn, so the
    # state a caller persists always describes the interview as it actually stands.
    st.unanswered_essentials = _unanswered_essentials(st, role_family)

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
    next_topic = None if over_ceiling else _next_topic(topics, st, essentials_for(role_family))
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
    return _acknowledgement(worker_message_raw) + question, next_topic.id, st, extraction_ready


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
    # §5: a worker ASKING whether they will get a job is answered honestly FIRST, then
    # taken back to the open question. The prefix is the only difference from a plain
    # clarify re-serve — same bound, same state advance, ask_counts still untouched
    # ("back to the open question" is explicitly not counted as re-asking).
    prefix = _GUARANTEE_LINE if signals.asks_about_job_prospects(worker_message_raw) else ""
    # Re-serve the wording the worker ACTUALLY saw. ask_counts is not incremented:
    # a clarify is not a new ask, and the ask budget must stay clarify-immune.
    return (
        prefix + _served_question(topic, _ask_count(state, last_id)),
        last_id,
        st,
        _extraction_ready(st, role_family),
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


def suggested_followups(
    role_family: str = "cnc_vmc", asked_question_id: str | None = None
) -> list[str]:
    """Tap-to-answer chips for the question being served THIS turn.

    ANSWERS to ``asked_question_id``, never questions — because the worker app sends
    a tapped chip's label verbatim as the worker's message. That makes the label the
    worker's answer of record, so anything served here is put in their mouth.

    WHAT THIS REPLACES, measured on the constant it removes. Three hard-coded
    QUESTIONS were served on every turn of every role family:

        'Controller kaunsa — Fanuc ya Siemens?' -> {'controllers': ['Fanuc','Siemens']}
        'Setting karte hain ya sirf operation?' -> {'skills': ['basic setting']}
        'Kis sheher mein kaam kar sakte hain?'  -> {}

    One tap on the first chip recorded TWO controllers the worker never named; the
    third answered nothing at all, so tapping it burned a turn and a bounded re-ask.
    The list was identical for `cnc_vmc`, `welding` and every unknown family, so a
    welder was offered CNC controllers to fabricate.

    ``asked_question_id=None`` yields ``[]`` — the wrap-up turn asks nothing, so
    there is nothing to offer options for.
    """
    return options_for(role_family, asked_question_id)


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


def _next_topic(
    topics: list[Topic], st: ConversationState, essentials: tuple[str, ...] = ESSENTIAL_TOPICS
) -> Topic | None:
    """Pick the next topic to serve, in STRICT priority order.

    ``essentials`` is the RE-ASKABLE set for the family whose ``topics`` were passed;
    the two must come from the same family or branch 1 re-asks an id this bank cannot
    serve (bug S1). It defaults to the CNC/VMC tuple purely so the signature stays
    back-compatible for callers that predate the split.

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
            topic.id in essentials
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
