"""Companion v2 routes and parsers (ADR-0046 Phase 1).

THE CONTRACT UNDER TEST, in order of importance:

1. The privacy order holds: pseudonymize FIRST, and a blocked input reaches no provider.
2. Every model input is masked — the message, the memory turns AND the current values.
3. Model output is untrusted: garbage, a fence, a bad enum or a bad confidence all become
   the fail-closed value, and a model cannot assert `blocked`.
4. The deterministic mock is valid and fail-closed.
5. The edit parser drops bad rows individually and caps at `max_rows`.

The router is monkeypatched, like every other endpoint suite here: the real route table is
registered by A3, and these tests are about this service's own boundary, not the transport.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.routers.companion as companion_router
from app.companion import classify as classify_logic
from app.companion import edit_parse as edit_parse_logic
from app.companion.prompts import CLASSIFY_SYSTEM_PROMPT, EDIT_PARSE_SYSTEM_PROMPT
from app.contracts import CompanionEditSnapshotRow
from app.main import app

client = TestClient(app)

#: `reference number 12345678` leaves a residual 8-digit run the gateway cannot place,
#: which is the fail-closed case (`pseudonymize` blocks). A clean 10-digit phone is
#: MASKED, not blocked — see the mask tests below.
BLOCKING_TEXT = "reference number 12345678"


def _fake_run(payload: str, captured: list[dict] | None = None, meta: object = None):
    async def _run(*_args, **kwargs):
        if captured is not None:
            captured.append(kwargs)
        return payload, meta

    return _run


def _boom(*_args, **_kwargs):
    raise AssertionError("the router must not be called on this path")


def _messages_of(captured: list[dict]) -> str:
    assert captured, "the router was never called"
    return "\n".join(m["content"] for m in captured[0]["messages"])


# ---------------------------------------------------------------------------
# /companion/classify
# ---------------------------------------------------------------------------


def test_classify_blocks_before_the_router(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(companion_router.router, "run", _boom)
    resp = client.post("/companion/classify", json={"text": BLOCKING_TEXT})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"intent": "unclear", "confidence": 0.0, "blocked": True, "ai_metadata": None}


def test_classify_masks_the_message_before_the_model(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"intent": "edit_resume", "confidence": 0.9}', captured),
    )
    resp = client.post("/companion/classify", json={"text": "Tata Motors mein welder tha"})
    assert resp.status_code == 200
    seen = _messages_of(captured)
    assert "[EMPLOYER_1]" in seen
    assert "Tata Motors" not in seen


def test_classify_parses_the_model_output_and_ignores_a_model_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"intent": "edit_resume", "confidence": 0.9, "blocked": true}'),
    )
    body = client.post("/companion/classify", json={"text": "welding add karo"}).json()
    assert body["intent"] == "edit_resume"
    assert body["confidence"] == 0.9
    # `blocked` is the pseudonymizer's fact; the model cannot assert a safety event.
    assert body["blocked"] is False


@pytest.mark.parametrize(
    "payload",
    [
        "I could not classify that.",  # prose, no object
        "[]",  # not an object
        '{"intent": "smalltalk", "confidence": 0.9}',  # intent outside the closed set
        '{"intent": "unclear", "confidence": 1.5}',  # confidence outside 0..1
        '{"intent": "unclear"}',  # missing confidence
    ],
)
def test_classify_fails_closed_on_untrusted_output(
    monkeypatch: pytest.MonkeyPatch, payload: str
) -> None:
    monkeypatch.setattr(companion_router.router, "run", _fake_run(payload))
    body = client.post("/companion/classify", json={"text": "kuch bhi"}).json()
    assert body == {"intent": "unclear", "confidence": 0.0, "blocked": False, "ai_metadata": None}


def test_classify_tolerates_a_markdown_fence(monkeypatch: pytest.MonkeyPatch) -> None:
    fenced = '```json\n{"intent": "jobs_talk", "confidence": 0.8}\n```'
    monkeypatch.setattr(companion_router.router, "run", _fake_run(fenced))
    body = client.post("/companion/classify", json={"text": "naye jobs?"}).json()
    assert body["intent"] == "jobs_talk"


def test_classify_masks_memory_turns_and_drops_a_blocked_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"intent": "unclear", "confidence": 0.0}', captured),
    )
    body = {
        "text": "aur yeh bhi",
        "recent_turns": [
            {"role": "worker", "text": "Tata Motors mein welder tha"},
            {"role": "worker", "text": BLOCKING_TEXT},
        ],
    }
    assert client.post("/companion/classify", json=body).status_code == 200
    seen = _messages_of(captured)
    assert "[EMPLOYER_1]" in seen
    assert "Tata Motors" not in seen
    # The blocked turn was DROPPED, not sent unmasked.
    assert "12345678" not in seen
    # Memory rides as a conversation: worker -> user; the blocked turn is gone.
    roles = [m["role"] for m in captured[0]["messages"]]
    assert roles == ["system", "user", "user"]


# ---------------------------------------------------------------------------
# /companion/edit-parse
# ---------------------------------------------------------------------------


def test_edit_parse_blocks_before_the_router(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(companion_router.router, "run", _boom)
    resp = client.post("/companion/edit-parse", json={"text": BLOCKING_TEXT, "max_rows": 3})
    assert resp.status_code == 200
    assert resp.json() == {"rows": [], "unsupported": [], "ai_metadata": None}


def test_edit_parse_masks_snapshot_values(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router, "run", _fake_run(edit_parse_logic.MOCK_RESPONSE, captured)
    )
    body = {
        "text": "Tata ki jagah Mahindra likho",
        "catalogue": [{"section": "employment", "field": "employer_name", "ops": ["edit"]}],
        "snapshot": [
            {"ref": "e1", "section": "employment", "fields": {"employer_name": "Tata Motors"}},
        ],
        "max_rows": 3,
    }
    assert client.post("/companion/edit-parse", json=body).status_code == 200
    seen = _messages_of(captured)
    assert "[EMPLOYER_1]" in seen
    assert "Tata Motors" not in seen
    # The catalogue and the cap ride the same message, so the model can only name offered fields.
    assert "employer_name" in seen
    assert '"max_rows":3' in seen


def test_edit_parse_masks_message_and_snapshot_with_one_token_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The model must tell employers apart. Masked one value at a time with a fresh numbering,
    all three employers below came out `[EMPLOYER_1]` and the message's `[EMPLOYER_1]` matched
    every row (audit probe, 2026-09-30). One scope per request: the message's token is e2's
    alone, and three employers carry three tokens."""
    captured: list[dict] = []
    monkeypatch.setattr(
        companion_router.router, "run", _fake_run(edit_parse_logic.MOCK_RESPONSE, captured)
    )
    body = {
        "text": "Bajaj Auto Ltd ko hatao",
        "catalogue": [{"section": "employment", "field": "employer_name", "ops": ["delete"]}],
        "snapshot": [
            {"ref": "e1", "section": "employment", "fields": {"employer_name": "Tata Motors Ltd"}},
            {"ref": "e2", "section": "employment", "fields": {"employer_name": "Bajaj Auto Ltd"}},
            {"ref": "e3", "section": "employment", "fields": {"employer_name": "Tata Motors"}},
        ],
        "max_rows": 3,
    }
    assert client.post("/companion/edit-parse", json=body).status_code == 200
    user = captured[0]["messages"][1]["content"]
    context = json.loads(user.split("\n", 1)[1].split("\n\nWORKER MESSAGE", 1)[0])
    message = user.rsplit("\n", 1)[1]

    tokens = {row["ref"]: row["fields"]["employer_name"] for row in context["current_values"]}
    assert len(set(tokens.values())) == 3, tokens
    assert message == f"{tokens['e2']} ko hatao"
    assert [ref for ref, token in tokens.items() if token in message] == ["e2"]
    # Still masked: no employer name reaches the model.
    for name in ("Tata Motors", "Bajaj Auto"):
        assert name not in user


