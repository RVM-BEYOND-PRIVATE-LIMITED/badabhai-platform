"""The free-chat reply-language set, its scorer and its staging CLI (ADR-0051 §11, #2181).

WHAT RUNS IN CI. The eval measures the live model, so CI pins what makes a staging run
meaningful, never a score:

  1. THE SET: about forty fabricated cases covering English, Hinglish in Latin letters and Hindi
     in Devanagari, each regional language in Latin letters AND its own script, the bare
     language requests and a kept language; every case is a valid reply request.
  2. THE SCORER: the marker words read each language (and only it), English is read by the
     absence of Hindi, Latin-only and the persona slips are the API walls' own shapes, and a
     repeat is caught word for word or with a word swapped, never on a paraphrase.
  3. THE CLI against a fake transport: it sends `reply_language` (or omits it for the baseline),
     reports per language and kind, writes and re-scores a dump, and refuses a run that is not
     evidence (a mock, a failed call, a fallback model).

Fabricated eval text only.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import get_args

import httpx
import pytest

from app.companion import eval_cli as call_layer
from app.contracts import FreeChatReplyInput, FreeChatReplyLanguage
from app.free_chat import eval_free_reply_language as gold
from app.free_chat import eval_reply_language_cli as cli
from app.free_chat import prompts as free_prompts

_REPO = Path(__file__).resolve().parents[4]
_BASE = "http://ai.test"
_MODEL = "claude-haiku-4-5"

#: The Unicode block each regional language's own script lives in (Hindi and Marathi: Devanagari).
_SCRIPT = {
    "hinglish": "DEVANAGARI",
    "marathi": "DEVANAGARI",
    "gujarati": "GUJARATI",
    "kannada": "KANNADA",
    "telugu": "TELUGU",
    "tamil": "TAMIL",
}

#: One fabricated, respectful reply per language: what a reply that follows the line looks like.
SAMPLES = {
    "english": [
        "You can join an ITI course for welding.",
        "After that, work as a helper with a senior welder to get practice.",
    ],
    "hinglish": [
        "Fitter ke liye ITI course kariye.",
        "Saath mein drawing padhna bhi seekhiye, kaam aasaan hota hai.",
    ],
    "marathi": [
        "Tumhi plumbing shikayla ITI course kara.",
        "Suruvatila anubhavi plumber sobat helper mhanun kaam kara, mag paise milayla lagtil.",
    ],
    "gujarati": [
        "Tame ITI ma electrician course karjo.",
        "Pachhi anubhavi electrician sathe helper tarike kaam shikho, tamne practice malse.",
    ],
    "kannada": [
        "Neevu ITI electrician course maadi.",
        "Aadare ondu senior jothe helper aagi kelasa kaliyiri.",
    ],
    "telugu": [
        "Meeru ITI lo welding course cheyyandi.",
        "Mundu oka senior welder daggara helper ga nerchukondi, practice baga vastundi.",
    ],
    "tamil": [
        "Neenga ITI la plumbing course pannunga.",
        "Mudhalla oru senior plumber kitta helper ah velai kathukonga, practice romba mukkiyam.",
    ],
}


# ── 1. the set ───────────────────────────────────────────────────────────────────────────────


def test_the_languages_are_the_contracts() -> None:
    assert gold.LANGUAGES == get_args(FreeChatReplyLanguage)
    assert set(gold.REGIONAL) < set(gold.LANGUAGES)
    assert set(SAMPLES) == set(gold.LANGUAGES)


def test_the_set_is_about_forty_cases_with_unique_ids() -> None:
    assert 35 <= len(gold.CASES) <= 45
    ids = [case.id for case in gold.CASES]
    assert len(set(ids)) == len(ids)
    keys = [(case.text, case.turns, case.reply_language) for case in gold.CASES]
    assert len(set(keys)) == len(keys), "duplicate cases"


def test_every_language_kind_and_script_the_issue_names_is_covered() -> None:
    messages = [case for case in gold.CASES if case.kind == "message"]
    by = {(c.reply_language, c.script) for c in messages}
    assert sum(c.reply_language == "english" for c in messages) >= 4
    # Hinglish in Latin letters and Hindi in Devanagari.
    assert {("hinglish", "latin"), ("hinglish", "native")} <= by
    # Each regional language in Latin letters AND in its own script.
    for language in gold.REGIONAL:
        assert {(language, "latin"), (language, "native")} <= by, language
    # Casual and career both, so both reply prompts are measured.
    assert {c.category for c in gold.CASES} == {"casual", "career"}


def test_each_case_is_written_in_the_script_it_claims() -> None:
    for case in gold.CASES:
        names = {unicodedata.name(ch, "") for ch in case.text if ch.isalpha()}
        if case.script == "native":
            block = _SCRIPT[case.reply_language]
            assert names and all(name.startswith(block) for name in names), case.id
        else:
            assert all(name.startswith("LATIN") for name in names), case.id


def test_the_language_requests_follow_an_earlier_answer() -> None:
    """R41: a bare request re-answers the previous question, so every request case carries the
    worker's question and the bot's answer just before it. The issue's three examples are in."""
    requests = [case for case in gold.CASES if case.kind == "request"]
    assert len(requests) >= 6
    texts = {case.text for case in requests}
    for required in ("marathi mai jawab do", "reply in English please", "Tamil-la sollunga"):
        assert required in texts, required
    assert {case.reply_language for case in requests} >= {"marathi", "english", "tamil"}
    for case in requests:
        assert [role for role, _t in case.turns[-2:]] == [gold.WORKER, gold.BOT], case.id
    # The 2026-10-08 device turn: a Marathi question answered in Hinglish with "tum" forms.
    device = next(case for case in requests if case.id == "rq-mr")
    assert device.turns[-1][1] == gold.PLUMBING_A_TUM
    assert gold.persona_slips([gold.PLUMBING_A_TUM], hinglish=True)


