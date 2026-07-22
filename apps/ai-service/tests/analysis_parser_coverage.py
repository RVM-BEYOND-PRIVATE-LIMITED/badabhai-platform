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

THIS RUN IS **POST-#426 / POST-#429**. The first revision of this harness measured the
parser at commit ``6d23419``. Since then: PR #426 ("P1 profiling correctness",
``fea207d``) fixed four of the defect classes it found; PR #412 (TAX-WELD-1,
``41d0cb7``) added welding to the gazetteer; and PR #429 (issue #424, ``64d4001``)
promoted salary/availability to ``MUST_ASK_TOPICS``, which changed the SHAPE of the
scripted interviews. Everything below is re-measured against the CURRENT engine and
parser. The pre-#426 numbers are retained ONLY as a labelled historical column in
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

# Per-topic (accepted, should-accept) measured by THIS harness at `26218e4`, the
# commit the widening was cut from. Static record; the current column is live.
PRE_WIDENING_ACCEPTED: dict[str, tuple[int, int]] = {
    "role": (8, 23),
    "machines": (14, 23),
    "experience": (12, 24),
    "skills": (14, 23),
    "current_location": (16, 23),
    "preferred_locations": (17, 23),
    "controllers": (13, 22),
    "salary_current": (19, 23),
    "salary_expected": (14, 23),
    "availability": (22, 24),
    "education": (11, 21),  # 2 fixtures re-filed to certifications on 2026-07-22
}
PRE_WIDENING_TOTAL: tuple[int, int] = (160, 252)

