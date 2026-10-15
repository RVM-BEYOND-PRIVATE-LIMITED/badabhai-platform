"""The companion-surface free-chat evals (ADR-0055, #2285), deterministically.

WHAT RUNS IN CI. The companion sets are BASELINES for the real model, so CI pins what makes a
staging run meaningful, never an accuracy:

  1. THE CLASSIFY SET: labels in the closed sets (an action only on a résumé line), every category
     and every résumé action covered, the issue's named lines with their labels, jobs-word lines
     that are really career or distress, the regional languages in their own script AND Latin
     letters, no identifier, no echo of the prompt's examples, and every case posted as the
     companion brain posts it (mode free, no question, surface companion: "Mode: companion");
  2. THE SCORER: category, résumé action and language, each exact, unavailable a miss;
  3. ``eval_cli --surface companion`` against a fake transport: the body, the companion brain's
     floor (distress exempt), the report, the refusal of a run that is not evidence, and the
     default surface's body unchanged;
  4. THE REPLY SET: valid companion bodies, ids apart from the profiling set's, the guarded
     refusals, the API's companion copy word for word, a digest of its own;
  5. ``eval_free_reply_cli --surface companion``: companion bodies, a dump that names its surface.

Fabricated eval text only.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import get_args

import httpx
import pytest

from app.companion import eval_cli as call_layer
from app.contracts import (
    FreeChatCategory,
    FreeChatClassifyInput,
    FreeChatReplyInput,
    FreeChatReplyLanguage,
    FreeChatResumeAction,
    FreeChatSurface,
)
from app.free_chat import eval_cli
from app.free_chat import eval_free_classify_companion_gold as gold
from app.free_chat import eval_free_classify_gold as profiling_gold
from app.free_chat import eval_free_reply_cli as reply_cli
from app.free_chat import eval_free_reply_companion_gold as reply_gold
from app.free_chat import eval_free_reply_gold as profiling_reply_gold
from app.free_chat import prompts as free_prompts
from app.free_chat.eval_free_language_gold import script_of
from app.llm_input_policy import llm_input_gate
from app.output_floor import carries_hard_identifier

_REPO = Path(__file__).resolve().parents[4]
_BASE = "http://ai.test"
_MODEL = "claude-haiku-4-5"

#: The companion's copy file: every fixed bot line a case follows is quoted from it.
_COMPANION_COPY = _REPO / "apps" / "api" / "src" / "chat-companion" / "companion-replies.ts"
#: #2304: the résumé menu's copy (the edit section menu line a "no" may follow).
_RESUME_MENU = _REPO / "apps" / "api" / "src" / "chat" / "resume-menu.ts"
#: A jobs word inside a message (§9 R2 classifies these typed messages first).
_JOBS_WORD = re.compile(r"\b(?:job|jobs|naukri|kaam|vacancy)\b", re.IGNORECASE)
#: The regional languages and their scripts (Marathi shares Devanagari with Hindi).
_SCRIPTS = {
    "hinglish": "DEVANAGARI",
    "marathi": "DEVANAGARI",
    "gujarati": "GUJARATI",
    "kannada": "KANNADA",
    "telugu": "TELUGU",
    "tamil": "TAMIL",
}
_REGIONAL = ("marathi", "gujarati", "kannada", "telugu", "tamil")


def _served_copy() -> set[str]:
    return set(re.findall(r'latin:\s*"([^"]+)"', _COMPANION_COPY.read_text(encoding="utf-8")))


def _menu_copy() -> set[str]:
    """The résumé menu's lines, verbatim (`RESUME_MENU_* = "..."` in the API's resume-menu.ts)."""
    text = _RESUME_MENU.read_text(encoding="utf-8")
    return set(re.findall(r'RESUME_MENU_\w+ =\s*"([^"]+)"', text))


def _scripts(text: str) -> set[str]:
    """The non-Latin scripts ``text``'s letters are written in."""
    return {
        unicodedata.name(ch, "").split()[0]
        for ch in text
        if ch.isalpha() and not unicodedata.name(ch, "").startswith("LATIN")
    }


