"""Non-interactive EDGE-CASE suite for the worker-profiling interview.

Every case runs through the SAME production path the interactive CLI uses —
``POST /profiling/respond`` (+ ``/pseudonymize``, + ``/profile/extract`` where the
case asks for it) on the real FastAPI app. There is no separate harness and no
re-implementation, so a case can never pass against code the service does not run.

HOW TO READ A RESULT. Three outcomes, and the difference matters:

* ``ok``   — the behaviour we want, asserted.
* ``defect`` — a KNOWN, OPEN defect. The expectation asserts the CURRENT (wrong)
  behaviour and names the defect. It is not a pass in any moral sense; it is a
  tripwire that tells us the day the behaviour changes.
* ``STALE`` — a ``defect`` expectation that NO LONGER reproduces. Usually good news
  (someone fixed it) but the suite is now lying, so it exits non-zero until the
  expectation is updated.

DEFECT IDS USED BELOW
---------------------
``TD98``  (docs/registers/tech-debt-register.md, open, logged 2026-07-22) — a
          third-party mention / denial / aspiration / training answer still records
          ``machines`` + ``skills``; only ``role`` is correctly withheld.
``R30``   (docs/registers/risks-register.md, open) — a phone split by a WORD
          ("98765 aur 43210") is not masked. Gates AI_ENABLE_REAL_CALLS.
``CLI-F1`` … ``CLI-F7`` — behaviours MEASURED by this suite on 2026-07-22 that are
          NOT in any register yet. They are labelled, not hidden, and are listed in
          the run summary so they cannot quietly become normal:

``CLI-F1`` an EXCLUDED / ORIGIN state ("Bihar ke alawa", "Kerala mein nahi
          jaunga", "Bihar se hu") is written to the profile's ``current_state``.
``CLI-F2`` a STATE-level preference ("Gujarat mein", "Gujarat ya Maharashtra")
          answers nothing — only city names close the topic. Same family: a
          spaced-out acronym ("V M C") and a common misspelling ("seter").
``CLI-F3`` pure DEVANAGARI answers extract nothing (the gazetteer is Latin-only)
          — note Sarvam STT returns Devanagari, so voice answers land here.
``CLI-F4`` half of a space-split phone is recorded as a SALARY (98765).
``CLI-F5`` a bare or lower-case name is not masked, so it would reach a model.
``CLI-F6`` one blocked message anywhere in the transcript fails the WHOLE
          extraction closed (empty profile, status ``blocked``) — because apps/api
          stores the inbound row BEFORE the AI call.
``CLI-F7`` the extraction transcript contains BADA BHAI'S OWN QUESTIONS
          (``buildTranscript`` keeps both directions) and the context-free
          ``signals.detect`` pass harvests them: the controller question adds
          Siemens/Mitsubishi/Heidenhain/Haas to a worker who said only "fanuc",
          and the experience RETRY question ("jaise 2 saal ya 5 saal?") rewrites a
          5-year machinist as a 2-year one. Payer-facing, and invisible to the old
          CLI because it built the transcript from the worker's answers only.

Run it:  ``python -m app.cli.onboarding_chat --edge-cases``
From pytest: :func:`run_suite` returns a :class:`SuiteResult`; the suite is
asserted green in ``tests/test_cli_edge_cases.py``.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..contracts import ConversationState
from ..profiling.interview_engine import ESSENTIAL_TOPICS, MUST_ASK_TOPICS
from .api_session import DEFAULT_ROLE_FAMILY, ExtractResult, InterviewSession, Transport, TurnResult

# --- seeds ------------------------------------------------------------------


@dataclass(frozen=True)
class Seed:
    """A ``ConversationState`` as apps/api would have persisted it mid-interview.

    Built through the Pydantic contract so a case can never seed a shape the
    endpoint would reject. ``asked[-1]`` is the question ON SCREEN — the value
    ``signals.detect_answered_topics`` attributes the next answer to (B-4/B-5).
    """

    asked: tuple[str, ...] = ()
    answered: tuple[str, ...] = ()
    collected: Mapping[str, Any] = field(default_factory=dict)

    def state(self) -> dict[str, Any] | None:
        if not self.asked and not self.answered:
            return None
        return ConversationState(
            role_family=DEFAULT_ROLE_FAMILY,
            turn_count=len(self.asked),
            answered_topics=list(self.answered),
            asked_question_ids=list(self.asked),
            collected=dict(self.collected),
            ask_counts={topic: 1 for topic in self.asked},
            unanswered_essentials=[t for t in ESSENTIAL_TOPICS if t not in self.answered],
        ).model_dump()


# A worker who has already answered the three earlier essentials, so the question
# on screen really is the location one (the realistic context for a location case).
_LOCATION_SEED = Seed(
    asked=("role", "machines", "experience", "current_location"),
    answered=("role", "machines", "experience"),
    collected={"role": "VMC Operator", "machines": ["VMC"], "experience": 5.0},
)
_PREFERRED_SEED = Seed(
    asked=("role", "machines", "experience", "current_location", "preferred_locations"),
    answered=("role", "machines", "experience", "current_location"),
    collected={
        "role": "VMC Operator",
        "machines": ["VMC"],
        "experience": 5.0,
        "current_location": "Pune",
    },
)
_ROLE_SEED = Seed(asked=("role",))


# --- run + checks -----------------------------------------------------------


@dataclass
class CaseRun:
    case: Case
    turns: list[TurnResult]
    extraction: ExtractResult | None
    final_state: dict[str, Any] | None

    @property
    def last(self) -> TurnResult:
        return self.turns[-1]

    @property
    def collected(self) -> dict[str, Any]:
        return (self.final_state or {}).get("collected") or {}

    @property
    def answered(self) -> list[str]:
        return list((self.final_state or {}).get("answered_topics") or [])

    @property
    def asked(self) -> list[str]:
        return list((self.final_state or {}).get("asked_question_ids") or [])


@dataclass(frozen=True)
class Check:
    """One expectation. ``fn`` returns ``(ok, actual)`` — ``actual`` is always
    printed, pass or fail, so the run is a measurement and not just a verdict."""

    label: str
    fn: Callable[[CaseRun], tuple[bool, str]]
    defect: str | None = None


def _c(label: str, fn: Callable[[CaseRun], tuple[bool, str]], defect: str | None = None) -> Check:
    return Check(label, fn, defect)


def records_nothing_for(topic: str) -> Check:
    """The strongest anti-fabrication assertion: the topic is neither marked
    ANSWERED (which would close it forever) nor given a value."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        answered = topic in run.answered
        collected = topic in run.collected
        return (
            not answered and not collected,
            f"answered={answered} collected={run.collected.get(topic, '<absent>')!r}",
        )

    return _c(f"records nothing for '{topic}'", _fn)


