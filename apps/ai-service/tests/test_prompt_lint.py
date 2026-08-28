"""§8.5 prompt lint — what a prompt may never ask the model to do.

WHY A LINT AND NOT A CONVENTION. Prompts drift. They are prose, they get edited by whoever is
closest to the symptom, and the rules they have to respect live in a document that is not in
this repository. A convention does not survive that; a test does.

WHAT IT CHECKS. §8.5 forbids asking the model to rate, rank, judge, summarise, improve phrasing,
guess a duration or a salary, infer a certification from a skill or the reverse, or fill a field
it was not told about. Those are the same rule as CLAUDE.md's "AI never owns business decisions",
stated at the level of the sentence a prompt actually contains.

WHAT IT DOES NOT CHECK, and this bound matters. It reads SOURCE. `prompt_registry` can serve a
Langfuse-managed override instead (`langfuse_prompts_enabled`), and this lint says nothing about
that text — so the flag being off is part of what makes this test meaningful, and is asserted.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1] / "app"

# Every module that builds text destined for an LLM.
PROMPT_FILES = [
    APP / "profiling" / "interview_prompts.py",
    APP / "profiling" / "prompts.py",
    APP / "profiling" / "parse_prompt.py",
    APP / "job_posting_chat" / "prompts.py",
    APP / "extraction.py",
]

# The forbidden asks, as the verb a prompt would actually use. Each maps to the §8.5 clause it
# implements; the phrasing is deliberately narrow so the lint flags instructions rather than
# incidental vocabulary ("no invented details" must not trip the "invent" rule).
FORBIDDEN = {
    "rate/score": r"\b(?:rate|score|grade)\s+(?:the\s+)?(?:worker|candidate|profile|answer)",
    "rank": r"\brank\s+(?:the\s+)?(?:worker|candidate|profile|them)",
    "judge": r"\b(?:judge|assess|evaluate)\s+(?:the\s+)?(?:worker|candidate|suitability|fit)\b",
    # Both the verb and the noun. The prompt this catches says "You write a short, plain worker
    # summary", which is the forbidden ask in noun form — a lint that only knew the verb would
    # have reported the file clean, which is how a rule quietly stops being enforced.
    "summarise the worker": (
        r"\bsummar(?:ise|ize)\s+(?:the\s+)?(?:worker|candidate|profile)\b"
        r"|\b(?:worker|candidate|profile)\s+summary\b"
    ),
    "improve phrasing": (
        r"\b(?:improve|polish|enhance|rewrite)\s+(?:the\s+)?"
        r"(?:phrasing|wording|answer|english)"
    ),
    "guess a duration": (
        r"\b(?:guess|estimate|infer|assume)\s+(?:the\s+)?"
        r"(?:duration|years|experience|tenure)"
    ),
    "guess a salary": r"\b(?:guess|estimate|infer|assume)\s+(?:the\s+)?(?:salary|wage|pay)",
    "infer a certification": r"\binfer\s+(?:a\s+)?(?:certification|certificate|qualification)",
    "fill an untold field": r"\bfill\s+in\s+(?:any\s+)?(?:missing|blank|unknown)\s+field",
}

# ---------------------------------------------------------------------------
# KNOWN CONFLICT, RECORDED RATHER THAN EXEMPTED QUIETLY.
#
# `profiling/prompts.py` instructs: "You write a short, plain worker summary from a structured
# profile." That is a shipped feature (the profile-summary surface) AND it matches §8.5's
# "summarise" clause head-on. Which one gives is an owner ruling, not a lint decision:
#
#   - if §8.5 means "never summarise INTO A JUDGEMENT", the prompt is fine as written and the
#     rule wants narrowing;
#   - if it means what it says, the feature needs re-scoping to a deterministic renderer.
#
# Suppressing it silently would lose the question; failing CI on it would block unrelated work
# for a decision nobody has been asked for. So it is listed here, by file and clause, where the
# next person cannot miss it — and the test below asserts the list is EXACTLY this, so a second
# violation cannot hide behind the first.
# ---------------------------------------------------------------------------
KNOWN_CONFLICTS = {("prompts.py", "summarise the worker")}


def _prompt_text(path: Path) -> str:
    """Source with comments stripped — a comment describing a rule is not an instruction."""
    return "\n".join(
        line
        for line in path.read_text(encoding="utf-8").splitlines()
        if not line.strip().startswith("#")
    )


def _violations() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path in PROMPT_FILES:
        if not path.exists():
            continue
        text = _prompt_text(path)
        for clause, pattern in FORBIDDEN.items():
            if re.search(pattern, text, re.IGNORECASE):
                found.add((path.name, clause))
    return found


def test_every_prompt_file_the_lint_names_still_exists():
    # A lint over a moved file is a lint over nothing, and it would stay green forever.
    missing = [p.name for p in PROMPT_FILES if not p.exists()]
    assert missing == []


@pytest.mark.parametrize("path", PROMPT_FILES, ids=lambda p: p.name)
def test_no_prompt_asks_the_model_to_do_what_8_5_forbids(path: Path):
    hits = {(f, c) for (f, c) in _violations() if f == path.name} - KNOWN_CONFLICTS
    assert hits == set(), (
        f"{path.name} instructs the model to do what §8.5 forbids: {sorted(c for _, c in hits)}. "
        "The model may extract, classify and generate; it may never rate, rank, judge or guess."
    )


def test_the_known_conflict_list_is_exactly_what_is_still_outstanding():
    # Two failure modes this closes. A conflict that gets FIXED must be removed from the list,
    # or the list starts documenting a problem that no longer exists. And a NEW violation must
    # not be able to shelter behind an existing entry.
    assert _violations() == KNOWN_CONFLICTS


def test_the_lint_can_actually_fire():
    # The mutation bar. A pattern set that matches nothing would pass every test above.
    sample = "Please rate the worker on a scale of one to ten and rank the candidate."
    matched = [c for c, p in FORBIDDEN.items() if re.search(p, sample, re.IGNORECASE)]
    assert "rate/score" in matched
    assert "rank" in matched


def test_source_linting_is_meaningful_because_managed_prompts_are_off():
    # The bound in this module's docstring, asserted rather than described: if Langfuse-managed
    # prompts were live, the text this lint reads would not be the text that gets sent.
    from app.config import Settings

    assert Settings.model_fields["langfuse_prompts_enabled"].default is False
