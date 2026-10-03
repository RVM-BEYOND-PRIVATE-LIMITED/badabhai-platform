"""#1911 / #1921: the API re-asks a refused field by EDITING this engine's state.

`apps/api/src/payer-portal/job-posting-chat/job-posting-chat.screen.ts` runs the shared
worker-visible text screen on every turn's draft. When it refuses `role_title` or `description`
it rewrites the returned `JobPostingChatState` so that THIS engine asks the topic again: the
answer leaves `collected`, the topic leaves `answered_topics`, and the topic is moved to the end
of `asked_question_ids`. When it refuses a `benefits` / `requirements` chip (#1921) it removes
only that chip from the stored list, keeps the clean ones (the topic stays answered while any
are left), and puts the topic back on screen the same way. That is only correct while the engine
keeps behaving the way the TypeScript assumes:

- the next message is attributed to `asked_question_ids[-1]`, whatever its ask count;
- `role_title` is the first essential, and none of the four is essential but it (the TS mirrors
  this in `FIELD_POLICY`); the bank's topic order is `BANK_TOPIC_ORDER`, which orders
  `missing_fields`;
- a refused field reopened as NEVER asked is served again before the interview wraps up;
- "no", the word the re-ask tells the payer to send to keep an earlier value or a list, records
  nothing, and so do the words a payer answers the hint with instead ("no, keep it", "no more",
  "that's it", "bas" — #1938), while a real answer that only starts like one is still recorded;
- a list answer is ADDED to the stored list, and the draft's chips are the stored items as they
  are, so a chip removed from `collected` cannot come back;
- a tap on a list's bank option is recorded as the option's "+"-separated parts, and a part the
  list already holds (trimmed, case-insensitively) is skipped, so the TS leaves an option out of
  the re-ask's chips once all its parts are held;
- none of the four is read in passing, so one turn can newly refuse only the field on screen;
- the wrap-up appends nothing to `asked_question_ids`, and the description is the bank's last
  topic and must-ask. So after a list re-asked at the wrap-up is answered, the TS moves the
  description back to the end, and the next message revises it instead of becoming a chip.

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
from app.pseudonymize import pseudonymize

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


def _ts_string_tuple(name: str) -> list[str]:
    """An ``export const NAME = [...] as const`` tuple of string literals, read from source."""
    tuples = dict(re.findall(r"export const (\w+) = \[(.*?)\] as const", _screen_ts(), re.S))
    assert name in tuples, f"{name} not found in job-posting-chat.screen.ts — it has moved"
    return re.findall(r'"(\w+)"', tuples[name])


def _screened_fields() -> list[str]:
    return _ts_string_tuple("SCREENED_DRAFT_FIELDS")


def _list_fields() -> list[str]:
    return _ts_string_tuple("SCREENED_LIST_FIELDS")


def _field_policy() -> dict[str, dict[str, str | list[str]]]:
    """`FIELD_POLICY` read from source: ``{field: {"label": ..., "question": ..., ...}}``.

    Values come back as their source text: a quoted string unquoted, ``true``/``false`` bare,
    and a one-line array of string literals as a list of them.
    """
    match = re.search(r"export const FIELD_POLICY: [^=]*= \{\n(.*?)\n\};", _screen_ts(), re.S)
    assert match, "FIELD_POLICY not found in job-posting-chat.screen.ts — it has moved"
    body = re.sub(r"^\s*//[^\n]*\n", "", match.group(1), flags=re.M)
    policy: dict[str, dict[str, str | list[str]]] = {}
    for field, entry in re.findall(r"^  (\w+): \{\n(.*?)\n  \},?$", body, re.S | re.M):
        pairs = re.findall(r'^\s+(\w+): (?:"([^"\n]*)"|(\w+)|(\[[^\]\n]*\])),$', entry, re.M)
        policy[field] = {
            key: re.findall(r'"([^"]*)"', array) if array else quoted or bare
            for key, quoted, bare, array in pairs
        }
    return policy


def _hint_word(constant: str) -> str:
    """The word a hint constant (`KEEP_HINT`, `ADD_HINT`) tells the payer to send."""
    hints = dict(re.findall(r"const (\w+_HINT) = '[^'\n]*\"(\w+)\"[^'\n]*';", _screen_ts()))
    assert constant in hints, f"{constant} not found in job-posting-chat.screen.ts — it has moved"
    return hints[constant]


def _keep_word() -> str:
    """The word `KEEP_HINT` tells the payer to send to keep an earlier value."""
    return _hint_word("KEEP_HINT")


def _add_word() -> str:
    """The word `ADD_HINT` tells the payer to send when a re-asked list has nothing to add."""
    return _hint_word("ADD_HINT")


def _ts_string_const(name: str) -> str:
    """A ``const NAME = "..."`` string literal (exported or not), read from source."""
    consts = dict(re.findall(r'^(?:export )?const (\w+) = "([^"\n]*)"', _screen_ts(), re.M))
    assert name in consts, f"{name} not found in job-posting-chat.screen.ts — it has moved"
    return consts[name]


# --- The facts FIELD_POLICY mirrors -------------------------------------------

_SCREENED = ["role_title", "benefits", "requirements", "description"]
_LISTS = ["benefits", "requirements"]


def test_the_ts_source_parses_to_the_real_policy_not_an_empty_one():
    assert _screened_fields() == _SCREENED
    assert _list_fields() == _LISTS
    policy = _field_policy()
    assert sorted(policy) == sorted(_SCREENED)
    for field, entry in policy.items():
        keys = {"label", "question", "essential", "chips"}
        assert set(entry) == (keys | {"addQuestion"} if field in _LISTS else keys)
    assert policy["benefits"]["chips"] == ["PF + ESI", "Canteen", "Transport", "Accommodation"]
    assert policy["role_title"]["chips"] == []


@pytest.mark.parametrize("field", _SCREENED)
def test_each_screened_field_is_a_bank_topic_and_a_draft_field(field: str):
    assert field in _screened_fields()
    assert question_bank.topic_by_id(field) is not None
    assert field in JobPostingDraft.model_fields


@pytest.mark.parametrize("field", _LISTS)
def test_each_list_field_is_a_list_on_the_draft_and_a_must_ask_topic(field: str):
    """A list emptied while another field is on screen is reopened as never asked: the
    must-ask gate then owes it, so the engine serves it before the wrap-up."""
    assert field in _list_fields()
    assert JobPostingDraft().model_dump()[field] == []
    assert field in interview_engine.MUST_ASK_TOPICS


def test_screened_fields_are_in_bank_order():
    bank = [t.id for t in question_bank.topics_for()]
    screened = _screened_fields()
    assert [t for t in bank if t in screened] == screened


def test_bank_topic_order_is_the_bank():
    """`missing_fields` is in bank order; the TS lists an emptied field at its place in it."""
    assert _ts_string_tuple("BANK_TOPIC_ORDER") == list(question_bank.topic_ids())


@pytest.mark.parametrize("field", _SCREENED)
def test_field_policy_essential_and_chips_match_the_engine(field: str):
    entry = _field_policy()[field]
    assert entry["essential"] == ("true" if field in interview_engine.ESSENTIAL_TOPICS else "false")
    assert entry["chips"] == question_bank.options_for(field)


@pytest.mark.parametrize("field", _SCREENED)
def test_no_screened_field_is_read_in_passing(field: str):
    """Only the topic on screen takes free text, so one turn newly refuses at most one field."""
    assert field not in answers._CROSS_TOPIC


def test_the_benefits_re_ask_is_the_bank_question_verbatim_and_the_lists_have_no_retry():
    benefits = question_bank.topic_by_id("benefits")
    requirements = question_bank.topic_by_id("requirements")
    assert benefits is not None and requirements is not None
    assert _field_policy()["benefits"]["question"] == benefits.question
    assert benefits.retry_question is None and requirements.retry_question is None


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
    assert answers.is_refusal(word)


def test_the_add_word_is_the_same_refusal():
    assert _add_word() == _keep_word()


def test_the_add_chip_is_the_add_word_and_a_refusal():
    """The add-question serves `ADD_CHIP` as a tap; tapping it must record nothing."""
    chip = _ts_string_const("ADD_CHIP")
    assert chip.lower() == _add_word()
    assert answers.is_refusal(chip)


@pytest.mark.parametrize("field", _LISTS)
def test_a_list_option_is_recorded_as_its_plus_separated_parts(field: str):
    """The TS judges an option held when every "+"-separated part of it is held."""
    for option in question_bank.options_for(field):
        assert answers._split_phrases(option) == [part.strip() for part in option.split("+")]


def test_the_wrap_up_topic_is_the_bank_last_must_ask_topic():
    topic = _ts_string_const("WRAP_UP_TOPIC")
    assert topic == question_bank.topic_ids()[-1] == "description"
    assert topic in interview_engine.MUST_ASK_TOPICS


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


# --- #1938: the hints answered in the payer's own words -----------------------
# `KEEP_HINT` and `ADD_HINT` ask for "no", but a payer answers a hint in their own words. Each
# reply below used to be RECORDED: it replaced the kept description, became the title, or was
# added to the list as a chip, because the engine's refusal was a short list of single words.


def _route_turn(state: JobPostingChatState, message: str):
    """`next_turn` with the inputs the route gives it: the raw message, and the draft text the
    gateway leaves — the MASKED text when it masked identity. It masks the "Nope" of "Nope, keep
    it" as a leading name (measured), so the refusal must be read from the payer's own words."""
    result = pseudonymize(message)
    draft_text = answers.safe_draft_text(message, result.text, result.placeholder_tokens)
    return interview_engine.next_turn(state, message, draft_text=draft_text)


