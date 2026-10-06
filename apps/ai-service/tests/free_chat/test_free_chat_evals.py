"""The free-chat classifier's labelled set and its staging CLI (ADR-0051 R20), deterministically.

WHAT RUNS IN CI. The set is a BASELINE for the real model, so CI pins what makes a staging run
meaningful, never an accuracy:

  1. THE SET covers all eight categories in both modes the way the spec asks (~60 lines, ~20 in
     résumé mode, mixed scripts) and does not echo the classify prompt's own examples;
  2. THE SCORER is exact (a perfect predictor scores 1.0, an unavailable answer is a miss);
  3. THE CLI, against a fake transport: it sends the mode and the question, applies the API's
     confidence floor, reports per category and p95, never fails on accuracy, and still refuses
     a run that is not evidence (a mock, a failed call, a fallback model).

Fabricated eval text only.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import get_args

import httpx
import pytest

from app.companion import eval_cli as call_layer
from app.contracts import FreeChatCategory, FreeChatClassifyMode
from app.free_chat import eval_cli
from app.free_chat import eval_free_classify_gold as gold
from app.free_chat.prompts import CLASSIFY_SYSTEM_PROMPT

_REPO = Path(__file__).resolve().parents[4]
_BASE = "http://ai.test"
_PRIMARY = "gemini-2.5-flash-lite"


# ── 1. the set ───────────────────────────────────────────────────────────────────────────────


def test_the_categories_and_modes_are_the_contracts() -> None:
    assert gold.CATEGORIES == get_args(FreeChatCategory)
    assert gold.MODES == get_args(FreeChatClassifyMode)


def test_the_set_is_about_sixty_lines_and_covers_every_category() -> None:
    assert 55 <= len(gold.CASES) <= 70
    counts = Counter(category for _t, _m, _q, category in gold.CASES)
    assert set(counts) == set(gold.CATEGORIES)
    for category in gold.CATEGORIES:
        assert counts[category] >= 3, f"{category}: only {counts[category]} cases"
    keys = [(text, mode, question) for text, mode, question, _c in gold.CASES]
    assert len(set(keys)) == len(keys), "duplicate cases"


def test_resume_mode_is_about_twenty_lines_with_answers_and_off_topic() -> None:
    resume_mode = [case for case in gold.CASES if case[1] == "resume"]
    assert 18 <= len(resume_mode) <= 25
    answers = [case for case in resume_mode if case[3] == "resume"]
    off_topic = {case[3] for case in resume_mode if case[3] != "resume"}
    assert len(answers) >= 10
    # Every non-résumé category appears mid-interview at least once.
    assert off_topic == set(gold.CATEGORIES) - {"resume"}
    texts = {case[0] for case in resume_mode}
    for required in ("cricket kaun jeeta", "koi job hai kya"):
        assert required in texts, required


def test_every_resume_case_has_a_question_and_no_free_case_does() -> None:
    for text, mode, question, _category in gold.CASES:
        assert mode in gold.MODES, text
        if mode == "resume":
            assert question, f"{text!r}: résumé mode needs the question on screen"
        else:
            assert question is None, f"{text!r}: free mode has no question on screen"


def test_the_set_mixes_hinglish_devanagari_and_english() -> None:
    texts = [text for text, _m, _q, _c in gold.CASES]
    devanagari = [t for t in texts if re.search("[ऀ-ॿ]", t)]
    english = [t for t in texts if t.isascii() and " " in t and re.search(r"\b(?:I|want)\b", t)]
    assert len(devanagari) >= 5, devanagari
    assert len(english) >= 3, english
    # Both modes carry Devanagari, so the script bucket is not only a free-mode measurement.
    modes = {mode for text, mode, _q, _c in gold.CASES if re.search("[ऀ-ॿ]", text)}
    assert modes == set(gold.MODES)


def test_no_case_is_one_of_the_classify_prompts_quoted_examples() -> None:
    """A gold line the prompt quotes is a memory test, not a measurement of the rule."""
    quoted = {q.casefold() for q in re.findall(r'"([^"]+)"', CLASSIFY_SYSTEM_PROMPT)}
    assert {"5 saal", "pune mein", "haan", "welding", "pata nahi"} <= quoted  # non-vacuous
    echoed = [text for text, _m, _q, _c in gold.CASES if text.casefold() in quoted]
    assert echoed == []


# ── 2. the scorer ────────────────────────────────────────────────────────────────────────────


def test_a_perfect_predictor_scores_one_everywhere() -> None:
    expected = {(t, m, q): c for t, m, q, c in gold.CASES}
    score = gold.evaluate(lambda t, m, q: expected[(t, m, q)])
    assert (score.correct, score.total, score.accuracy) == (len(gold.CASES), len(gold.CASES), 1.0)
    assert all(correct == total for correct, total in score.per_category.values())
    assert all(correct == total for correct, total in score.per_mode.values())
    assert score.misses == []


def test_an_unavailable_answer_is_a_miss_for_every_category_never_unclear() -> None:
    score = gold.evaluate(lambda _t, _m, _q: None)
    assert score.correct == 0
    assert score.predicted == {gold.UNAVAILABLE: len(gold.CASES)}
    # Not folded into `unclear`: the unclear lines score zero too.
    assert score.per_category["unclear"][0] == 0


def test_the_per_category_counts_add_up() -> None:
    score = gold.evaluate(lambda _t, _m, _q: "unclear")
    unclear_total = sum(1 for case in gold.CASES if case[3] == "unclear")
    assert score.per_category["unclear"] == (unclear_total, unclear_total)
    assert sum(total for _c, total in score.per_category.values()) == len(gold.CASES)
    assert sum(total for _c, total in score.per_mode.values()) == len(gold.CASES)
    assert score.correct == unclear_total
    assert len(score.misses) == len(gold.CASES) - unclear_total


# ── 3. the CLI against a fake transport ──────────────────────────────────────────────────────


def _meta(real_call: bool = True, model: str = _PRIMARY, latency_ms: int = 100) -> dict:
    return {
        "ai_call_id": "c",
        "task_type": "profiling_free_classify",
        "model_name": model,
        "provider": "google",
        "real_call": real_call,
        "success": True,
        "latency_ms": latency_ms,
        "estimated_cost_inr": 0.01 if real_call else 0.0,
        "error_code": None,
        "candidates_tried": [model] if real_call else [],
    }


class FakeService:
    """`httpx.post` and the clock, replaced on the SHARED call layer (the companion eval's)."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, answer) -> None:
        self.now = 0.0
        self.calls: list[tuple[str, dict]] = []
        self._answer = answer
        monkeypatch.setattr(call_layer.httpx, "post", self.post)
        monkeypatch.setattr(call_layer.time, "perf_counter", lambda: self.now)

    def post(self, url: str, json: dict, headers: dict, timeout: float) -> httpx.Response:
        path = url.removeprefix(_BASE)
        self.calls.append((path, json))
        result = self._answer(path, json)
        latency_ms = 100.0
        if isinstance(result, tuple):
            result, latency_ms = result
        self.now += latency_ms / 1000.0
        request = httpx.Request("POST", url)
        if isinstance(result, int):
            return httpx.Response(result, request=request)
        return httpx.Response(200, json=result, request=request)


def _verdict(category: str, confidence: float = 0.9, **meta) -> dict:
    return {
        "category": category,
        "confidence": confidence,
        "blocked": False,
        "ai_metadata": _meta(**meta),
    }


def _small_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        gold,
        "CASES",
        [
            ("5 saal ho gaye", "resume", gold.Q_YEARS, "resume"),
            ("namaste", "free", None, "casual"),
            ("hmm", "free", None, "unclear"),
        ],
    )