def test_a_kept_language_differs_from_the_message_and_follows_the_approved_copy() -> None:
    kept = [case for case in gold.CASES if case.kind == "kept"]
    assert len(kept) >= 2
    adr = (_REPO / "docs" / "decisions" / "0051-profiling-stage-free-chat.md").read_text(
        encoding="utf-8"
    )
    assert "| LANG_YES | Theek hai, ab se {Language} mein baat karenge. |" in adr
    assert "| LANG_ASK | Kya aage ki saari baat {Language} mein karein? |" in adr
    for case in kept:
        name = case.reply_language.capitalize()
        assert case.turns == gold.kept(name), case.id
        # The message itself is in another language: only the kept choice says which to use.
        assert gold.detect_language(case.text) != case.reply_language, case.id


def test_the_fixed_lines_the_cases_carry_are_the_apis_served_copy() -> None:
    copy = _REPO / "apps" / "api" / "src" / "profiling" / "free-chat" / "free-chat.copy.ts"
    served = set(re.findall(r'latin:\s*"([^"]+)"', copy.read_text(encoding="utf-8")))
    assert gold.GREETING_LINE in served
    assert gold.LATER_ACK_LINE in served


def test_every_case_is_a_valid_reply_request() -> None:
    """The bodies the CLI posts parse as the contract the route enforces, so a staging run can
    never fail on a 422 the set itself caused."""
    for case in gold.CASES:
        for send in (True, False):
            body = FreeChatReplyInput(**cli.request_body(case, send_language=send))
            assert body.reply_language == (case.reply_language if send else None), case.id


def test_the_set_carries_no_bidi_or_invisible_character() -> None:
    for case in gold.CASES:
        for text in (case.text, *(t for _r, t in case.turns)):
            assert not any(unicodedata.category(ch) == "Cf" for ch in text), case.id


# ── 2. the scorer ────────────────────────────────────────────────────────────────────────────


def test_the_markers_are_disjoint_across_languages() -> None:
    """A word two languages share would score both; every marker belongs to one language."""
    seen: dict[str, str] = {}
    for language, words in gold.MARKERS.items():
        for word in words:
            assert word not in seen, (word, seen.get(word), language)
            seen[word] = language
    assert not (gold.ENGLISH_WORDS & set(seen))


@pytest.mark.parametrize("language", list(SAMPLES))
def test_each_sample_reply_reads_as_its_language(language: str) -> None:
    assert gold.detect_language("\n".join(SAMPLES[language])) == language