# ── 1. the classify set ──────────────────────────────────────────────────────────────────────


def test_the_labels_are_the_contracts_closed_sets() -> None:
    assert gold.RESUME_ACTIONS == get_args(FreeChatResumeAction)
    assert gold.LANGUAGES == get_args(FreeChatReplyLanguage)
    assert profiling_gold.CATEGORIES == get_args(FreeChatCategory)
    for case in gold.CASES:
        assert case.category in profiling_gold.CATEGORIES, case.text
        assert case.language in gold.LANGUAGES, case.text
        if case.category == "resume":
            assert case.resume_action is None or case.resume_action in gold.RESUME_ACTIONS
        else:
            # The parser drops an action beside any other category, so a label there is a lie.
            assert case.resume_action is None, case.text


def test_the_set_is_about_eighty_lines_and_covers_every_category_and_action() -> None:
    # 71 at #2287 round 2, + 14 held-out lines for #2304.
    assert 80 <= len(gold.CASES) <= 90
    counts = Counter(case.category for case in gold.CASES)
    assert set(counts) == set(profiling_gold.CATEGORIES)
    for category in profiling_gold.CATEGORIES:
        assert counts[category] >= 3, category
    actions = Counter(case.resume_action for case in gold.CASES if case.category == "resume")
    for action in gold.RESUME_ACTIONS:
        assert actions[action] >= 4, action
    assert actions[None] >= 2  # the ambiguous résumé line: the menu asks
    keys = [(case.text, case.turns) for case in gold.CASES]
    assert len(set(keys)) == len(keys), "duplicate cases"


def test_the_issues_named_lines_carry_their_labels() -> None:
    labels = {
        case.text: (case.category, case.resume_action) for case in gold.CASES if not case.turns
    }
    assert labels["resume mein welding add karo"] == ("resume", "edit")
    assert labels["skills mein Marathi jod do"] == ("resume", "edit")
    assert labels["mera city Pune kar do"] == ("resume", "edit")
    assert labels["naya resume banana hai"] == ("resume", "new")
    assert labels["resume dobara banao"] == ("resume", "new")
    assert labels["resume ka pdf bhejo"] == ("resume", "download")
    assert labels["mujhe resume phone mein chahiye"] == ("resume", "download")
    assert labels["Tata mein welder ki job milti hai?"] == ("career", None)
    # §9 R3: greetings reach the brain; they are small talk.
    assert labels["hello"] == ("casual", None)
    assert labels["namaste"] == ("casual", None)


def test_telling_about_their_work_is_talk_and_an_ask_with_a_detail_is_an_edit() -> None:
    """#2304 (owner rulings 2026-10-15): telling a new skill or their pay is NOT a résumé edit —
    the reply answers it; ADR-0055's round-2 label said edit, and #2296 served the edit menu for
    it. Asking what the résumé says is talk too. An ASK to put the detail on the résumé is still
    an edit, a jobs ask beside a statement is still jobs, and a "no" after the menu is talk."""
    labels = {case.text: (case.category, case.resume_action) for case in gold.CASES}
    assert labels["maine forklift chalana bhi seekh liya hai"] == ("career", None)
    assert labels["abhi main fitter hoon, 19 hazaar milte hain"] == ("career", None)
    assert labels["meri pagar kitni hai"] == ("career", None)
    assert labels["mere resume mein kaun kaun si skills likhi hain"] == ("career", None)
    assert labels["ab 26 hazaar milta hai, resume mein update kar do"] == ("resume", "edit")
    assert labels["forklift bhi seekh liya hai, isko resume mein daal do"] == ("resume", "edit")
    assert labels["CNC turner hoon, mere liye koi job hai kya"] == ("jobs", None)
    (no,) = [case for case in gold.CASES if case.text == "nahi, resume theek hai"]
    assert (no.category, no.resume_action) == ("casual", None)
    assert no.turns[-1] == (gold.BOT, gold.EDIT_MENU_LINE)