_KEEP_REPLIES = [
    "no, keep it",
    "No keep it",
    "keep it",
    "Keep the earlier one",
    "keep the old one",
    "Keep it as is",
    "no change",
    "nope, keep it",
    "Nope, keep it",  # masked by the gateway: "[PERSON_1], keep it"
    "No, that's it",
    '"no"',  # the hint's word, quotes and all
]


@pytest.mark.parametrize("reply", _KEEP_REPLIES)
def test_the_keep_hint_answered_in_words_keeps_a_kept_description(reply: str):
    _, asked_id, after, ready = _route_turn(_kept_description_on_screen(), reply)
    assert after.collected["description"] == _EARLIER
    assert asked_id is None
    assert ready


@pytest.mark.parametrize("reply", _KEEP_REPLIES)
def test_the_keep_hint_answered_in_words_keeps_a_kept_title(reply: str):
    """Before #1938, "no, keep it" BECAME the job title: the title takes a bare answer."""
    state = JobPostingChatState(
        turn_count=3,
        answered_topics=["role_title", "location_label", "city"],
        asked_question_ids=["location_label", "role_title"],
        ask_counts={"location_label": 1},
        collected={"role_title": "CNC Operator", "location_label": "Pune, Chakan", "city": "Pune"},
    )
    _, asked_id, after, _ = _route_turn(state, reply)
    assert after.collected["role_title"] == "CNC Operator"
    assert asked_id == "vacancy"


