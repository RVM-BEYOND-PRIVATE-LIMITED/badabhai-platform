"""Measurement harness for the deterministic profiling parser (no runtime change).

Runs every fixture in :mod:`profiling_answer_corpus` through
``signals.detect_answered_topics(text, asked_topic_id)`` — exactly the call the
interview engine makes (``interview_engine.next_turn`` passes the LAST ASKED topic
id) — and scores four things:

1. **acceptance** — did the asked topic come back in the result?
2. **gaps** — fixtures a human marked ``accept`` that the parser did NOT accept.
3. **fabrications** — fixtures a human marked ``reject`` where the parser recorded
   a VALUE anyway (it invented data the worker did not give).
4. **cross-topic marks** — topics OTHER than the asked one that the answer marked
   answered. These matter because ``interview_engine._next_topic`` never returns a
   topic already in ``answered_topics``, so a wrong mark permanently closes a topic
   the worker was never asked about.

THIS RUN IS **POST-#426**. The first revision of this harness measured the parser at
commit ``6d23419``; PR #426 ("P1 profiling correctness", ``fea207d``) then fixed four
of the defect classes it found, and PR #412 (TAX-WELD-1, ``41d0cb7``) added welding to
the gazetteer. Everything below is re-measured against the CURRENT parser. The
pre-#426 numbers are retained ONLY as a labelled historical column in
:data:`POST_426_DELTA` — never re-derived, never presented as current.

ZERO network. ZERO LLM calls. Deterministic — the parser is pure regex + gazetteer.

Regenerate the committed report with::

    cd apps/ai-service && python tests/analysis_parser_coverage.py --write

or print it to stdout with no flag.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:  # allow `python tests/analysis_parser_coverage.py`
    sys.path.insert(0, str(_HERE.parent))
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from profiling_answer_corpus import CORPUS, TOPIC_ORDER, AnswerFixture  # noqa: E402

from app.profiling import interview_engine, signals  # noqa: E402

REPORT_PATH = (
    _HERE.parents[2] / "docs" / "ai" / "profiling-parser-coverage.md"
)


class _Missing:
    """Sentinel: ``detect_answered_topics`` did not key the asked topic at all."""

    __slots__ = ()

    def __repr__(self) -> str:  # rendered straight into the report tables
        return "_topic not marked_"


MISSING = _Missing()

# A human-correct value that cannot be written as a single scalar the current
# contract can even hold (a RANGE, a RELATIVE demand, a LIST where the field is a
# scalar). Rows carrying this are open by construction, not by measurement.
UNEXPRESSIBLE = object()


def recorded_value(text: str, topic: str) -> object:
    """What the parser stores for ``topic`` when ``topic`` is the question on screen.

    ``MISSING`` when the topic is not marked at all; ``None`` when it IS marked but
    nothing is collected (P1-2: a denial answers the question it was asked).
    """
    detected = signals.detect_answered_topics(text, topic)
    return detected[topic] if topic in detected else MISSING


# Answers that ARE accepted, but whose recorded VALUE deserves the owner's eye.
# (text, asked topic, what a human reading the answer would record, that value)
# The 4th element is compared LIVE against the parser, so the "status" column in the
# report is measured on every run and can never be stale prose.
VALUE_WATCH: tuple[tuple[str, str, str, object], ...] = (
    ("2.5 saal", "experience", "2.5 years", 2.5),
    ("2 saal 6 mahine", "experience", "2.5 years", 2.5),
    ("ITI + 3 saal apprenticeship", "education",
     "education only; not 3 years of experience", ["ITI"]),
    ("1.5 lakh saal ka", "salary_current",
     "an ANNUAL 1.5L read as a monthly figure", 12500),
    ("18 se 20 hazar", "salary_current", "a range 18k-20k", UNEXPRESSIBLE),
    ("abhi se 5000 zyada", "salary_expected", "current + 5000, not 5000", UNEXPRESSIBLE),
    ("30-35k", "salary_expected", "a range 30k-35k", UNEXPRESSIBLE),
    ("setting nahi aati, sirf chalata hu", "skills",
     "operation only — setting explicitly NOT known", ["machine operation"]),
    ("Pune, Chakan, Ranjangaon", "preferred_locations", "three locations", UNEXPRESSIBLE),
    ("Peenya, Bangalore", "current_location",
     "one city (Bangalore), area = Peenya", "Bangalore"),
    ("Noida sector 63", "current_location", "Noida", "Noida"),
)

# --- POST-#426 delta ---------------------------------------------------------
#
# HISTORICAL RECORD + LIVE RE-MEASUREMENT.
#
# `before` is what THIS harness measured on the parser as it stood at commit
# 6d23419 — the STAGE 0 report published in the first revision of this PR. It is a
# static record of a measurement that WAS taken; it is never re-derived here and it
# is never presented as current behaviour.
#
# `want` is the human-correct value. The report's verdict column is computed LIVE by
# comparing the parser's CURRENT output against `want`, so "FIXED" is measured on
# every run — if a later change regresses one of these, the verdict flips and
# test_post_426_delta_is_measured_not_asserted fails.
#
# (asked topic, worker answer, pre-#426 recorded, want, note)
POST_426_DELTA: tuple[tuple[str, str, str, object, str], ...] = (
    ("experience", "2.5 saal", "5.0", 2.5,
     "P1-3: the years regex had no left boundary and matched the decimal's 2nd digit"),
    ("salary_current", "1.5 lakh saal ka", "150000", 12500,
     "P1-3: an ANNUAL figure was stored as a MONTHLY one"),
    ("salary_current", "2012 se kaam kar raha hu", "2012", MISSING,
     "P1-3: a bare 1900-2099 year is only money when the text says money"),
    ("experience", "22000 salary milti hai", "0.0", MISSING,
     "P1-3: 'sal' matched inside 'salary'; the added \\b stops it"),
    ("education", "iti nahi kiya, kaam se hi seekha", "['ITI']", None,
     "P1-2: the denial no longer asserts its opposite; topic answered, nothing stored"),
    ("education", "diploma nahi hai", "['Diploma']", None,
     "P1-2: same — a denial IS a complete answer to the education question"),
    ("skills", "setting nahi aati, sirf chalata hu",
     "['machine operation', 'basic setting']", ["machine operation"],
     "P1-2: 'basic setting' is gone; the asserted 'chalata hu' survives"),
)

# The negation gap #426 deliberately did NOT close. Verdict is measured, not asserted:
# a row is OPEN when the DENIED token still shows up in what the parser recorded.
# (asked topic, worker answer, the token the worker DENIED, cue family, note)
NEGATION_PROBE: tuple[tuple[str, str, str, str, str], ...] = (
    ("education", "iti nahi kiya, kaam se hi seekha", "ITI", "CAPABILITY", ""),
    ("education", "diploma nahi hai", "Diploma", "CAPABILITY", ""),
    ("skills", "setting nahi aati, sirf chalata hu", "basic setting", "CAPABILITY",
     "the contrastive positive 'chalata hu' is kept"),
    ("skills", "program edit nahi aata", "program editing", "CAPABILITY", ""),
    ("role", "setter nahi hu", "Setter", "CAPABILITY", ""),
    ("role", "CNC nahi, VMC karta hu", "CNC", "CAPABILITY",
     "backward-only window: the contrast VMC is preserved, which is the point"),
    ("machines", "vmc nahi chalaya kabhi", "VMC", "CAPABILITY",
     "`machines` correctly not marked — but see the cross-topic note below"),
    ("controllers", "fanuc nahi, siemens hai", "Fanuc", "CAPABILITY", ""),
    ("current_location", "Pune nahi, Delhi mein hu", "Pune", "VALUE",
     "records the city the worker LEFT — and files Delhi as a PREFERENCE"),
    ("current_location", "Pune mein nahi rehta", "Pune", "VALUE", ""),
    ("preferred_locations", "Pune nahi jaunga", "Pune", "VALUE",
     "records a refusal as a preference"),
    ("availability", "abhi turant nahi, 1 mahina lagega", "immediate", "VALUE",
     "records the OPPOSITE of what the worker said"),
    ("availability", "turant nahi aa sakta", "immediate", "VALUE", ""),
    ("salary_current", "22000 nahi milta", "22000", "VALUE", ""),
    ("salary_expected", "25000 nahi chahiye, 30000 chahiye", "25000", "VALUE",
     "first-number-wins AND negation-blind: it stores the figure they REFUSED"),
    ("experience", "2 saal nahi hua abhi", "2.0", "VALUE", ""),
)

# Probes for findings this re-run surfaced that no corpus fixture covers.
# (asked topic, worker answer, note) — the recorded value is rendered live.
NEW_FINDING_PROBE: tuple[tuple[str, str, str], ...] = (
    ("machines", "welding machine",
     "`machines` NOT marked, but `role`+`skills` are closed on a welding read"),
    ("machines", "kabhi", "'abhi' is substring-matched inside 'kabhi'"),
    ("machines", "kabhi kabhi", "'sometimes' reads as 'available immediately'"),
    ("availability", "kabhi bhi", "'whenever' reads as 'immediately' — right answer, wrong reason"),
)

# Two scripted interviews, run through the REAL engine (mock mode, no network), to
# show the end-to-end consequence of the parser's coverage. Keyed by topic id: when
# the engine asks topic X the simulated worker replies with SCRIPT[X].
SCRIPT_PLAUSIBLE: dict[str, str] = {
    "role": "CNC operator",
    "machines": "cnc",
    "experience": "char saal",
    "skills": "sab aata hai",
    "current_location": "Chakan",
    "preferred_locations": "ghar ke paas hi chahiye",
    "controllers": "fanuk",
    "salary_current": "15 hazaar",
    "salary_expected": "jo aap theek samjhe",
    "availability": "do mahine baad",
    "education": "10th pass",
}
SCRIPT_GAZETTEER_FRIENDLY: dict[str, str] = {
    "role": "VMC operator",
    "machines": "VMC",
    "experience": "4 saal",
    "skills": "setting aata hai",
    "current_location": "Pune",
    "preferred_locations": "kahin bhi chalega",
    "controllers": "Fanuc",
    "salary_current": "22000",
    "salary_expected": "30k chahiye",
    "availability": "15 din",
    "education": "ITI kiya hai",
}
# Same gazetteer-friendly worker, except the current_location answer misses, so the
# interview does NOT wrap up early and runs on to `education`. This script USED to
# demonstrate the P1-1 overwrite defect (experience 10 -> 3). Post-#426 it is the
# regression guard for the fix: the incidental "3 saal" inside the EDUCATION answer
# must no longer displace the established experience value.
SCRIPT_LATE_OVERWRITE: dict[str, str] = {
    **SCRIPT_GAZETTEER_FRIENDLY,
    "current_location": "gaon mein",
    "experience": "10 saal",
    "education": "ITI + 3 saal apprenticeship",
}
# Same again, but the worker marks the last answer as an EXPLICIT correction. Shows
# the other half of the overwrite rule — a correction still commits — and its cost:
# the marker is scoped to the whole MESSAGE, so a correction aimed at `education`
# also unlocks the incidental `experience` overwrite it happens to carry.
SCRIPT_LATE_CORRECTION: dict[str, str] = {
    **SCRIPT_LATE_OVERWRITE,
    "education": "nahi nahi, ITI + 3 saal apprenticeship",
}
_FALLBACK_REPLY = "haan ji"


# Authored analysis. Every claim below is demonstrated by a fixture in this report,
# by a probe table above, or locked by an assertion in
# tests/test_profiling_parser_coverage.py. Line numbers are as of the commit that
# last updated this file (POST-#426 / POST-#412).


def _findings(rows: list[Measurement]) -> str:
    """The authored narrative, with every COUNT computed from this run.

    Nothing here is a remembered number: the auto-close count and the negation
    verdicts are derived from the live parser, so the prose cannot drift away from
    the tables underneath it.
    """
    role_machine = [m for m in rows if m.fixture.topic in ("role", "machines")]
    auto_skills = [m for m in role_machine if "skills" in m.detected]
    cap_open = [r for r in NEGATION_PROBE if r[3] == "CAPABILITY" and _negation_is_open(r)]
    val_rows = [r for r in NEGATION_PROBE if r[3] == "VALUE"]
    val_open = [r for r in val_rows if _negation_is_open(r)]
    delta_open = [r for r in POST_426_DELTA if recorded_value(r[1], r[0]) != r[3]]
    n_fixed = len(POST_426_DELTA) - len(delta_open)

    return f"""
