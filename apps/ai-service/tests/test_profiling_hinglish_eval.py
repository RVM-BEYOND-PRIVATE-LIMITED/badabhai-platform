"""The D4 blind Hinglish gate — set, scorer and staging CLI, deterministically.

WHAT RUNS IN CI. The real model is scored only by the staging CLI. CI pins what makes that run
meaningful:
  1. the set is contained to its own schema, covers every field, mixes scripts and carries
     no-fact cases so an invented fact is catchable;
  2. the scorer passes a perfect prediction and fails on a miss, a wrong value and an extra
     fill;
  3. the CLI posts the fixture request, scores the served body, writes the JSON report and
     refuses a run that is not evidence (a mock, a failed call, a fallback model).
Fabricated eval text only.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.companion import eval_cli as call_layer
from app.contracts import ProfilingTurnUnderstandInput
from app.profiling import eval_hinglish_cli as eval_cli
from app.profiling import eval_hinglish_gold as gold

_BASE = "http://ai.test"
_PRIMARY = "claude-haiku-4-5"


def _perfect(case: gold.Case) -> list[tuple[str, str]]:
    return [(key, values[0]) for key, values in case.expected.items()]


# ── 1. the set ───────────────────────────────────────────────────────────────────────────────


def test_the_set_is_sound() -> None:
    assert gold.check_set() == []


def test_every_case_is_a_valid_request() -> None:
    for case in gold.CASES:
        ProfilingTurnUnderstandInput.model_validate(case.request())


def test_the_set_covers_every_field_and_carries_no_fact_cases() -> None:
    for field_name in gold.SCHEMA_KEYS:
        assert any(field_name in case.expected for case in gold.CASES), field_name
    assert sum(1 for case in gold.CASES if not case.expected) >= 5


def test_the_set_mixes_scripts() -> None:
    devanagari = [case for case in gold.CASES if any("ऀ" <= ch <= "ॿ" for ch in case.text)]
    assert len(devanagari) >= 2
    assert len(gold.CASES) >= 100


# ── 2. the scorer ────────────────────────────────────────────────────────────────────────────


def test_a_perfect_predictor_scores_everything() -> None:
    score = gold.evaluate(lambda case: _perfect(case))
    assert score.field_accuracy == 1.0
    assert score.fill_precision == 1.0
    assert score.exact_rate == 1.0
    assert score.misses == [] and score.wrong_fills == []


def test_a_missed_fact_lowers_recall_but_not_precision() -> None:
    skip = gold.CASES[0].text

    def predict(case: gold.Case) -> list[tuple[str, str]]:
        return [] if case.text == skip else _perfect(case)

    score = gold.evaluate(predict)
    assert score.field_accuracy < 1.0
    assert score.fill_precision == 1.0
    assert any("case 1" in miss for miss in score.misses)


def test_a_wrong_value_is_a_miss_and_a_wrong_fill() -> None:
    target = gold.CASES[0]

    def predict(case: gold.Case) -> list[tuple[str, str]]:
        fills = _perfect(case)
        if case is target:
            fills = [
                ("primary_trade", "Plumber") if key == "primary_trade" else (key, value)
                for key, value in fills
            ]
        return fills

    score = gold.evaluate(predict)
    assert score.field_accuracy < 1.0
    assert score.fill_precision < 1.0
    assert any("wrong primary_trade" in wrong for wrong in score.wrong_fills)


def test_an_extra_fill_on_a_no_fact_case_is_a_false_positive() -> None:
    no_fact = next(case for case in gold.CASES if not case.expected)

    def predict(case: gold.Case) -> list[tuple[str, str]]:
        return [("current_city", "Pune")] if case is no_fact else _perfect(case)

    score = gold.evaluate(predict)
    assert score.fill_precision < 1.0
    assert any("extra current_city" in wrong for wrong in score.wrong_fills)


def test_numbers_are_read_in_the_units_hinglish_uses() -> None:
    assert gold._number("5 saal") == 5
    assert gold._number("35,000") == 35_000
    assert gold._number("35k") == 35_000
    assert gold._number("35 hazar") == 35_000
    assert gold._number("1.5 lakh") == 150_000
    assert gold._number("koi nahi") is None


def test_a_city_with_a_state_suffix_still_matches() -> None:
    assert gold._matches("current_city", ("Pune",), "Pune, Maharashtra")


def test_the_surface_grinder_alias_the_baseline_returned_matches() -> None:
    assert gold._matches("primary_trade", gold.GRINDER, "Surface Grinder Operator")


# ── 3. the CLI against a fake transport ──────────────────────────────────────────────────────


def _meta(real_call: bool = True, model: str = _PRIMARY) -> dict:
    return {
        "ai_call_id": "c",
        "task_type": eval_cli.TASK_TYPE,
        "model_name": model,
        "provider": "anthropic",
        "real_call": real_call,
        "success": True,
        "latency_ms": 100,
        "estimated_cost_inr": 0.01 if real_call else 0.0,
        "error_code": None,
        "candidates_tried": [model] if real_call else [],
    }


class FakeService:
    """`httpx.post` and the clock, replaced on the SHARED call layer."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, answer) -> None:
        self.now = 0.0
        self.calls: list[tuple[str, dict]] = []
        self._answer = answer
        monkeypatch.setattr(call_layer.httpx, "post", self.post)
        monkeypatch.setattr(call_layer.time, "perf_counter", lambda: self.now)

    def post(self, url: str, json: dict, headers: dict, timeout: float) -> httpx.Response:
        self.calls.append((url.removeprefix(_BASE), json))
        result = self._answer(json)
        self.now += 0.1
        request = httpx.Request("POST", url)
        if isinstance(result, int):
            return httpx.Response(result, request=request)
        return httpx.Response(200, json=result, request=request)