@pytest.mark.parametrize(
    "reply", ["Keep records of the daily output", "Keeping the line running on nights"]
)
def test_a_real_description_that_starts_like_keep_still_replaces_a_kept_one(reply: str):
    _, _, after, _ = _route_turn(_kept_description_on_screen(), reply)
    assert after.collected["description"] == reply


# --- #1921: a re-asked chip list ----------------------------------------------
# The shapes the TS screen suite expects `reaskRefusedFields` to produce for a benefits answer
# that carried a refused chip: every topic before benefits answered, the requirements question
# the engine picked un-served, and benefits back on screen.

_ASKED_TO_BENEFITS = _ASKED_TO_REQUIREMENTS[:-1]
_ANSWERED_TO_NEEDED_BY = [
    "role_title",
    "location_label",
    "city",
    "vacancy",
    "skills",
    "pay_range",
    "pay_type",
    "experience",
    "shift",
    "needed_by",
]
# The #1921 report: "Canteen, details www.acme.in" records this as a chip.
_REFUSED_CHIP = "details www.acme.in"


def _benefits_on_screen(kept: list[str]) -> JobPostingChatState:
    """Benefits re-asked. With chips `kept` it stays answered; with none it is reopened."""
    return JobPostingChatState(
        turn_count=10,
        answered_topics=[*_ANSWERED_TO_NEEDED_BY, *(["benefits"] if kept else [])],
        asked_question_ids=_ASKED_TO_BENEFITS,
        ask_counts=_one_each(_ASKED_TO_BENEFITS),
        collected={"role_title": "CNC Operator", **({"benefits": kept} if kept else {})},
    )