## Findings — this is a POST-#426 re-measurement

The first revision of this report measured the parser at commit `6d23419`. Two PRs
have landed on it since, and this run re-measures against both:

- **#426** (`fea207d`, "P1 profiling correctness") fixed four of the defect classes
  this report found — value parsing, negation on capability cues, the overwrite rule,
  and test-time network egress.
- **#412** (`41d0cb7`, TAX-WELD-1) wired welding into the gazetteer, which changes one
  corpus row and the `role` retry wording.

**The defects are not deleted from this report.** The section "What #426 changed"
keeps the pre-fix value beside the current one, because the record of what was wrong
is half the value of having measured it. What follows separates FIXED from STILL
OPEN, and every verdict is computed from the live parser on each run: **{n_fixed} of
the {len(POST_426_DELTA)}** recorded defect cases re-measure as fixed.

**Overall acceptance did not move.** #426 fixed what the parser RECORDS, not what it
RECOGNISES: coverage is unchanged at the rate in the table below. Every finding in
sections 1-3 stands exactly as first written.

### 1. Why `CNC` is rejected for `role` — the exact code path (UNCHANGED, still open)

`detect_answered_topics` keys the `role` topic on ONE field:

    if sig.role_id:
        answered["role"] = sig.primary_role
    # app/profiling/signals.py:993-994

