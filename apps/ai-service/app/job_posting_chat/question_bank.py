"""Job-posting interview question bank (ADR-0035).

Topics are DATA, not code — the engine reads this bank and never hardcodes a
question. Mirrors the structure of ``app/profiling/question_bank.py`` (a Topic
dataclass, a ``core`` ask-priority flag, a bounded ``retry_question``, and
tap-to-answer ``options``) with three deliberate differences, each recorded here
because a reviewer will otherwise read them as omissions.

TONE. This bank addresses an EMPLOYER/RECRUITER, not a worker. Plain professional
English, one question per turn, under 20 words. It is NOT the worker-facing
low-literacy Hinglish "Bada Bhai" voice, and it must never become it: the payer
side has a different literacy profile, a different relationship to us, and a
different question set.

ONE BANK, NOT SIX (the trade-awareness decision, ADR-0035 §Decision 2). The worker
bank splits into six role families (cnc_vmc / welding / plumbing / carpentry /
design / interior_design) because the QUESTIONS genuinely differ by trade — a
welder is asked about welding positions, a CNC operator about controllers. A JOB
POSTING has no such split: "how many people do you need", "what is the monthly pay
range", "which shift", "which city" are IDENTICAL questions whether the employer is
hiring a welder or a carpenter. Six near-identical copies would be six places for
the same question to drift. The ONE trade-sensitive topic is ``skills``, and it is
deliberately asked WITHOUT trade-specific example values (see the options rule
below) — offering "Fanuc, Siemens" to a carpentry employer is the same fabrication
defect the worker bank's ``options`` comment documents, pointed at the demand side.
``topics_for()`` still TAKES a ``trade_hint`` so a future trade-specific bank can be
added without a caller change (the same shape ``one_shot_opener_for`` uses); today
every hint resolves to this one bank.

THE ORG-NAME RULE (ADR-0035 §Decision 3, non-negotiable). No question in this bank
asks for the employer's company/organisation/business name, and none ever may. It
is already known server-side (``payers.orgNameEnc``) and is interpolated into the
posting AFTER the chat, in the NestJS layer — the AI service never sees it, never
sends it to an LLM, and never stores it in conversation state. Asking for it in free
text would (a) duplicate data we hold, and (b) invite the payer to type a personal
name or contact alongside it. ``tests/test_job_posting_chat.py`` asserts the absence
mechanically over every string in this module, so the rule survives a future edit
that forgets this paragraph.

OPTIONS ARE ANSWERS, NEVER QUESTIONS. A tapped chip is sent verbatim as the payer's
message, so every option here becomes the payer's answer of record. Three topics
carry options and they are exactly the three with a genuinely CLOSED answer space:
``vacancy`` (the five ADR-0012 bands), ``shift`` (the three ``jobs.shift`` enum
values) and ``benefits`` (standard statutory/site offerings). Every option is
executed against ``answers.detect_answers`` by the test suite and must resolve ITS
OWN topic. The open-ended topics — ``role_title``, ``location_label``, ``skills``,
``pay_range``, ``requirements``, ``description`` — carry NONE: any four role titles,
cities or pay figures we picked would be four we put in the employer's mouth.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Topic:
    id: str
    label: str
    # Professional employer-facing phrasing, served directly on the mock/templated
    # path (which is every path today — see prompts.py).
    question: str
    why: str | None = None  # short reason, surfaced if the payer asks "why"
    # Ask PRIORITY: core topics are served before optional ones. Readiness itself is
    # the engine's ESSENTIAL_TOPICS / MUST_ASK_TOPICS, not this flag.
    core: bool = False
    # Wording for the ONE bounded RE-ask of an unanswered ESSENTIAL topic (engine
    # MAX_ASKS_PER_TOPIC = 2). A UX rewording — re-serving an identical string reads
    # as broken — and NOT a detection fix. Only ESSENTIAL topics carry one; every
    # other topic is asked once and never re-asked, so they leave this None.
    retry_question: str | None = None
    # Tap-to-answer options for THIS topic — short ANSWERS, never questions. See the
    # module docstring: only closed-answer-space topics carry any.
    options: tuple[str, ...] = ()


# The ordered bank. Reading order only — the ENGINE's ask order is
# ``interview_engine._next_topic``'s strict priority (unanswered essential -> core
# -> optional), so the first questions a payer actually sees are the three
# essentials, whatever their position here.
_TOPICS: list[Topic] = [
    Topic(
        "role_title",
        "Role title",
        "Which role are you hiring for?",
        core=True,
        retry_question="What is the job title — for example CNC Operator, MIG Welder or Plumber?",
    ),
    Topic(
        "skills",
        "Required skills",
        "Which skills or machines must the candidate know?",
        why="So we can match workers who can actually do this job.",
        core=True,
    ),
    Topic(
        "location_label",
        "Work location",
        "Which city is this job in?",
        core=True,
        retry_question="Which city and area is the workplace in — for example Pune, Chakan?",
    ),
    Topic(
        "vacancy",
        "Number of openings",
        "How many people do you need for this role?",
        core=True,
        retry_question="Roughly how many openings — 1, 2-5, 6-10, 11-25 or more than 25?",
        # The five ADR-0012 bands, verbatim. Tapping one IS the banded answer, so
        # this chip set cannot fabricate a head count the employer did not choose.
        options=("1", "2-5", "6-10", "11-25", "25+"),
    ),
    Topic(
        "pay_range",
        "Monthly pay range",
        "What is the monthly pay range for this role?",
        why="Workers filter on pay — a range gets far more applications than a blank.",
        core=True,
    ),
    Topic(
        "shift",
        "Shift",
        "Which shift is this — day, night or rotational?",
        # The closed `jobs.shift` enum (day/night/rotational), title-cased.
        options=("Day", "Night", "Rotational"),
    ),
    Topic(
        "benefits",
        "Benefits",
        "Which benefits are included — PF, ESI, canteen, transport or accommodation?",
        options=("PF + ESI", "Canteen", "Transport", "Accommodation"),
    ),
    Topic(
        "requirements",
        "Requirements",
        "What experience or qualification must candidates have?",
    ),
    Topic(
        "description",
        "Job description",
        "Anything else about the day-to-day work that candidates should know?",
    ),
]


# --- Opening ---------------------------------------------------------------
# A SHORT greeting that asks only the first (role) question. Same discipline as the
# worker opener: it is never posted into the transcript as an assistant answer, it
# holds exactly one "?", and it names no example values — so it cannot self-answer a
# topic. It carries NO vocative and NO organisation name, which is what keeps the
# opening endpoint PII-free by construction.
#
# It DOES ask the bank's first question, which is why `interview_engine.next_turn`
# attributes the payer's FIRST message to that topic (see _OPENER_TOPIC_ID there).
# Without that, the payer answers the role question and is immediately asked it
# again — the single most trust-destroying thing a chat product can do.
OPENING_MESSAGE: str = (
    "Let's build your job posting. I'll ask a few short questions. "
    "First — which role are you hiring for?"
)


def opening_message_for(trade_hint: str | None = None) -> str:
    """The opening line. Takes ``trade_hint`` so a trade-specific opener can be
    added later without a caller change; today the copy is shared."""
    _ = topics_for(trade_hint)  # keeps the hint on the resolution path
    return OPENING_MESSAGE


def topics_for(trade_hint: str | None = None) -> list[Topic]:
    """The topic bank. ONE bank today — see the module docstring for why the
    six-family split the worker bank uses does not apply to a job posting."""
    return _TOPICS


def topic_by_id(topic_id: str, trade_hint: str | None = None) -> Topic | None:
    for topic in topics_for(trade_hint):
        if topic.id == topic_id:
            return topic
    return None


def options_for(topic_id: str | None, trade_hint: str | None = None) -> list[str]:
    """Tap-to-answer options for the topic just asked — ``[]`` when there are none.

    ``[]`` is the correct and COMMON answer: no topic asked yet (the wrap-up turn),
    or a topic with an open answer space. Returning a generic list instead is the
    defect the worker bank's ``_FOLLOWUPS`` constant shipped — it fabricated answers.
    """
    if not topic_id:
        return []
    topic = topic_by_id(topic_id, trade_hint)
    return list(topic.options) if topic else []


def topic_ids(trade_hint: str | None = None) -> tuple[str, ...]:
    return tuple(t.id for t in topics_for(trade_hint))
