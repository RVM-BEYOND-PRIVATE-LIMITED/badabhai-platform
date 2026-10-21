"""#2387 — a chat-built résumé is always professional English, and "sab" means every chip shown.

Owner ruling 2026-10-21 (ADR-0058). Pinned here:

- the Phase C prompt asks for English, parsed values and keeps ADR-0039's prohibitions, with
  `duration_text` the one verbatim field;
- the chips Bada Bhai showed reach the model as ``[Options: …]`` after the line they belong to,
  masked chip by chip, and a line sent without chips renders exactly as before;
- the general road's skills prompt asks for English labels and expands a catch-all the same way.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

import app.main as main_module
from app.contracts import AICallMetadata, LlmTurnInput, TranscriptLine
from app.profiling.interview_prompts import extract_system_prompt, skills_interview_system_prompt
from app.profiling.parse_masking import default_masker, mask_transcript_lines
from app.routers.profiling import _render_history, _render_line

client = TestClient(main_module.app)

_BLOCKED = "reference number 12345678"


def _meta() -> AICallMetadata:
    return AICallMetadata(
        ai_call_id="call-1",
        task_type="profile_extraction",
        model_name="test-model",
        provider="test-provider",
        real_call=True,
        created_at="2026-10-21T00:00:00Z",
    )


def _capture(monkeypatch) -> list[list[dict]]:
    sent: list[list[dict]] = []

    async def _run(_task_type, *, messages, **_kwargs):
        sent.append(messages)
        return "{}", _meta()

    monkeypatch.setattr(main_module.router, "run", _run)
    return sent


# --- the Phase C prompt -----------------------------------------------------------------------


def test_the_extract_prompt_makes_the_resume_english_and_no_longer_forbids_translating() -> None:
    prompt = extract_system_prompt()
    assert "THE RESUME IS ALWAYS IN ENGLISH" in prompt
    assert "Never copy a Hindi or Hinglish phrase into any field" in prompt
    assert "do not translate" not in prompt.lower()
    assert "COPIED — NOT REWRITTEN" not in prompt


def test_the_extract_prompt_parses_like_a_resume_writer() -> None:
    prompt = extract_system_prompt()
    # Translate, repair speech-to-text, drop filler, resolve references — the owner's examples.
    assert '"VMC chalata hoon" -> "VMC operation"' in prompt
    assert '"let machine" or "khraad" is a lathe' in prompt
    assert "Drop filler" in prompt
    assert '"donon pe kaam kiya"' in prompt
    assert "at most 6 words" in prompt


def test_the_extract_prompt_keeps_every_adr_0039_prohibition() -> None:
    """The rewrite changes words, never claims — no gate can prove it, so the prompt must say it."""
    prompt = extract_system_prompt()
    never = prompt.split("NEVER ADD, in any field:")[1].split("NEVER record a company")[0]
    for banned in (
        "skill level",
        "A number the conversation does not contain",
        "did not name",
        "A responsibility he did not state",
        "Praise or quality claims",
    ):
        assert banned in never, banned
    assert "You change the\nWORDS, never the CLAIMS" in prompt


def test_duration_text_is_the_one_verbatim_field() -> None:
    prompt = extract_system_prompt()
    assert "`duration_text` IS THE ONE EXCEPTION" in prompt
    assert "copy how long he said, in his own words" in prompt


def test_a_catch_all_expands_to_the_options_shown_never_to_the_word_itself() -> None:
    prompt = extract_system_prompt()
    assert "A CATCH-ALL ANSWER MEANS EVERY OPTION THAT WAS SHOWN" in prompt
    assert '"[Options: A | B | C]"' in prompt
    for catch_all in ('"sab"', '"sab kuch"', '"sab aata hai"', '"sab kiya hai"', '"all"'):
        assert catch_all in prompt, catch_all
    assert 'Never record "sab", "all" or "everything" itself' in prompt
    # The system's own buttons are never an answer.
    for button in ('"Kuch aur"', '"Other"', '"Haan"', '"Nahi"', '"None of these"'):
        assert button in prompt, button
    assert "If no options were shown for that question, a catch-all records nothing" in prompt


# --- the chips reach the model ------------------------------------------------------------------


def test_extract_renders_the_chips_after_the_question_they_belong_to(monkeypatch) -> None:
    sent = _capture(monkeypatch)
    resp = client.post(
        "/profiling/extract",
        json={
            "worker_ref": "w1",
            "transcript": [
                {
                    "i": 0,
                    "role": "assistant",
                    "text": "Kaunsi machines chalate hain?",
                    "options": ["VMC", "CNC lathe", "Kuch aur"],
                },
                {"i": 1, "role": "worker", "text": "sab chalata hu"},
            ],
        },
    )
    assert resp.status_code == 200
    user = sent[0][1]["content"]
    assert user == (
        "The conversation:\n"
        "Bada Bhai: Kaunsi machines chalate hain? [Options: VMC | CNC lathe | Kuch aur]\n"
        "Worker: sab chalata hu"
    )


def test_a_line_without_chips_renders_byte_identically_to_before() -> None:
    plain = TranscriptLine(i=0, role="assistant", text="Kitne saal ka experience hai?")
    empty = TranscriptLine(i=0, role="assistant", text="Kitne saal ka experience hai?", options=[])
    assert _render_line(plain) == "Bada Bhai: Kitne saal ka experience hai?"
    assert _render_line(empty) == "Bada Bhai: Kitne saal ka experience hai?"


def test_each_chip_is_masked_on_its_own_and_a_refused_chip_is_dropped() -> None:
    lines = [
        TranscriptLine(
            i=0, role="assistant", text="Kaunse tools?", options=["Vernier", _BLOCKED, "Micrometer"]
        )
    ]
    masked = mask_transcript_lines(lines, default_masker)
    assert masked[0].options == ["Vernier", "Micrometer"]
    assert "12345678" not in json.dumps([line.model_dump() for line in masked])


def test_a_line_whose_every_chip_is_refused_carries_none() -> None:
    lines = [TranscriptLine(i=0, role="assistant", text="Kaunse tools?", options=[_BLOCKED])]
    assert mask_transcript_lines(lines, default_masker)[0].options is None


def test_the_turn_history_shows_the_chips_too() -> None:
    body = LlmTurnInput.model_validate(
        {
            "worker_ref": "w1",
            "stage": "skills",
            "interview_mode": "skills_only",
            "message_text": "sab aata hai",
            "history": [
                {
                    "i": 0,
                    "role": "assistant",
                    "text": "Kaunse database use karte hain?",
                    "options": ["PostgreSQL", "MySQL"],
                },
            ],
        }
    )
    assert _render_history(body) == (
        "Bada Bhai: Kaunse database use karte hain? [Options: PostgreSQL | MySQL]"
    )


# --- the general road's skills stage ------------------------------------------------------------


def test_the_skills_prompt_asks_for_english_labels_that_keep_the_workers_trade_words() -> None:
    prompt = skills_interview_system_prompt()
    assert "THE RESUME IS ALWAYS IN ENGLISH" in prompt
    assert "Keep the worker's own product, tool and trade words" in prompt
    assert '"Tally mein billing karta\n  hoon" -> "Billing in Tally"' in prompt
    assert "never translate" not in prompt
    assert "Write every chip in English" in prompt


def test_the_skills_prompt_expands_a_catch_all_to_the_chips_shown() -> None:
    prompt = skills_interview_system_prompt()
    assert "A CATCH-ALL ANSWER MEANS EVERY CHIP THAT WAS SHOWN" in prompt
    assert "return each of those chips as a skill" in prompt
    assert 'Never return "sab", "all" or "everything" itself as a skill' in prompt
