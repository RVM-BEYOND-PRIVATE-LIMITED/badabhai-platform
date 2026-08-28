"""The two tools built to REPORT on defects, tested (R12 §4).

WHY THESE TWO NEED TESTS MORE THAN THE CODE THEY REPORT ON. Both HIGH findings of the R8
adversarial re-verification were inside instruments, not features:

  * `scripts/effective-ai-flags.py` omitted `resume_generation`, so it reported "five of six
    tasks armed" when six of seven were — from the one command built to end three previous
    rounds of flag misreporting.
  * `scripts/count-discarded-interviews.sql` gated on `ai_jobs.real_call`, which is FALSE on
    precisely the rows the query exists to find. It would have returned ~0 and been read as
    "no interviews were discarded".

A number carrying its command is only as good as the command. And the second one names the
sub-pattern this file is really about:

    A DETECTOR'S FIXTURE MUST CONTAIN THE THING THE DETECTOR DETECTS.

The SQL was validated against a three-worker fixture with no discarded row in it, so every
result it produced was consistent with both a working query and a broken one. Every assertion
below that checks for absence is paired with one that proves the probe could have found
something.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
FLAGS_SCRIPT = REPO / "scripts" / "effective-ai-flags.py"
DISCARDED_SQL = REPO / "scripts" / "count-discarded-interviews.sql"


# ─────────────────────────────────────────────────────────────────────────────────────────
# §4.1 — the flag resolver's task list
# ─────────────────────────────────────────────────────────────────────────────────────────


def _gated_task_strings() -> set[str]:
    """Every task string that reaches `Settings.real_call_enabled_for` — THE GATE ITSELF.

    THE SOURCE OF TRUTH, and picking it took three tries. It is not `_ROUTE_SHAPES` (misses the
    traced-only tasks), not `_TASK_TRACE` (misses `domain_match`), and not their union either —
    that drops `stt_transcription` and `tts_synthesis`, which never touch `AIRouter` and call the
    gate directly from `stt.py` and `tts.py`. A registry is a list somebody maintains; the gate
    is the thing the report is ABOUT.

    Three call shapes, all of them present in the service today:
      `.run("literal", …)`            the router, positionally
      `task_type="literal"`           the router, by keyword
      `real_call_enabled_for(CONST)`  a direct caller passing a module constant
    """
    app = REPO / "apps" / "ai-service" / "app"
    literals: set[str] = set()
    consts: set[str] = set()
    assignments: dict[str, str] = {}

    for path in app.rglob("*.py"):
        src = path.read_text(encoding="utf8")
        literals.update(re.findall(r"""\.run\(\s*["']([a-z_]+)["']""", src))
        literals.update(re.findall(r"""task_type\s*=\s*["']([a-z_]+)["']""", src))
        literals.update(re.findall(r"""real_call_enabled_for\(\s*["']([a-z_]+)["']""", src))
        consts.update(re.findall(r"real_call_enabled_for\(\s*([A-Z][A-Z_]*)\s*\)", src))
        consts.update(re.findall(r"\.run\(\s*([A-Z][A-Z_]*)\s*,", src))
        for name, value in re.findall(
            r"""^([A-Z][A-Z_]*)\s*[:=][^=\n]*?["']([a-z_]+)["']""", src, re.M
        ):
            assignments.setdefault(name, value)

    return literals | {assignments[c] for c in consts if c in assignments}


def test_the_flag_scripts_task_list_covers_every_gated_task() -> None:
    """`TASKS` is derived from three sources; assert it against the GATE's call sites.

    A registry can drift from the code that uses it — that is how `resume_generation` went
    missing, and how the first derivation silently dropped STT and TTS. This is the check the
    script's own comment used to CLAIM and not implement.
    """
    import runpy

    module = runpy.run_path(str(FLAGS_SCRIPT), run_name="__not_main__")
    tasks = set(module["TASKS"])

    missing = _gated_task_strings() - tasks
    assert not missing, (
        "these task types are gated by real_call_enabled_for but the flag report does not cover "
        f"them, so their armed/unarmed state is invisible: {sorted(missing)}"
    )


def test_the_probe_can_see_a_task_that_is_gated_outside_the_router() -> None:
    """THE FIXTURE MUST CONTAIN WHAT THE DETECTOR DETECTS (R12 §0).

    The first version of the test above scanned only `AIRouter.run` call sites. It found five
    tasks, both the correct and the broken derivations covered all five, and a deliberately
    sabotaged build PASSED. The hole was precise: the sabotage dropped tasks the probe could not
    see. So assert that the probe sees at least one task whose ONLY gate is a direct call — if it
    stops seeing them, the test above is measuring less than it claims.
    """
    seen = _gated_task_strings()
    for task in ("stt_transcription", "tts_synthesis", "skill_embedding"):
        assert task in seen, (
            f"{task} is gated by a direct real_call_enabled_for call and the probe missed it — "
            "the coverage test above is now weaker than it reads"
        )


def test_the_task_list_is_not_hand_written() -> None:
    """The list must be DERIVED. A hand-written one has now been wrong twice.

    Asserted structurally rather than by value: pinning the nine names would be a third hand
    -written list, in a test, with the same failure mode one level up.
    """
    src = FLAGS_SCRIPT.read_text(encoding="utf8")
    assert "_ROUTE_SHAPES" in src and "_TASK_TRACE" in src, (
        "TASKS is no longer derived from the router's registries — a literal list here has been "
        "wrong twice, once with two invented task names"
    )
    # And it must not have quietly regained a literal.
    literal = re.search(r"^TASKS\s*=\s*\[", src, re.M)
    assert literal is None, "TASKS is a literal list again"


def test_the_two_registries_are_reported_as_their_union_and_it_matters() -> None:
    """The union is load-bearing: each registry holds tasks the other does not.

    THE FIXTURE CONTAINS WHAT THE DETECTOR DETECTS. If the two registries ever agreed, "union"
    and "either one" would be indistinguishable and this rule would be untested — so assert the
    disagreement itself, and name it when it disappears.
    """
    from app.ai.langfuse_tracing import _TASK_TRACE
    from app.ai.model_config import _ROUTE_SHAPES

    routed, traced = set(_ROUTE_SHAPES), set(_TASK_TRACE)
    assert routed - traced, "every routed task is now traced — the union rule is untested"
    assert traced - routed, "every traced task is now routed — the union rule is untested"


# ─────────────────────────────────────────────────────────────────────────────────────────
# §4.2 — the discarded-interview query
# ─────────────────────────────────────────────────────────────────────────────────────────


def _sql() -> str:
    return DISCARDED_SQL.read_text(encoding="utf8")


def _sql_without_comments() -> str:
    """The EXECUTABLE SQL only.

    WRITTEN AFTER THIS FILE COMMITTED THE VERY ERROR IT TESTS FOR. The first version searched
    the whole file for `ai_jobs.real_call IS TRUE` and went red — on the COMMENT that explains
    why that filter was wrong. A detector that matches a description of the defect instead of the
    defect is the same shape as a query that reads a column which cannot answer it, and it failed
    in the safe direction only by luck.
    """
    return "\n".join(
        line.split("--", 1)[0] for line in DISCARDED_SQL.read_text(encoding="utf8").splitlines()
    )


def test_the_query_reads_the_table_that_can_answer_it() -> None:
    """`ai_call_traces`, never `ai_jobs.real_call`.

    THE CHAIN, re-derived rather than quoted: `resume_profile` is written only by
    `toExtractionOutput`, which hardcodes `ai_metadata: null`; the job row's usage is then
    `toAiJobUsage(aiMeta ?? parseMeta)`, so with `aiMeta` null it records the /profile/parse
    call's metadata; `profile_parse` is not armed, so its `real_call` is false. The extraction
    call — the one that produced the overlay and the one that FAILED — never reaches `ai_jobs`.
    """
    executable = _sql_without_comments()
    assert "ai_call_traces" in executable, "the query no longer reads ai_call_traces at all"
    assert not re.search(r"ai_jobs\s*\.\s*real_call", executable, re.I), (
        "the query gates on ai_jobs.real_call, which is FALSE on exactly the rows it exists to "
        "find — this is the R8 §5.1 defect, back"
    )
    # NOT VACUOUS: the comment block explaining the old filter must still be there, so this test
    # cannot pass merely because someone deleted the file's history along with its defect.
    assert "ai_jobs.real_call IS TRUE" in _sql(), (
        "the explanation of why ai_jobs.real_call is wrong has been deleted — the next person to "
        "read this query has no way to know not to switch it back"
    )


FIXTURE = REPO / "apps" / "ai-service" / "tests" / "fixtures" / "discarded_interviews.sql"


def test_the_fixture_contains_a_discarded_interview() -> None:
    """THE SUB-PATTERN, as an executable rule.

    The original validation ran against three workers, none of whom had a discarded interview.
    A query returning zero was therefore consistent with a working query AND with the broken one
    that shipped. A fixture for a detector must contain a positive, a negative, and the decoy
    that fooled the previous version — here a `profile_parse` row, whose `real_call` is false and
    which the old filter matched.
    """
    assert FIXTURE.exists(), f"the seed fixture is missing: {FIXTURE}"
    sql = FIXTURE.read_text(encoding="utf8")
    assert "POSITIVE" in sql, "no discarded interview in the fixture — the detector's own hole"
    assert "NEGATIVE" in sql, (
        "no healthy interview in the fixture — a query returning every row would pass"
    )
    assert "DECOY" in sql, "no profile_parse decoy — the shape the OLD filter matched"
    assert "profile_extraction" in sql and "profile_parse" in sql


@pytest.mark.parametrize(
    "marker,why",
    [
        ("POSITIVE", "a worker whose interview produced an overlay and then lost it"),
        ("NEGATIVE", "a worker whose interview landed cleanly"),
        ("DECOY", "a profile_parse row the old ai_jobs.real_call filter would have matched"),
    ],
)
def test_each_fixture_row_states_what_it_is_for(marker: str, why: str) -> None:
    """A fixture row with no stated purpose is one nobody can tell is missing."""
    block = _fixture_block(marker)
    assert block.strip(), f"{marker} block is empty — {why}"
    assert "INSERT" in block.upper(), f"{marker} block inserts nothing — {why}"


#: The section RULE, not the word. Every marker word also appears in the file's header, and
#: anchoring on the bare word found the explanation instead of the rows it explains — the same
#: mistake `_sql_without_comments` exists to undo, one file over.
def _rule(marker: str) -> str:
    return f"── {marker} "


def _fixture_block(marker: str) -> str:
    sql = FIXTURE.read_text(encoding="utf8")
    start = sql.index(_rule(marker))
    later = [
        sql.index(m, start + 1)
        for m in [_rule(x) for x in ("POSITIVE", "NEGATIVE", "DECOY", "THE TURN FLOOR")]
        + ["-- END"]
        if m in sql[start + 1 :]
    ]
    return sql[start : min(later)] if later else sql[start:]