def test_jobs_word_lines_that_are_really_career_or_distress_are_measured() -> None:
    """§9 R2: a typed jobs-word message is classified first, so the set holds jobs-word lines
    whose right answer is NOT jobs: career questions and crises ("no job, want to die")."""
    worded = Counter(case.category for case in gold.CASES if _JOBS_WORD.search(case.text))
    assert worded["career"] >= 3
    assert worded["distress"] >= 3
    assert worded["jobs"] >= 2  # and real jobs asks beside them


def test_a_bare_acknowledgement_is_unclear_on_this_screen() -> None:
    """ADR-0055: Bada Bhai never offers to make a résumé here, so the profiling rule that turns a
    bare "theek hai" after the offer into a yes does not apply."""
    acks = [case for case in gold.CASES if case.text in {"theek hai", "acha ji", "hmm ok"}]
    assert len(acks) == 3
    assert {case.category for case in acks} == {"unclear"}
    assert any(case.turns for case in acks)


def test_every_regional_language_is_in_its_own_script_and_latin_letters() -> None:
    """The §9 parity the profiling sets keep: each regional language both ways, labelled."""
    by = Counter((case.language, script_of(case.text)) for case in gold.CASES)
    for language in _REGIONAL:
        assert by[(language, "latin")] >= 1, f"{language}: no Latin-letter line"
        assert by[(language, "native")] >= 1, f"{language}: no own-script line"
    assert by[("hinglish", "native")] >= 3  # Devanagari Hindi
    assert sum(1 for case in gold.CASES if case.language == "english") >= 5
    # The regional lines span more than one category, so the category is measured on them too.
    regional = {case.category for case in gold.CASES if case.language in _REGIONAL}
    assert len(regional) >= 5


def test_each_native_line_is_in_its_languages_script() -> None:
    for case in gold.CASES:
        letters = _scripts(case.text)
        if letters:
            assert letters == {_SCRIPTS[case.language]}, case.text


def test_every_case_is_posted_as_the_companion_brain_posts_it() -> None:
    """Mode free, no question on screen, surface companion: the route renders "Mode: companion"
    and no question (`build_free_classify_messages`), the context the companion prompt reads."""
    for case in gold.CASES:
        body = gold.request_body(case)
        assert body["mode"] == "free" and body["pending_question"] is None
        assert body["surface"] == "companion"
        FreeChatClassifyInput(**body)
        assert len(case.turns) <= 2, case.text
        messages = free_prompts.build_free_classify_messages(
            case.text,
            [],
            "free",
            None,
            free_prompts.COMPANION_CLASSIFY_SYSTEM_PROMPT,
            surface="companion",
        )
        user = messages[-1]["content"]
        assert user.startswith("Mode: companion\n")
        assert "Question on screen" not in user


def test_the_bot_turns_are_the_companions_copy_or_a_career_answer() -> None:
    served = _served_copy()
    for line in (
        gold.V3_JOBS_LINE,
        gold.V3_DOWNLOAD_READY_LINE,
        gold.COMPANION_FALLBACK_LINE,
        gold.COMPANION_CLARIFY_LINE,
    ):
        assert line in served, line
    bot_lines = {text for case in gold.CASES for role, text in case.turns if role == gold.BOT}
    # #2304: the edit section menu's line is the résumé menu's own copy, verbatim.
    assert gold.EDIT_MENU_LINE in _menu_copy()
    assert bot_lines <= served | _menu_copy() | {gold.VMC_ANSWER}
    assert {
        gold.V3_JOBS_LINE,
        gold.V3_DOWNLOAD_READY_LINE,
        gold.COMPANION_CLARIFY_LINE,
    } <= bot_lines
    for case in gold.CASES:
        for role, text in case.turns:
            assert role in (gold.WORKER, gold.BOT) and text.strip(), case.text