def records(topic: str, value: Any) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        actual = run.collected.get(topic, "<absent>")
        return actual == value, f"collected[{topic}]={actual!r}"

    return _c(f"collected[{topic}] == {value!r}", _fn)


def answers(topic: str) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        return topic in run.answered, f"answered={run.answered}"

    return _c(f"'{topic}' marked answered", _fn)


def collects_exactly(expected: Mapping[str, Any], defect: str | None = None) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        return dict(run.collected) == dict(expected), f"collected={_j(run.collected)}"

    return _c(f"collected == {_j(expected)}", _fn, defect)


def never_stored(needle: str) -> Check:
    """The excluded/refused place must not appear ANYWHERE in what was collected
    (nor in the extracted draft, when the case ran extraction)."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        blobs = [_j(run.collected)]
        if run.extraction is not None:
            blobs.append(_j(run.extraction.draft))
        joined = " ".join(blobs).lower()
        return needle.lower() not in joined, f"searched={' '.join(blobs)[:120]}"

    return _c(f"{needle!r} is never stored", _fn)


def gate_blocks(reason_contains: str = "") -> Check:
    """Fail-closed proof: the gate blocked, the turn reports blocked, no state
    advanced, and the reply is the safe fallback."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        turn = run.last
        gate = turn.gate
        ok = bool(gate and gate.blocked) and turn.blocked and turn.state is None
        if reason_contains:
            ok = ok and reason_contains in (turn.blocked_reason or "")
        return ok, (
            f"gate.blocked={getattr(gate, 'blocked', None)} turn.blocked={turn.blocked} "
            f"reason={turn.blocked_reason!r} "
            f"updated_state={'null' if turn.state is None else 'set'}"
        )

    return _c(f"gate BLOCKS (fail-closed){f' [{reason_contains}]' if reason_contains else ''}", _fn)


def gate_masks(token: str) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        gate = run.last.gate
        tokens = list(gate.placeholder_tokens) if gate else []
        return token in tokens, f"tokens={tokens} text={getattr(gate, 'text', '')!r}"

    return _c(f"gate masks to {token}", _fn)


