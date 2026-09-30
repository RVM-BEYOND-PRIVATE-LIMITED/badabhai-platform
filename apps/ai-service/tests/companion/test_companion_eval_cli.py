"""The staging eval CLI's own behaviour (ADR-0046 A4 / P3 A3) — against a FAKE transport.

The CLI scores a live service on staging; CI can still pin HOW it scores, with `httpx.post` and
the clock replaced:

1. IT SCORES WHAT PRODUCTION DOES: the API's confidence floor turns a low-confidence intent into
   `unclear` (both directions), and a response slower than the API's timeout is no answer. The
   floor and the timeouts are read from the API/config SOURCE, not retyped.
2. ONE FAILED CALL DOES NOT END THE RUN: 5xx / timeout / non-JSON are retried once, then scored
   as no answer and listed; the run completes and the gate fails as INCOMPLETE.
3. A MOCK ANSWER IS NOT A MODEL ANSWER: `real_call` false or a failed real call marks the run
   CONTAMINATED.
4. LATENCY is measured per call, p50/p95 by nearest rank, and gated (classify < 1.5 s, career
   < 4 s).
5. `--dump-samples N` writes answered career samples (synthetic prompts) for the owner's review,
   and prints nothing of them.

Fabricated eval text only.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import httpx
import pytest

from app.companion import eval_career_redteam as career_gold
from app.companion import eval_classify_gold as classify_gold
from app.companion import eval_cli
from app.companion import eval_edit_parse_gold as edit_gold
from app.companion.prompts import CLASSIFY_SYSTEM_PROMPT

_REPO = Path(__file__).resolve().parents[4]
_BASE = "http://ai.test"


def _meta(real_call: bool = True, success: bool = True, latency_ms: int = 100) -> dict:
    return {
        "ai_call_id": "c",
        "task_type": "t",
        "model_name": "model-x",
        "provider": "p",
        "real_call": real_call,
        "success": success,
        "latency_ms": latency_ms,
        "error_code": None if real_call and success else "llm_call_failed",
    }


class FakeService:
    """`httpx.post` + `time.perf_counter` stand-ins. ``answer(path, body)`` returns either a
    JSON body, an int status, an exception to raise, or ``(body, latency_ms)``."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, answer) -> None:
        self.now = 0.0
        self.calls: list[tuple[str, dict]] = []
        self._answer = answer
        monkeypatch.setattr(eval_cli.httpx, "post", self.post)
        monkeypatch.setattr(eval_cli.time, "perf_counter", lambda: self.now)

    def post(self, url: str, json: dict, headers: dict, timeout: float) -> httpx.Response:
        path = url.removeprefix(_BASE)
        self.calls.append((path, json))
        result = self._answer(path, json)
        latency_ms = 100.0
        if isinstance(result, tuple):
            result, latency_ms = result
        self.now += latency_ms / 1000.0
        request = httpx.Request("POST", url)
        if isinstance(result, Exception):
            raise result
        if isinstance(result, int):
            return httpx.Response(result, request=request)
        if isinstance(result, str):
            return httpx.Response(200, content=result.encode(), request=request)
        return httpx.Response(200, json=result, request=request)


# ── 1. the API's own numbers, read from source ───────────────────────────────────────────────


def test_the_confidence_floor_is_the_api_config_default_and_the_prompts_number() -> None:
    server = (_REPO / "packages" / "config" / "src" / "server.ts").read_text(encoding="utf-8")
    match = re.search(
        r"CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE: fractionFromString\(([\d.]+)\)", server
    )
    assert match, "the knob moved in packages/config/src/server.ts"
    assert float(match.group(1)) == eval_cli.ROUTER_MIN_CONFIDENCE
    # The classifier prompt hard-codes the same number; a knob change must move both.
    assert f"below {eval_cli.ROUTER_MIN_CONFIDENCE}" in CLASSIFY_SYSTEM_PROMPT


def test_the_api_timeouts_are_the_ai_client_s_own() -> None:
    source = (_REPO / "apps" / "api" / "src" / "ai" / "ai.service.ts").read_text(encoding="utf-8")
    found = {
        path: float(ms.replace("_", ""))
        for path, ms in re.findall(
            r'this\.post\("(/companion/[a-z-]+)", input, \w+, ([\d_]+)', source
        )
    }
    assert found == eval_cli.API_TIMEOUT_MS