def test_the_cli_sends_the_mode_and_the_question(monkeypatch: pytest.MonkeyPatch) -> None:
    _small_set(monkeypatch)
    service = FakeService(monkeypatch, lambda _p, _b: _verdict("resume"))
    eval_cli.main(["--base-url", _BASE])
    assert [path for path, _b in service.calls] == ["/free-chat/classify"] * 3
    assert service.calls[0][1] == {
        "text": "5 saal ho gaye",
        "recent_turns": [],
        "mode": "resume",
        "pending_question": gold.Q_YEARS,
    }
    assert service.calls[1][1]["mode"] == "free"
    assert service.calls[1][1]["pending_question"] is None


def test_accuracy_is_a_baseline_a_clean_wrong_run_still_exits_zero(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Owner ruling (R18/R20): no accuracy bar. Every answer wrong, but real, primary-served and
    complete, is EVIDENCE of a bad classifier: recorded, not failed."""
    _small_set(monkeypatch)
    FakeService(monkeypatch, lambda _p, _b: _verdict("trash"))
    assert eval_cli.main(["--base-url", _BASE, "--expect-model", _PRIMARY]) == 0
    out = capsys.readouterr().out
    assert "0/3 = 0.0% overall" in out
    assert "RESULT: PASS" in out
    assert "MISS [resume] '5 saal ho gaye': expected resume, got trash" in out


def test_the_report_prints_every_category_both_modes_and_p95(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _small_set(monkeypatch)
    expected = {text: category for text, _m, _q, category in gold.CASES}
    FakeService(monkeypatch, lambda _p, body: (_verdict(expected[body["text"]]), 400.0))
    assert eval_cli.main(["--base-url", _BASE]) == 0
    out = capsys.readouterr().out
    for category in gold.CATEGORIES:
        assert re.search(rf"category {category}\s", out), category
    assert re.search(r"category resume\s+1/1 = 100\.0%", out)
    assert re.search(r"category trash\s+0/0 = 0\.0%", out)
    assert re.search(r"mode\s+resume\s+1/1 = 100\.0%", out)
    assert "p95 400 ms" in out
    assert "3/3 = 100.0% overall" in out


def test_the_api_floor_turns_low_confidence_into_unclear_both_ways(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _small_set(monkeypatch)
    answers = {
        "5 saal ho gaye": _verdict("resume", 0.5),  # right category, below the floor: MISS
        "namaste": _verdict("casual", 0.6),  # exactly the floor: kept
        "hmm": _verdict("career", 0.3),  # wrong category, below the floor: unclear, HIT
    }
    FakeService(monkeypatch, lambda _p, body: answers[body["text"]])
    run = eval_cli.run_free_classify_eval(_BASE)
    assert run.score.correct == 2
    assert run.floored == 2
    assert run.score.misses == ["[resume] '5 saal ho gaye': expected resume, got unclear"]


def test_a_mock_answer_contaminates_the_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The unarmed task's mock says `unclear` and would HIT the unclear line: it must not count,
    and the run is not evidence (is the task in the target's AI_REAL_CALL_TASKS?)."""
    _small_set(monkeypatch)
    FakeService(monkeypatch, lambda _p, _b: _verdict("unclear", 0.0, real_call=False))
    assert eval_cli.main(["--base-url", _BASE]) == 1
    out = capsys.readouterr().out
    assert "CONTAMINATED: 3 answers came from the deterministic mock" in out
    assert re.search(r"category unclear\s+0/1 = 0\.0%", out)
    assert "RESULT: FAIL" in out


def test_a_fallback_model_fails_the_run_under_expect_model(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _small_set(monkeypatch)
    FakeService(monkeypatch, lambda _p, _b: _verdict("casual", model="claude-haiku-4-5"))
    assert eval_cli.main(["--base-url", _BASE, "--expect-model", _PRIMARY]) == 1
    assert "FALLBACK: 3 answers were not served by the expected model" in capsys.readouterr().out


def test_a_failed_call_is_incomplete_and_the_run_continues(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _small_set(monkeypatch)

    def answer(_path: str, body: dict):
        return 503 if body["text"] == "namaste" else _verdict("unclear")

    service = FakeService(monkeypatch, answer)
    assert eval_cli.main(["--base-url", _BASE]) == 1
    out = capsys.readouterr().out
    assert len(service.calls) == 4  # the 503 was retried once, and the run went on
    assert "INCOMPLETE: 1 calls failed" in out


def test_a_late_or_blocked_answer_is_unavailable_not_a_verdict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _small_set(monkeypatch)
    late_ms = eval_cli.API_TIMEOUT_MS + 1

    def answer(_path: str, body: dict):
        if body["text"] == "5 saal ho gaye":
            return _verdict("resume"), late_ms  # right, but the API timed it out
        if body["text"] == "hmm":
            return {"category": "unclear", "confidence": 0.0, "blocked": True, "ai_metadata": None}
        return _verdict("casual")

    FakeService(monkeypatch, answer)
    run = eval_cli.run_free_classify_eval(_BASE)
    assert run.score.predicted == {gold.UNAVAILABLE: 2, "casual": 1}
    assert run.score.correct == 1
    assert len(run.calls.over_api_timeout) == 1


def test_the_eval_floor_is_the_number_the_classify_prompt_names() -> None:
    """ADR-0051 §3.2 rule 12: below 0.6 is clarify. The eval scores with the same floor the
    prompt tells the model to use, so a change to one must move the other."""
    assert eval_cli.MIN_CONFIDENCE == 0.6
    assert f"use below {eval_cli.MIN_CONFIDENCE} when unsure" in CLASSIFY_SYSTEM_PROMPT


def test_the_cli_refuses_bad_arguments() -> None:
    for argv in (
        ["--base-url", _BASE, "--pace-ms", "-1"],
        ["--base-url", _BASE, "--expect-model", " "],
        ["--base-url", _BASE, "--min-confidence", "1.5"],
        [],
    ):
        with pytest.raises(SystemExit):
            eval_cli.main(argv)


def test_the_api_timeout_is_the_api_clients_own_once_it_calls_the_route() -> None:
    """ADR-0051 §3.3 says ~2.5 s; the number that counts is the API client's. Until the API
    change (PR B) calls `/free-chat/classify` there is nothing to pin against, and this skips
    rather than asserting the ADR's prose; from then on a drift turns it red."""
    source = (_REPO / "apps" / "api" / "src" / "ai" / "ai.service.ts").read_text(encoding="utf-8")
    found = re.findall(r'this\.post\("/free-chat/classify", input, \w+, ([\d_]+)', source)
    if not found:
        pytest.skip("apps/api does not call /free-chat/classify yet (ADR-0051 PR B)")
    assert {float(ms.replace("_", "")) for ms in found} == {eval_cli.API_TIMEOUT_MS}