def llm_input_excludes(needle: str, defect: str | None = None) -> Check:
    """What would actually reach a model must not contain this substring."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        gate = run.last.gate
        if gate is None:
            return False, "no gate probe"
        if gate.blocked:
            return True, "blocked - nothing would be sent"
        return needle not in gate.text, f"to-LLM={gate.text!r}"

    return _c(f"model input excludes {needle!r}", _fn, defect)


def llm_input_contains(needle: str, defect: str | None = None) -> Check:
    """Used ONLY to pin an under-masking defect as current behaviour."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        gate = run.last.gate
        if gate is None:
            return False, "no gate probe"
        return (not gate.blocked and needle in gate.text), f"to-LLM={gate.text!r}"

    return _c(f"model input STILL contains {needle!r}", _fn, defect)


def http_status(code: int) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        turn = run.last
        errors = turn.response.validation_errors()
        detail = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'] or [])}: {e['type']}" for e in errors
        )
        return turn.response.status_code == code, f"HTTP {turn.response.status_code} {detail}"

    return _c(f"HTTP {code}", _fn)


def clarify_reserved(topic: str) -> Check:
    """COST-4: the clarify branch re-serves the SAME question instead of advancing."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        turn = run.last
        return (
            turn.clarified and turn.asked_question_id == topic,
            f"clarified={turn.clarified} asked={turn.asked_question_id} "
            f"clarify_count={(turn.state or {}).get('clarify_count')}",
        )

    return _c(f"clarify re-serves '{topic}'", _fn)


def advanced_past_clarify_bound() -> Check:
    """...and the re-serve is BOUNDED: the third consecutive clarify falls through
    to ``next_turn`` (clarify_count resets), so the interview can never loop."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        turn = run.last
        return (
            not turn.clarified and int((turn.state or {}).get("clarify_count") or 0) == 0,
            f"clarified={turn.clarified} clarify_count={(turn.state or {}).get('clarify_count')} "
            f"reply={turn.reply_text[:48]!r}",
        )

    return _c("3rd consecutive clarify falls through to next_turn", _fn)


def is_mock() -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        turn = run.last
        meta = turn.ai_metadata or {}
        return turn.is_mock, f"is_mock={turn.is_mock} real_call={meta.get('real_call')}"

    return _c("no real model call", _fn)


def extraction_ready(expected: bool) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        actual = run.last.extraction_ready
        return actual == expected, f"extraction_ready={actual}"

    return _c(f"extraction_ready == {expected}", _fn)


def all_must_ask_raised() -> Check:
    """Issue #424: every MUST_ASK topic must be asked-or-answered before wrap-up."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        seen = set(run.asked) | set(run.answered)
        missing = [t for t in MUST_ASK_TOPICS if t not in seen]
        return not missing, f"missing={missing} asked={run.asked}"

    return _c("every MUST_ASK topic was raised before wrap-up", _fn)


def wrapped_up_within(max_turns: int) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        ready = any(t.extraction_ready for t in run.turns)
        return ready and len(run.turns) <= max_turns, (
            f"turns={len(run.turns)} ready_at="
            f"{next((t.index for t in run.turns if t.extraction_ready), None)}"
        )

    return _c(f"wraps up within {max_turns} turns (no infinite loop)", _fn)


def unanswered_essentials_are(expected: Sequence[str]) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        actual = list((run.final_state or {}).get("unanswered_essentials") or [])
        return actual == list(expected), f"unanswered_essentials={actual}"

    return _c(f"unanswered_essentials == {list(expected)}", _fn)


def draft_field(name: str, expected: Any, defect: str | None = None) -> Check:
    """An assertion about the PRODUCTION extraction output (rich draft)."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        if run.extraction is None:
            return False, "the case did not run extraction"
        if run.extraction.draft is None:
            return False, "worker_profile_draft is null (the blocked leg returns none)"
        actual = run.extraction.draft.get(name, "<absent>")
        return actual == expected, f"draft[{name}]={actual!r}"

    return _c(f"extraction draft[{name}] == {expected!r}", _fn, defect)


def profile_field(name: str, expected: Any, defect: str | None = None) -> Check:
    """An assertion about the legacy ``DraftProfile`` — the field apps/api persists
    (and the only half the response carries on the blocked leg)."""

    def _fn(run: CaseRun) -> tuple[bool, str]:
        if run.extraction is None:
            return False, "the case did not run extraction"
        actual = run.extraction.profile.get(name, "<absent>")
        return actual == expected, f"profile[{name}]={actual!r}"

    return _c(f"extraction profile[{name}] == {expected!r}", _fn, defect)


def extraction_blocked(expected: bool, defect: str | None = None) -> Check:
    def _fn(run: CaseRun) -> tuple[bool, str]:
        if run.extraction is None:
            return False, "no extraction ran"
        ext = run.extraction
        return ext.blocked == expected, (
            f"blocked={ext.blocked} status={ext.status} reason={ext.blocked_reason!r} "
            f"role={ext.profile.get('canonical_role_id')!r}"
        )

    return _c(f"extraction blocked == {expected}", _fn, defect)