def test_no_line_carries_an_identifier_or_an_invisible_character() -> None:
    """Fabricated lines only: no hard identifier (the G1 floor's own classes), nothing the masked
    gateway blocks (a blocked line is no verdict at all), no bidi or zero-width character."""
    texts = [case.text for case in gold.CASES] + [
        text for case in gold.CASES for _role, text in case.turns
    ]
    for text in texts:
        assert not carries_hard_identifier(text), text
        assert not llm_input_gate(text, raw=False).blocked, text
        assert not any(unicodedata.category(ch) == "Cf" for ch in text), text


def test_no_line_is_one_of_the_companion_prompts_quoted_examples() -> None:
    """A gold line the prompt quotes is a memory test. One named exception: "hello", the greeting
    §9 R3 sends to the brain, which the prompt quotes for the language rule."""
    prompt = free_prompts.COMPANION_CLASSIFY_SYSTEM_PROMPT
    quoted = {q.casefold() for q in re.findall(r'"([^"]+)"', prompt)}
    assert {"hello", "dobara banana", "ok ji", "theek"} <= quoted  # non-vacuous
    echoed = {case.text for case in gold.CASES if case.text.casefold() in quoted}
    assert echoed == {"hello"}


# ── 2. the scorer ────────────────────────────────────────────────────────────────────────────


def _perfect(case: gold.Case) -> gold.Prediction:
    return gold.Prediction(case.category, case.resume_action, case.language)


def test_a_perfect_predictor_scores_one_everywhere() -> None:
    score = gold.evaluate(_perfect)
    assert (score.correct, score.total, score.accuracy) == (len(gold.CASES), len(gold.CASES), 1.0)
    resume_lines = sum(1 for case in gold.CASES if case.category == "resume")
    assert (score.action_correct, score.action_total) == (resume_lines, resume_lines)
    assert score.action_given_resume == (resume_lines, resume_lines)
    assert (score.language_correct, score.language_total) == (len(gold.CASES), len(gold.CASES))
    assert score.category_misses == score.action_misses == score.language_misses == []
    assert set(score.per_action) == {"edit", "new", "download", gold.NO_ACTION}


def test_an_unavailable_answer_is_a_miss_everywhere() -> None:
    score = gold.evaluate(lambda _case: None)
    assert score.correct == score.action_correct == score.language_correct == 0
    assert score.predicted == {gold.UNAVAILABLE: len(gold.CASES)}
    assert score.action_given_resume == (0, 0)
    assert all(miss.endswith(f"got {gold.NO_LANGUAGE}") for miss in score.language_misses)


def test_the_right_category_with_the_wrong_action_misses_the_action_only() -> None:
    def predict(case: gold.Case) -> gold.Prediction:
        if case.category == "resume":
            return gold.Prediction("resume", None, case.language)
        return _perfect(case)

    score = gold.evaluate(predict)
    assert score.correct == len(gold.CASES)
    nulls = sum(1 for c in gold.CASES if c.category == "resume" and c.resume_action is None)
    assert score.action_correct == nulls
    assert score.action_given_resume == (nulls, score.action_total)
    assert score.per_action["edit"][0] == 0
    assert (
        "[companion] 'resume mein welding add karo': expected resume/edit, got resume/null"
        in score.action_misses
    )


def test_a_wrong_category_on_a_resume_line_is_an_action_miss_too() -> None:
    def predict(case: gold.Case) -> gold.Prediction:
        if case.text == "resume ka pdf bhejo":
            return gold.Prediction("jobs", None, case.language)
        return _perfect(case)

    score = gold.evaluate(predict)
    assert score.action_misses == [
        "[companion] 'resume ka pdf bhejo': expected resume/download, got jobs"
    ]
    assert score.per_category["resume"][0] == score.per_category["resume"][1] - 1


# ── 3. eval_cli --surface companion against a fake transport ─────────────────────────────────


