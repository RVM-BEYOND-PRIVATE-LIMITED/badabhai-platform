"""#1911: the API re-asks a refused title or description by EDITING this engine's state.

`apps/api/src/payer-portal/job-posting-chat/job-posting-chat.screen.ts` runs the shared
worker-visible text screen on every turn's draft. When it refuses `role_title` or `description`
it rewrites the returned `JobPostingChatState` so that THIS engine asks the topic again: the
answer leaves `collected`, the topic leaves `answered_topics`, and the topic is moved to the end
of `asked_question_ids`. That is only correct while the engine keeps behaving the way the
TypeScript assumes:

- the next message is attributed to `asked_question_ids[-1]`, whatever its ask count;
- `role_title` is the first essential and the bank's first topic, and `description` is the
  bank's last topic and not essential (the TS mirrors this in `FIELD_POLICY`);
- a refused field reopened as NEVER asked is served again before the interview wraps up;
- "no", the word the re-ask tells the payer to send to keep an earlier value, records nothing.

Nothing on the TypeScript side can watch the engine, so this file pins those facts here. It
reads the TS module from SOURCE, as test_contract_parity.py does, so a change on either side
alone turns this red. The screen suite in apps/api reads this engine's source the other way,
because CI runs each language's suite only when its own paths change.

The states below have the shapes the TS screen suite expects `reaskRefusedFields` to produce.

Reaches across the repo with ``parents[3]``, which is fine HERE and nowhere in ``app/``: tests
are never copied into the image.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.contracts import JobPostingChatState, JobPostingDraft
from app.job_posting_chat import answers, interview_engine, question_bank

_SCREEN_TS = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "api"
    / "src"
    / "payer-portal"
    / "job-posting-chat"
    / "job-posting-chat.screen.ts"
)


def _screen_ts() -> str:
    return _SCREEN_TS.read_text(encoding="utf-8").replace("\r\n", "\n")


def _screened_fields() -> list[str]:
    match = re.search(r"export const SCREENED_DRAFT_FIELDS = \[(.*?)\] as const;", _screen_ts())
    assert match, "SCREENED_DRAFT_FIELDS not found in job-posting-chat.screen.ts — it has moved"
    return re.findall(r'"(\w+)"', match.group(1))


def _field_policy() -> dict[str, dict[str, str]]:
    """`FIELD_POLICY` read from source: ``{field: {"label": ..., "question": ..., ...}}``.

    Values come back as their source text: a quoted string unquoted, ``true``/``false`` bare.
    """
    match = re.search(r"export const FIELD_POLICY: [^=]*= \{\n(.*?)\n\};", _screen_ts(), re.S)
    assert match, "FIELD_POLICY not found in job-posting-chat.screen.ts — it has moved"
    body = re.sub(r"^\s*//[^\n]*\n", "", match.group(1), flags=re.M)
    policy: dict[str, dict[str, str]] = {}
    for field, entry in re.findall(r"^  (\w+): \{\n(.*?)\n  \},?$", body, re.S | re.M):
        pairs = re.findall(r'^\s+(\w+): (?:"([^"\n]*)"|(\w+)),$', entry, re.M)
        policy[field] = {key: quoted or bare for key, quoted, bare in pairs}
    return policy


def _keep_word() -> str:
    """The word `KEEP_HINT` tells the payer to send to keep an earlier value."""
    match = re.search(r"const KEEP_HINT = '[^'\n]*\"(\w+)\"[^'\n]*';", _screen_ts())
    assert match, "KEEP_HINT not found in job-posting-chat.screen.ts — it has moved"
    return match.group(1)


# --- The facts FIELD_POLICY mirrors -------------------------------------------


def test_the_ts_source_parses_to_the_real_policy_not_an_empty_one():
    assert _screened_fields() == ["role_title", "description"]
    policy = _field_policy()
    assert sorted(policy) == ["description", "role_title"]
    for entry in policy.values():
        assert set(entry) == {"label", "question", "essential", "bankEdge"}


@pytest.mark.parametrize("field", ["role_title", "description"])
def test_each_screened_field_is_a_bank_topic_and_a_draft_field(field: str):
    assert field in _screened_fields()
    assert question_bank.topic_by_id(field) is not None
    assert field in JobPostingDraft.model_fields


def test_screened_fields_are_in_bank_order():
    bank = [t.id for t in question_bank.topics_for()]
    screened = _screened_fields()
    assert [t for t in bank if t in screened] == screened


@pytest.mark.parametrize("field", ["role_title", "description"])
def test_field_policy_essential_and_bank_edge_match_the_engine(field: str):
    entry = _field_policy()[field]
    assert entry["essential"] == ("true" if field in interview_engine.ESSENTIAL_TOPICS else "false")
    bank = question_bank.topics_for()
    edge = bank[0] if entry["bankEdge"] == "first" else bank[-1]
    assert edge.id == field


def test_a_reopened_title_is_the_first_essential():
    """The TS PREPENDS a reopened title to `unanswered_essentials`; the engine lists them in
    `ESSENTIAL_TOPICS` order, so that is only the same list while the title comes first."""
    assert interview_engine.ESSENTIAL_TOPICS[0] == "role_title"


def test_the_title_re_ask_is_the_bank_retry_wording_verbatim():
    title = question_bank.topic_by_id("role_title")
    assert title is not None
    assert _field_policy()["role_title"]["question"] == title.retry_question
    # The description is asked once, so the bank has no re-ask for it and the TS owns that one.
    description = question_bank.topic_by_id("description")
    assert description is not None and description.retry_question is None


def test_the_keep_word_is_a_refusal_the_engine_records_nothing_for():
    word = _keep_word()
    assert word == "no"
    assert answers._REFUSAL_RE.match(word)


# --- The engine reads a re-ask-shaped state the way the TS assumes ------------

# Every topic but the title and the description, as asked in a full interview (the opener
# asks the title). The same list the TS screen suite uses.
_ASKED_TO_REQUIREMENTS = [
    "location_label",
    "vacancy",
    "skills",
    "pay_range",
    "pay_type",
    "experience",
    "shift",
    "needed_by",
    "benefits",
    "requirements",
]
_EARLIER = "Machining on the shop floor"


def _one_each(ids: list[str]) -> dict[str, int]:
    return dict.fromkeys(ids, 1)


@pytest.mark.parametrize("title_asks", [None, 1, 2])
def test_a_re_asked_title_takes_the_next_message_and_the_unserved_pick_comes_next(
    title_asks: int | None,
):
    """Turn 1's refused title: the location question the engine picked was un-served."""
    state = JobPostingChatState(
        turn_count=1,
        asked_question_ids=["role_title"],
        ask_counts={} if title_asks is None else {"role_title": title_asks},
        unanswered_essentials=["role_title", "location_label", "city", "vacancy"],
    )
    _, asked_id, after, ready = interview_engine.next_turn(state, "CNC Operator")
    assert after.collected["role_title"] == "CNC Operator"
    assert "role_title" in after.answered_topics
    assert asked_id == "location_label"
    assert not ready