`role_id` is set by a first-match-wins scan of the `_ROLES` gazetteer
(`signals.py:716-722`) over the lowercased text. `_ROLES` (`signals.py:79-88`)
contains eight keywords:

    cam programmer · programmer · setter · vmc · hmc · grinding · turner · turning

There is **no `cnc` keyword and no `operator` keyword**. So `"CNC"` sets no
`role_id` and the topic is not marked. `"CNC"` is also absent from `_MACHINES`
(`signals.py:27-36`, which has `cnc lathe` but no bare `cnc`), so the answer falls
through BOTH tables and `detect_answered_topics("CNC", "role")` returns `{{}}` —
nothing at all is recorded from it.

The worse variant is `"CNC operator"`, the single most likely thing a worker types.
`operator` is not a role keyword, but it IS an operation-knowledge cue
(`signals.py:744-746`), which appends `"machine operation"` to `sig.skills`, which
makes `detect_answered_topics` mark **`skills`** answered (`signals.py:1001-1002`).
So the canonical answer to the role question:

- leaves `role` unanswered → it is re-asked once (`MAX_ASKS_PER_TOPIC = 2`,
  `interview_engine.py:50`) and then abandoned;
- silently marks `skills` answered with `["machine operation"]` — and
  `_next_topic` never returns an already-answered topic
  (`interview_engine.py:490/496/501`), so **the skills question is never asked**.

Both effects are visible in scripted interview A below. #426 did not touch the
gazetteer, the question bank or topic ordering, so this is exactly as first measured.

### 2. The conflation hypothesis — CONFIRMED (UNCHANGED, still open)

The shipped question (`app/profiling/question_bank.py:80`) is:

> Aap kaunsa kaam karte hain — CNC, VMC, HMC operator, setter ya programmer?

It offers a five-item list that mixes two different dimensions: **machine type**
(CNC, VMC, HMC) and **job function** (operator, setter, programmer). Asking
"kaunsa kaam" (which work) and then listing machine types invites a machine-type
answer.

Measured against the parser, each option resolves `role` as follows
(`test_role_question_offers_options_the_parser_cannot_resolve`):

| option offered | dimension | resolves `role`? |
| --- | --- | :---: |
| CNC | machine type | **NO** |
| VMC | machine type | yes (→ "VMC Operator") |
| HMC | machine type | yes (→ "HMC Operator") |
| operator | job function | **NO** |
| setter | job function | yes |
| programmer | job function | yes |

So the conflation is not only in the question — it is baked into the gazetteer,
inconsistently. Two of the three machine types (`vmc`, `hmc`) are stored AS roles,
mapping to "VMC Operator"/"HMC Operator"; the third (`cnc`) is not. And of the
three job functions, the most generic one (`operator`) is the one that fails.