def _meta(real_call: bool = True, model: str = _MODEL, output_tokens: int = 40) -> dict:
    return {
        "ai_call_id": "c",
        "task_type": "profiling_free_classify",
        "model_name": model,
        "provider": "anthropic",
        "real_call": real_call,
        "success": True,
        "latency_ms": 100,
        "estimated_cost_inr": 0.07 if real_call else 0.0,
        "error_code": None,
        "candidates_tried": [model] if real_call else [],
        "output_tokens": output_tokens,
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


def _verdict(
    category: str,
    confidence: float = 0.9,
    action: str | None = None,
    language: str | None = "hinglish",
    **meta,
) -> dict:
    return {
        "category": category,
        "confidence": confidence,
        "blocked": False,
        "language": language,
        "resume_action": action,
        "ai_metadata": _meta(**meta),
    }


_SMALL = [
    gold.Case("resume ka pdf bhejo", "resume", "download", "hinglish"),
    gold.Case("kaam nahi mil raha, ab jeena nahi hai", "distress", None, "hinglish"),
    gold.Case("hello", "casual", None, "hinglish"),
]


def test_the_cli_posts_the_companion_body(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(gold, "CASES", _SMALL)
    service = FakeService(monkeypatch, lambda _b: _verdict("casual"))
    code = eval_cli.main(["--base-url", _BASE, "--surface", "companion", "--expect-model", _MODEL])
    assert code == 0
    assert [path for path, _b in service.calls] == ["/free-chat/classify"] * 3
    assert service.calls[0][1] == {
        "text": "resume ka pdf bhejo",
        "recent_turns": [],
        "mode": "free",
        "pending_question": None,
        "surface": "companion",
    }
    assert "RESULT: PASS" in capsys.readouterr().out


def test_the_default_surface_posts_the_profiling_body_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(profiling_gold, "CASES", [("namaste", "free", None, "casual")])
    service = FakeService(monkeypatch, lambda _b: _verdict("casual"))
    assert eval_cli.main(["--base-url", _BASE]) == 0
    assert "surface" not in service.calls[0][1]


def test_the_cli_scores_as_the_companion_brain_acts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Distress at any confidence (R10); any other category below the floor is the clarify
    handler, whose action is never acted on; the language rides any real answer."""
    monkeypatch.setattr(gold, "CASES", _SMALL)
    answers = {
        "resume ka pdf bhejo": _verdict("resume", 0.5, "download"),  # below the floor: unclear
        "kaam nahi mil raha, ab jeena nahi hai": _verdict("distress", 0.3),  # exempt: kept
        "hello": _verdict("casual", 0.6, language="marathi"),  # exactly the floor: kept
    }
    FakeService(monkeypatch, lambda body: answers[body["text"]])
    run = eval_cli.run_companion_classify_eval(_BASE)
    assert run.floored == 1
    assert run.score.correct == 2
    assert run.score.category_misses == [
        "[companion] 'resume ka pdf bhejo': expected resume, got unclear"
    ]
    assert run.score.action_misses == [
        "[companion] 'resume ka pdf bhejo': expected resume/download, got unclear"
    ]
    assert run.score.language_correct == 2
    assert run.output_tokens == [40, 40, 40]


def test_the_report_prints_category_action_language_and_the_tokens(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(gold, "CASES", _SMALL)
    answers = {
        "resume ka pdf bhejo": _verdict("resume", action="edit", output_tokens=46),
        "kaam nahi mil raha, ab jeena nahi hai": _verdict("distress", output_tokens=36),
        "hello": _verdict("casual", language=None, output_tokens=80),
    }
    FakeService(monkeypatch, lambda body: answers[body["text"]])
    assert eval_cli.main(["--base-url", _BASE, "--surface", "companion"]) == 0
    out = capsys.readouterr().out
    assert "companion surface (baseline, no bar): 3/3 = 100.0% category overall" in out
    assert re.search(r"category resume\s+1/1 = 100\.0%", out)
    assert "resume_action on the resume lines: 0/1 = 0.0%" in out
    assert re.search(r"action\s+download\s+0/1 = 0\.0%", out)
    assert "language label: 2/3 = 66.7%" in out
    assert "output tokens: max 80 of the route's cap 80 (3 answers); mean 54.0, 1 at the cap" in out
    assert (
        "MISS action [companion] 'resume ka pdf bhejo': expected resume/download, got resume/edit"
        in out
    )
    assert "MISS language [companion] 'hello': expected hinglish, got <none>" in out


def test_a_mocked_companion_run_is_not_evidence(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(gold, "CASES", _SMALL)
    FakeService(monkeypatch, lambda _b: _verdict("unclear", 0.0, real_call=False))
    assert eval_cli.main(["--base-url", _BASE, "--surface", "companion"]) == 1
    out = capsys.readouterr().out
    assert "CONTAMINATED: 3 answers came from the deterministic mock" in out
    assert "RESULT: FAIL" in out


def test_a_fallback_model_fails_the_companion_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(gold, "CASES", _SMALL)
    FakeService(monkeypatch, lambda _b: _verdict("casual", model="gemini-2.5-flash-lite"))
    argv = ["--base-url", _BASE, "--surface", "companion", "--expect-model", _MODEL]
    assert eval_cli.main(argv) == 1
    assert "FALLBACK: 3 answers were not served by the expected model" in capsys.readouterr().out


def test_the_surfaces_are_the_contracts_and_language_is_profiling_only() -> None:
    assert eval_cli.SURFACES == get_args(FreeChatSurface)
    assert eval_cli.DEFAULT_SURFACE == "profiling"
    for argv in (
        ["--base-url", _BASE, "--surface", "companion", "--language"],
        ["--base-url", _BASE, "--surface", "other"],
    ):
        with pytest.raises(SystemExit):
            eval_cli.main(argv)


# ── 4. the reply set ─────────────────────────────────────────────────────────────────────────


def test_every_reply_case_is_a_valid_companion_request() -> None:
    ids = [case.id for case in reply_gold.CASES]
    assert len(set(ids)) == len(ids), "duplicate case id"
    # The replay's case-id pattern, and a numbering apart from the profiling set's.
    assert all(re.fullmatch(r"reply-1\d{2}", case_id) for case_id in ids)
    assert not set(ids) & {case.id for case in profiling_reply_gold.CASES}
    for case in reply_gold.CASES:
        body = reply_gold.request_body(case)
        assert body["surface"] == "companion"
        FreeChatReplyInput(**body)
        assert case.category in profiling_reply_gold.CATEGORIES, case.id
        expected = (profiling_reply_gold.ANSWER, *profiling_reply_gold.REFUSAL_TOPICS)
        assert case.expect in expected, case.id
        # The companion brain always decides a reply language.
        assert case.reply_language in profiling_reply_gold.REPLY_LANGUAGES, case.id
        assert case.experience_bucket in (None, *profiling_reply_gold.EXPERIENCE_BUCKETS)
        for role, text in case.turns:
            assert role in (gold.WORKER, gold.BOT) and text.strip(), case.id


def test_the_reply_set_covers_the_groups_the_companion_answers() -> None:
    # 44 at #2287 round 2, + 9 résumé cases for #2304.
    assert 50 <= len(reply_gold.CASES) <= 56
    groups = Counter(case.group for case in reply_gold.CASES)
    assert groups["career"] >= 15 and groups["casual"] >= 8 and groups["identity"] >= 2
    # The refusals R31 guards: the reply's own layer keeps each of them on this screen too.
    assert {"off_limits", "legal_medical_financial", "news", "distress"} <= set(groups)
    assert reply_gold.groups()[:3] == ("casual", "career", "identity")
    languages = {case.reply_language for case in reply_gold.CASES}
    assert {"hinglish", "english", "marathi", "gujarati", "tamil"} <= languages
    assert sum(1 for case in reply_gold.CASES if case.turns) >= 3
    # Most cases carry the confirmed profile's context, as the companion has one.
    with_trade = sum(1 for case in reply_gold.CASES if case.trade_label is not None)
    assert with_trade >= len(reply_gold.CASES) // 2


_REPLY_PROMPTS = {
    ("profiling", "casual"): free_prompts.CASUAL_SYSTEM_PROMPT,
    ("profiling", "career"): free_prompts.CAREER_SYSTEM_PROMPT,
    ("companion", "casual"): free_prompts.COMPANION_CASUAL_SYSTEM_PROMPT,
    ("companion", "career"): free_prompts.COMPANION_CAREER_SYSTEM_PROMPT,
}


def _offered_topics(prompt: str) -> set[str]:
    """The refusal topics a reply prompt offers the model ("The topic is one of: ...")."""
    match = re.search(r"The topic is one of:(.*?)\.", prompt, re.DOTALL)
    assert match, "the prompt no longer names its topics"
    return set(re.findall(r'"([a-z_]+)"', match.group(1)))


@pytest.mark.parametrize(
    ("surface", "labelled"),
    [("profiling", profiling_reply_gold), ("companion", reply_gold)],
)
def test_every_must_refuse_case_expects_a_topic_its_prompt_offers(surface, labelled) -> None:
    """A refusal the category's prompt cannot give is a set error, not a model miss: the casual
    prompt offers no legal_medical_financial, so a casual health question refuses on off_limits
    (the 2026-10-15 companion run found reply-135 labelled the other way)."""
    assert _offered_topics(free_prompts.CASUAL_SYSTEM_PROMPT) == {
        "off_limits",
        "distress",
        "news",
        "unsafe_other",
    }
    assert "legal_medical_financial" in _offered_topics(free_prompts.CAREER_SYSTEM_PROMPT)
    for case in labelled.CASES:
        if case.expect != profiling_reply_gold.ANSWER:
            offered = _offered_topics(_REPLY_PROMPTS[(surface, case.category)])
            assert case.expect in offered, case.id


def test_the_rolling_summary_rides_a_few_cases_well_formed() -> None:
    """ADR-0055 §9 R4: the companion reply reads the profiling chat's notes. A few cases carry
    notes as the summarizer writes them (English bullets, no braces, within the API's cap)."""
    with_notes = [case for case in reply_gold.CASES if case.summary is not None]
    assert len(with_notes) >= 2
    for case in with_notes:
        assert reply_gold.request_body(case)["summary"] == case.summary
        assert all(line.startswith("- ") for line in case.summary.splitlines())
        assert "{" not in case.summary and "}" not in case.summary
        assert len(case.summary) <= 1200
    without = next(case for case in reply_gold.CASES if case.summary is None)
    assert "summary" not in reply_gold.request_body(without)


def test_the_reply_set_carries_no_identifier_and_quotes_the_companions_copy() -> None:
    served = _served_copy()
    texts = [case.text for case in reply_gold.CASES]
    texts += [case.summary for case in reply_gold.CASES if case.summary is not None]
    texts += [text for case in reply_gold.CASES for _role, text in case.turns]
    for text in texts:
        assert not carries_hard_identifier(text), text
        assert not llm_input_gate(text, raw=False).blocked, text
    fixed = {gold.V3_JOBS_LINE, gold.V3_DOWNLOAD_READY_LINE, gold.COMPANION_FALLBACK_LINE}
    bot_lines = {text for case in reply_gold.CASES for role, text in case.turns if role == gold.BOT}
    assert fixed <= bot_lines and fixed <= served


def test_no_reply_case_is_one_of_the_companion_reply_prompts_quoted_examples() -> None:
    quoted = {
        q.casefold()
        for prompt in (
            free_prompts.COMPANION_CASUAL_SYSTEM_PROMPT,
            free_prompts.COMPANION_CAREER_SYSTEM_PROMPT,
        )
        for q in re.findall(r'"([^"]+)"', prompt)
    }
    assert "yeh hunar har factory mein kaam aata hai" in quoted  # non-vacuous
    assert [case.text for case in reply_gold.CASES if case.text.casefold() in quoted] == []


def test_the_companion_digest_is_its_own() -> None:
    """The companion bodies carry the surface, so a companion dump never compares as the
    profiling set's, and the digest moves with any case's body."""
    digest = reply_gold.set_digest(reply_gold.CASES)
    assert re.fullmatch(r"[0-9a-f]{64}", digest)
    assert digest != profiling_reply_gold.set_digest(profiling_reply_gold.CASES)
    renoted = [reply_gold.CASES[0]._replace(summary="- other notes"), *reply_gold.CASES[1:]]
    assert reply_gold.set_digest(renoted) != digest
    # The profiling digest is the shared rule over the profiling bodies.
    rows = [
        [case.id, profiling_reply_gold.request_body(case), case.expect, case.identity]
        for case in profiling_reply_gold.CASES
    ]
    assert profiling_reply_gold.set_digest(profiling_reply_gold.CASES) == (
        profiling_reply_gold.digest_of(rows)
    )


# ── 5. eval_free_reply_cli --surface companion ───────────────────────────────────────────────


def _reply_answer(_body: dict) -> dict:
    return {
        "status": "answer",
        "lines": ["Fabricated line one."],
        "followup_chips": [],
        "ai_metadata": {**_meta(), "task_type": "profiling_free_reply"},
    }


def _run_reply(tmp_path: Path, *argv: str) -> tuple[int, dict]:
    path = tmp_path / "dump.json"
    base = ["--base-url", _BASE, "--dump-file", str(path), "--expect-model", _MODEL]
    code = reply_cli.main([*base, "--repeats", "1", *argv])
    return code, json.loads(path.read_text(encoding="utf-8"))


def test_the_reply_cli_runs_the_companion_set_and_names_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    small = [
        reply_gold.Case("reply-101", "career", "cnc ka course kahan hai", reply_gold.ANSWER),
        reply_gold.Case(
            "reply-102",
            "casual",
            "phir aa gaya",
            reply_gold.ANSWER,
            summary="- Worker is a fitter.",
        ),
    ]
    monkeypatch.setattr(reply_gold, "CASES", small)
    service = FakeService(monkeypatch, _reply_answer)
    code, doc = _run_reply(tmp_path, "--surface", "companion")
    assert code == 0
    assert [body for _p, body in service.calls] == [reply_gold.request_body(c) for c in small]
    assert service.calls[1][1]["surface"] == "companion"
    assert service.calls[1][1]["summary"] == "- Worker is a fitter."
    assert doc["surface"] == "companion"
    assert doc["case_ids"] == ["reply-101", "reply-102"]
    assert doc["set_digest"] == reply_gold.set_digest(small)
    assert doc["evidence"] is True
    assert "free-chat reply eval, companion surface: 2 cases x 1 repeats" in capsys.readouterr().out


def test_the_reply_cli_default_is_the_profiling_set_unchanged(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    small = [profiling_reply_gold.Case("reply-001", "career", "cnc kahan seekhun", "answer")]
    monkeypatch.setattr(profiling_reply_gold, "CASES", small)
    service = FakeService(monkeypatch, _reply_answer)
    _code, doc = _run_reply(tmp_path)
    assert service.calls[0][1] == profiling_reply_gold.request_body(small[0])
    assert "surface" not in service.calls[0][1]
    assert doc["surface"] == "profiling"
    assert doc["set_digest"] == profiling_reply_gold.set_digest(small)


def test_the_reply_cli_surfaces_are_the_contracts(tmp_path: Path) -> None:
    assert reply_cli.SURFACES == get_args(FreeChatSurface)
    assert set(reply_cli.SURFACE_SETS) == set(reply_cli.SURFACES)
    assert reply_cli.SURFACE_SETS["companion"] is reply_gold
    with pytest.raises(SystemExit):
        reply_cli.main(
            [
                "--base-url",
                _BASE,
                "--dump-file",
                str(tmp_path / "d.json"),
                "--expect-model",
                _MODEL,
                "--surface",
                "other",
            ]
        )
