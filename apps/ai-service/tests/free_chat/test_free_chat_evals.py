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
    # About sixty Hindi/Hinglish/English lines, plus the regional lines (ADR-0051 §9) and the
    # improvement loop's held-out round-1 lines (§10, #2128).
    blocks = (gold.REGIONAL_ROWS, gold.ROUND1_ROWS)
    assert 55 <= len(gold.CASES) - sum(len(block) for block in blocks) <= 70
    assert 15 <= len(gold.REGIONAL_ROWS) <= 25
    assert 20 <= len(gold.ROUND1_ROWS) <= 30
    assert all(isinstance(case, gold.Case) for case in gold.CASES)
    counts = Counter(case.category for case in gold.CASES)
    assert set(counts) == set(gold.CATEGORIES)
    for category in gold.CATEGORIES:
        assert counts[category] >= 3, f"{category}: only {counts[category]} cases"
    keys = [(case.text, case.mode, case.question, case.turns) for case in gold.CASES]
    assert len(set(keys)) == len(keys), "duplicate cases"


def test_resume_mode_is_about_twenty_lines_with_answers_and_off_topic() -> None:
    resume_mode = [case for case in gold.CASES if case.mode == "resume"]
    # About twenty, plus the regional and round-1 guards (a "not now" that answers the question).
    assert 18 <= len(resume_mode) <= 28
    answers = [case for case in resume_mode if case.category == "resume"]
    off_topic = {case.category for case in resume_mode if case.category != "resume"}
    assert len(answers) >= 10
    # Every non-résumé category appears mid-interview at least once.
    assert off_topic == set(gold.CATEGORIES) - {"resume"}
    texts = {case.text for case in resume_mode}
    for required in ("cricket kaun jeeta", "koi job hai kya"):
        assert required in texts, required


def test_every_resume_case_has_a_question_and_no_free_case_does() -> None:
    for case in gold.CASES:
        assert case.mode in gold.MODES, case.text
        if case.mode == "resume":
            assert case.question, f"{case.text!r}: résumé mode needs the question on screen"
        else:
            assert case.question is None, f"{case.text!r}: free mode has no question on screen"


def test_the_review_cases_are_in_the_set_with_their_labels() -> None:
    """The #2041 review's cases: self-descriptions are `resume` in either mode, a detail that
    answers a different résumé question is still an answer, a bad experience told as an answer
    is not trash, a news question is casual, and a reply to the JOBS line reads its turn."""
    by_key = {(case.text, case.mode, case.question): case for case in gold.CASES}
    assert by_key[("main welder hoon, 6 saal se", "free", None)].category == "resume"
    assert by_key[("3 saal Maruti mein fitter tha", "free", None)].category == "resume"
    assert by_key[("Nashik mein rehta hoon", "resume", gold.Q_YEARS)].category == "resume"
    left = by_key[("malik gaali deta tha, isliye chhoda", "resume", gold.Q_LEFT_JOB)]
    assert left.category == "resume"
    assert gold.Q_LEFT_JOB == "Pichli naukri kyun chhodi?"
    assert by_key[("kal ka match kaun jeeta", "free", None)].category == "casual"
    after_jobs = ((gold.BOT, gold.JOBS_LINE),)
    assert by_key[("haan ji", "free", None)] == ("haan ji", "free", None, "resume", after_jobs)
    assert by_key[("nahi abhi nahi", "free", None)].category == "casual"
    assert by_key[("nahi abhi nahi", "free", None)].turns == after_jobs


def test_recent_turns_are_well_formed_and_carry_the_jobs_line() -> None:
    with_turns = [case for case in gold.CASES if case.turns]
    assert len(with_turns) >= 2
    for case in with_turns:
        assert len(case.turns) <= 2, case.text  # the classify contract's CLASSIFY_TURNS_MAX
        for role, text in case.turns:
            assert role in ("worker", "bada_bhai"), case.text
            assert text.strip(), case.text
    # The bot's offer lines are the reviewed JOBS and CASUAL_NUDGE copy (ADR-0051 §5.1), verbatim.
    adr = (_REPO / "docs" / "decisions" / "0051-profiling-stage-free-chat.md").read_text(
        encoding="utf-8"
    )
    assert f"| JOBS | {gold.JOBS_LINE} |" in adr
    assert f"| CASUAL_NUDGE | {gold.CASUAL_NUDGE_LINE} |" in adr


