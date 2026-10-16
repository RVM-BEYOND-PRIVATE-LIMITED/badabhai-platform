"""The interview turn's reply eval (ADR-0057 #2310), deterministically: the set, the scorer and the
CLI against a fake transport. The real model is scored only by the staging CLI."""

from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from app.companion import eval_cli as call_layer
from app.contracts import LlmTurnInput
from app.profiling import eval_turn_reply_cli as eval_cli
from app.profiling import eval_turn_reply_gold as gold
from app.profiling import lexicon

_REPO = Path(__file__).resolve().parents[3]
_BASE = "http://ai.test"
_PRIMARY = "claude-haiku-4-5"


# ── the set ──────────────────────────────────────────────────────────────────────────────────


def test_every_case_is_a_valid_turn_request() -> None:
    for case in [*gold.BRIDGE_CASES, *gold.CLASSIC_CASES]:
        LlmTurnInput.model_validate(case.request())


def test_the_set_covers_every_bridge_reason_and_an_unknown_count() -> None:
    reasons = {case.reason for case in gold.BRIDGE_CASES}
    assert reasons == {"filled", "chat", "progress"}
    assert any(c.reason == "progress" and c.remaining is None for c in gold.BRIDGE_CASES)
    assert any(c.progress for c in gold.CLASSIC_CASES)
    assert any(any("ऀ" <= ch <= "ॿ" for ch in c.text) for c in gold.BRIDGE_CASES)


def test_the_api_timeout_is_the_api_clients_own() -> None:
    source = (_REPO / "apps" / "api" / "src" / "ai" / "ai.service.ts").read_text(encoding="utf-8")
    found = re.findall(r"PROFILING_TURN_TIMEOUT_MS = ([\d_]+);", source)
    assert found and float(found[0].replace("_", "")) == eval_cli.API_TIMEOUT_MS


# ── the scorer ───────────────────────────────────────────────────────────────────────────────


def _good_bridge(case: gold.BridgeCase) -> str:
    if case.reason == "progress":
        return (
            f"Bas {case.remaining} sawaal aur, ho jayega."
            if case.remaining is not None
            else "Bas thoda sa aur, ho jayega."
        )
    return "Theek hai, likh liya."


def _good_classic(case: gold.ClassicCase) -> str:
    if case.progress:
        return f"Bas {case.remaining} sawaal aur. Aap kab se kaam shuru kar sakte hain?"
    return "Aap kab se kaam shuru kar sakte hain?"


def test_good_replies_pass_every_bar() -> None:
    score = gold.evaluate(_good_bridge, _good_classic)
    assert score.failed == []
    assert score.bridge_served == score.bridge_total
    assert score.classic_served == score.classic_total


def test_a_wrong_or_invented_count_fails() -> None:
    def wrong(case: gold.BridgeCase) -> str:
        return "Bas 9 sawaal aur." if case.reason == "progress" else "Theek hai."

    assert any("real count" in f for f in gold.evaluate(wrong, _good_classic).failed)


def test_a_question_about_a_filled_field_fails() -> None:
    def asks_again(case: gold.ClassicCase) -> str:
        return "Aapko kitne saal ka tajurba hai?"

    assert any("already-filled" in f for f in gold.evaluate(_good_bridge, asks_again).failed)


def test_a_persona_break_fails() -> None:
    banned = lexicon.persona_banned_tokens()[0]

    def breaks(case: gold.BridgeCase) -> str:
        return f"Theek hai {banned} likh liya."

    assert any("persona" in f for f in gold.evaluate(breaks, _good_classic).failed)


def test_an_empty_reply_is_not_served_and_breaks_nothing() -> None:
    score = gold.evaluate(lambda _c: "", lambda _c: None)
    assert score.failed == []
    assert score.bridge_served == 0 and score.classic_served == 0


# ── the CLI against a fake transport ─────────────────────────────────────────────────────────


def _meta(real_call: bool = True) -> dict:
    return {
        "ai_call_id": "c",
        "task_type": "profiling_chat_turn",
        "model_name": _PRIMARY,
        "provider": "anthropic",
        "real_call": real_call,
        "success": True,
        "latency_ms": 100,
        "estimated_cost_inr": 0.01 if real_call else 0.0,
        "error_code": None,
        "candidates_tried": [_PRIMARY] if real_call else [],
    }


class FakeService:
    def __init__(self, monkeypatch: pytest.MonkeyPatch, real_call: bool = True) -> None:
        self.now = 0.0
        self.calls: list[dict] = []
        self.real_call = real_call
        monkeypatch.setattr(call_layer.httpx, "post", self.post)
        monkeypatch.setattr(call_layer.time, "perf_counter", lambda: self.now)

    def post(self, url: str, json: dict, headers: dict, timeout: float) -> httpx.Response:
        self.calls.append(json)
        self.now += 0.1
        if json.get("interview_mode") == "bridge":
            remaining = json.get("remaining_questions")
            reply = (
                f"Bas {remaining} sawaal aur."
                if json["bridge"]["reason"] == "progress" and remaining is not None
                else "Theek hai, likh liya."
            )
        else:
            remaining = json.get("remaining_questions")
            reply = (
                f"Bas {remaining} sawaal aur. Aap kab se kaam shuru kar sakte hain?"
                if remaining is not None
                else "Aap kab se kaam shuru kar sakte hain?"
            )
        body = {"reply_text": reply, "blocked": False, "ai_metadata": _meta(self.real_call)}
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))


def test_the_cli_posts_both_sets_and_passes_good_replies(monkeypatch: pytest.MonkeyPatch) -> None:
    service = FakeService(monkeypatch)
    assert eval_cli.main(["--base-url", _BASE, "--expect-model", _PRIMARY]) == 0
    assert len(service.calls) == len(gold.BRIDGE_CASES) + len(gold.CLASSIC_CASES)
    assert service.calls[0] == gold.BRIDGE_CASES[0].request()


def test_a_mock_answer_is_not_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeService(monkeypatch, real_call=False)
    assert eval_cli.main(["--base-url", _BASE]) == 1