def test_the_report_answer_records_the_refused_text_as_a_chip_of_its_own():
    """Why the API screens per chip: the refused text is one item, the clean ones are others."""
    assert answers._split_phrases(f"PF, ESI, {_REFUSED_CHIP}") == ["PF", "ESI", _REFUSED_CHIP]


def test_the_draft_chips_are_the_stored_items_as_they_are():
    """The TS screens the stored list to screen the draft, and removes a chip from it so the
    rebuild cannot bring it back. Both hold while the draft's chips are the stored items."""
    stored = answers._split_phrases("PF + ESI, canteen; free bus / [Kalyani] hostel")
    state = JobPostingChatState(collected={"benefits": stored, "requirements": stored})
    draft = interview_engine.build_draft(state)
    assert draft.benefits == stored
    assert draft.requirements == stored


@pytest.mark.parametrize("keep", ["no", "none"])
def test_the_add_word_keeps_a_re_asked_list_and_the_unserved_pick_comes_next(keep: str):
    _, asked_id, after, ready = interview_engine.next_turn(_benefits_on_screen(["PF", "ESI"]), keep)
    assert after.collected["benefits"] == ["PF", "ESI"]
    assert "benefits" in after.answered_topics
    assert asked_id == "requirements"
    assert not ready
    assert _REFUSED_CHIP not in interview_engine.build_draft(after).benefits


def test_a_new_answer_is_added_to_a_re_asked_list_and_the_dropped_chip_stays_gone():
    _, asked_id, after, _ = interview_engine.next_turn(
        _benefits_on_screen(["PF", "ESI"]), "Free bus"
    )
    assert after.collected["benefits"] == ["PF", "ESI", "Free bus"]
    assert interview_engine.build_draft(after).benefits == ["PF", "ESI", "Free bus"]
    assert asked_id == "requirements"


def test_the_add_chip_keeps_a_re_asked_list():
    _, asked_id, after, _ = interview_engine.next_turn(
        _benefits_on_screen(["PF", "ESI"]), _ts_string_const("ADD_CHIP")
    )
    assert after.collected["benefits"] == ["PF", "ESI"]
    assert asked_id == "requirements"


# #1938: the add-question answered in words. Each was added to the list as a chip.
_NONE_MORE_REPLIES = [
    "no more",
    "Nothing more",
    "no other",
    "that's it",
    "That’s all.",
    "bas",
    "Bas itna hi",
    "no, nothing else",
    "nope, that's all",
    "Nope, that's all",  # masked by the gateway: "[PERSON_1], that's all"
    "nahi, bas",
    "aur kuch nahi",
]


@pytest.mark.parametrize("reply", _NONE_MORE_REPLIES)
def test_the_add_hint_answered_in_words_keeps_a_re_asked_list(reply: str):
    _, asked_id, after, ready = _route_turn(_benefits_on_screen(["PF", "ESI"]), reply)
    assert after.collected["benefits"] == ["PF", "ESI"]
    assert "benefits" in after.answered_topics
    assert asked_id == "requirements"
    assert not ready
    assert interview_engine.build_draft(after).benefits == ["PF", "ESI"]


@pytest.mark.parametrize(
    "reply",
    [
        "Bus",  # transport, not "bas"
        "basic medical insurance",
        "bas PF",  # "just PF": an answer, kept whole as typed
        "no other benefits than PF",
        "no more than 2 night shifts a week",
    ],
)
def test_a_real_answer_that_starts_like_a_refusal_is_still_added_to_a_re_asked_list(reply: str):
    _, _, after, _ = _route_turn(_benefits_on_screen(["PF", "ESI"]), reply)
    assert after.collected["benefits"] == ["PF", "ESI", reply]


def test_a_tapped_option_whose_parts_are_all_held_adds_nothing():
    """Why the TS leaves such an option out of the add-question's chips."""
    held = ["pf", "esi", "canteen"]
    for option in ("PF + ESI", "Canteen"):
        _, _, after, _ = interview_engine.next_turn(_benefits_on_screen(held), option)
        assert after.collected["benefits"] == held
    _, _, after, _ = interview_engine.next_turn(_benefits_on_screen(held), "Transport")
    assert after.collected["benefits"] == [*held, "Transport"]