def _answer_perfectly(meta: dict | None = None):
    by_text = {case.text: _perfect(case) for case in gold.CASES}

    def answer(body: dict) -> dict:
        fills = by_text[body["text"]]
        return {
            "intent": "statement",
            "confidence": 0.9,
            "fills": [{"key": key, "value": value} for key, value in fills],
            "edits": [],
            "page_owned_mentions": [],
            "on_screen_none": False,
            "blocked": False,
            "ai_metadata": meta if meta is not None else _meta(),
        }

    return answer


def test_the_cli_posts_every_case_and_passes_a_perfect_service(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    service = FakeService(monkeypatch, _answer_perfectly())
    report = tmp_path / "report.json"
    assert (
        eval_cli.main(
            [
                "--base-url",
                _BASE,
                "--expect-model",
                _PRIMARY,
                "--label",
                "haiku-4-5",
                "--json",
                str(report),
            ]
        )
        == 0
    )
    assert [path for path, _body in service.calls] == [eval_cli.ROUTE] * len(gold.CASES)
    assert service.calls[0][1] == gold.CASES[0].request()
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["label"] == "haiku-4-5"
    assert payload["field_accuracy"] == 1.0
    assert payload["total"] == len(gold.CASES)


def test_a_mock_answer_makes_the_run_not_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeService(monkeypatch, _answer_perfectly(_meta(real_call=False)))
    assert eval_cli.main(["--base-url", _BASE]) == 1


def test_a_fallback_model_fails_an_expect_model_run(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeService(monkeypatch, _answer_perfectly(_meta(model="gemini-2.5-flash-lite")))
    assert eval_cli.main(["--base-url", _BASE, "--expect-model", _PRIMARY]) == 1


def test_a_failed_call_is_scored_as_no_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeService(monkeypatch, lambda _body: 500)
    assert eval_cli.main(["--base-url", _BASE]) == 1


def test_malformed_fills_are_ignored() -> None:
    assert eval_cli._fills({"fills": [{"key": "current_city", "value": "Pune"}, "x", {}]}) == [
        ("current_city", "Pune")
    ]
    assert eval_cli._fills({"fills": None}) == []


def test_the_cli_refuses_bad_arguments() -> None:
    for argv in (
        ["--base-url", _BASE, "--pace-ms", "-1"],
        ["--base-url", _BASE, "--expect-model", " "],
        [],
    ):
        with pytest.raises(SystemExit):
            eval_cli.main(argv)