def _j(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


# --- the cases --------------------------------------------------------------


@dataclass(frozen=True)
class Case:
    id: str
    group: str
    messages: tuple[str, ...]
    checks: tuple[Check, ...]
    seed: Seed | None = None
    note: str = ""
    extract: bool = False


def _fabrication(case_id: str, message: str, machine: str, note: str) -> Case:
    """A statement the worker never made ABOUT THEMSELVES must not become their
    profile. ``role`` is correctly withheld today; ``machines``/``skills`` are not
    (TD98), so both halves are asserted — the right one as ``ok``, the wrong one as
    a labelled defect tripwire."""
    return Case(
        id=case_id,
        group="fabrication",
        messages=(message,),
        seed=_ROLE_SEED,
        note=note,
        checks=(
            records_nothing_for("role"),
            collects_exactly(
                {"machines": [machine], "skills": ["machine operation"]}, defect="TD98"
            ),
        ),
    )


FABRICATION_CASES: tuple[Case, ...] = (
    _fabrication(
        "fab-angle-grinder", "angle grinder chalata hu", "Grinding",
        "a hand-held angle grinder is not a CNC grinding machine",
    ),
    _fabrication(
        "fab-third-party-brother", "mere bhai lathe operator hai", "CNC Lathe",
        "the worker's BROTHER's job",
    ),
    _fabrication(
        "fab-helper", "lathe operator ka helper hu", "CNC Lathe",
        "a helper TO a lathe operator is not a lathe operator",
    ),
    _fabrication(
        "fab-aspiration", "lathe operator banna chahta hu", "CNC Lathe",
        "an aspiration, not experience",
    ),
    _fabrication(
        "fab-question", "lathe operator ki salary kitni hoti hai", "CNC Lathe",
        "the worker is ASKING us a question",
    ),
    _fabrication(
        "fab-father", "pitaji lathe chalate hai", "CNC Lathe",
        "the worker's FATHER's job",
    ),
    _fabrication(
        "fab-training", "lathe chalane ki training li hai", "CNC Lathe",
        "training taken, no claim of doing the job",
    ),
)


def _exclusion(case_id: str, message: str, excluded: str, expect_flexible: bool) -> Case:
    """'Anywhere except X' must never be recorded as 'X'. Today the exclusion is
    dropped entirely (right direction) — but the excluded STATE still lands on the
    extracted profile's ``current_state`` (CLI-F1), which is asserted below."""
    checks: list[Check] = [never_stored(excluded)]
    if expect_flexible:
        checks.append(records("preferred_locations", "flexible"))
    else:
        checks.append(records_nothing_for("preferred_locations"))
    return Case(
        id=case_id,
        group="exclusion",
        messages=(message,),
        seed=_PREFERRED_SEED,
        checks=tuple(checks),
        note=f"excluded={excluded}",
    )


EXCLUSION_CASES: tuple[Case, ...] = (
    _exclusion("excl-alawa", "Bihar ke alawa kahin bhi", "Bihar", True),
    _exclusion("excl-atirikt", "Bihar ke atirikt kahin bhi", "Bihar", True),
    _exclusion("excl-chhodke", "Bihar chhodke kahin bhi", "Bihar", True),
    _exclusion("excl-kerala-refusal", "Kerala mein bilkul bhi nahi jaunga", "Kerala", False),
    _exclusion("excl-gujarat-refusal", "Gujarat mein nahi jaunga", "Gujarat", False),
    # The extraction half of the same class: the topic layer stays clean, but the
    # transcript pass writes the EXCLUDED state onto the profile.
    Case(
        id="excl-state-leaks-into-extraction",
        group="exclusion",
        messages=("Bihar ke alawa kahin bhi",),
        seed=_PREFERRED_SEED,
        extract=True,
        note="CLI-F1: the excluded state lands on the profile as current_state",
        checks=(
            records("preferred_locations", "flexible"),
            draft_field("current_state", "Bihar", defect="CLI-F1"),
            draft_field("preferred_locations", []),
        ),
    ),
    Case(
        id="excl-refusal-state-leaks-into-extraction",
        group="exclusion",
        messages=("Kerala mein bilkul bhi nahi jaunga",),
        seed=_PREFERRED_SEED,
        extract=True,
        note="CLI-F1: a REFUSED state is recorded as where the worker IS",
        checks=(
            records_nothing_for("preferred_locations"),
            draft_field("current_state", "Kerala", defect="CLI-F1"),
        ),
    ),
)


ORIGIN_CASES: tuple[Case, ...] = tuple(
    Case(
        id=f"origin-{n}",
        group="origin-vs-preference",
        messages=(message,),
        seed=_LOCATION_SEED,
        note="a STATE is not a city: the engine deliberately keeps asking for the "
             "city (signals.detect_answered_topics), which is better matching data",
        checks=(
            records_nothing_for("current_location"),
            records_nothing_for("preferred_locations"),
        ),
    )
    for n, message in (
        ("se-hu", "Bihar se hu"),
        ("ka-hu", "main Bihar ka hu"),
        ("ghar", "ghar Bihar me hai"),
    )
)


VAGUE_CASES: tuple[Case, ...] = (
    Case(
        id="vague-kahi-bhi",
        group="vague",
        messages=("kahi bhi",),
        seed=_PREFERRED_SEED,
        checks=(records("preferred_locations", "flexible"), answers("preferred_locations")),
        note="flexibility IS an answer to the preferred question",
    ),
    Case(
        id="vague-kahin-bhi",
        group="vague",
        messages=("kahin bhi",),
        seed=_PREFERRED_SEED,
        checks=(records("preferred_locations", "flexible"),),
    ),
    Case(
        id="vague-city-answer",
        group="vague",
        messages=("Nashik mein",),
        seed=_PREFERRED_SEED,
        checks=(records("preferred_locations", ["Nashik"]),),
        note="control: a CITY-level preference works",
    ),
    Case(
        id="vague-state-preference",
        group="vague",
        messages=("Gujarat mein",),
        seed=_PREFERRED_SEED,
        note="CLI-F2: a state-level preference answers nothing - only cities close it",
        checks=(collects_exactly(_PREFERRED_SEED.collected, defect="CLI-F2"),),
    ),
    Case(
        id="vague-two-states",
        group="vague",
        messages=("Gujarat ya Maharashtra dono chalega",),
        seed=_PREFERRED_SEED,
        note="CLI-F2: two states named, nothing recorded",
        checks=(collects_exactly(_PREFERRED_SEED.collected, defect="CLI-F2"),),
    ),
    Case(
        id="vague-spaced-acronym",
        group="vague",
        messages=("V M C operator",),
        seed=_ROLE_SEED,
        note="CLI-F2b: a spaced-out acronym does not resolve the role or the machine",
        checks=(
            collects_exactly({"skills": ["machine operation"]}, defect="CLI-F2"),
            records_nothing_for("role"),
        ),
    ),
    Case(
        id="vague-misspelled-setter",
        group="vague",
        messages=("seter hu",),
        seed=_ROLE_SEED,
        note="CLI-F2c: a common misspelling of 'setter' resolves nothing",
        checks=(collects_exactly({}, defect="CLI-F2"),),
    ),
    Case(
        id="vague-bare-years",
        group="vague",
        messages=("2 saal",),
        seed=Seed(asked=("role", "machines", "experience"), answered=("role", "machines")),
        checks=(records("experience", 2.0),),
        note="a bare duration answering the experience question works",
    ),
)


DEVANAGARI_CASES: tuple[Case, ...] = (
    Case(
        id="deva-vmc-operator",
        group="devanagari",
        messages=("मैं वीएमसी ऑपरेटर हूँ",),
        seed=_ROLE_SEED,
        note="CLI-F3: pure Devanagari extracts NOTHING (the gazetteer is Latin-only). "
             "Sarvam STT returns Devanagari, so voice answers land here.",
        checks=(collects_exactly({}, defect="CLI-F3"), records_nothing_for("role")),
    ),
    Case(
        id="deva-denial",
        group="devanagari",
        messages=("प्रोग्रामर नहीं हूँ",),
        seed=_ROLE_SEED,
        note="a denial in Devanagari: nothing recorded (right outcome, for the "
             "wrong reason - see CLI-F3)",
        checks=(records_nothing_for("role"),),
    ),
    Case(
        id="deva-code-switched",
        group="devanagari",
        messages=("मैं VMC operator hu, 5 saal ka experience",),
        seed=_ROLE_SEED,
        note="the Latin half carries it: mixed script DOES work",
        checks=(records("role", "VMC Operator"), records("experience", 5.0)),
    ),
)


PRIVACY_CASES: tuple[Case, ...] = (
    Case(
        id="privacy-phone",
        group="privacy",
        messages=("mera number 9876543210 hai",),
        seed=_ROLE_SEED,
        checks=(
            gate_masks("[PHONE_1]"),
            llm_input_excludes("9876543210"),
            is_mock(),
        ),
        note="masked, NOT blocked - the turn continues with [PHONE_1]",
    ),
    Case(
        id="privacy-phone-space-split",
        group="privacy",
        messages=("mera number 98765 43210 hai",),
        seed=_ROLE_SEED,
        extract=True,
        note="CLI-F4: masked for the model, but the local parser reads 98765 as a SALARY",
        checks=(
            gate_masks("[PHONE_1]"),
            llm_input_excludes("98765"),
            records("salary_current", 98765),
            draft_field("current_salary", 98765, defect="CLI-F4"),
        ),
    ),
    Case(
        id="privacy-phone-word-split",
        group="privacy",
        messages=("98765 aur 43210 par call karo",),
        seed=_ROLE_SEED,
        note="R30 (open, registered): a WORD-split phone is not masked and not blocked",
        checks=(
            llm_input_contains("98765", defect="R30"),
            llm_input_contains("43210", defect="R30"),
        ),
    ),
    Case(
        id="privacy-phone-separator-split",
        group="privacy",
        messages=("mera number 98-76-54-32-10 hai",),
        seed=_ROLE_SEED,
        checks=(gate_masks("[PHONE_1]"), llm_input_excludes("9876543210")),
        note="separator-split IS caught by _PHONE_RE",
    ),
    Case(
        id="privacy-name-with-cue",
        group="privacy",
        messages=("mera naam Ravi hai",),
        seed=_ROLE_SEED,
        checks=(gate_masks("[PERSON_1]"), llm_input_excludes("Ravi")),
        note="the cue-based name masker works when the cue PRECEDES a capitalised name",
    ),
    Case(
        id="privacy-name-bare",
        group="privacy",
        messages=("Ravi Kumar naam hai mera",),
        seed=_ROLE_SEED,
        note="CLI-F5: the cue FOLLOWS the name, so nothing is masked - the name would "
             "reach a model (bounded today by AI_ENABLE_REAL_CALLS=false)",
        checks=(llm_input_contains("Ravi Kumar", defect="CLI-F5"),),
    ),
    Case(
        id="privacy-name-lowercase",
        group="privacy",
        messages=("mera naam ravi hai",),
        seed=_ROLE_SEED,
        note="CLI-F5: the masker requires a capital letter",
        checks=(llm_input_contains("ravi", defect="CLI-F5"),),
    ),
    Case(
        id="privacy-residual-digits",
        group="privacy",
        messages=("mera ref number 12345678 hai",),
        seed=_ROLE_SEED,
        checks=(gate_blocks("residual numeric sequence"), is_mock()),
        note="fail-closed: an unexplained 7+ digit run blocks the whole turn",
    ),
    Case(
        id="privacy-oversize-blocks",
        group="privacy",
        messages=("x" * 20_001,),
        seed=_ROLE_SEED,
        checks=(gate_blocks("input exceeds 20000 characters"),),
        note="fail-closed on oversize input: no model call, engine never runs",
    ),
    Case(
        id="privacy-blocked-message-fails-extraction-closed",
        group="privacy",
        messages=("VMC operator hu, 5 saal", "mera ref number 12345678 hai"),
        note="CLI-F6: apps/api stores the inbound message BEFORE the AI call, so a "
             "blocked message is in the extraction transcript - and blocks the WHOLE "
             "extraction closed (empty profile, profile_status='draft')",
        extract=True,
        checks=(
            gate_blocks("residual numeric sequence"),
            extraction_blocked(True, defect="CLI-F6"),
            # The whole profile is empty even though turn 1 answered role+experience
            # cleanly: the blocked message poisons the WHOLE transcript.
            profile_field("canonical_role_id", None, defect="CLI-F6"),
        ),
    ),
)


ROBUSTNESS_CASES: tuple[Case, ...] = (
    Case(
        id="robust-empty",
        group="robustness",
        messages=("",),
        checks=(http_status(422),),
        note="the ai-service contract rejects an empty message "
             "(apps/api rejects it first with 400, so this leg is not worker-reachable)",
    ),
    Case(
        id="robust-whitespace",
        group="robustness",
        messages=("   ",),
        seed=_ROLE_SEED,
        checks=(collects_exactly({}), extraction_ready(False)),
        note="whitespace passes the contract and simply records nothing",
    ),
    Case(
        id="robust-very-long",
        group="robustness",
        messages=("vmc operator hu " * 260,),  # ~4160 chars
        seed=_ROLE_SEED,
        checks=(records("role", "VMC Operator"), is_mock()),
        note="4160 chars: fine here, but apps/api caps a message at 4000 (safeTextSchema)",
    ),
    Case(
        id="robust-emoji",
        group="robustness",
        messages=("\U0001f600\U0001f600\U0001f600",),
        seed=_ROLE_SEED,
        checks=(collects_exactly({}),),
    ),
    Case(
        id="robust-punctuation",
        group="robustness",
        messages=("!!!???...",),
        seed=_ROLE_SEED,
        checks=(collects_exactly({}),),
    ),
    Case(
        id="robust-clarify",
        group="robustness",
        messages=("matlab kya?",),
        seed=_ROLE_SEED,
        checks=(clarify_reserved("role"), collects_exactly({})),
        note="COST-4: a clarifying message re-serves the question instead of advancing",
    ),
    Case(
        id="robust-clarify-bounded",
        group="robustness",
        messages=("matlab kya?", "matlab kya?", "matlab kya?"),
        seed=_ROLE_SEED,
        checks=(advanced_past_clarify_bound(),),
        note="...and the re-serve is bounded at 2, so it can never loop",
    ),
)


# The extraction pass runs over the WHOLE stored transcript — Bada Bhai's own
# questions included (buildTranscript) — and ``signals.detect`` is context-free, so
# the QUESTION TEXT is harvested as if the worker had said it. Both cases below were
# MEASURED on 2026-07-22 and are deterministic.
EXTRACTION_CASES: tuple[Case, ...] = (
    Case(
        id="extract-harvests-its-own-controller-question",
        group="extraction",
        messages=("vmc operator hu", "5 saal ho gaye", "abhi Pune me hu", "kahin bhi", "fanuc"),
        extract=True,
        note="CLI-F7: the worker said ONLY 'fanuc'. Siemens/Mitsubishi/Heidenhain/Haas "
             "come from OUR question text and reach the payer-facing profile",
        checks=(
            records("controllers", ["Fanuc"]),
            draft_field(
                "controllers",
                ["Fanuc", "Siemens", "Mitsubishi", "Heidenhain", "Haas"],
                defect="CLI-F7",
            ),
            profile_field(
                "skills", ["skill_fanuc", "skill_siemens", "skill_mitsubishi"], defect="CLI-F7"
            ),
        ),
    ),
    Case(
        id="extract-overwrites-experience-from-the-retry-question",
        group="extraction",
        messages=("vmc operator hu", "hmm", "5 saal ho gaye", "abhi Pune me hu", "kahin bhi"),
        extract=True,
        note="CLI-F7, the worst instance: the worker said '5 saal', the engine recorded "
             "5.0 — but the retry question ('jaise 2 saal ya 5 saal?') is in the "
             "transcript, so the extracted profile says 2 years / 'junior'",
        checks=(
            records("experience", 5.0),
            draft_field("experience_years", 2.0, defect="CLI-F7"),
            draft_field("experience_level", "junior", defect="CLI-F7"),
        ),
    ),
)


FLOW_CASES: tuple[Case, ...] = (
    Case(
        id="flow-articulate-worker",
        group="flow",
        messages=(
            "VMC operator hu, 5 saal ka experience, Pune me hu, VMC aur CNC lathe "
            "chalata hu, setting aur tool offset aata hai",
            "haan", "haan", "haan", "haan", "haan", "haan",
        ),
        extract=True,
        note="issue #424: answering every essential in message 1 must NOT skip the "
             "money/availability asks",
        checks=(
            unanswered_essentials_are([]),
            all_must_ask_raised(),
            wrapped_up_within(7),
            extraction_blocked(False),
        ),
    ),
    Case(
        id="flow-never-answers",
        group="flow",
        messages=("hmm",) * 20,
        note="the ask ceiling must end the interview instead of looping forever",
        checks=(
            wrapped_up_within(16),
            unanswered_essentials_are(list(ESSENTIAL_TOPICS)),
            all_must_ask_raised(),
        ),
    ),
)


ALL_CASES: tuple[Case, ...] = (
    FABRICATION_CASES
    + EXCLUSION_CASES
    + ORIGIN_CASES
    + VAGUE_CASES
    + DEVANAGARI_CASES
    + PRIVACY_CASES
    + ROBUSTNESS_CASES
    + EXTRACTION_CASES
    + FLOW_CASES
)


# --- runner -----------------------------------------------------------------


@dataclass
class CheckOutcome:
    check: Check
    ok: bool
    actual: str

    @property
    def verdict(self) -> str:
        if self.check.defect is None:
            return "ok" if self.ok else "FAIL"
        return f"defect[{self.check.defect}]" if self.ok else f"STALE[{self.check.defect}]"

    @property
    def failed(self) -> bool:
        """A plain expectation that missed, or a defect tripwire that no longer
        reproduces (the suite is then stale and must be updated)."""
        return not self.ok


@dataclass
class CaseOutcome:
    case: Case
    outcomes: list[CheckOutcome]
    run: CaseRun

    @property
    def failed(self) -> bool:
        return any(o.failed for o in self.outcomes)


@dataclass
class SuiteResult:
    cases: list[CaseOutcome]

    @property
    def failed_cases(self) -> list[CaseOutcome]:
        return [c for c in self.cases if c.failed]

    @property
    def defects(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for case in self.cases:
            for outcome in case.outcomes:
                if outcome.check.defect and outcome.ok:
                    counts[outcome.check.defect] = counts.get(outcome.check.defect, 0) + 1
        return counts

    @property
    def stale(self) -> list[tuple[str, str]]:
        return [
            (case.case.id, outcome.check.defect or "")
            for case in self.cases
            for outcome in case.outcomes
            if outcome.check.defect and not outcome.ok
        ]

    @property
    def ok(self) -> bool:
        return not self.failed_cases


def run_case(transport: Transport, case: Case) -> CaseRun:
    """Drive one case through the production endpoints."""
    session = InterviewSession(transport, seed_state=case.seed.state() if case.seed else None)
    turns: list[TurnResult] = []
    for message in case.messages:
        turn = session.send(message)
        turns.append(turn)
        if turn.extraction_ready:
            break
    extraction = session.extract() if case.extract else None
    return CaseRun(case=case, turns=turns, extraction=extraction, final_state=session.state)


def evaluate(run: CaseRun) -> CaseOutcome:
    outcomes = []
    for check in run.case.checks:
        try:
            ok, actual = check.fn(run)
        except Exception as exc:  # pragma: no cover - a broken check must be visible
            ok, actual = False, f"check raised {type(exc).__name__}: {exc}"
        outcomes.append(CheckOutcome(check, ok, actual))
    return CaseOutcome(run.case, outcomes, run)


def run_suite(
    transport: Transport,
    cases: Sequence[Case] = ALL_CASES,
    *,
    print_fn: Callable[..., None] | None = None,
    verbose: bool = False,
) -> SuiteResult:
    """Run the suite and (optionally) print a per-case report."""
    emit = print_fn or (lambda *_a, **_k: None)
    result = SuiteResult([])
    emit("=== EDGE CASES (driven through POST /profiling/respond on the real app) ===")
    group = None
    for case in cases:
        if case.group != group:
            group = case.group
            emit(f"\n-- {group} " + "-" * (68 - len(group)))
        outcome = evaluate(run_case(transport, case))
        result.cases.append(outcome)
        status = "FAIL" if outcome.failed else "PASS"
        preview = " | ".join(m[:48] + ("..." if len(m) > 48 else "") for m in case.messages[:2])
        emit(f"[{status}] {case.id}  {preview!r}")
        if case.note:
            emit(f"         note: {case.note}")
        for check_outcome in outcome.outcomes:
            if check_outcome.failed or check_outcome.check.defect or verbose:
                emit(
                    f"         {check_outcome.verdict:<14} {check_outcome.check.label}"
                    f"\n             actual: {check_outcome.actual}"
                )
    emit("")
    emit(render_summary(result))
    return result


def render_summary(result: SuiteResult) -> str:
    passed = len(result.cases) - len(result.failed_cases)
    lines = [
        "=== SUMMARY ===",
        f"  cases      : {passed} passed / {len(result.failed_cases)} failed "
        f"({len(result.cases)} total)",
    ]
    defects = result.defects
    if defects:
        listed = ", ".join(f"{k} x{v}" for k, v in sorted(defects.items()))
        lines.append(f"  defects    : {listed}  (asserted as CURRENT behaviour, not as 'ok')")
    if result.stale:
        lines.append("  STALE      : a known-defect expectation no longer reproduces:")
        lines.extend(f"               {cid} [{defect}]" for cid, defect in result.stale)
        lines.append("               -> probably GOOD NEWS: update the expectation "
                     "in edge_cases.py")
    for case in result.failed_cases:
        lines.append(f"  FAILED     : {case.case.id}")
        for outcome in case.outcomes:
            if outcome.failed:
                lines.append(f"               {outcome.check.label} -> {outcome.actual}")
    return "\n".join(lines)


# --- scripted transcripts (--script FILE) -----------------------------------


def load_script(path: str) -> list[str]:
    """Read a canned transcript: one worker message per line.

    ``#`` starts a comment line and blank lines are skipped, so a script can be
    annotated. A JSON file containing a list of strings is also accepted.
    """
    with open(path, encoding="utf-8") as handle:
        raw = handle.read()
    stripped = raw.lstrip()
    if stripped.startswith("["):
        data = json.loads(raw)
        return [str(item) for item in data]
    return [
        line.rstrip("\n")
        for line in raw.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