def test_nearest_rank_percentiles() -> None:
    samples = [float(n) for n in range(1, 21)]
    assert eval_cli.nearest_rank(samples, 0.50) == 10.0
    assert eval_cli.nearest_rank(samples, 0.95) == 19.0
    assert eval_cli.nearest_rank([7.0], 0.95) == 7.0
    assert eval_cli.nearest_rank([], 0.95) is None


# ── 2. the classifier is scored after the floor, in both directions ──────────────────────────


def test_the_floor_turns_low_confidence_into_unclear_both_ways(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cases = [
        ("mera resume update kar do", "edit_resume"),  # right intent, 0.5 -> MISS in production
        ("kuch bhi", "unclear"),  # wrong intent, 0.4 -> the API says unclear -> HIT
        ("welder ke baad kya seekhun", "career_talk"),  # 0.9 -> hit
        ("theek hai", "unclear"),  # wrong edit_resume at 0.3: never a false positive
    ]
    monkeypatch.setattr(classify_gold, "CASES", cases)
    replies = {
        "mera resume update kar do": ("edit_resume", 0.5),
        "kuch bhi": ("faltu", 0.4),
        "welder ke baad kya seekhun": ("career_talk", 0.9),
        "theek hai": ("edit_resume", 0.3),
    }

    def answer(_path: str, body: dict) -> dict:
        intent, confidence = replies[body["text"]]
        return {
            "intent": intent,
            "confidence": confidence,
            "blocked": False,
            "ai_metadata": _meta(),
        }

    FakeService(monkeypatch, answer)
    run = eval_cli.run_classify_eval(_BASE)
    assert run.score.correct == 3
    assert run.floored == 3
    # The sub-floor edit_resume never reached the precision count; the one at 0.5 was a miss.
    assert run.score.edit_resume_precision == 1.0
    assert any("mera resume update kar do" in miss for miss in run.score.misses)

    # A lower floor (a target API that overrides the knob) scores the 0.5 line as a hit.
    FakeService(monkeypatch, answer)
    lowered = eval_cli.run_classify_eval(_BASE, min_confidence=0.45)
    assert lowered.score.correct == 4
    assert lowered.floored == 2


# ── 3. one failed call is scored and listed, not a traceback ─────────────────────────────────


def test_a_failed_call_is_scored_as_no_answer_and_the_run_continues(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    cases = [("a", "edit_resume"), ("b", "unclear"), ("c", "career_talk"), ("d", "faltu")]
    monkeypatch.setattr(classify_gold, "CASES", cases)
    attempts: dict[str, int] = {}

    def answer(_path: str, body: dict):
        text = body["text"]
        attempts[text] = attempts.get(text, 0) + 1
        if text == "a":
            return 503  # every attempt: listed as failed, scored unclear
        if text == "b":
            return httpx.ConnectTimeout("slow")
        if text == "c" and attempts[text] == 1:
            return 502  # a blip: the retry answers
        if text == "d":
            return "<html>not json</html>"
        return {
            "intent": "career_talk",
            "confidence": 0.9,
            "blocked": False,
            "ai_metadata": _meta(),
        }

    FakeService(monkeypatch, answer)
    code = eval_cli.main(["--classify", "--base-url", _BASE])
    out = capsys.readouterr().out
    assert code == 1
    assert attempts == {"a": 2, "b": 2, "c": 2, "d": 2}
    assert "FAILED CALL 'a': HTTP 503" in out
    assert "FAILED CALL 'b': ConnectTimeout" in out
    assert "FAILED CALL 'd': JSONDecodeError" in out
    assert "calls: 4 sent, 1 answered by the model, 3 failed" in out
    assert "INCOMPLETE: 3 calls failed" in out
    assert "RESULT: FAIL" in out


def test_a_4xx_is_not_retried_and_a_401_names_the_token(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(classify_gold, "CASES", [("a", "unclear")])
    service = FakeService(monkeypatch, lambda _p, _b: 401)
    assert eval_cli.main(["--classify", "--base-url", _BASE]) == 1
    assert len(service.calls) == 1
    assert "AI_INTERNAL_TOKEN" in capsys.readouterr().out


def test_a_mock_answer_contaminates_the_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # The mock's "unclear" would score a HIT on an unclear line; it must not count.
    monkeypatch.setattr(classify_gold, "CASES", [("kkkkkk", "unclear"), ("x", "unclear")])

    def answer(_path: str, body: dict) -> dict:
        real = body["text"] == "x"
        meta = _meta(real_call=real) if real else _meta(real_call=False)
        return {"intent": "unclear", "confidence": 0.0, "blocked": False, "ai_metadata": meta}

    FakeService(monkeypatch, answer)
    assert eval_cli.main(["--classify", "--base-url", _BASE]) == 1
    out = capsys.readouterr().out
    assert "MOCK ANSWER 'kkkkkk'" in out
    assert "CONTAMINATED: 1 answers came from the deterministic mock" in out


def test_a_real_call_that_fell_back_to_the_mock_is_contaminated_too() -> None:
    log = eval_cli.CallLog()
    log.mocked.append("'x': llm_call_failed")
    assert any(r.startswith("CONTAMINATED") for r in eval_cli.gate_failures(log, None))


def test_a_blocked_input_is_scored_as_the_product_answers_it_and_not_timed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(classify_gold, "CASES", [("reference number 12345678", "unclear")])
    FakeService(
        monkeypatch,
        lambda _p, _b: {
            "intent": "unclear",
            "confidence": 0.0,
            "blocked": True,
            "ai_metadata": None,
        },
    )
    run = eval_cli.run_classify_eval(_BASE)
    assert run.score.correct == 1
    assert run.calls.latencies_ms == [] and run.calls.failures == [] and run.calls.mocked == []


# ── 4. latency ───────────────────────────────────────────────────────────────────────────────


def _classify_at(
    monkeypatch: pytest.MonkeyPatch, latencies_ms: list[float]
) -> eval_cli.ClassifyRun:
    cases = [(f"line {i}", "career_talk") for i in range(len(latencies_ms))]
    monkeypatch.setattr(classify_gold, "CASES", cases)
    by_text = {text: ms for (text, _), ms in zip(cases, latencies_ms, strict=True)}

    def answer(_path: str, body: dict):
        payload = {
            "intent": "career_talk",
            "confidence": 0.9,
            "blocked": False,
            "ai_metadata": _meta(latency_ms=int(by_text[body["text"]]) - 50),
        }
        return payload, by_text[body["text"]]

    FakeService(monkeypatch, answer)
    return eval_cli.run_classify_eval(_BASE)


def test_latency_is_measured_per_call_and_gated_at_the_classify_bar(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fast = _classify_at(monkeypatch, [200.0 + 10 * i for i in range(20)])
    assert fast.calls.p50_ms == pytest.approx(290.0)
    assert fast.calls.p95_ms == pytest.approx(380.0)
    assert eval_cli.gate_failures(fast.calls, eval_cli.THRESHOLDS["classify_p95_ms"]) == []

    # Two slow calls in twenty put the nearest-rank p95 over 1.5 s: the gate fails.
    slow = _classify_at(monkeypatch, [300.0] * 18 + [1_600.0, 2_900.0])
    assert slow.calls.p95_ms == pytest.approx(1_600.0)
    reasons = eval_cli.gate_failures(slow.calls, eval_cli.THRESHOLDS["classify_p95_ms"])
    assert reasons == ["p95 latency 1600 ms >= 1500 ms"]
    assert slow.score.correct == 20  # under the API's 3 s timeout: still answers


def test_a_call_slower_than_the_api_timeout_is_no_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    run = _classify_at(monkeypatch, [300.0, 3_200.0])
    # The API would have timed out at 3 s and served the clarify line: scored unclear, a miss.
    assert run.score.correct == 1
    assert len(run.calls.over_api_timeout) == 1
    assert run.calls.latencies_ms == [pytest.approx(300.0), pytest.approx(3_200.0)]


def test_no_measured_call_cannot_pass_a_latency_bar() -> None:
    reasons = eval_cli.gate_failures(eval_cli.CallLog(), eval_cli.THRESHOLDS["career_p95_ms"])
    assert reasons == ["latency not measured: no call was answered by the model"]


# ── 5. career: the validator note and the owner's samples ────────────────────────────────────


def _career_service(monkeypatch: pytest.MonkeyPatch, answer_risky: set[str]) -> FakeService:
    normal = {text for text, expected, _t in career_gold.PROMPTS if expected == "answer"}

    def answer(_path: str, body: dict) -> dict:
        text = body["text"]
        if text in normal or text in answer_risky:
            return {
                "status": "answer",
                "lines": ["Pehle TIG welding ki practice kijiye."],
                "followup_chips": ["TIG kaise seekhein"],
                "ai_metadata": _meta(),
            }
        return {"status": "refuse", "topic": "unsafe_other", "ai_metadata": _meta()}

    return FakeService(monkeypatch, answer)


def test_career_dump_writes_n_answered_samples_risky_first(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    risky = next(text for text, expected, _t in career_gold.PROMPTS if expected == "refuse")
    _career_service(monkeypatch, {risky})
    dump = tmp_path / "samples.json"
    code = eval_cli.main(
        ["--career", "--base-url", _BASE, "--dump-samples", "30", "--dump-file", str(dump)]
    )
    out = capsys.readouterr().out
    assert code == 1  # the risky answer is UNSAFE
    assert "measured BEFORE the API's career validator" in out
    assert "samples: wrote 30 of 30 requested" in out
    # No answer text reaches the terminal — only the file.
    assert "TIG welding ki practice" not in out

    document = json.loads(dump.read_text(encoding="utf-8"))
    assert document["written"] == 30
    assert "BEFORE the API's career validator" in document["note"]
    first = document["samples"][0]
    assert first["prompt"] == risky and first["expected"] == "refuse"
    assert first["prompt_id"] == eval_cli.CAREER_PROMPT_IDS[risky]
    assert set(first) == {
        "prompt_id",
        "expected",
        "refusal_topic",
        "prompt",
        "lines",
        "followup_chips",
        "model",
    }
    assert all(sample["expected"] == "answer" for sample in document["samples"][1:])
    assert len({sample["prompt_id"] for sample in document["samples"]}) == 30


def test_career_passes_on_a_clean_fast_run_and_writes_no_file_unasked(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    _career_service(monkeypatch, set())
    assert eval_cli.main(["--career", "--base-url", _BASE]) == 0
    assert "RESULT: PASS" in capsys.readouterr().out
    assert list(tmp_path.iterdir()) == []


def test_the_career_prompt_ids_are_unique_and_stable() -> None:
    assert len(set(eval_cli.CAREER_PROMPT_IDS.values())) == len(career_gold.PROMPTS)
    assert eval_cli.CAREER_PROMPT_IDS[career_gold.PROMPTS[0][0]] == "career-001"


def test_dump_samples_needs_career() -> None:
    with pytest.raises(SystemExit):
        eval_cli.main(["--classify", "--base-url", _BASE, "--dump-samples", "5"])


def test_a_failed_career_call_on_a_risky_prompt_is_safe_but_the_run_is_incomplete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    risky = {text for text, expected, _t in career_gold.PROMPTS if expected == "refuse"}

    def answer(_path: str, body: dict):
        if body["text"] in risky:
            return 500
        return {
            "status": "answer",
            "lines": ["Line."],
            "followup_chips": [],
            "ai_metadata": _meta(),
        }

    FakeService(monkeypatch, answer)
    run = eval_cli.run_career_eval(_BASE)
    assert run.score.unsafe == 0  # the API's fail-closed line, not an answer
    assert len(run.calls.failures) == len(risky)
    assert any(r.startswith("INCOMPLETE") for r in eval_cli.gate_failures(run.calls, None))


# ── edit-parse: same call layer ──────────────────────────────────────────────────────────────


def test_edit_parse_scores_a_failed_call_as_no_rows(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(
        edit_gold,
        "CASES",
        [("theek hai", []), ("hindi hata do", [("delete", "languages", "l1", "language", None)])],
    )

    def answer(_path: str, body: dict):
        if body["text"] == "hindi hata do":
            return httpx.ReadTimeout("slow")
        return {"rows": [], "unsupported": [], "ai_metadata": _meta()}

    FakeService(monkeypatch, answer)
    assert eval_cli.main(["--edit-parse", "--base-url", _BASE]) == 1
    out = capsys.readouterr().out
    assert "edit-parse: 1/2 exact" in out
    assert "FAILED CALL 'hindi hata do': ReadTimeout" in out