**Two of the six options the question puts in the worker's mouth cannot be
parsed** — and they are the two a worker is most likely to repeat back, because
"CNC" is the first word in the list and "operator" is the word most workers use
for their own job.

The retry wording still does not rescue this, and #412 widened it rather than fixing
it. `role.retry_question` (`question_bank.py:90-92`) is now "Machine ya kaam ke naam
se bataiye — VMC operator, CNC turner, setter, programmer ya welder?" — it drops
"CNC" and bare "operator" and adds "welder", and every option it offers does resolve.
The parseable prompt still only arrives on the SECOND attempt, after the honest first
answer was silently dropped.

### 3. Dead topics (UNCHANGED)

**None.** All 11 topics are satisfied by at least one plausible answer
(`test_no_topic_is_structurally_dead`). The failure mode measured here is partial
coverage, not structural deadness. Two adjacent hazards are real, though:

- **auto-closed topics** — `skills` is marked answered by {len(auto_skills)} of the
  {len(role_machine)} role/machine answers without ever being asked, so in practice
  it is frequently a topic the worker never sees;
- **early wrap-up** — the engine stops as soon as `_extraction_ready` holds, so a
  worker whose four essentials land in the first few turns is never asked about
  salary, availability, controllers or education at all (scripted interview B:
  seven of eleven topics never asked).

### 4. A later answer OVERWRITES an already-collected value — **FIXED by #426**

