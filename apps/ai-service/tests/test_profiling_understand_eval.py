"""The profiling turn's understanding — gold set, scorer and staging CLI, deterministically.

WHAT RUNS IN CI (ADR-0057 §6). The real model is scored only by the staging CLI; CI pins what
makes that run meaningful:
  1. THE SET is contained to its own fixture (every expected key, ref and mention is one the model
     is shown), covers every intent and the cases the issue names, and mixes scripts;
  2. THE SCORER is capable of passing AND of failing on each of the four bars;
  3. THE CLI, against a fake transport, posts the fixture request, scores the served body, and
     refuses a run that is not evidence (a mock answer, a failed call, a fallback model).
Fabricated eval text only.
"""

from __future__ import annotations

import httpx
import pytest

from app.companion import eval_cli as call_layer
from app.contracts import ProfilingTurnIntent, ProfilingTurnUnderstandInput
from app.profiling import eval_understand_cli as eval_cli
from app.profiling import eval_understand_gold as gold

_BASE = "http://ai.test"
_PRIMARY = "claude-haiku-4-5"


# ── 1. the set ───────────────────────────────────────────────────────────────────────────────


def test_the_set_is_contained_to_its_own_fixture() -> None:
    assert gold.check_set() == []


def test_every_case_is_a_valid_request() -> None:
    """A staging run cannot fail on a 422 the set itself caused."""
    for case in gold.CASES:
        ProfilingTurnUnderstandInput.model_validate(case.request())


def test_the_set_covers_every_intent_the_api_acts_on() -> None:
    from typing import get_args

    covered = {intent for case in gold.CASES for intent in case.intents}
    assert covered == set(get_args(ProfilingTurnIntent))


def test_the_set_carries_the_cases_the_issue_names() -> None:
    texts = {case.text for case in gold.CASES}
    # The owner's own message, read into a fresh interview.
    assert any("CNC turner hoon, paanch saal" in text for text in texts)
    kinds = {
        "edit with a value": any(e[0] == "edit" and e[3] for c in gold.CASES for e in c.edits),
        "edit without a value": any(
            e[0] == "edit" and e[3] is None for c in gold.CASES for e in c.edits
        ),
        "delete": any(e[0] == "delete" for c in gold.CASES for e in c.edits),
        "page-owned mention": any(c.mentions for c in gold.CASES),
        "fill while chatting": any(c.on_screen == gold.HOW_ARE_YOU and c.fills for c in gold.CASES),
        "statement, not an edit": any(
            "statement" in c.intents and not c.edits and not c.fills for c in gold.CASES
        ),
    }
    assert all(kinds.values()), kinds


def test_the_set_mixes_scripts_and_languages() -> None:
    devanagari = [c for c in gold.CASES if any("ऀ" <= ch <= "ॿ" for ch in c.text)]
    english = [c for c in gold.CASES if c.text.startswith(("I am", "how ", "remove "))]
    assert len(devanagari) >= 2 and len(english) >= 2
    assert 40 <= len(gold.CASES) <= 80


# ── 2. the scorer ────────────────────────────────────────────────────────────────────────────


def _perfect(case: gold.Case) -> gold.Prediction:
    fills = [(key, values[0]) for key, values in case.fills.items()]
    edits = [
        (op, key, ref, None if values is None else values[0]) for op, key, ref, values in case.edits
    ]
    return (case.intents[0], fills, edits, list(case.mentions), case.none is True)


def test_a_perfect_predictor_passes_every_bar() -> None:
    score = gold.evaluate(_perfect)
    assert score.failed == []
    assert score.intent_accuracy == 1.0
    assert score.fill_precision == 1.0
    assert score.fills_found == score.fills_required
    assert score.edits_exact == score.total


def test_a_single_false_delete_fails_the_run() -> None:
    def predict(case: gold.Case) -> gold.Prediction:
        intent, fills, edits, mentions, none = _perfect(case)
        if case.text == "aur kitna bacha hai":
            edits = [("delete", "skills", "s1", None)]
        return (intent, fills, edits, mentions, none)

    score = gold.evaluate(predict)
    assert any("false-positive deletes" in f for f in score.failed)


def test_a_key_outside_the_schema_fails_the_run() -> None:
    def predict(case: gold.Case) -> gold.Prediction:
        intent, fills, edits, mentions, none = _perfect(case)
        return (
            intent,
            [*fills, ("aadhaar_number", "x")] if case is gold.CASES[0] else fills,
            edits,
            mentions,
            none,
        )

    assert any("outside the schema" in f for f in gold.evaluate(predict).failed)


def test_wrong_fills_fail_precision_and_allowed_ones_do_not() -> None:
    def wrong(case: gold.Case) -> gold.Prediction:
        intent, fills, edits, mentions, none = _perfect(case)
        return (intent, [(key, "Kuch aur") for key, _v in fills], edits, mentions, none)

    assert any("fill precision" in f for f in gold.evaluate(wrong).failed)

    def generous(case: gold.Case) -> gold.Prediction:
        intent, fills, edits, mentions, none = _perfect(case)
        extra = [(key, values[0]) for key, values in case.allowed.items() if values]
        return (intent, fills + extra, edits, mentions, none)

    assert gold.evaluate(generous).failed == []


def test_no_answer_misses_the_intent_and_finds_nothing() -> None:
    score = gold.evaluate(lambda _case: None)
    assert score.intent_correct == 0
    assert score.fills_found == 0
    assert any("intent accuracy" in f for f in score.failed)