def test_the_markers_read_the_sets_own_latin_lines_as_their_language() -> None:
    """An independent check of the marker lists: the fabricated worker lines in Latin letters
    (not replies, and not written for the scorer) are read as the language they are in."""
    for case in gold.CASES:
        if case.kind == "message" and case.script == "latin":
            assert gold.detect_language(case.text) == case.reply_language, case.id


def test_english_means_no_hindi_word_at_all() -> None:
    english = "You can join a course after two years of work."
    assert gold.detect_language(english) == "english"
    # One Hindi word, even one a regional reply may borrow, is not English (R40).
    for word in ("aap", "kaam", "nahi", "namaste"):
        assert gold.detect_language(f"{english} {word}") != "english", word
    assert gold.detect_language("ok") == gold.MIXED  # too little to read


def test_a_tie_or_too_few_markers_is_mixed() -> None:
    assert gold.detect_language("tumhi aahe kariye hai") == gold.MIXED  # 2 against 2
    assert gold.detect_language("Tumhi ITI course") == gold.MIXED  # one marker only


def test_a_marker_ending_is_read_only_on_a_longer_word() -> None:
    assert gold.marker_counts("karnyasathi")["marathi"] == 1
    assert gold.marker_counts("velaikku")["tamil"] == 1
    assert gold.marker_counts("kku")["tamil"] == 0


def test_latin_letters_only_reads_the_scripts_and_the_danda() -> None:
    assert gold.non_latin(["ITI course kariye"]) is False
    assert gold.non_latin(["₹15,000 se ₹25,000, 0.02 µm, 4 Ω"]) is False  # the API strips units
    assert gold.non_latin(["Café résumé"]) is False
    for text in ("काम करिए", "வேலை", "ಕೆಲಸ", "పని", "કામ", "Theek hai।"):
        assert gold.non_latin(["ok", text]) is True, text


def test_hinglish_slips_are_read_only_on_a_hinglish_reply() -> None:
    line = "Course karo, phir kaam seekh jaoge aur kamana shuru kar sakte ho."
    assert gold.persona_slips([line], hinglish=True) == ["karo", "jaoge", "sakte ho"]
    # Gujarati "karo" is respectful, Telugu "lo" is "in": a regional reply is never read for them.
    assert gold.persona_slips(["Tame course karo", "ITI lo join cheyyandi"], hinglish=False) == []
    assert gold.persona_slips(["Aap course kariye, seekh sakte hain."], hinglish=True) == []
    assert gold.persona_slips(["Thoda rest kar le, paani pi le."], hinglish=True) == [
        "kar le",
        "pi le",
    ]


def test_regional_informal_forms_are_read_on_every_reply() -> None:
    """The API's regional persona wall runs on every reply, a Hinglish one included."""
    assert gold.persona_slips(["Nee velai kathuko, thambi"], hinglish=False) == ["nee", "thambi"]
    assert gold.persona_slips(["tula kaam milel"], hinglish=True) == ["tula"]
    assert gold.REGIONAL_SLIP_WORDS == frozenset(free_prompts.REGIONAL_PERSONA_TOKENS)
    # The product's own name is not a vocative.
    assert gold.persona_slips(["Bada Bhai yahan hai"], hinglish=True) == []


def test_the_prompts_banned_hinglish_forms_are_all_scored() -> None:
    """The eval measures what the prompt bans: every "never" form in the LANGUAGE block's
    Hinglish line is a slip here."""
    rule = " ".join(free_prompts._LANGUAGE_RULES.split()).split("- Hinglish:")[1].split("- ")[0]
    banned = re.findall(r'"([^"]+)"', rule.split("never")[1])
    assert "karo" in banned and "sakte ho" in banned
    for form in banned:
        assert form in gold.HINGLISH_TUM_WORDS or form in gold.HINGLISH_TUM_PHRASES, form