@pytest.mark.parametrize(
    ("message", "recorded"),
    [
        ("Canteen, transport", ["Canteen", "transport"]),
        ("no", None),
        ("no more", None),  # #1938
        ("that's it", None),  # #1938
    ],
)
def test_an_emptied_list_on_screen_takes_the_next_message(message: str, recorded: list[str] | None):
    _, asked_id, after, _ = interview_engine.next_turn(_benefits_on_screen([]), message)
    assert after.collected.get("benefits") == recorded
    assert "benefits" in after.answered_topics
    assert asked_id == "requirements"


def test_an_emptied_list_reopened_as_never_asked_is_served_after_the_title():
    """A refused title on screen; every benefits chip refused too, so benefits is owed again."""
    asked = [t for t in _ASKED_TO_BENEFITS if t != "benefits"]
    state = JobPostingChatState(
        turn_count=10,
        answered_topics=[t for t in _ANSWERED_TO_NEEDED_BY if t != "role_title"],
        asked_question_ids=[*asked, "role_title"],
        ask_counts=_one_each(asked),
        unanswered_essentials=["role_title"],
    )
    _, asked_id, after, ready = interview_engine.next_turn(state, "CNC Operator")
    assert after.collected["role_title"] == "CNC Operator"
    assert asked_id == "benefits"
    assert not ready

    _, asked_id, after, _ = interview_engine.next_turn(after, "Canteen")
    assert after.collected["benefits"] == ["Canteen"]
    assert asked_id == "requirements"


def _benefits_re_asked_after_the_wrap_up(kept: list[str]) -> JobPostingChatState:
    """The wrap-up turn's re-ask: benefits on screen, the earlier description kept. With chips
    `kept` the list stays answered; with none it was emptied."""
    asked = [t for t in _ASKED_TO_REQUIREMENTS if t != "benefits"]
    return JobPostingChatState(
        turn_count=13,
        answered_topics=[
            "role_title",
            *asked,
            "city",
            "description",
            *(["benefits"] if kept else []),
        ],
        asked_question_ids=[*asked, "description", "benefits"],
        ask_counts=_one_each([*_ASKED_TO_REQUIREMENTS, "description"]),
        collected={
            "role_title": "CNC Operator",
            "description": _EARLIER,
            **({"benefits": kept} if kept else {}),
        },
    )


def test_an_emptied_list_re_asked_after_the_wrap_up_takes_the_answer_and_wraps_up_again():
    state = _benefits_re_asked_after_the_wrap_up([])
    _, asked_id, after, ready = interview_engine.next_turn(state, "Canteen")
    assert after.collected["benefits"] == ["Canteen"]
    assert after.collected["description"] == _EARLIER
    assert asked_id is None
    assert ready


@pytest.mark.parametrize(
    ("kept", "answer", "recorded"),
    [([], "Canteen", ["Canteen"]), (["PF", "ESI"], "no", ["PF", "ESI"])],
)
def test_after_that_wrap_up_the_description_put_back_last_takes_the_next_message(
    kept: list[str], answer: str, recorded: list[str]
):
    """`restoreWrapUpTarget`: the wrap-up appends nothing, so the list is still last. Left
    there, the next message would be added to it as a chip. Moved behind the description, it
    revises the description, as every message after a wrap-up does."""
    state = _benefits_re_asked_after_the_wrap_up(kept)
    _, asked_id, wrapped, ready = interview_engine.next_turn(state, answer)
    assert asked_id is None and ready
    assert wrapped.asked_question_ids == state.asked_question_ids

    message = "Machining and deburring on the night line"
    _, _, left, _ = interview_engine.next_turn(wrapped, message)
    assert left.collected["benefits"] != recorded
    assert left.collected["description"] == _EARLIER

    topic = _ts_string_const("WRAP_UP_TOPIC")
    restored = wrapped.model_copy(deep=True)
    restored.asked_question_ids = [t for t in wrapped.asked_question_ids if t != topic] + [topic]
    _, asked_id, after, ready = interview_engine.next_turn(restored, message)
    assert after.collected["benefits"] == recorded
    assert after.collected["description"] == message
    assert asked_id is None
    assert ready