# The EXACT gap set measured at `26218e4`, the commit the widening was cut from:
# every fixture a human labelled `accept` that the parser did NOT accept. Static
# record. It exists so "no fixture that was accepted before is rejected now" is a
# MEASURED claim (the current gap set must be a strict SUBSET of this one) instead of
# a sentence in the report — the exact shape of assertion this file exists to avoid.
# (asked topic, worker answer)
PRE_WIDENING_GAPS: tuple[tuple[str, str], ...] = (
    ('role', 'CNC'),
    ('role', 'CNC operator'),
    ('role', 'lathe operator'),
    ('role', 'operator'),
    ('role', 'machine operator hu'),
    ('role', 'CNC machine chalata hoon'),
    ('role', 'main CNC operator ka kaam karta hu'),
    ('role', 'cnc oprator'),
    ('role', 'seter ka kaam'),
    ('role', 'V M C operator'),
    ('role', 'मैं वीएमसी ऑपरेटर हूँ'),
    ('role', 'प्रोग्रामर'),
    ('role', 'helper hu, machine seekh raha hu'),
    ('role', 'fitter'),
    ('role', 'supervisor'),
    ('machines', 'cnc'),
    ('machines', 'milling machine'),
    ('machines', 'drilling machine'),
    ('machines', 'वीएमसी'),
    ('machines', 'vtl'),
    ('machines', 'boring machine'),
    ('machines', 'shaper machine'),
    ('machines', 'power press'),
    ('machines', 'welding machine'),
    ('experience', 'char saal'),
    ('experience', 'chaar saal ka experience hai'),
    ('experience', 'do saal'),
    ('experience', 'teen saal'),
    ('experience', 'ek saal'),
    ('experience', 'bees saal'),
    ('experience', '6 mahine'),
    ('experience', '5 साल'),
    ('experience', 'पाँच साल का तजुर्बा'),
    ('experience', '2012 se kaam kar raha hu'),
    ('experience', 'fresher hu'),
    ('experience', 'naya hu, abhi start kiya'),
    ('skills', 'sab aata hai'),
    ('skills', 'sirf operation'),
    ('skills', 'vernier aur micrometer use karta hu'),
    ('skills', 'quality checking karta hu'),
    ('skills', 'sirf loading unloading'),
    ('skills', 'deburring aur finishing'),
    ('skills', 'बेसिक सेटिंग आती है'),
    ('skills', 'ड्रॉइंग पढ़ लेता हूँ'),
    ('skills', 'counter boring aur tapping'),
    ('current_location', 'Chakan'),
    ('current_location', 'Ranjangaon'),
    ('current_location', 'Bhiwadi'),
    ('current_location', 'Jamshedpur'),
    ('current_location', 'Kolhapur'),
    ('current_location', 'Bihar'),
    ('current_location', 'पुणे'),
    ('preferred_locations', 'apne sheher mein hi'),
    ('preferred_locations', 'ghar ke paas hi chahiye'),
    ('preferred_locations', 'Gujarat mein'),
    ('preferred_locations', 'South India'),
    ('preferred_locations', 'NCR'),
    ('preferred_locations', 'जहाँ भी काम मिले'),
    ('controllers', 'fanuk'),
    ('controllers', 'phanuc'),
    ('controllers', 'फैनुक'),
    ('controllers', 'sinumerik'),
    ('controllers', 'Mazatrol'),
    ('controllers', 'Syntec'),
    ('controllers', 'GSK'),
    ('controllers', 'Hurco'),
    ('controllers', 'Delta controller'),
    ('salary_current', '15 hazaar'),
    ('salary_current', 'daily 700 rupaye'),
    ('salary_current', 'pandrah hazaar'),
    ('salary_current', 'पंद्रह हज़ार'),
    ('salary_expected', '25 hazaar chahiye'),
    ('salary_expected', 'double chahiye'),
    ('salary_expected', 'jo aap theek samjhe'),
    ('salary_expected', 'aapke hisab se'),
    ('salary_expected', 'company jo de'),
    ('salary_expected', 'jitna aap de sako'),
    ('salary_expected', 'salary aapki marzi'),
    ('salary_expected', 'negotiable'),
    ('salary_expected', 'जो भी मिले'),
    ('availability', 'जल्दी जॉइन कर सकता हूँ'),
    ('availability', 'पंद्रह दिन'),
    ('education', 'B.E. mechanical'),
    ('education', '10th pass'),
    ('education', '12th pass'),
    ('education', '8th pass'),
    ('education', 'graduation kiya hai'),
    ('education', 'BA pass'),
    ('education', 'apprentice kiya tha'),
    ('education', 'CNC ka course kiya private institute se'),
    ('education', 'आईटीआई किया है'),
    ('education', 'डिप्लोमा किया है'),
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

# --- Parser widening (fix/profiling-parser-widening) -------------------------
#
# HISTORICAL RECORD + LIVE RE-MEASUREMENT, the same shape as POST_426_DELTA.
#
# `before` is what THIS harness measured on the parser at `26218e4`, the commit the
# widening was cut from. Static; never re-derived. `want` is compared LIVE, so every
# "closed" claim in the report is measured on each run and a regression flips it back.
#
# (asked topic, worker answer, pre-widening recorded, want, note)
WIDENING_DELTA: tuple[tuple[str, str, str, object, str], ...] = (
    ("role", "V M C operator", "_topic not marked_", "VMC Operator",
     "spacing variant; `_ROLES` is substring-matched and cannot see it"),
    ("role", "seter ka kaam", "_topic not marked_", "CNC Setter-Operator",
     "`setter` with one `t`"),
    ("role", "मैं वीएमसी ऑपरेटर हूँ", "_topic not marked_", "VMC Operator",
     "Devanagari form of a gazetteer entry that already exists in Latin"),
    ("role", "प्रोग्रामर", "_topic not marked_", "CNC Programmer", ""),
    ("preferred_locations", "Gujarat mein", "_topic not marked_", ["Gujarat"],
     "a STATE is a real answer to 'kahan kaam kar sakte hain?' — unlike for CURRENT "
     "location, where the engine should go on to ask for the city"),
    ("preferred_locations", "South India", "_topic not marked_", ["South India"], ""),
    ("preferred_locations", "NCR", "_topic not marked_", ["NCR"], ""),
    ("preferred_locations", "जहाँ भी काम मिले", "_topic not marked_", "flexible",
     "Devanagari 'anywhere'; `\\b` does not work after a matra, so it needs its own "
     "boundary form"),
    ("preferred_locations", "Gujarat ya Maharashtra dono chalega", "_topic not marked_",
     ["Gujarat", "Maharashtra"],
     "ALL areas, not the first: the PR #488 review measured first-match-wins dropping "
     "the second choice while closing the topic against re-asking"),
)

# The negatives that make the widening safe, and the ONLY reason it is safe.
#
# Rows marked ADVERSARIAL were MEASURED as fabrications in an earlier cut of this
# widening by the code review of PR #488, across THREE rounds, by running the head
# commit against `main` in isolated copies. Every one recorded `{}` (or `flexible`) on
# main and a wrong VALUE on the cut under review.
#
# What changed after round 3 is not this table but the CODE it measures. Rounds 1-2
# answered each row with a blocklist entry; round 3 measured a new spelling or word
# order past every blocklist, because the blocked class is GENERATIVE. So:
#
#   - the `<machine> + <function>` role inference was DELETED outright — nothing
#     infers a role from "lathe" + "operator" any more, so the entire role family
#     below is closed structurally rather than blocked;
#   - the preferred-AREA read was inverted into a POSITIVE requirement (the message
#     must be area names plus a short filler allow-list), which closes the refusal,
#     exclusion, origin and third-party families without naming one of their words.
#
# `want` is MISSING for "must record nothing", or a concrete value where the correct
# behaviour is a DIFFERENT answer (the exclusion phrasings ARE flexible answers, and
# reading them as the excluded state was a REGRESSION, not merely a new gap).
#
# (asked topic, worker answer, want, why)
WIDENING_NEGATIVE_PROBE: tuple[tuple[str, str, object, str], ...] = (
    # --- role: the standing ruling ---
    ("role", "CNC", MISSING, "a family-of-families (VMC/HMC/lathe/grinder are all CNC)"),
    ("role", "operator", MISSING, "the function without the machine family"),
    ("role", "ऑपरेटर", MISSING, "same, in the other script"),
    # --- role: the DELETED <machine>+<function> inference ---
    ("role", "lathe operator", MISSING,
     "the inference itself is GONE — an honest gap again, worth -1 acceptance"),
    ("role", "lathe chalata hu", MISSING, "same"),
    ("role", "grinder operator", MISSING, "same"),
    ("role", "angle grinder chalata hu", MISSING,
     "ADVERSARIAL: an ANGLE grinder is a handheld tool, not a CNC grinding machine"),
    ("role", "TIG aur MIG welding karta hu, grinder bhi chalata hu", MISSING,
     "ADVERSARIAL: a welder with a grinder is not a CNC grinding operator"),
    ("role", "welder hu, lathe chalata hu kabhi kabhi", MISSING,
     "ADVERSARIAL: the cue used to preempt `_assign_welding_role`; with no cue at all "
     "the welding gate is reached exactly as on main"),
    ("role", "lathe operator ka helper hu", MISSING, "ADVERSARIAL: the HELPER, not the operator"),
    ("role", "mere bhai lathe operator hai", MISSING, "ADVERSARIAL: a third party's role"),
    ("role", "lathe operator mere saath kaam karta tha", MISSING,
     "ADVERSARIAL round 3: the matched pair of a row the round-2 blocklist DID block — "
     "`ke saath` was listed, `mere saath` was not"),
    ("role", "pitaji lathe chalate hai", MISSING,
     "ADVERSARIAL round 3: `papa` was listed, `pitaji` and `chacha` were not"),
    ("role", "chacha lathe chalate hai", MISSING, "ADVERSARIAL round 3"),
    ("role", "lathe operator ki zarurat hai", MISSING,
     "ADVERSARIAL round 3: `requirement` was listed, `zarurat` was not"),
    ("role", "lathe operator ki salary kitni hoti hai", MISSING,
     "ADVERSARIAL round 3: an INTERROGATIVE — nothing blocked questions at all"),
    ("role", "lathe operator ka kaam kaisa hota hai", MISSING, "ADVERSARIAL round 3"),
    ("role", "ek lathe operator ko jaanta hu", MISSING, "ADVERSARIAL round 3"),
    ("role", "lathe operator ke under kaam kiya", MISSING, "ADVERSARIAL round 3"),
    ("role", "pehle jahan tha wahan lathe operator tha", MISSING, "ADVERSARIAL round 3"),
    ("role", "hamari company me lathe hai, operator ki jagah khali hai", MISSING,
     "ADVERSARIAL: a VACANCY being described"),
    ("role", "lathe operator banna chahta hu", MISSING, "ADVERSARIAL: an aspiration"),
    ("role", "lathe chalane ki training li hai", MISSING,
     "ADVERSARIAL: an EDUCATION answer, not a role claim"),
    ("role", "lathe operator ka kaam mujhe nahi aata", MISSING, "ADVERSARIAL: a denial"),
    # --- role: near-misses the surviving VARIANT rows must not match ---
    ("role", "seater cover lagata hu", MISSING, "near-miss on the `set[ae]r` variant"),
    ("role", "v mc", MISSING, "not a spelled-out acronym"),
    ("role", "वीएमसी नहीं चलाता", MISSING,
     "denial, Devanagari — the same masked text `_ROLES` reads"),
    # --- preferred_locations: refusals at every distance from the negator ---
    ("preferred_locations", "Bihar nahi jaunga", MISSING, "a REFUSED state is not a preference"),
    ("preferred_locations", "Gujarat mein nahi jaunga", MISSING, "same, one filler word"),
    ("preferred_locations", "Kerala mein bilkul bhi nahi jaunga", MISSING,
     "ADVERSARIAL: two filler words walked through the 3-word backward mask"),
    ("preferred_locations", "West Bengal me kaam karne ki koi ichha nahi hai", MISSING,
     "ADVERSARIAL: 'no wish to work there' recorded as a preference"),
    ("preferred_locations", "Bihar me kaam karne ka mann nahi hai", MISSING, "ADVERSARIAL"),
    ("preferred_locations", "Odisha ki taraf jaana mujhe pasand nahi", MISSING, "ADVERSARIAL"),
    ("preferred_locations", "Punjab wale bulate hai par mai nahi jaunga", MISSING, "ADVERSARIAL"),
    ("preferred_locations", "Kerala bahut door hai, nahi ja sakta", MISSING,
     "ADVERSARIAL: the negator is in a DIFFERENT clause"),
    # --- preferred_locations: EXCLUSION — the round-3 spelling family ---
    ("preferred_locations", "Bihar ke alawa kahin bhi", "flexible",
     "ADVERSARIAL REGRESSION: 'anywhere EXCEPT Bihar' was `flexible` on main and an "
     "earlier cut turned it into `['Bihar']` — the one state ruled out, topic closed"),
    ("preferred_locations", "Bihar ke alaawa kahin bhi kaam kar sakta hu", "flexible",
     "ADVERSARIAL round 3: one extra `a` defeated the round-2 exclusion list"),
    ("preferred_locations", "Bihar ke alaava kahin bhi kaam kar sakta hu", "flexible",
     "ADVERSARIAL round 3"),
    ("preferred_locations", "Bihar ke alawaa kahin bhi", "flexible", "ADVERSARIAL round 3"),
    ("preferred_locations", "Bihar chhodke kahin bhi kaam kar sakta hu", "flexible",
     "ADVERSARIAL round 3: `chhod ke` was listed, the unspaced `chhodke` was not"),
    ("preferred_locations", "Bihar chodke kahin bhi kaam kar sakta hu", "flexible",
     "ADVERSARIAL round 3"),
    ("preferred_locations", "Bihar hatake kahin bhi kaam kar sakta hu", "flexible",
     "ADVERSARIAL round 3"),
    ("preferred_locations", "Bihar ke sivay kahin bhi kaam kar sakta hu", "flexible",
     "ADVERSARIAL round 3: the listed `ke siva` could not reach `sivay`"),
    ("preferred_locations", "Bihar ke siwaay kahin bhi kaam kar sakta hu", "flexible",
     "ADVERSARIAL round 3"),
    ("preferred_locations", "Bihar ke atirikt kahin bhi", "flexible",
     "NEVER enumerated anywhere — passes because the guard is a positive requirement, "
     "which is the whole point of the rewrite"),
    # --- preferred_locations: ORIGIN / third party ---
    ("preferred_locations", "Bihar se hu", MISSING, "where the worker is FROM"),
    ("preferred_locations", "main Bihar ka hu", MISSING,
     "ADVERSARIAL round 3: the round-2 origin list had `se hu`, not `ka hu`"),
    ("preferred_locations", "ghar Bihar me hai", MISSING, "ADVERSARIAL round 3"),
    ("preferred_locations", "gaon Bihar me hai", MISSING, "ADVERSARIAL round 3"),
    ("preferred_locations", "Bihar mera home town hai", MISSING, "ADVERSARIAL round 3"),
    ("preferred_locations", "Bihar me paida hua", MISSING, "ADVERSARIAL round 3"),
    ("preferred_locations", "mere papa Kerala me rehte hain", MISSING,
     "ADVERSARIAL round 3: the third-party guard was applied to the ROLE path only"),
    ("preferred_locations", "Bihar me tha, ab Gujarat me kaam chahiye", MISSING,
     "ADVERSARIAL: first-match-wins recorded the state the migrant LEFT. Abandoned "
     "whole, so the real 'Gujarat' answer is lost too — a GAP, and the correct trade"),
    # --- preferred_locations: an incidental state must not beat "anywhere" ---
    ("preferred_locations", "kahin bhi ja sakta hu, abhi Gujarat me kaam kar raha hu",
     "flexible", "ADVERSARIAL round 3: a REGRESSION vs main — the state they are IN "
     "replaced the anywhere they offered"),
    ("preferred_locations", "company Gujarat me hai, main kahin bhi jaa sakta hu",
     "flexible", "ADVERSARIAL round 3"),
    ("preferred_locations", "Maharashtra me salary kam hai, kahin bhi bhej do",
     "flexible", "ADVERSARIAL round 3"),
    ("preferred_locations", "Punjab me kaam milega to theek, warna kahin bhi",
     "flexible", "ADVERSARIAL round 3"),
    ("preferred_locations", "mera bhai Kerala me hai, main kahin bhi ja sakta hu",
     "flexible", "ADVERSARIAL round 3"),
    ("preferred_locations", "Maharashtra mein kahin bhi", "flexible",
     "REVERTED to main's value: an earlier cut recorded ['Maharashtra'], ranking the "
     "state above the anywhere. Precedence now goes to `flexible`"),
    # --- preferred_locations: the abbreviation and phrase guards ---
    ("preferred_locations", "set UP karta hu", MISSING,
     "'UP' in caps inside 'set UP' — why the 2-letter abbreviations are not read here"),
    ("preferred_locations", "south side me rehta hu", MISSING, "'south' alone is not a region"),
    ("preferred_locations", "Gujarat me kaam?", MISSING,
     "a QUESTION is not an answer — found by re-probing the allow-list, since both "
     "`me` and `kaam` are filler and it otherwise passed"),
)

# Probes for findings this re-run surfaced that no corpus fixture covers.
# (asked topic, worker answer, note) — the recorded value is rendered live.
NEW_FINDING_PROBE: tuple[tuple[str, str, str], ...] = (
    ("machines", "welding machine",
     "`machines` NOT marked, but `role`+`skills` are closed on a welding read"),
    ("machines", "वीएमसी",
     "the widening's deliberate ASYMMETRY: the Devanagari cue is a ROLE cue only, so "
     "`machines` (ESSENTIAL) stays open and gets asked — Latin 'VMC' closes both"),
    ("machines", "kabhi",
     "FIXED (#424 follow-up): 'abhi' was substring-matched inside 'kabhi'; the cue "
     "is now word-boundary matched AND needs a real availability cue"),
    ("machines", "kabhi kabhi",
     "FIXED (#424 follow-up): 'sometimes' no longer reads as 'available immediately'"),
    ("availability", "kabhi bhi",
     "'whenever' — still immediate, now for the RIGHT reason: matched explicitly as an "
     "anytime phrase, and only because the availability question was the one asked"),
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
    "certifications": "koi certificate nahi hai",
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
    "certifications": "NCVT certificate hai",
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


def _essential_closure_table(rows: list[Measurement]) -> str:
    """How often each ESSENTIAL topic is closed by some OTHER topic's answer.

    Evidence for finding 7. Counts fixtures whose asked topic is NOT the essential
    but whose detector output marks it anyway — i.e. the essential gets closed, and
    `_next_topic` will then never ask it.
    """
    out = ["| essential topic | closed by another topic's answer | example |",
           "| --- | ---: | --- |"]
    for essential in interview_engine.ESSENTIAL_TOPICS:
        closers = [
            m for m in rows
            if m.fixture.topic != essential and essential in m.detected
        ]
        example = (
            f"`{closers[0].fixture.topic}` answer `{closers[0].fixture.text}`"
            if closers else "—"
        )
        plural = "fixture" if len(closers) == 1 else "fixtures"
        out.append(f"| `{essential}` | {len(closers)} {plural} | {example} |")
    return "\n".join(out)


def _ALL_SIMS() -> list[SimulatedInterview]:  # noqa: N802 - report-local helper
    """Every scripted interview in this report, simulated once."""
    return [
        simulate(s) for s in (
            SCRIPT_PLAUSIBLE,
            SCRIPT_GAZETTEER_FRIENDLY,
            SCRIPT_LATE_OVERWRITE,
            SCRIPT_LATE_CORRECTION,
        )
    ]


# Authored analysis. Every claim below is demonstrated by a fixture in this report,
# by a probe table above, or locked by an assertion in
# tests/test_profiling_parser_coverage.py. Line numbers are as of the commit that
# last updated this file (POST-#426 / POST-#412 / POST-#429).


def _findings(rows: list[Measurement]) -> str:
    """The authored narrative, with every COUNT computed from this run.

    Nothing here is a remembered number: the auto-close count and the negation
    verdicts are derived from the live parser, so the prose cannot drift away from
    the tables underneath it.
    """
    role_machine = [m for m in rows if m.fixture.topic in ("role", "machines")]
    auto_skills = [m for m in role_machine if "skills" in m.detected]
    should_accept_now = [m for m in rows if m.fixture.expected == "accept"]
    accepted_now = [m for m in should_accept_now if m.accepted]
    cap_open = [r for r in NEGATION_PROBE if r[3] == "CAPABILITY" and _negation_is_open(r)]
    val_rows = [r for r in NEGATION_PROBE if r[3] == "VALUE"]
    val_open = [r for r in val_rows if _negation_is_open(r)]
    delta_open = [r for r in POST_426_DELTA if recorded_value(r[1], r[0]) != r[3]]
    n_fixed = len(POST_426_DELTA) - len(delta_open)

    # Finding 7 evidence, all measured.
    sims = _ALL_SIMS()
    friendly_never_asked = simulate(SCRIPT_GAZETTEER_FRIENDLY).never_asked
    must_ask_never = sorted({t for s in sims for t in s.must_asks_never_asked})
    ess_never = sorted({t for s in sims for t in s.essentials_never_asked})
    role_closers = len(
        [m for m in rows if m.fixture.topic != "role" and "role" in m.detected]
    )
    essential_closure_table = _essential_closure_table(rows)

    return f"""
## Findings — this is a POST-#426 / POST-#429 re-measurement

The first revision of this report measured the parser at commit `6d23419`. Three PRs
have landed on it since, and this run re-measures against all three:

- **#426** (`fea207d`, "P1 profiling correctness") fixed four of the defect classes
  this report found — value parsing, negation on capability cues, the overwrite rule,
  and test-time network egress.
- **#412** (`41d0cb7`, TAX-WELD-1) wired welding into the gazetteer, which changes one
  corpus row and the `role` retry wording.
- **#429** (`64d4001`, issue #424, owner ruling) promoted `salary_current` /
  `salary_expected` / `availability` to `MUST_ASK_TOPICS`. This changed the ENGINE,
  not the parser: no acceptance number moves, but the scripted interviews are
  reshaped and the never-asked hazard in finding 3 is narrowed — see **finding 7**,
  which is the more serious form that narrowing exposed.

**The defects are not deleted from this report.** The section "What #426 changed"
keeps the pre-fix value beside the current one, because the record of what was wrong
is half the value of having measured it. What follows separates FIXED from STILL
OPEN, and every verdict is computed from the live parser on each run: **{n_fixed} of
the {len(POST_426_DELTA)}** recorded defect cases re-measure as fixed.

**#426 did not move overall acceptance** — it fixed what the parser RECORDS, not what
it RECOGNISES. The **parser widening** that this revision measures is the first change
that moves it: from **{PRE_WIDENING_TOTAL[0]}/{PRE_WIDENING_TOTAL[1]}** to
**{len(accepted_now)}/{len(should_accept_now)}**, on `role` and `preferred_locations`
only. See "What the parser widening changed" below for the per-topic before/after, the
negatives that make it safe, and the two classes it deliberately did NOT close.

### 1. Why `CNC` is rejected for `role` — the exact code path (still open, now by RULING)

`detect_answered_topics` keys the `role` topic on ONE field:

    if sig.role_id:
        answered["role"] = sig.primary_role

`role_id` is set by a first-match-wins scan of the `_ROLES` gazetteer over the
lowercased text. `_ROLES` contains eight keywords:

    cam programmer · programmer · setter · vmc · hmc · grinding · turner · turning

There is **no `cnc` keyword and no `operator` keyword**. So `"CNC"` sets no
`role_id` and the topic is not marked. `"CNC"` is also absent from `_MACHINES`
(which has `cnc lathe` but no bare `cnc`), so the answer falls through BOTH tables
and `detect_answered_topics("CNC", "role")` returns `{{}}` — nothing at all is
recorded from it.

The worse variant WAS `"CNC operator"`, the single most likely thing a worker types.
`operator` is not a role keyword, but it IS an operation-knowledge cue, which appends
`"machine operation"` to `sig.skills`, which makes `detect_answered_topics` mark
**`skills`** answered. So until 2026-07-22 the canonical answer to the role question:

- left `role` unanswered → it was re-asked once (`MAX_ASKS_PER_TOPIC = 2`,
  `interview_engine.py`) and then abandoned;
- silently marked `skills` answered with `["machine operation"]` — and
  `_next_topic` never returns an already-answered topic, so **the skills question was
  never asked**.

**CLOSED by TD94** (owner ruling 2026-07-21, [#460]), which minted a GENERIC
`role_cnc_operator` and assigns it from ONE gated function
(`signals._assign_generic_cnc_role`), the same mechanism `role_welder` uses. The
second bullet is unchanged — "operator" still keys `skills` — but `role` now resolves,
and scripted interview A below shows the difference end to end.

**What was NOT closed, and why that is a decision rather than an omission.** Neither
half of the phrase resolves alone: `"CNC"` → `{{}}` and `"operator"` →
`{{'skills': [...]}}`, both unchanged. Every *specialised* operator role in the closed
set names a machine family (`role_vmc_operator` / `role_hmc_operator` /
`role_cnc_turner_operator` / `role_cnc_grinding_operator`); `operator` states the
FUNCTION without the family and `CNC` a family-of-families (VMC, HMC, lathe and
grinder are all CNC) without saying which, so resolving either ONE to a specialisation
would have to PICK a machine the worker never named — the fabrication class this
parser exists to prevent, on the topic where it is least recoverable (a closed topic
is never re-asked). `lathe operator` and `milling` are still gaps for the same reason.

The generic id sidesteps that because it names no family at all. It carries a
different cost, which the ruling accepted explicitly:
`packages/reach-engine/src/scoring.ts` `scoreRole` is exact-id-match and returns
**0.4** for a NULL roleId ("trade not stated yet") against **0.0** for a non-matching
one, so the id ALONE ranks these workers BELOW the null they used to get. The ruling
pairs it with `secondaryRoleIds` carrying the CNC specialisations, which the same
function already scores at **0.6** (`scoring.ts:157-158`) — 0.4 → 0.6, no change to
the scoring math. The taxonomy half of that pairing shipped with the mint
(`RELATED_ROLE_IDS`, `packages/taxonomy/src/index.ts`); the read-path half has NOT
(`apps/api/src/reach/reach.mappers.ts` still returns a hard-coded
`secondaryRoleIds: []`, and `worker_profiles` has no column to persist a per-worker
set), so until it is wired this closure is a reach regression for exactly this
population. `test_bare_cnc_and_bare_operator_still_resolve_nothing` locks the two
halves that stayed open so the remaining ruling has to be argued with, not drifted
past.

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

### 3. Dead topics (UNCHANGED) — but see finding 7, which grew out of this

**None.** All 11 topics are satisfied by at least one plausible answer
(`test_no_topic_is_structurally_dead`). The failure mode measured here is partial
coverage, not structural deadness. Two adjacent hazards are real, though:

- **auto-closed topics** — `skills` is marked answered by {len(auto_skills)} of the
  {len(role_machine)} role/machine answers without ever being asked, so in practice
  it is frequently a topic the worker never sees;
- **early wrap-up** — the engine stops as soon as `_extraction_ready` holds, so a
  worker whose essentials land in the first few turns is never asked about the rest.

**#429 narrowed the second one.** Promoting `salary_current` / `salary_expected` /
`availability` to `MUST_ASK_TOPICS` means `_extraction_ready` now also requires those
to have been ASKED, so the wrap-up can no longer skip money and notice period.
Measured on scripted interview B: `never_asked` was seven topics before #429 and is
`{friendly_never_asked}` now.

It did NOT close the hazard, it moved it — see finding 7, which is the more serious
form and is the reason this revision exists.

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
2. **`kabhi` was read as `abhi` — FIXED by the #424 follow-up.** The availability cue
   used to be a plain substring test, so "kabhi" (ever), "kabhi kabhi" (occasionally)
   and "kabhi bhi" (whenever) all set `availability = immediate`; so did every answer
   to the bank's own "**Abhi** kis sheher mein hain?" / "**Abhi** salary kitni hai?".
   The cue family is now word-boundary matched and requires a GENUINE availability cue
   (join/start intent, being free, a notice duration) — a bare time adverb only counts
   next to a join intent. "vmc nahi chalaya kabhi" no longer marks availability.
   Pre-existing and NOT caused by #426; surfaced by probing for the negation gap and
   fixed once #429 made `availability` a MUST_ASK topic that the false positive was
   silently satisfying.
3. **`salary_expected` stores the refused number.** "25000 nahi chahiye, 30000
   chahiye" records 25000: the parser is both first-number-wins and negation-blind,
   and the two compose into the worst available answer.
4. **The correction marker is message-scoped** — see the residual in section 4.

### 7. An ESSENTIAL topic can be marked answered WITHOUT EVER BEING ASKED

**This is the most serious finding in this report.** It surfaced while re-measuring
after #429 and it is not the hazard finding 3 originally described — it is a worse
one that finding 3's wording ("salary, availability, controllers or education") had
been quietly standing in front of.

`_extraction_ready` gates the four `ESSENTIAL_TOPICS` on **answered**, never on
**asked**:

    if not all(t in st.answered_topics for t in ESSENTIAL_TOPICS):
        return False
    # app/profiling/interview_engine.py:113-114

and `_unanswered_essentials` — the EXPLICIT completeness signal, the thing that is
supposed to declare an incomplete profile — is computed the same way:

    return [t for t in ESSENTIAL_TOPICS if t not in st.answered_topics]

Neither looks at `asked_question_ids`. But `detect_answered_topics` marks topics from
CROSS-TOPIC inference, so an essential can be closed by a DIFFERENT question's
answer, and `_next_topic` then never returns it because it is already in
`answered_topics`.

**Measured on scripted interview B** (a worker whose phrasing matches the gazetteer):

- `extraction_ready` = **True**
- `unanswered_essentials` = **`[]`** — the profile reports itself COMPLETE
- yet `machines`, an ESSENTIAL topic, is in `never_asked`

The worker was asked "aap kaunsa kaam karte hain?" and said "VMC operator". The
gazetteer read "vmc" out of that ONE answer and filled `machines=['VMC']`. **The
machine question was never put to them.** A worker who runs a VMC *and* an HMC *and*
a lathe ships as VMC-only, and every completeness signal the system has says nothing
is missing.

This is not confined to `machines`. Across the corpus, each essential is closed by
some OTHER topic's answer in:

{essential_closure_table}

`role` is the largest: {role_closers} fixtures for other topics close it — mostly
`machines` answers, because the gazetteer stores `vmc`/`hmc` as ROLES as well as
machines (finding 2). `role` happens to be asked first in bank order, so it is asked
before anything can pre-empt it; that is ORDERING luck, not a guarantee.

**Why #429 does not cover this.** #429 fixed exactly this shape of hole for the
MUST_ASK topics, and it fixed it with an **asked-or-answered** gate. The essentials
kept the answered-only gate — reasonably, since an essential must genuinely be
ANSWERED — but the consequence is that inference satisfies them while the question
goes unasked. Measured across all four scripted interviews below:

- `MUST_ASK_TOPICS` never asked: **{must_ask_never or "none — the #429 gate holds"}**
- `ESSENTIAL_TOPICS` never asked: **{ess_never}**

Written up, NOT fixed here — this PR changes zero runtime files. The shape of a fix
is in "Suggested next steps" item 0.
"""


def _widening_section(rows: list[Measurement]) -> str:
    """Before/after for the parser widening, every number computed from this run."""
    now = {t: (acc, should) for t, _n, should, acc, _r in _per_topic_rows(rows)}
    # Topics added after the baseline was taken have no "before" to move from.
    moved = [
        t for t in TOPIC_ORDER
        if t in PRE_WIDENING_ACCEPTED and now[t][0] != PRE_WIDENING_ACCEPTED[t][0]
    ]
    lines = [
        "## What the parser widening changed — measured before / after",
        "",
        "`before` is what THIS harness measured at `26218e4`, the commit the widening",
        "was cut from. `now` is recomputed on every run, so nothing below is a",
        "remembered number.",
        "",
        "| topic | before | now | delta |",
        "| --- | ---: | ---: | ---: |",
    ]
    for topic in TOPIC_ORDER:
        before_acc, before_should = PRE_WIDENING_ACCEPTED.get(topic, (0, 0))
        acc, should = now[topic]
        delta = acc - before_acc
        # A topic added after the baseline has no "before" — say so rather than
        # printing a fabricated 0/0 (0%) that reads like a measured regression.
        before_cell = (
            f"{before_acc}/{before_should} ({before_acc / before_should:.0%})"
            if before_should
            else "— (added later)"
        )
        now_cell = f"{acc}/{should} ({acc / should:.0%})" if should else "—"
        delta_cell = f"{delta:+d}" if before_should else "n/a"
        lines.append(f"| `{topic}` | {before_cell} | {now_cell} | {delta_cell} |")
    should_accept = [m for m in rows if m.fixture.expected == "accept"]
    accepted = [m for m in should_accept if m.accepted]
    # Scoped to the topics the baseline actually covered — a topic added later
    # cannot be "a gap the widening opened".
    now_gaps = {
        (m.fixture.topic, m.fixture.text)
        for m in rows
        if m.is_gap and m.fixture.topic in PRE_WIDENING_ACCEPTED
    }
    before_gaps = set(PRE_WIDENING_GAPS)
    regressed = sorted(now_gaps - before_gaps)
    should_accept = [m for m in should_accept if m.fixture.topic in PRE_WIDENING_ACCEPTED]
    accepted = [m for m in accepted if m.fixture.topic in PRE_WIDENING_ACCEPTED]
    lines += [
        f"| **overall** | **{PRE_WIDENING_TOTAL[0]}/{PRE_WIDENING_TOTAL[1]}** "
        f"({PRE_WIDENING_TOTAL[0] / PRE_WIDENING_TOTAL[1]:.0%}) | "
        f"**{len(accepted)}/{len(should_accept)}** "
        f"({len(accepted) / len(should_accept):.0%}) | "
        f"**{len(accepted) - PRE_WIDENING_TOTAL[0]:+d}** |",
        "",
        f"Topics that moved: **{moved}**.",
        "",
        "**Nothing was traded away** — computed, not asserted: the gap set now is a",
        "strict SUBSET of the gap set at `26218e4`. Fixtures that were accepted",
        f"before and are gaps now: **{regressed or 'none'}**",
        f"({len(before_gaps)} gaps before, {len(now_gaps)} now,",
        f"{len(before_gaps - now_gaps)} closed).",
        "",
        "### The answers it now reads",
        "",
        "| asked topic | worker answer | before | now | want | verdict |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for topic, text, before, want, _note in WIDENING_DELTA:
        current = recorded_value(text, topic)
        verdict = "**CLOSED**" if current == want else "**OPEN**"
        lines.append(
            f"| `{topic}` | `{text}` | `{before}` | `{_fmt_value(current)}` | "
            f"`{_fmt_value(want)}` | {verdict} |"
        )
    lines.append("")
    for _topic, text, _before, _want, note in WIDENING_DELTA:
        if note:
            lines.append(f"- `{text}` — {note}")
    adversarial = [r for r in WIDENING_NEGATIVE_PROBE if r[3].startswith("ADVERSARIAL")]
    holding = [r for r in WIDENING_NEGATIVE_PROBE if recorded_value(r[1], r[0]) == r[2]]
    lines += [
        "",
        "### The negatives that make it safe",
        "",
        "A widening is only as good as what it still REFUSES. The `recorded` column is",
        f"live, so a future over-match shows up here as a value: **{len(holding)} of "
        f"{len(WIDENING_NEGATIVE_PROBE)}** rows hold.",
        "",
        f"**{len(adversarial)} of these are marked ADVERSARIAL**: they were MEASURED as",
        "FABRICATIONS in the first cut of this widening by the code review of PR #488,",
        "which ran the head commit against `main` in isolated copies. Each recorded `{}`",
        "on main and a VALUE on the first cut. They are the negatives table now.",
        "",
        "| asked topic | worker answer | recorded | want | why |",
        "| --- | --- | --- | --- | --- |",
    ]
    for topic, text, want, why in WIDENING_NEGATIVE_PROBE:
        current = recorded_value(text, topic)
        rendered = "—" if current is MISSING else f"`{_fmt_value(current)}`"
        wanted = "—" if want is MISSING else f"`{_fmt_value(want)}`"
        mark = "" if current == want else " **BROKEN**"
        lines.append(f"| `{topic}` | `{text}` | {rendered}{mark} | {wanted} | {why} |")
    lines += [
        "",
        "**The lesson those measurements taught is structural, and it cost a whole",
        "widening.** Rounds 1 and 2 answered each row above with a BLOCKLIST — a",
        "negation window, an exclusion-marker list, an origin-marker list, a",
        "possessor/aspiration/vacancy list. Round 3 measured a fresh hole in every one",
        "of them, because the class being blocked is GENERATIVE and Hinglish spells",
        "everything several ways:",
        "",
        "| round 2 BLOCKED | round 3 HOLE |",
        "| --- | --- |",
        "| `Bihar ke alawa kahin bhi` | `ke alaawa`, `ke alaava`, `ke alawaa` |",
        "| `Bihar chhod ke kahin bhi` | `Bihar chhodke ...`, `chodke`, `hatake` |",
        "| `ke siwa` | `ke sivay`, `ke siwaay` |",
        "| `lathe operator ke saath kaam karta tha` | `lathe operator MERE saath kaam karta tha` |",
        "| `papa lathe chalate hai` | `pitaji ...`, `chacha ...` |",
        "| `... ki requirement hai` | `... ki zarurat hai` |",
        "| (nothing blocked questions) | `lathe operator ki salary kitni hoti hai` |",
        "",
        "A blocklist can only enumerate; what it must exclude is unbounded. So two",
        "structural changes replaced all of it, and BOTH cost coverage on purpose:",
        "",
        "1. **The `<machine> + <function>` role inference was DELETED, not patched.**",
        "   It read \"lathe operator\" as `role_cnc_turner_operator`. Deciding whether a",
        "   speaker is CLAIMING a role — rather than asking about it, aspiring to it,",
        "   training for it, working beside it or describing a relative's job — is a",
        "   judgement `_ROLES` never makes, and every regex written to make it leaked.",
        "   It bought ONE corpus fixture. `role` gives back a point (57% -> 52%) and",
        "   `lathe operator` is an honest, re-askable gap again.",
        "2. **The preferred-AREA read was INVERTED into a positive requirement.** Instead",
        "   of listing what must not appear, the message must consist of NOTHING BUT area",
        "   names plus a short filler allow-list (`me`/`mein`, `ya`/`aur`/`dono`,",
        "   `sirf`/`hi`/`bhi`, `kaam`/`chahiye`, `chalega`/`theek`). Every row in the",
        "   table above now fails for the same structural reason — it contains a word",
        "   that is not an area and not filler — including spellings nobody enumerated",
        "   (`Bihar ke atirikt kahin bhi` is in the probe table precisely because it was",
        "   never listed anywhere). Fails CLOSED on the unseen, which is the property a",
        "   blocklist cannot have. Cost: a discursive but genuine preference",
        "   (\"Gujarat me kaam kiya tha, wahi chahiye\") records nothing and is re-asked.",
        "",
        "Two smaller decisions from the same rounds:",
        "",
        "- **\"anywhere\" outranks an incidental state.** If a message carries a",
        "  generality-of-place idiom, a state beside it is context (where the worker IS,",
        "  where the company is, where a relative lives), so `flexible` wins. Asserted in",
        "  code via `_has_anywhere_cue`, not left to emerge from the filler list.",
        "- **The 2-letter state abbreviations are not read on this path.** An adversarial",
        "  probe measured `set UP karta hu` -> `['Uttar Pradesh']`: the CASE-SENSITIVE",
        "  guard they rely on is defeated by a worker typing in caps, which was harmless",
        "  only while abbreviations reached `Signals.current_state` (which marks no",
        "  topic). `UP mein` records nothing and the question is asked again.",
        "",
        "**What an abandoned area read does NOT mean.** It abandons the AREA, not the",
        "topic: `detect_answered_topics` falls through to the flexibility arm, so",
        "\"Bihar ke alawa kahin bhi\" still records `flexible` (what it means, and what",
        "`main` recorded) while \"Bihar me tha\" records nothing at all. One honest edge:",
        "\"Maharashtra ke andar kahin bhi, bahar nahi jaunga\" records `flexible`, i.e.",
        "anywhere in India, although the worker excluded outside Maharashtra — unchanged",
        "from `main`, which this read neither causes nor fixes.",
        "",
        "### What it deliberately did NOT close",
        "",
        "1. **`CNC` / bare `operator`** (2 role gaps) — finding 1 above. No closed-set",
        "   id can be chosen from EITHER half alone without inventing a machine family.",
        "   `CNC operator` and `cnc oprator` were the other two gaps in this group and",
        "   were CLOSED later, by TD94's generic-id mint (owner/ADR, as this line said",
        "   it would have to be) — the PAIR names no family, so it invents nothing.",
        "2. **`helper` / `fitter` / `supervisor`** (3 role gaps) — real shop-floor roles",
        "   with no id in the ADR-0030 taxonomy. Closing them means adding roles to the",
        "   closed set, i.e. a scope decision about which trades this product serves.",
        "3. **`apne sheher mein hi` / `ghar ke paas hi chahiye`** (2 preferred gaps) — a",
        "   'stay local' answer. A sentinel for it would be DROPPED by",
        "   `profile_extractor.merge_collected` (it is not a list), so closing them would",
        "   move the acceptance number and store nothing — metric, not data. The honest",
        "   version sets `willing_to_relocate = False`, which is the payer-facing field",
        "   with the #437 fabrication history and deserves its own measured change.",
        "4. **The `machines` Devanagari gap (`वीएमसी`)** — closable the same way, but the",
        "   Latin path shows what that costs: 'VMC operator' closes the ESSENTIAL",
        "   `machines` topic by inference and the question is never asked (finding 7).",
        "   The Devanagari cue is a ROLE cue only, so the machine question still gets",
        "   asked. The asymmetry is deliberate and locked by a test.",
        "5. **`lathe operator` / `lathe chalata hu` / `grinder operator`** — GIVEN BACK.",
        "   Closed by an earlier cut of this PR, then deleted with the",
        "   `<machine> + <function>` inference that closed them. -1 acceptance, taken",
        "   deliberately.",
        "6. **A machining worker who ALSO welds** ('cnc lathe operator hu, welding bhi",
        "   kar leta hu') — records no role, exactly as `main` does: `_ROLES` has no",
        "   `lathe` keyword and `_assign_welding_role` declines whenever a machining",
        "   signal is present. Deciding which trade is PRIMARY is the judgement that",
        "   gate refuses to make, and nothing in this PR makes it either.",
        "7. **Discursive but genuine preferences** ('Maharashtra se bahar nahi jaunga',",
        "   'Gujarat me kaam kiya tha, wahi chahiye', 'Gujarat me kaam karna pasand",
        "   karunga') — they fail the positive requirement. Blunt on purpose: the same",
        "   requirement is what stops every measured refusal, exclusion and origin",
        "   statement being stored as a preference.",
        "8. **`_ROLES`'s own limits, inherited by the variant rows.** A variant is a",
        "   surface-form alias, so `V M C operator ki job hai kya` resolves `role` —",
        "   and so does `VMC operator ki job hai kya` on `main`, through the shipped",
        "   substring gazetteer. Measured as pairs in",
        "   `test_a_variant_row_can_only_do_what_its_latin_twin_already_does`. Narrowing",
        "   that means narrowing `_ROLES` for every worker: a separate, shipped-behaviour",
        "   change, not something to smuggle in behind a spelling table.",
        "9. **`lathe m/c operator hu`** — `m/c` is the standard Indian shop abbreviation",
        "   for machine. It never resolved on `main` and does not now; noted because an",
        "   earlier cut of this PR did briefly resolve it.",
        "",
    ]
    return "\n".join(lines)


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

    @property
    def essentials_never_asked(self) -> list[str]:
        """ESSENTIAL topics the worker was never actually asked about.

        The sharp one. ``_extraction_ready`` gates essentials on ANSWERED, and
        ``unanswered_essentials`` — the explicit completeness signal — is likewise
        computed from ``answered_topics``. Neither looks at whether the question was
        ever put to the worker, so an essential closed by INFERENCE from some other
        answer is invisible to both.
        """
        return [t for t in interview_engine.ESSENTIAL_TOPICS if t in self.never_asked]

    @property
    def must_asks_never_asked(self) -> list[str]:
        """MUST_ASK topics never asked. Should always be empty — that is the gate."""
        return [t for t in interview_engine.MUST_ASK_TOPICS if t in self.never_asked]


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

    add("# Deterministic profiling parser — coverage measurement (POST parser widening)")
    add("")
    add("> **This revision is NOT measurement-only.** Earlier revisions changed zero")
    add("> runtime files; the revision that produced these numbers WIDENS")
    add("> `app/profiling/signals.py` — role cues, state/region answers to the PREFERRED")
    add("> location question, and the Devanagari/misspelling 'anywhere' family. Overall")
    add("> acceptance moves for the first time; see \"What the parser widening changed\"")
    add("> for the per-topic before/after, the negatives that make it safe, and the four")
    add("> classes it deliberately did NOT close.")
    add(">")
    add("> **`CNC`, bare `operator` and `cnc oprator` STILL resolve nothing — by ruling,")
    add("> not omission.** Every operator role in the closed set names a machine family,")
    add("> so resolving them would have to invent one; minting a generic id instead is a")
    add("> measured RANKING regression (reach `scoreRole`: 0.0 'different trade' vs 0.4")
    add("> 'trade not stated'). Finding 1 carries the argument and a test locks it.")
    add(">")
    add("> Prior baselines, each measured at the time: `6d23419` (the `pre-#426` column),")
    add("> then **#426** (`fea207d`, P1 profiling correctness), **#412** (`41d0cb7`,")
    add("> TAX-WELD-1) and **#429** (`64d4001`, issue #424 — salary/availability promoted")
    add("> to MUST_ASK). None of them is re-derived here; they survive only as labelled")
    add("> historical columns, never as current behaviour.")
    add(">")
    add("> **Read finding 7 first** — an ESSENTIAL topic can be marked answered without")
    add("> ever being asked, and the completeness signal cannot see it. Unchanged.")
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

    add(_widening_section(rows))

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
    add("**Scope of this number.** It counts only CORPUS fixtures a human labelled")
    add("`reject`, and the corpus is capped at 25 per topic (`role` and")
    add("`preferred_locations` are both at the cap). The 20+ fabrications the PR #488")
    add("review measured therefore could NOT be added here — they live in \"The negatives")
    add("that make it safe\" above, which pins each one to an EXACT expected value rather")
    add("than merely to not-accepted. Read the two together; neither alone is the whole")
    add("fabrication picture.")
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
        if sim.essentials_never_asked:
            add(f"- **ESSENTIAL topics NEVER ASKED (finding 7): "
                f"`{sim.essentials_never_asked}`** — closed by inference from another "
                f"answer, and invisible to `unanswered_essentials` above")
        if sim.must_asks_never_asked:
            add(f"- MUST_ASK topics never asked: `{sim.must_asks_never_asked}` "
                f"(would be a #429 regression)")
        add(f"- collected: `{sim.collected}`")
        add("")

    add("## Suggested next steps")
    add("")
    add("Item 2 was the parser widening and is now **DONE in part** — see \"What the")
    add("parser widening changed\". Everything else below is still the SHAPE of a fix,")
    add("in the order the data ranks it, and none of it is implemented.")
    add("")
    add("0. **An ESSENTIAL topic marked answered without ever being asked** (finding 7)")
    add("   — ranked above everything else because it defeats the completeness signal")
    add("   itself: `unanswered_essentials` reports `[]` while `machines` was never put")
    add("   to the worker. #429 already established the pattern for a fix — it gave the")
    add("   MUST_ASK topics an **asked-or-answered** gate. The essentials cannot simply")
    add("   copy that (an essential must be genuinely ANSWERED, and asked-or-answered")
    add("   would WEAKEN them). Two directions worth the owner's call, neither")
    add("   implemented here:")
    add("   - **require asked AND answered for essentials** — strictly stronger, but it")
    add("     costs turns and could re-ask something the worker already volunteered;")
    add("   - **keep the inference but confirm it** — ask the question with the inferred")
    add("     value pre-filled (\"aap VMC chalate hain — aur koi machine?\"), which keeps")
    add("     the turn count and still gives the worker the chance to correct/extend.")
    add("   Whichever is chosen, `unanswered_essentials` should probably distinguish")
    add("   \"answered by the worker\" from \"inferred and never confirmed\" — today it")
    add("   cannot, and that is what makes this silent.")
    add("1. **Negation on VALUE cues** (finding 5) — the only class that writes a")
    add("   confidently WRONG value rather than leaving a field empty. `_apply_negation`")
    add("   already produces the masked text; the work is deciding, per topic, whether a")
    add("   denial should suppress-and-re-ask (location, salary, experience) or suppress")
    add("   and take the contrast (`Pune nahi, Delhi mein hu` → Delhi). Note the")
    add("   first-measurement evidence that motivated the current exclusion:")
    add("   `Pune se bahar nahi jaunga` LOSES Pune under naive masking. Needs its own")
    add("   before/after run on this corpus.")
    add("2. **`cnc` / `operator` in the role gazetteer** (findings 1-2) — **MOSTLY DONE**.")
    add("   The widening closed the variant classes (a machine plus the function performed")
    add("   on it, spacing, one misspelling, the Devanagari forms): `role` 35% -> 57%.")
    add("   TD94 then closed the `cnc` + operating-claim PAIR by taking the second owner")
    add("   option below — a generic `role_cnc_operator`, minted into the closed set and")
    add("   assigned by one gated function, never by a `cnc`/`operator` keyword.")
    add("   What remains:")
    add("   - **fix the QUESTION** (STILL OPEN) — it offers `CNC` and `operator` as if")
    add("     they were answers, and neither resolves on its own; asking for the machine")
    add("     family first makes every answer resolvable. `question_bank.py` also still")
    add("     excludes a `CNC operator` answer chip on a now-stale measurement.")
    add("   - **finish the taxonomy half** (STILL OPEN, and it is a REGRESSION until it")
    add("     lands) — the generic id scores 0.0 against a specialised job where the null")
    add("     it replaced scored 0.4. `RELATED_ROLE_IDS` (packages/taxonomy) carries the")
    add("     adjacency, but `reach.mappers.ts` still returns `secondaryRoleIds: []`, so")
    add("     the 0.6 secondary-match path these workers need is not reached yet.")
    add("3. **`skills` auto-close** (finding 3) — a role/machine answer marking `skills`")
    add("   answered means the skills question is never asked. Marking a topic answered on")
    add("   an INFERENCE, rather than on an answer to the question, is the root cause.")
    add("4. **Spelled-out numerals and Devanagari numbers** — `char saal`, `पाँच साल`,")
    add("   `pandrah hazaar` are all gaps, and they are a large share of the `experience`")
    add("   and `salary_current` misses.")
    add("5. **`kabhi` matching `abhi`** (finding 6.2) — DONE by the #424 follow-up; kept")
    add("   in the list because the report's probe table still measures it every run.")
    add("5b. **Devanagari beyond `role` / `preferred_locations`** — the widening covered")
    add("   only the two topics it was scoped to. `experience` (`5 साल`), `skills`,")
    add("   `education` (`आईटीआई किया है`), `controllers` (`फैनुक`) and `salary_current`")
    add("   (`पंद्रह हज़ार`) all still return nothing in Devanagari. Note `\\b` does NOT")
    add("   work after a Devanagari matra — use `signals._dev`, and probe it, or the")
    add("   pattern is silently dead.")
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
        # newline="\n" — the committed report is LF. Without it a Windows run
        # rewrites all ~1200 lines as CRLF and the real content diff disappears
        # inside a whole-file line-ending churn.
        REPORT_PATH.write_text(report, encoding="utf-8", newline="\n")
        print(f"wrote {REPORT_PATH}")
    else:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