def test_a_repeat_is_word_for_word_or_one_word_swapped_never_a_paraphrase() -> None:
    turns = ((gold.WORKER, gold.WELD_Q), (gold.BOT, gold.WELD_A))
    said = "ITI welder ya NSDC ka welding certificate kaafi kaam aata hai."
    assert gold.verbatim_repeat([said], turns) is True
    # The 2026-10-08 baseline: the earlier answer with "ka" swapped for "na".
    assert gold.verbatim_repeat([said.replace(" ka ", " na ")], turns) is True
    assert (
        gold.verbatim_repeat(["Tame ITI welder certificate lidha to kaam saral thay."], turns)
        is False
    )
    # A short sentence is ordinary talk, and a WORKER turn is never "an earlier reply".
    assert gold.verbatim_repeat(["Theek hai."], ((gold.BOT, "Theek hai."),)) is False
    assert gold.verbatim_repeat([gold.WELD_Q], turns) is False


def test_a_refusal_or_no_answer_is_counted_apart_never_as_a_language_miss() -> None:
    case = gold.CASES[0]
    assert gold.score_reply(case, {"status": "refuse", "topic": "news"}).status == gold.REFUSE
    assert gold.score_reply(case, None).status == gold.UNAVAILABLE
    assert gold.score_reply(case, {"status": "answer", "lines": []}).status == gold.UNAVAILABLE


def _perfect(case: gold.Case) -> dict:
    return {"status": "answer", "lines": SAMPLES[case.reply_language], "followup_chips": []}


def test_a_perfect_replier_scores_every_case() -> None:
    score = gold.evaluate(_perfect)
    assert score.overall.cases == score.overall.answered == score.overall.adhered == len(gold.CASES)
    assert score.overall.slipped == score.overall.repeated == score.overall.non_latin == 0
    assert score.misses == []
    for language, tally in score.per_language.items():
        assert tally.adhered == tally.cases > 0, language
    assert sum(t.cases for t in score.per_kind.values()) == len(gold.CASES)


def test_a_hinglish_reply_to_every_case_misses_all_but_hinglish_and_names_no_reply_text() -> None:
    reply = {"status": "answer", "lines": ["Aap course kar sakte ho, phir seekh jaoge."]}
    score = gold.evaluate(lambda _case: reply)
    hinglish = sum(case.reply_language == "hinglish" for case in gold.CASES)
    assert score.overall.adhered == hinglish
    assert score.overall.slipped == len(gold.CASES)
    assert all("seekh jaoge" not in miss for miss in score.misses)
    assert any("language hinglish" in miss for miss in score.misses)


# ── 3. the CLI against a fake transport ──────────────────────────────────────────────────────