def test_the_set_grades_the_none_reading_both_ways() -> None:
    """#2330: real nones, real answers over the same free-text question, and no pack question."""
    graded = [c for c in gold.CASES if c.none is not None]
    nones = [c for c in graded if c.none and c.on_screen == gold.TRAINING_Q]
    answers = [c for c in graded if not c.none and c.on_screen == gold.TRAINING_Q]
    assert len(nones) >= 3 and len(answers) >= 3
    assert any(c.none is False and c.on_screen == gold.MODEL_Q for c in graded)
    # A Devanagari none too: the floor of the rule is the meaning, not the script.
    assert any(c.none and any("ऀ" <= ch <= "ॿ" for ch in c.text) for c in nones)


def _with_none(text: str, value: bool):
    def predict(case: gold.Case) -> gold.Prediction:
        intent, fills, edits, mentions, none = _perfect(case)
        return (intent, fills, edits, mentions, value if case.text == text else none)

    return predict


def test_a_none_over_a_real_free_text_answer_fails_the_run() -> None:
    """Owner ruling 2026-10-16: 0 false nones — the API would never store this training."""
    score = gold.evaluate(_with_none("ITI se welding ki training li thi", True))
    assert score.false_nones == ["'ITI se welding ki training li thi'"]
    assert any("false-positive 'none'" in f for f in score.failed)


def test_a_missed_none_and_a_none_the_api_never_acts_on_are_reported_not_gated() -> None:
    missed = gold.evaluate(_with_none("maine koi course nahi kiya bhai", False))
    assert missed.failed == [] and missed.missed_nones == ["'maine koi course nahi kiya bhai'"]
    # Over a select question the API never declines anything: reported, not a lost answer.
    stray = gold.evaluate(_with_none("aur kitna bacha hai", True))
    assert stray.failed == [] and stray.stray_nones == ["'aur kitna bacha hai'"]


def test_a_perfect_predictor_reads_every_graded_none() -> None:
    score = gold.evaluate(_perfect)
    assert score.none_correct == score.none_graded > 0


def test_numbers_compare_in_canonical_form() -> None:
    assert gold.normalise(" 5.0 ") == gold.normalise("5") == "5"
    assert gold.normalise("CNC  Turner") == "cnc turner"


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
    """`httpx.post` and the clock, replaced on the SHARED call layer (the companion eval's)."""

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
        intent, fills, edits, mentions, none = by_text[body["text"]]
        return {
            "intent": intent,
            "confidence": 0.9,
            "fills": [{"key": k, "value": v} for k, v in fills],
            "edits": [{"op": o, "key": k, "ref": r, "value": v} for o, k, r, v in edits],
            "page_owned_mentions": mentions,
            "on_screen_none": none,
            "blocked": False,
            "ai_metadata": meta if meta is not None else _meta(),
        }

    return answer


def test_the_cli_posts_the_fixture_request_and_passes_a_perfect_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = FakeService(monkeypatch, _answer_perfectly())
    assert eval_cli.main(["--base-url", _BASE, "--expect-model", _PRIMARY]) == 0
    assert [path for path, _b in service.calls] == [eval_cli.ROUTE] * len(gold.CASES)
    assert service.calls[0][1] == gold.CASES[0].request()


def test_a_mock_answer_makes_the_run_not_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeService(monkeypatch, _answer_perfectly(_meta(real_call=False)))
    assert eval_cli.main(["--base-url", _BASE]) == 1


def test_a_fallback_model_fails_an_expect_model_run(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeService(monkeypatch, _answer_perfectly(_meta(model="gemini-2.5-flash-lite")))
    assert eval_cli.main(["--base-url", _BASE, "--expect-model", _PRIMARY]) == 1


def test_a_failed_call_is_scored_as_no_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeService(monkeypatch, lambda _body: 500)
    assert eval_cli.main(["--base-url", _BASE]) == 1


def test_a_blocked_answer_is_no_answer() -> None:
    assert eval_cli._prediction({"blocked": True}) is None


def test_the_cli_reads_none_as_the_api_does_a_literal_true_only() -> None:
    assert eval_cli._prediction({"intent": "answer", "on_screen_none": True})[4] is True
    for loose in ("true", 1, None):
        assert eval_cli._prediction({"intent": "answer", "on_screen_none": loose})[4] is False
    assert eval_cli._prediction({"intent": "answer"})[4] is False


def test_the_cli_refuses_bad_arguments() -> None:
    for argv in (
        ["--base-url", _BASE, "--pace-ms", "-1"],
        ["--base-url", _BASE, "--expect-model", " "],
        [],
    ):
        with pytest.raises(SystemExit):
            eval_cli.main(argv)


def test_the_api_timeout_is_the_api_clients_own() -> None:
    """The eval scores what the API acts on, so its timeout must be the client's (#2311)."""
    import re
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[3] / "apps" / "api" / "src" / "ai" / "ai.service.ts"
    ).read_text(encoding="utf-8")
    found = re.findall(r'"/profiling/understand",\s*input,\s*\w+,\s*([\d_]+)', source)
    assert found, (
        "ai.service.ts no longer calls /profiling/understand as "
        "`this.post(route, input, Schema, ms)`: update this pattern to the client's call shape"
    )
    assert {float(ms.replace("_", "")) for ms in found} == {eval_cli.API_TIMEOUT_MS}