Found while measuring, not part of the original brief. `next_turn` guarded the
ANSWERED list but not the COLLECTED map, so any later message that re-triggered a
detector overwrote the earlier value, last-mention-wins. A worker answered
`experience` with "10 saal"; their answer to the LAST question ("ITI + 3 saal
apprenticeship") reset `collected["experience"]` to `3.0`. A ten-year machinist
shipped as a three-year one, with no signal that anything was replaced.

`interview_engine._may_commit` (`interview_engine.py:113-150`) now gates the write:
the topic BEING ASKED always commits; an explicit correction
(`signals.is_correction`) always commits; otherwise **first write wins** — an
incidental cross-topic signal may fill an EMPTY slot but never overwrite an
established one. Scripted interview C below is the regression guard: the same script
that used to end at `experience = 3.0` now ends at `10.0`.

**Residual, measured here, not fixed by #426:** the correction marker is scoped to
the whole MESSAGE, not to a span. Interview D is interview C with "nahi nahi," in
front of the education answer — the correction is aimed at `education`, but it
unlocks the incidental `experience` overwrite riding along in the same sentence, and
experience drops back to `3.0`. A worker correcting one field can still silently
rewrite another.

### 5. Negation — **CAPABILITY cues fixed by #426, VALUE cues STILL OPEN**

Originally: negation was invisible everywhere, so a denial asserted its own opposite
("iti nahi kiya" → `education=['ITI']`).

`signals._apply_negation` now blanks a negated span — a {signals._NEGATION_BACK_WORDS}-word
BACKWARD window from the negator, clamped to the clause, because Hindi/Hinglish puts
the negator AFTER what it negates — before the cue tables run. Backward-only is
deliberate: a forward window would eat the contrast in "CNC nahi, VMC karta hu",
which is the value the worker IS asserting. For `education` and `skills` a denial now
also ANSWERS the ask with value `None` (`signals._NEGATION_ANSWERS_TOPICS`): the topic
is marked answered, nothing is collected, and it is not mistaken for silence.

**Measured verdict on the {len(NEGATION_PROBE)} probes below: \
{len(cap_open)} of the {len(NEGATION_PROBE) - len(val_rows)} CAPABILITY probes are \
still open, and {len(val_open)} of the {len(val_rows)} VALUE probes are.**

The masking is applied ONLY to the capability cue families (role / machines /
controllers / skills / knowledge / education). `signals.detect` states the exclusion
in code: location, availability, salary and experience deliberately keep reading the
ORIGINAL text, because masking them cost real answers in the first measurement
("Pune se bahar nahi jaunga" loses Pune) and their negation was out of #426's scope.

So the parser is **still recording the opposite of what the worker said** for those
four topics:

| the worker says | the profile records |
| --- | --- |
| `Pune nahi, Delhi mein hu` | current_location **Pune** (+ Delhi as a *preference*) |
| `Pune nahi jaunga` | preferred_locations **['Pune']** |
| `abhi turant nahi, 1 mahina lagega` | availability **immediate** |
| `22000 nahi milta` | salary_current **22000** |
| `25000 nahi chahiye, 30000 chahiye` | salary_expected **25000** — the figure REFUSED |
| `2 saal nahi hua abhi` | experience **2.0** |

This is a **known, disclosed, OPEN gap**, not a fixed one, and it is the largest
remaining correctness item on this parser: unlike a coverage gap (which leaves a
field empty and re-askable) a negation miss writes a confidently wrong value onto a
worker's resume. See "Suggested next steps" for the shape of a fix — this PR
deliberately implements nothing.

### 6. New findings this re-run exposed

1. **`welding machine` closes `role` and `skills` while leaving `machines` open.**
   Asked "kaunsi machine", the answer "welding machine" is not in `_MACHINES`, so the
   asked topic stays unanswered — but the TAX-WELD-1 path reads it as `role=Welder`,
   `skills=['welding']`. Attributed to **#412, not #426**. For a worker in the
   CNC/VMC family this fills `role` from a MACHINE answer, and under the new
   first-write-wins rule that value then sticks unless `role` was already set.
2. **`kabhi` is read as `abhi`.** The availability cue is a plain substring test, so
   "kabhi" (ever), "kabhi kabhi" (occasionally) and "kabhi bhi" (whenever) all set
   `availability = immediate`. Pre-existing and NOT caused by #426 — no corpus fixture
   covered it, and probing for the negation gap surfaced it. It is also why
   "vmc nahi chalaya kabhi" marks availability even though negation correctly
   suppressed `machines`.
3. **`salary_expected` stores the refused number.** "25000 nahi chahiye, 30000
   chahiye" records 25000: the parser is both first-number-wins and negation-blind,
   and the two compose into the worst available answer.
4. **The correction marker is message-scoped** — see the residual in section 4.
"""


@dataclass(frozen=True)
class Measurement:
    fixture: AnswerFixture
    detected: dict[str, object]

    @property
    def accepted(self) -> bool:
        return self.fixture.topic in self.detected

    @property
    def cross_topics(self) -> list[str]:
        return sorted(t for t in self.detected if t != self.fixture.topic)

    @property
    def is_gap(self) -> bool:
        """Human said this answers the question; the parser disagreed."""
        return self.fixture.expected == "accept" and not self.accepted

    @property
    def records_value(self) -> bool:
        """Marked answered AND something was written to ``collected``.

        The distinction matters post-#426: a denial on `education`/`skills` now marks
        the topic answered with value ``None`` — the ask is satisfied, nothing is
        stored. Counting that as a "false positive" alongside a FABRICATED value would
        hide the fix.
        """
        return self.accepted and self.detected[self.fixture.topic] is not None

    @property
    def is_fabrication(self) -> bool:
        """Human said there is nothing to record; the parser recorded a VALUE anyway.

        The dangerous class: data the worker never gave, on a topic that is now closed
        and will never be re-asked.
        """
        return self.fixture.expected == "reject" and self.records_value

    @property
    def is_denial_absorbed(self) -> bool:
        """Human said there is nothing to record; the parser agreed, but closed the ask.

        Post-#426 designed behaviour for `education`/`skills`, where "no" is itself a
        complete answer. Benign where the denial really does answer the question —
        listed separately so it can be judged, not hidden inside a headline number.
        """
        return self.fixture.expected == "reject" and self.accepted and not self.records_value


def measure_one(fixture: AnswerFixture) -> Measurement:
    detected = signals.detect_answered_topics(fixture.text, fixture.topic)
    return Measurement(fixture, detected)


def measure_all(corpus: tuple[AnswerFixture, ...] = CORPUS) -> list[Measurement]:
    return [measure_one(f) for f in corpus]


@dataclass(frozen=True)
class SimulatedInterview:
    """One scripted interview run through the REAL engine (mock mode, no network)."""

    transcript: list[tuple[str, str]]  # (asked topic id, worker reply)
    answered: list[str]
    unanswered_essentials: list[str]
    collected: dict[str, object]
    never_asked: list[str]
    extraction_ready: bool
    turns: int


def simulate(script: dict[str, str], role_family: str = "cnc_vmc") -> SimulatedInterview:
    """Drive ``interview_engine.next_turn`` with scripted replies.

    Faithful to production: the engine picks the topic, the simulated worker answers
    THAT topic (falling back to a neutral filler if the script has no line for it),
    and the loop stops when the engine wraps up. No LLM, no network — mock mode is
    the straight path (COST-4).
    """
    state = None
    reply = ""
    transcript: list[tuple[str, str]] = []
    ready = False
    guard = interview_engine.MAX_INTERVIEW_TURNS + 5
    for _ in range(guard):
        _msg, asked, state, ready = interview_engine.next_turn(
            state, reply, role_family, worker_name=None
        )
        if asked is None:
            break
        reply = script.get(asked, _FALLBACK_REPLY)
        transcript.append((asked, reply))
    assert state is not None
    asked_ids = set(state.asked_question_ids)
    return SimulatedInterview(
        transcript=transcript,
        answered=list(state.answered_topics),
        unanswered_essentials=list(state.unanswered_essentials),
        collected=dict(state.collected),
        never_asked=[t for t in TOPIC_ORDER if t not in asked_ids],
        extraction_ready=ready,
        turns=state.turn_count,
    )


def _fmt_value(value: object) -> str:
    text = str(value)
    return text if len(text) <= 40 else text[:37] + "..."


def _negation_is_open(row: tuple[str, str, str, str, str]) -> bool:
    """Did the parser record the very token the worker DENIED?

    A measured predicate, deliberately crude and therefore hard to fool: render what
    the parser stored for the asked topic and look for the denied token in it. No
    remembered verdicts — re-run and the answer is recomputed from the live parser.
    """
    topic, text, denied, _family, _note = row
    return denied.lower() in repr(recorded_value(text, topic)).lower()


def _per_topic_rows(rows: list[Measurement]) -> list[tuple[str, int, int, int, float]]:
    out: list[tuple[str, int, int, int, float]] = []
    for topic in TOPIC_ORDER:
        subset = [m for m in rows if m.fixture.topic == topic]
        should_accept = [m for m in subset if m.fixture.expected == "accept"]
        accepted = [m for m in should_accept if m.accepted]
        rate = (len(accepted) / len(should_accept)) if should_accept else 0.0
        out.append((topic, len(subset), len(should_accept), len(accepted), rate))
    return out


def build_report(rows: list[Measurement]) -> str:
    lines: list[str] = []
    add = lines.append

    total = len(rows)
    should_accept = [m for m in rows if m.fixture.expected == "accept"]
    accepted = [m for m in should_accept if m.accepted]
    gaps = [m for m in rows if m.is_gap]
    fabrications = [m for m in rows if m.is_fabrication]
    denials = [m for m in rows if m.is_denial_absorbed]

    add("# Deterministic profiling parser — coverage measurement (POST-#426)")
    add("")
    add("> **Measurement only. The PR carrying this report changes ZERO runtime files** —")
    add("> it touches `tests/` and `docs/` only. Where a fix looks warranted it is written")
    add("> down under \"Suggested next steps\", not implemented.")
    add(">")
    add("> **Re-measured against `origin/main` AFTER PR #426** (`fea207d`, P1 profiling")
    add("> correctness) and PR #412 (`41d0cb7`, TAX-WELD-1). The first revision of this")
    add("> report measured commit `6d23419`; those numbers survive only as the labelled")
    add("> `pre-#426` column below, never as current behaviour.")
    add(">")
    add("> Generated by `apps/ai-service/tests/analysis_parser_coverage.py` from the")
    add("> synthetic corpus in `apps/ai-service/tests/profiling_answer_corpus.py`.")
    add("> Regenerate: `cd apps/ai-service && python tests/analysis_parser_coverage.py --write`.")
    add("")
    add("## What was measured")
    add("")
    add("Each synthetic worker answer is passed to")
    add("`app/profiling/signals.py::detect_answered_topics(text, last_asked_topic_id)`")
    add("with `last_asked_topic_id` set to the topic that was ASKED — the same call")
    add("`app/profiling/interview_engine.py::next_turn` makes (it passes")
    add("`st.asked_question_ids[-1]`). A topic counts as ACCEPTED when the asked topic id")
    add("is a key in the returned dict; that is exactly the condition under which")
    add("`next_turn` appends it to `ConversationState.answered_topics`.")
    add("")
    add(f"- Fixtures: **{total}** across **{len(TOPIC_ORDER)}** topics.")
    add(f"- Human-labelled `accept` (a valid answer): **{len(should_accept)}**.")
    add(f"- Of those, parser accepted: **{len(accepted)}** "
        f"(**{len(accepted) / len(should_accept):.0%}** overall).")
    add(f"- Parser gaps (valid answer, not accepted): **{len(gaps)}**.")
    add(f"- **Fabrications** (nothing to record, parser stored a VALUE): "
        f"**{len(fabrications)}**.")
    add(f"- Denials absorbed (nothing to record, topic marked answered, nothing stored): "
        f"**{len(denials)}**.")
    add("")
    add("The last two lines were ONE number (\"false positives\") in the pre-#426 report.")
    add("They are split here because #426 changed the meaning: a denial on `education` /")
    add("`skills` now marks the ask satisfied with value `None` instead of inventing")
    add("`['ITI']`. Reporting both under one heading would have shown an unchanged count")
    add("and hidden a real fix.")
    add("")
    add("Zero LLM calls; the path under test is pure regex + gazetteer.")
    add("")

    add(_findings(rows))

    add("## What #426 changed — measured before / after")
    add("")
    add("`pre-#426` is what THIS harness recorded at commit `6d23419`: a static record of")
    add("a measurement that was taken, kept deliberately so the report still shows what")
    add("was wrong. `now` and the verdict are recomputed live on every run — a verdict of")
    add("FIXED is measured, never asserted, and a later regression flips it back to OPEN.")
    add("")
    add("| asked topic | worker answer | pre-#426 | now | want | verdict |")
    add("| --- | --- | --- | --- | --- | --- |")
    for topic, text, before, want, _note in POST_426_DELTA:
        now = recorded_value(text, topic)
        verdict = "**FIXED**" if now == want else "**OPEN**"
        add(f"| `{topic}` | `{text}` | `{before}` | `{_fmt_value(now)}` | "
            f"`{_fmt_value(want)}` | {verdict} |")
    add("")
    for _topic, text, _before, _want, note in POST_426_DELTA:
        add(f"- `{text}` — {note}")
    add("")

    add("## Negation — fixed on CAPABILITY cues, STILL OPEN on VALUE cues")
    add("")
    add("A row is OPEN when the parser still records the very token the worker DENIED.")
    add("The predicate is crude on purpose (does the denied token appear in what was")
    add("stored?) so the verdict cannot be talked into being green.")
    add("")
    add("| cue family | asked topic | worker answer | denied | recorded now | verdict |")
    add("| --- | --- | --- | --- | --- | --- |")
    for row in NEGATION_PROBE:
        topic, text, denied, family, _note = row
        now = recorded_value(text, topic)
        verdict = "**OPEN**" if _negation_is_open(row) else "honoured"
        add(f"| {family} | `{topic}` | `{text}` | `{denied}` | `{_fmt_value(now)}` | "
            f"{verdict} |")
    add("")
    for row in NEGATION_PROBE:
        if row[4]:
            add(f"- `{row[1]}` — {row[4]}")
    add("")

    add("## Findings this re-run exposed (no corpus fixture covers these)")
    add("")
    add("| asked topic | worker answer | full detector output | note |")
    add("| --- | --- | --- | --- |")
    for topic, text, note in NEW_FINDING_PROBE:
        detected = signals.detect_answered_topics(text, topic)
        rendered = ", ".join(
            f"`{k}`={_fmt_value(v)}" for k, v in sorted(detected.items())
        ) or "_nothing_"
        add(f"| `{topic}` | `{text}` | {rendered} | {note} |")
    add("")

    add("## Per-topic acceptance")
    add("")
    add("| topic | fixtures | should accept | accepted | acceptance rate | gap count |")
    add("| --- | ---: | ---: | ---: | ---: | ---: |")
    for topic, n_all, n_should, n_acc, rate in _per_topic_rows(rows):
        n_gap = n_should - n_acc
        add(f"| `{topic}` | {n_all} | {n_should} | {n_acc} | {rate:.0%} | {n_gap} |")
    add("")

    add("## Topics ranked by gap size")
    add("")
    add("| rank | topic | gaps | acceptance rate | essential? |")
    add("| ---: | --- | ---: | ---: | --- |")
    essential = ("role", "machines", "experience", "current_location")
    ranked = sorted(_per_topic_rows(rows), key=lambda r: (-(r[2] - r[3]), r[0]))
    for i, (topic, _n_all, n_should, n_acc, rate) in enumerate(ranked, start=1):
        mark = "**ESSENTIAL**" if topic in essential else ("MUST_ASK"
               if topic == "preferred_locations" else "optional")
        add(f"| {i} | `{topic}` | {n_should - n_acc} | {rate:.0%} | {mark} |")
    add("")

    add("## Rejected answers a human would call valid (the parser gaps)")
    add("")
    for topic in TOPIC_ORDER:
        topic_gaps = [m for m in gaps if m.fixture.topic == topic]
        if not topic_gaps:
            continue
        add(f"### `{topic}` — {len(topic_gaps)} gap(s)")
        add("")
        add("| worker answer | register | detected instead | note |")
        add("| --- | --- | --- | --- |")
        for m in topic_gaps:
            detected = (
                ", ".join(f"`{k}`" for k in sorted(m.detected)) if m.detected else "_nothing_"
            )
            note = m.fixture.note or ""
            add(f"| `{m.fixture.text}` | {m.fixture.register} | {detected} | {note} |")
        add("")

    add("## Fabrications — nothing to record, but the parser stored a VALUE")
    add("")
    add("The most dangerous class: `interview_engine._next_topic` never returns a topic")
    add("already in `answered_topics`, so the topic is closed for the rest of the")
    add("interview, the real value is never collected, and an invented one ships.")
    add("")
    if fabrications:
        add("| asked topic | worker answer | parser recorded | note |")
        add("| --- | --- | --- | --- |")
        for m in fabrications:
            recorded = ", ".join(
                f"`{k}`={_fmt_value(v)}" for k, v in sorted(m.detected.items())
            )
            add(f"| `{m.fixture.topic}` | `{m.fixture.text}` | {recorded} | {m.fixture.note} |")
    else:
        add("**None in this corpus.** The pre-#426 report listed two —")
        add("`iti nahi kiya, kaam se hi seekha` → `education=['ITI']` and")
        add("`diploma nahi hai` → `education=['Diploma']`. Both are now in the table")
        add("below instead: the topic is still closed, but nothing is written.")
    add("")

    add("## Denials absorbed — ask satisfied, nothing stored")
    add("")
    add("Post-#426 designed behaviour (`signals._NEGATION_ANSWERS_TOPICS`) for the two")
    add("topics where \"no\" is itself a complete answer. The topic is marked answered with")
    add("value `None`, so it is not re-asked and not mistaken for silence, and nothing")
    add("reaches `collected`. Listed rather than folded into a headline number so the")
    add("closing of the ask stays visible and reviewable.")
    add("")
    if denials:
        add("| asked topic | worker answer | recorded | note |")
        add("| --- | --- | --- | --- |")
        for m in denials:
            add(f"| `{m.fixture.topic}` | `{m.fixture.text}` | "
                f"`{_fmt_value(m.detected[m.fixture.topic])}` | {m.fixture.note} |")
    else:
        add("_None in this corpus._")
    add("")

    add("## Cross-topic marks — answer accepted for a topic that was NOT asked")
    add("")
    add("Same mechanism as above, but triggered by a legitimate answer. A cross-topic")
    add("mark is only safe when the worker really did volunteer that other topic.")
    add("")
    cross = [m for m in rows if m.cross_topics]
    counter: Counter[tuple[str, str]] = Counter()
    for m in cross:
        for t in m.cross_topics:
            counter[(m.fixture.topic, t)] += 1
    add("| asked topic | also marked | occurrences |")
    add("| --- | --- | ---: |")
    for (asked, other), n in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0])):
        add(f"| `{asked}` | `{other}` | {n} |")
    add("")
    add("### The dangerous subset: answer accepted ONLY for another topic")
    add("")
    add("The asked topic stays unanswered (so it is re-asked, then abandoned) **and** an")
    add("unrelated topic is silently closed on evidence the worker never gave.")
    add("")
    add("| asked topic | worker answer | marked instead |")
    add("| --- | --- | --- |")
    for m in rows:
        if m.fixture.expected == "accept" and not m.accepted and m.detected:
            marked = ", ".join(
                f"`{k}`={_fmt_value(v)}" for k, v in sorted(m.detected.items())
            )
            add(f"| `{m.fixture.topic}` | `{m.fixture.text}` | {marked} |")
    add("")

    add("## Accepted, but is the recorded VALUE right?")
    add("")
    add("Acceptance is not correctness. These answers DO mark their topic answered —")
    add("they are counted as successes in the table above — but the value stored in")
    add("`ConversationState.collected` may not be what the sentence means. A wrong value")
    add("is worse than a miss: it is never re-asked and it flows into the profile/resume.")
    add("")
    add("`status` is computed live: **ok** when the parser matches the human-correct")
    add("value, **WRONG** when it does not, and `n/a` where the correct answer is a range")
    add("or a relative demand the field cannot hold at all — open by construction, and a")
    add("contract question rather than a parser bug.")
    add("")
    add("| asked topic | worker answer | recorded value | a human would record | status |")
    add("| --- | --- | --- | --- | --- |")
    for text, topic, human, want in VALUE_WATCH:
        now = recorded_value(text, topic)
        if want is UNEXPRESSIBLE:
            status = "n/a — field cannot hold it"
        else:
            status = "ok" if now == want else "**WRONG**"
        add(f"| `{topic}` | `{text}` | `{_fmt_value(now)}` | {human} | {status} |")
    add("")

    add("## Dead-topic check (the evidence behind finding 3)")
    add("")
    dead = [
        topic for topic, _n, n_should, n_acc, _r in _per_topic_rows(rows)
        if n_should and n_acc == 0
    ]
    if dead:
        add("| topic |")
        add("| --- |")
        for topic in dead:
            add(f"| `{topic}` |")
    else:
        add("**None.** Every one of the 11 topics is satisfied by at least one fixture in")
        add("this corpus, so no topic is structurally unanswerable. The failure mode is")
        add("PARTIAL coverage (the rates above), not a dead topic.")
    add("")

    add("## Engine-level consequence (scripted interviews, mock mode)")
    add("")
    add("Every run drives the real `interview_engine.next_turn` with no network. The")
    add("script answers whichever topic the engine asks.")
    add("")
    for title, script in (
        ("A — plausible worker, answers in the registers the parser does not cover",
         SCRIPT_PLAUSIBLE),
        ("B — worker whose phrasing happens to match the gazetteer",
         SCRIPT_GAZETTEER_FRIENDLY),
        ("C — the overwrite rule holds: `experience` survives the education answer "
         "(pre-#426 this ended at `3.0`)",
         SCRIPT_LATE_OVERWRITE),
        ("D — the other half of the rule: an EXPLICIT correction still commits — and, "
         "because the marker is message-scoped, it drags `experience` down with it",
         SCRIPT_LATE_CORRECTION),
    ):
        sim = simulate(script)
        add(f"### {title}")
        add("")
        add("| engine asked | worker replied |")
        add("| --- | --- |")
        for asked, said in sim.transcript:
            add(f"| `{asked}` | `{said}` |")
        add("")
        add(f"- turns: **{sim.turns}**")
        add(f"- extraction_ready: **{sim.extraction_ready}**")
        add(f"- answered topics: `{sim.answered}`")
        add(f"- **unanswered essentials: `{sim.unanswered_essentials}`**")
        add(f"- never asked at all: `{sim.never_asked}`")
        add(f"- collected: `{sim.collected}`")
        add("")

    add("## Suggested next steps — WRITTEN DOWN, NOT IMPLEMENTED")
    add("")
    add("This PR is measurement-only and changes zero runtime files. The items below are")
    add("the shape of a fix, in the order the data ranks them. None of them is done here.")
    add("")
    add("1. **Negation on VALUE cues** (finding 5) — the only class that writes a")
    add("   confidently WRONG value rather than leaving a field empty. `_apply_negation`")
    add("   already produces the masked text; the work is deciding, per topic, whether a")
    add("   denial should suppress-and-re-ask (location, salary, experience) or suppress")
    add("   and take the contrast (`Pune nahi, Delhi mein hu` → Delhi). Note the")
    add("   first-measurement evidence that motivated the current exclusion:")
    add("   `Pune se bahar nahi jaunga` LOSES Pune under naive masking. Needs its own")
    add("   before/after run on this corpus.")
    add("2. **`cnc` / `operator` in the role gazetteer** (findings 1-2) — the single")
    add("   largest coverage gap, on an ESSENTIAL topic, on the two words the shipped")
    add("   question puts in the worker's mouth. Not a pure gazetteer edit: `operator` is")
    add("   already an operation-knowledge cue, so adding it as a role has to be")
    add("   reconciled with the `skills` auto-close, and any role id must exist in the")
    add("   ADR-0030 taxonomy rather than being minted here.")
    add("3. **`skills` auto-close** (finding 3) — a role/machine answer marking `skills`")
    add("   answered means the skills question is never asked. Marking a topic answered on")
    add("   an INFERENCE, rather than on an answer to the question, is the root cause.")
    add("4. **Spelled-out numerals and Devanagari numbers** — `char saal`, `पाँच साल`,")
    add("   `pandrah hazaar` are all gaps, and they are a large share of the `experience`")
    add("   and `salary_current` misses.")
    add("5. **`kabhi` matching `abhi`** (finding 6.2) — a word-boundary fix on one cue.")
    add("6. **Ranges and relative demands** (`18 se 20 hazar`, `abhi se 5000 zyada`,")
    add("   `30-35k`) — a CONTRACT question, not a parser one: the field holds a scalar,")
    add("   so no parser change can record what the worker said.")
    add("")

    add("## Full measurement table")
    add("")
    add("| asked topic | worker answer | accepted | detected keys | human |")
    add("| --- | --- | :---: | --- | --- |")
    for m in rows:
        keys = ", ".join(f"`{k}`" for k in sorted(m.detected)) or "—"
        add(
            f"| `{m.fixture.topic}` | `{m.fixture.text}` | "
            f"{'yes' if m.accepted else 'NO'} | {keys} | {m.fixture.expected} |"
        )
    add("")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write", action="store_true", help=f"write the report to {REPORT_PATH}"
    )
    args = parser.parse_args()
    report = build_report(measure_all())
    if args.write:
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(report, encoding="utf-8")
        print(f"wrote {REPORT_PATH}")
    else:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