def _meta(real_call: bool = True, model: str = _MODEL) -> dict:
    return {
        "ai_call_id": "c",
        "task_type": "profiling_free_reply",
        "model_name": model,
        "provider": "anthropic",
        "real_call": real_call,
        "success": True,
        "latency_ms": 100,
        "estimated_cost_inr": 0.25 if real_call else 0.0,
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


def _answer_in(language_of: dict[str, str] | None = None, **meta):
    """Answer each request in the language it names (or `language_of[text]`), as a real call."""

    def answer(body: dict) -> dict:
        language = (language_of or {}).get(body["text"], body.get("reply_language", "hinglish"))
        return {
            "status": "answer",
            "lines": SAMPLES[language],
            "followup_chips": [],
            "ai_metadata": _meta(**meta),
        }

    return answer


def test_the_revised_run_sends_the_reply_language(monkeypatch: pytest.MonkeyPatch) -> None:
    service = FakeService(monkeypatch, _answer_in())
    assert cli.main(["--base-url", _BASE, "--expect-model", _MODEL]) == 0
    assert [path for path, _b in service.calls] == ["/free-chat/reply"] * len(gold.CASES)
    first = gold.CASES[0]
    assert service.calls[0][1] == {
        "category": first.category,
        "text": first.text,
        "recent_turns": [{"role": r, "text": t} for r, t in first.turns],
        "worker_context": {"trade_label": None, "experience_bucket": None},
        "reply_language": first.reply_language,
    }


def test_the_baseline_omits_the_reply_language(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    service = FakeService(monkeypatch, _answer_in())
    assert cli.main(["--base-url", _BASE, "--omit-language"]) == 0
    assert all("reply_language" not in body for _p, body in service.calls)
    out = capsys.readouterr().out
    assert "BASELINE, reply_language omitted" in out
    # Every answer came back Hinglish (the fake's default): only the Hinglish cases adhere.
    hinglish = sum(case.reply_language == "hinglish" for case in gold.CASES)
    assert f"{hinglish}/{len(gold.CASES)}" in out.splitlines()[0]


def test_the_report_prints_every_language_and_kind(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    FakeService(monkeypatch, _answer_in())
    assert cli.main(["--base-url", _BASE]) == 0
    out = capsys.readouterr().out
    assert "REVISED, reply_language sent" in out
    for name in (*gold.LANGUAGES, *gold.KINDS, "overall"):
        assert re.search(rf"^  {name}\s+language \d+/\d+", out, re.M), name
    total = len(gold.CASES)
    assert re.search(rf"^  overall\s+language {total}/{total} = 100%", out, re.M)
    assert "spend INR" in out and "RESULT: PASS" in out


def test_cases_runs_only_the_named_ones(monkeypatch: pytest.MonkeyPatch) -> None:
    service = FakeService(monkeypatch, _answer_in())
    run = cli.run_reply_language_eval(_BASE, case_ids=["ta-1", "en-1"])
    assert [body["text"] for _p, body in service.calls] == [
        case.text for case in gold.CASES if case.id in ("en-1", "ta-1")
    ]
    assert run.score.overall.cases == 2
    with pytest.raises(SystemExit):
        cli.main(["--base-url", _BASE, "--cases", "nope"])


def test_a_mock_answer_contaminates_the_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    FakeService(monkeypatch, _answer_in(real_call=False))
    assert cli.main(["--base-url", _BASE]) == 1
    out = capsys.readouterr().out
    assert "CONTAMINATED" in out and "RESULT: FAIL" in out


def test_a_fallback_model_fails_the_run_under_expect_model(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    FakeService(monkeypatch, _answer_in(model="gemini-2.5-flash"))
    assert cli.main(["--base-url", _BASE, "--expect-model", _MODEL]) == 1
    assert "were not served by the expected model" in capsys.readouterr().out


def test_a_failed_call_is_incomplete_and_unavailable(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    first = gold.CASES[0].text

    def answer(body: dict):
        return 503 if body["text"] == first else _answer_in()(body)

    FakeService(monkeypatch, answer)
    assert cli.main(["--base-url", _BASE]) == 1
    out = capsys.readouterr().out
    assert "INCOMPLETE: 1 calls failed" in out
    assert f"{gold.CASES[0].id}: unavailable" in out


def test_the_dump_carries_every_reply_and_rescores_without_a_call(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    dump = tmp_path / "run.json"
    FakeService(monkeypatch, _answer_in({gold.CASES[0].text: "hinglish"}))
    assert cli.main(["--base-url", _BASE, "--dump-file", str(dump)]) == 0
    rows = json.loads(dump.read_text(encoding="utf-8"))
    assert [row["id"] for row in rows] == [case.id for case in gold.CASES]
    assert rows[0]["lines"] == SAMPLES["hinglish"] and rows[0]["adhered"] is False
    assert rows[1]["adhered"] is True and rows[1]["model"] == _MODEL
    capsys.readouterr()

    def no_call(*_args, **_kwargs):
        raise AssertionError("--rescore must make no call")

    monkeypatch.setattr(call_layer.httpx, "post", no_call)
    assert cli.main(["--rescore", str(dump)]) == 0
    out = capsys.readouterr().out
    assert "re-scored from a dump: no calls made" in out
    assert f"{len(gold.CASES) - 1}/{len(gold.CASES)}" in out.splitlines()[0]


def test_the_cli_refuses_bad_arguments() -> None:
    for argv in (
        [],
        ["--base-url", _BASE, "--rescore", "x.json"],
        ["--base-url", _BASE, "--pace-ms", "-1"],
        ["--base-url", _BASE, "--expect-model", " "],
    ):
        with pytest.raises(SystemExit):
            cli.main(argv)


def test_the_api_timeout_is_the_api_clients_own() -> None:
    source = (_REPO / "apps" / "api" / "src" / "ai" / "ai.service.ts").read_text(encoding="utf-8")
    found = re.findall(r'this\.post\(\s*"/free-chat/reply",\s*input,\s*\w+,\s*([\d_]+)', source)
    assert found, "ai.service.ts no longer posts /free-chat/reply in the shape this pin reads"
    assert {float(ms.replace("_", "")) for ms in found} == {cli.API_TIMEOUT_MS}