def test_a_re_asked_description_takes_the_next_message_and_wraps_up():
    state = JobPostingChatState(
        turn_count=12,
        answered_topics=["role_title", *_ASKED_TO_REQUIREMENTS, "city"],
        asked_question_ids=[*_ASKED_TO_REQUIREMENTS, "description"],
        ask_counts=_one_each([*_ASKED_TO_REQUIREMENTS, "description"]),
        collected={"role_title": "CNC Operator"},
    )
    _, asked_id, after, ready = interview_engine.next_turn(state, _EARLIER)
    assert after.collected["description"] == _EARLIER
    assert asked_id is None
    assert ready


def test_a_description_reopened_as_never_asked_is_served_after_the_title():
    """Both refused: the title is on screen and the description is owed from scratch."""
    state = JobPostingChatState(
        turn_count=12,
        answered_topics=[*_ASKED_TO_REQUIREMENTS, "city"],
        asked_question_ids=[*_ASKED_TO_REQUIREMENTS, "role_title"],
        ask_counts=_one_each(_ASKED_TO_REQUIREMENTS),
        unanswered_essentials=["role_title"],
    )
    _, asked_id, after, ready = interview_engine.next_turn(state, "CNC Operator")
    assert after.collected["role_title"] == "CNC Operator"
    assert asked_id == "description"
    assert not ready

    _, asked_id, done, ready = interview_engine.next_turn(after, _EARLIER)
    assert done.collected["description"] == _EARLIER
    assert ready


def _kept_description_on_screen() -> JobPostingChatState:
    """A refused overwrite after the wrap-up: the earlier description is back, still answered."""
    return JobPostingChatState(
        turn_count=13,
        answered_topics=["role_title", *_ASKED_TO_REQUIREMENTS, "city", "description"],
        asked_question_ids=[*_ASKED_TO_REQUIREMENTS, "description"],
        ask_counts=_one_each([*_ASKED_TO_REQUIREMENTS, "description"]),
        collected={"role_title": "CNC Operator", "description": _EARLIER},
    )


def test_the_keep_word_keeps_a_kept_description_and_the_interview_wraps_up():
    _, asked_id, after, ready = interview_engine.next_turn(
        _kept_description_on_screen(), _keep_word()
    )
    assert after.collected["description"] == _EARLIER
    assert asked_id is None
    assert ready


def test_a_new_answer_replaces_a_kept_description():
    _, _, after, _ = interview_engine.next_turn(
        _kept_description_on_screen(), "Operating Fanuc lathes"
    )
    assert after.collected["description"] == "Operating Fanuc lathes"


def test_the_keep_word_keeps_a_kept_title_and_the_interview_moves_on():
    """The title is a value-required topic: the keep word records nothing and closes nothing,
    and the title is already answered, so the engine serves its next question."""
    state = JobPostingChatState(
        turn_count=3,
        answered_topics=["role_title", "location_label", "city"],
        asked_question_ids=["location_label", "role_title"],
        ask_counts={"location_label": 1},
        collected={"role_title": "CNC Operator", "location_label": "Pune, Chakan", "city": "Pune"},
    )
    _, asked_id, after, _ = interview_engine.next_turn(state, _keep_word())
    assert after.collected["role_title"] == "CNC Operator"
    assert asked_id == "vacancy"