def test_round1_replies_to_a_resume_offer_follow_the_offer() -> None:
    """ADR-0051 §10 round 1 (#2128): a yes to the bot's own résumé offer is `resume`, a no or a
    later is `casual` (the lock must never close on a "no"), after BOTH offer lines, and a yes to
    a casual line that offered nothing stays casual. Held-out lines, never the baseline's misses."""
    offers = {gold.JOBS_LINE, gold.CASUAL_NUDGE_LINE}
    after_offer: dict[str, set[str]] = {"resume": set(), "casual": set()}
    for row in gold.ROUND1_ROWS:
        case = gold.Case(*row)
        if not case.turns:
            continue
        bot_line = case.turns[-1][1]
        assert case.turns[-1][0] == gold.BOT, case.text
        offered = bot_line.splitlines()[-1] in offers
        if not offered:
            assert case.category == "casual", case.text
            continue
        assert case.category in after_offer, case.text
        after_offer[case.category].add(bot_line.splitlines()[-1])
    # Yes and no are both measured after both offers.
    assert after_offer == {"resume": offers, "casual": offers}
    # The reviewed labels, line by line: a flipped yes or no fails here, not only in a live run.
    labels = {gold.Case(*row).text: gold.Case(*row).category for row in gold.ROUND1_ROWS}
    yes = {"ji haan", "theek hai bana do", "chalo, kar lete hain", "சரி, பண்ணலாம்"}
    no = {"nahi ji", "abhi nahi", "baad mein karenge", "rehne do", "vaddu, tarvata chuddam"}
    assert {text: labels[text] for text in yes} == dict.fromkeys(yes, "resume")
    assert {text: labels[text] for text in no} == dict.fromkeys(no, "casual")
    baseline_misses = {"haan ji", "nahi abhi nahi", "ok", "tu pagal hai kya"}
    assert not baseline_misses & {row[0] for row in gold.ROUND1_ROWS}


def test_every_regional_language_asks_for_a_job_in_both_scripts() -> None:
    """Round 1 (#2128): the jobs question in each §9 language, own script AND Latin letters."""
    jobs = [case.text for case in gold.CASES if case.category == "jobs" and case.mode == "free"]
    for language, block in {
        "Tamil": "[஀-௿]",
        "Telugu": "[ఀ-౿]",
        "Kannada": "[ಀ-೿]",
        "Gujarati": "[઀-૿]",
    }.items():
        assert any(re.search(block, text) for text in jobs), language
    # Marathi shares Devanagari with Hindi, so its line is named rather than found by script.
    assert "पुण्यात काही काम आहे का" in jobs
    latin_regional = {
        "Chennai la velai irukka",
        "naaku edaina job dorukutunda",
        "yaavudadru kelasa ide na",
        "mala kuthe naukri milel ka",
        "Surat ma koi nokri chhe",
    }
    assert latin_regional <= set(jobs)


def test_the_set_mixes_hinglish_devanagari_and_english() -> None:
    texts = [case.text for case in gold.CASES]
    devanagari = [t for t in texts if re.search("[ऀ-ॿ]", t)]
    english = [t for t in texts if t.isascii() and " " in t and re.search(r"\b(?:I|want)\b", t)]
    assert len(devanagari) >= 5, devanagari
    assert len(english) >= 3, english
    # Both modes carry Devanagari, so the script bucket is not only a free-mode measurement.
    modes = {case.mode for case in gold.CASES if re.search("[ऀ-ॿ]", case.text)}
    assert modes == set(gold.MODES)


def test_the_set_carries_the_five_regional_languages_in_both_scripts() -> None:
    """ADR-0051 §9 (#2126): own script for each, Latin letters too, and both modes."""
    texts = [row[0] for row in gold.REGIONAL_ROWS]
    for language, block in {
        "Tamil": "[஀-௿]",
        "Telugu": "[ఀ-౿]",
        "Kannada": "[ಀ-೿]",
        "Gujarati": "[઀-૿]",
        "Marathi (Devanagari)": "[ऀ-ॿ]",
    }.items():
        assert any(re.search(block, text) for text in texts), language
    assert sum(text.isascii() for text in texts) >= 5, "too few Latin-letter regional lines"
    assert {row[1] for row in gold.REGIONAL_ROWS} == set(gold.MODES)
    # Every regional row is also a case, scored like any other.
    assert all(gold.Case(*row) in gold.CASES for row in gold.REGIONAL_ROWS)


