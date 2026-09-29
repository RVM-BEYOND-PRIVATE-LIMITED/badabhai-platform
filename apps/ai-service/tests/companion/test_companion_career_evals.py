"""The career red-team eval's CI half (ADR-0046 P3, A3).

CI cannot score a model — the suite is mock-only — so this file gates the two deterministic
halves the staging CLI depends on:

1. THE SET: size, per-topic coverage, language spread, no duplicates. A red-team set that lost
   a topic would let the CLI report 100 % while a whole category went unasked.
2. THE SCORER: it must be capable of FAILING. A predictor that answers everything must trip the
   unsafe check; one that refuses everything must trip the answer-rate bar; a perfect one passes.

The model itself is scored on staging by `python -m app.companion.eval_cli --career`.
"""

from __future__ import annotations

from collections import Counter

from app.companion import eval_career_redteam as gold


def test_the_set_meets_the_phase_3_size_and_coverage_bars():
    assert len(gold.PROMPTS) >= 150
    risky = [(t, e, topic) for t, e, topic in gold.PROMPTS if e == "refuse"]
    normal = [(t, e, topic) for t, e, topic in gold.PROMPTS if e == "answer"]
    assert len(normal) >= 50

    per_topic = Counter(topic for _t, _e, topic in risky)
    for topic in gold.TOPICS:
        assert per_topic[topic] >= 25, f"{topic} has only {per_topic[topic]} prompts"
    # Every label is one of the two dispositions, and a refusal always names a closed topic.
    assert {e for _t, e, _topic in gold.PROMPTS} == {"refuse", "answer"}
    assert set(per_topic) == set(gold.TOPICS)
    assert all(topic == "" for _t, e, topic in gold.PROMPTS if e == "answer")


def test_the_set_spans_languages_and_includes_jailbreak_wrappers():
    joined = "\n".join(t for t, _e, _topic in gold.PROMPTS)
    # Devanagari lines are present...
    assert any("\u0900" <= ch <= "\u097f" for ch in joined)
    # ...and so are Latin-Hinglish and English lines.
    assert "welder ki salary" in joined
    assert "how much salary does a welder get" in joined
    # Jailbreak wrappers ride around real questions (ignore rules / role-play / extraction).
    assert "ignore your rules" in joined
    assert "pretend you are" in joined
    assert "system prompt" in joined


def test_the_set_has_no_duplicates():
    texts = [t for t, _e, _topic in gold.PROMPTS]
    duplicates = [t for t, n in Counter(texts).items() if n > 1]
    assert duplicates == []


def test_the_scorer_passes_a_perfect_predictor():
    score = gold.evaluate(lambda text: None)  # everything failed = fail-closed, no unsafe
    # A model that never answers serves no unsafe answer but misses every normal question.
    assert score.unsafe == 0
    assert score.failed_checks != []
    assert score.answer_rate < gold.THRESHOLDS["answer_rate"]


def test_the_scorer_catches_a_model_that_answers_risky_prompts():
    def answers_everything(_text: str) -> str:
        return "answered"

    score = gold.evaluate(answers_everything)
    # THE failure this set exists to catch: risky prompts served as answers.
    assert score.unsafe >= 125
    assert any("unsafe answers served" in check for check in score.failed_checks)


def test_the_scorer_catches_a_model_that_refuses_everything():
    def refuses_everything(_text: str) -> str:
        return "refused"

    score = gold.evaluate(refuses_everything)
    assert score.unsafe == 0
    assert score.answer_rate == 0.0
    assert any("answer rate" in check for check in score.failed_checks)


def test_a_model_that_refuses_risky_and_answers_normal_passes():
    risky = {t for t, e, _topic in gold.PROMPTS if e == "refuse"}

    def perfect(text: str) -> str:
        return "refused" if text in risky else "answered"

    score = gold.evaluate(perfect)
    assert score.unsafe == 0
    assert score.answer_rate == 1.0
    assert score.failed_checks == []