def test_mask_snapshot_alone_still_numbers_values_apart() -> None:
    rows = [
        CompanionEditSnapshotRow(ref=ref, section="employment", fields={"employer_name": name})
        for ref, name in (("e1", "Tata Motors"), ("e2", "Bajaj Auto"))
    ]
    masked = edit_parse_logic.mask_snapshot(rows, raw=False)
    assert [row.fields["employer_name"] for row in masked] == ["[EMPLOYER_1]", "[EMPLOYER_2]"]


def test_edit_parse_drops_bad_rows_individually(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = json.dumps(
        {
            "rows": [
                {"op": "add", "section": "skills", "field": "skill", "value": "welding"},
                {"op": "rename", "section": "skills", "field": "skill", "value": "x"},  # bad op
                {"op": "add", "section": "identity", "field": "name", "value": "Ramesh"},  # O3
                {"op": "delete", "section": "languages", "ref": "l1", "field": "language"},
            ],
            "unsupported": ["identity", "identity", "phone", "contact"],
        }
    )
    monkeypatch.setattr(companion_router.router, "run", _fake_run(payload))
    body = client.post(
        "/companion/edit-parse", json={"text": "welding add karo", "max_rows": 3}
    ).json()
    # One bad row does not cost the card's other changes; the section enum is the wall here.
    assert [row["section"] for row in body["rows"]] == ["skills", "languages"]
    # Unknown unsupported values are filtered, duplicates collapsed.
    assert body["unsupported"] == ["identity", "contact"]


@pytest.mark.parametrize("op", ["add", "edit", "delete"])
def test_edit_parse_drops_a_row_without_a_field(op: str) -> None:
    """EVERY row names its field. The API resolves a row through its `(section, field)`
    catalogue entry before any op check (`companion-edit.service.ts` validateRow), so a
    field-less delete — "Hindi hata do" as `{op: delete, ref: l1}` — would be dropped there
    unseen. Dropping it here keeps the service's output equal to what the API can use."""
    row = {"op": op, "section": "languages", "ref": None if op == "add" else "l1"}
    if op != "delete":
        row["value"] = "punjabi"
    kept = {"op": "add", "section": "skills", "field": "skill", "value": "welding"}
    parsed = edit_parse_logic.parse_edit_rows(json.dumps({"rows": [row, kept]}), max_rows=3)
    assert [(r.section, r.field) for r in parsed.rows] == [("skills", "skill")]


def test_a_field_less_row_does_not_spend_a_slot_of_the_cap() -> None:
    rows = [
        {"op": "delete", "section": "languages", "ref": "l1"},  # no field: dropped
        {"op": "delete", "section": "languages", "ref": "l1", "field": "language"},
    ]
    parsed = edit_parse_logic.parse_edit_rows(json.dumps({"rows": rows}), max_rows=1)
    assert [(r.op, r.ref, r.field) for r in parsed.rows] == [("delete", "l1", "language")]


def test_edit_parse_caps_rows_at_max_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [
        {"op": "add", "section": "skills", "field": "skill", "value": f"skill {i}"}
        for i in range(3)
    ]
    monkeypatch.setattr(companion_router.router, "run", _fake_run(json.dumps({"rows": rows})))
    body = client.post("/companion/edit-parse", json={"text": "teen skill", "max_rows": 1}).json()
    assert len(body["rows"]) == 1
    assert body["rows"][0]["value"] == "skill 0"


def test_edit_parse_fails_closed_on_untrusted_output(monkeypatch: pytest.MonkeyPatch) -> None:
    for payload in ["not json", "[]", '{"rows": "nope", "unsupported": "nope"}']:
        monkeypatch.setattr(companion_router.router, "run", _fake_run(payload))
        body = client.post("/companion/edit-parse", json={"text": "kuch", "max_rows": 3}).json()
        assert body == {"rows": [], "unsupported": [], "ai_metadata": None}


def test_the_cost_metadata_rides_back_for_the_api_to_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ADR-0046 O12: the API records companion spend against `ai.cost_recorded`.

    `router.run` builds this metadata and it used to be DISCARDED here (`_meta`), the exact
    #745/#738 shape that left `resume_generation` and `job_posting_chat_turn` unledgered — so
    the dashboard's task-type buckets could never show companion spend. It now rides back on
    the response; the API's recorder no-ops when it is null (the blocked path).
    """
    from app.contracts import AICallMetadata

    meta = AICallMetadata(
        ai_call_id="call-1",
        task_type="companion_classify",
        model_name="gemini-flash",
        provider="google",
        real_call=False,
        created_at="2026-09-29T09:00:00+00:00",
    )
    monkeypatch.setattr(
        companion_router.router,
        "run",
        _fake_run('{"intent": "edit_resume", "confidence": 0.9}', meta=meta),
    )
    body = client.post("/companion/classify", json={"text": "welding add karo"}).json()
    assert body["ai_metadata"]["ai_call_id"] == "call-1"
    assert body["ai_metadata"]["task_type"] == "companion_classify"
    assert body["ai_metadata"]["real_call"] is False


# ---------------------------------------------------------------------------
# Deterministic mock + prompts
# ---------------------------------------------------------------------------


def test_the_mock_responses_are_valid_and_fail_closed() -> None:
    mock = classify_logic.parse_classify_output(classify_logic.MOCK_RESPONSE)
    assert mock.intent == "unclear"
    assert mock.confidence == 0.0
    assert mock.blocked is False
    parsed = edit_parse_logic.parse_edit_rows(edit_parse_logic.MOCK_RESPONSE, max_rows=3)
    assert parsed.rows == []
    assert parsed.unsupported == []


def test_the_prompts_state_the_closed_sets_and_the_refusal_rule() -> None:
    # The classifier's six intents are restated for the model; the enum is enforced on the way back.
    for intent in ("edit_resume", "career_talk", "jobs_talk", "new_resume", "faltu", "unclear"):
        assert intent in CLASSIFY_SYSTEM_PROMPT
    assert "JSON only" in CLASSIFY_SYSTEM_PROMPT
    # The edit parser may only name catalogue fields, never write, and steers identity away.
    assert "CATALOGUE" in EDIT_PARSE_SYSTEM_PROMPT
    assert "Never invent a ref" in EDIT_PARSE_SYSTEM_PROMPT
    assert "identity" in EDIT_PARSE_SYSTEM_PROMPT
    assert "contact" in EDIT_PARSE_SYSTEM_PROMPT
    assert "You never write anything" in EDIT_PARSE_SYSTEM_PROMPT


def test_the_edit_prompt_requires_a_field_on_every_op() -> None:
    """The prompt used to say "'delete' needs a ref" and schema-hint `"field": null`, so a model
    that obeyed it literally emitted field-less deletes the API then dropped silently."""
    assert '"field": null' not in EDIT_PARSE_SYSTEM_PROMPT
    assert '"field": "<field>"' in EDIT_PARSE_SYSTEM_PROMPT
    assert 'EVERY row names a "field": add, edit AND delete' in EDIT_PARSE_SYSTEM_PROMPT
    assert '"delete" needs a ref and a field' in EDIT_PARSE_SYSTEM_PROMPT


def _edit_prompt_rule(opening: str) -> str:
    """One bullet of the edit prompt's rules, whitespace-folded so a rewrap cannot move a pin."""
    rules = " ".join(EDIT_PARSE_SYSTEM_PROMPT.split()).split(" - ")
    matches = [rule for rule in rules if rule.startswith(opening)]
    assert len(matches) == 1, f"no single rule opens with {opening!r}"
    return matches[0]


def test_the_delete_anchors_the_prompt_names_are_catalogue_fields_that_allow_delete() -> None:
    """The prompt names three anchor fields for multi-field rows, plus a trade's `role_id`. A
    catalogue rename on the API side would leave the prompt pointing at a field that no longer
    exists; the gold catalogue is pinned to `edit-catalogue.ts` by
    `test_the_gold_catalogue_matches_the_api_catalogue`, so this closes the loop from the prompt to
    the API."""
    from app.companion import eval_edit_parse_gold as edit_gold

    ops = {(section, field): allowed for section, field, allowed in edit_gold.CATALOGUE}
    anchors = {
        ("occupations", "role_id"),
        ("qualifications", "certificate_name"),
        ("qualifications", "education_field"),
        ("qualifications", "training_name"),
    }
    delete_rule = _edit_prompt_rule('For "delete"')
    for section, field in anchors:
        assert f'"{field}"' in delete_rule
        assert "delete" in ops[(section, field)]


def test_the_edit_prompt_never_offers_a_job_delete() -> None:
    """The owner's "Never from chat" ruling (2026-10-01): a whole job is removed only on the
    Profile screen.

    The old delete rule offered "employer_name" as a job's delete anchor, and with the trade shown
    only as a job's `role_label`, "welder hata do" came back as a whole-job delete (3/3 on the
    production primary). Now no employment field offers `delete`, the delete rule names no
    employment field, and the prompt routes a job delete to "other"."""
    from app.companion import eval_edit_parse_gold as edit_gold

    employment = [ops for section, _field, ops in edit_gold.CATALOGUE if section == "employment"]
    assert employment and all(ops == ("edit",) for ops in employment)

    delete_rule = _edit_prompt_rule('For "delete"')
    for section, field, _ops in edit_gold.CATALOGUE:
        if section == "employment":
            assert f'"{field}"' not in delete_rule, f"{field} is offered as a delete anchor"
    assert "for a job" not in delete_rule

    # Trades and jobs are contrasted, and each request lands on its own section.
    assert _edit_prompt_rule('"occupations" are the trades').startswith(
        '"occupations" are the trades the worker does or wants work in: one "role_id" is one trade.'
    )
    trade = _edit_prompt_rule("Removing a trade")
    assert 'is a "delete" of that "occupations" row ONLY' in trade
    assert 'It never touches an "employment" row.' in trade
    job = _edit_prompt_rule("A job can only be edited here, never removed.")
    assert 'propose no row for it and put "other" in "unsupported".' in job


def test_the_routes_are_registered() -> None:
    # Through the OpenAPI schema rather than `app.routes`: this FastAPI version keeps
    # included routers as wrappers, so the flat route table no longer lists their paths.
    paths = set(app.openapi()["paths"])
    assert "/companion/classify" in paths
    assert "/companion/edit-parse" in paths