def test_no_case_is_one_of_the_classify_prompts_quoted_examples() -> None:
    """A gold line the prompt quotes is a memory test, not a measurement of the rule."""
    quoted = {q.casefold() for q in re.findall(r'"([^"]+)"', CLASSIFY_SYSTEM_PROMPT)}
    assert {"5 saal", "pune mein", "haan", "welding", "pata nahi"} <= quoted  # non-vacuous
    echoed = [case.text for case in gold.CASES if case.text.casefold() in quoted]
    assert echoed == []


# ── 2. the scorer ────────────────────────────────────────────────────────────────────────────


def test_a_perfect_predictor_scores_one_everywhere() -> None:
    score = gold.evaluate(lambda case: case.category)
    assert (score.correct, score.total, score.accuracy) == (len(gold.CASES), len(gold.CASES), 1.0)
    assert all(correct == total for correct, total in score.per_category.values())
    assert all(correct == total for correct, total in score.per_mode.values())
    assert score.misses == []


def test_an_unavailable_answer_is_a_miss_for_every_category_never_unclear() -> None:
    score = gold.evaluate(lambda _case: None)
    assert score.correct == 0
    assert score.predicted == {gold.UNAVAILABLE: len(gold.CASES)}
    # Not folded into `unclear`: the unclear lines score zero too.
    assert score.per_category["unclear"][0] == 0


def test_a_miss_after_recent_turns_says_so() -> None:
    score = gold.evaluate(lambda _case: "jobs")
    assert "[free +turns] 'haan ji': expected resume, got jobs" in score.misses


def test_the_per_category_counts_add_up() -> None:
    score = gold.evaluate(lambda _case: "unclear")
    unclear_total = sum(1 for case in gold.CASES if case.category == "unclear")
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


def test_the_cli_posts_a_cases_recent_turns(monkeypatch: pytest.MonkeyPatch) -> None:
    turns = ((gold.BOT, gold.JOBS_LINE),)
    monkeypatch.setattr(gold, "CASES", [gold.Case("haan ji", "free", None, "resume", turns)])
    service = FakeService(monkeypatch, lambda _p, _b: _verdict("resume"))
    assert eval_cli.main(["--base-url", _BASE]) == 0
    assert service.calls[0][1]["recent_turns"] == [{"role": "bada_bhai", "text": gold.JOBS_LINE}]


def test_every_real_set_case_is_a_valid_classify_request() -> None:
    """The bodies the CLI would post parse as the contract the route enforces, turns included,
    so a staging run cannot fail on a 422 the set itself caused."""
    from app.contracts import FreeChatClassifyInput

    for case in gold.CASES:
        FreeChatClassifyInput(
            text=case.text,
            mode=case.mode,
            pending_question=case.question,
            recent_turns=[{"role": role, "text": text} for role, text in case.turns],
        )


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
    """ADR-0051 §3.3 says ~2.5 s; the number that counts is the API client's.

    It skips ONLY while `ai.service.ts` does not mention the route at all (PR B not merged).
    Once the route is there, a call this pattern cannot read FAILS rather than skipping: a
    reshaped call must update the pattern, never silently turn the pin off."""
    source = (_REPO / "apps" / "api" / "src" / "ai" / "ai.service.ts").read_text(encoding="utf-8")
    if eval_cli.ROUTE not in source:
        pytest.skip("apps/api does not call /free-chat/classify yet (ADR-0051 PR B)")
    found = re.findall(r'this\.post\(\s*"/free-chat/classify",\s*input,\s*\w+,\s*([\d_]+)', source)
    assert found, (
        "ai.service.ts names /free-chat/classify but no `this.post(route, input, Schema, ms)` "
        "timeout was found: update this pattern to the client's call shape"
    )
    assert {float(ms.replace("_", "")) for ms in found} == {eval_cli.API_TIMEOUT_MS}
