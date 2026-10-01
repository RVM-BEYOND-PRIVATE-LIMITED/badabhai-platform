"""The companion evals' deterministic half (ADR-0046 A4).

WHAT RUNS IN CI, AND WHAT DOES NOT. The accuracy gates (>= 90% overall / >= 95% edit_resume
precision; >= 90% exact edit rows) are for the REAL model, so CI asserts the things that make the
staging run meaningful:

  1. THE SETS ARE BIG ENOUGH AND COVER EVERYTHING (>= 150 classifier lines across all six
     intents; >= 60 edit cases across all six sections, all ops, and multi-row messages);
  2. THE SCORER IS CAPABLE OF FAILING — a perfect predictor scores 1.0, a constant one fails, and
     an out-of-catalogue row is caught (the detector's fixture contains what it detects);
  3. CONTAINMENT — every expected edit row names a section/field/op the API catalogue offers, so
     "0 rows outside the catalogue" is a property of the gold set itself;
  4. THE STAGING CLI EXISTS and is the only place the real thresholds gate
     (`python -m app.companion.eval_cli`).
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from app.companion import eval_classify_gold as classify_gold
from app.companion import eval_edit_parse_gold as edit_gold

_REPO = Path(__file__).resolve().parents[4]
_CATALOGUE_TS = (
    _REPO / "apps" / "api" / "src" / "chat-companion" / "v2" / "edit-catalogue.ts"
)

# ── 1. the sets ──────────────────────────────────────────────────────────────────────────────


def test_classifier_set_is_big_enough_and_covers_every_intent():
    assert len(classify_gold.CASES) >= 150
    counts = Counter(intent for _text, intent in classify_gold.CASES)
    for intent in classify_gold.INTENTS:
        assert counts[intent] >= 15, f"{intent}: only {counts[intent]} cases"
    # Every label is one of the closed intents, and the set is not a duplicate pile.
    assert set(counts) == set(classify_gold.INTENTS)
    assert len({text for text, _ in classify_gold.CASES}) == len(classify_gold.CASES)


def test_classifier_set_carries_mixed_scripts_typos_and_voice_shapes():
    texts = [text for text, _ in classify_gold.CASES]
    assert any(any("\u0900" <= ch <= "\u097f" for ch in t) for t in texts), "no Devanagari line"
    assert any(t.isascii() and " " in t for t in texts), "no English line"
    # Typo / voice-transcript shapes: no punctuation, repeated words, romanised run-ons.
    assert any(t in {"resum naya banao", "naya resume bnana hai"} for t in texts)
    assert any(t in {"hello hello hello hello", "kkkkkk"} for t in texts)


def test_edit_set_is_big_enough_and_covers_sections_ops_and_multi_row():
    assert len(edit_gold.CASES) >= 60
    sections = Counter(row[1] for _text, rows in edit_gold.CASES for row in rows)
    for section in edit_gold.SECTIONS:
        assert sections[section] > 0, f"no case edits {section}"
    ops = {row[0] for _text, rows in edit_gold.CASES for row in rows}
    assert ops == {"add", "edit", "delete"}
    multi = [rows for _text, rows in edit_gold.CASES if len(rows) >= 2]
    assert len(multi) >= 3, "no multi-row messages"
    assert any(len(rows) == 3 for rows in multi), "no three-row message"


# ── 2. the scorers can fail ──────────────────────────────────────────────────────────────────


def test_classifier_scorer_passes_a_perfect_predictor_and_fails_a_constant_one():
    by_text = dict(classify_gold.CASES)
    perfect = classify_gold.evaluate(lambda text: by_text[text])
    assert perfect.accuracy == 1.0
    assert perfect.edit_resume_precision == 1.0
    assert perfect.failed == []

    constant = classify_gold.evaluate(lambda _text: "unclear")
    unclear_share = sum(1 for _t, i in classify_gold.CASES if i == "unclear") / len(
        classify_gold.CASES
    )
    assert constant.accuracy == unclear_share < classify_gold.THRESHOLDS["accuracy"]
    assert constant.failed, "a constant predictor must fail the accuracy gate"


def test_edit_scorer_passes_a_perfect_predictor_and_fails_on_an_out_of_catalogue_row():
    by_text = dict(edit_gold.CASES)
    perfect = edit_gold.evaluate(lambda text: by_text[text])
    assert perfect.accuracy == 1.0
    assert perfect.out_of_catalogue == []
    assert perfect.failed == []

    smuggler = edit_gold.evaluate(
        lambda text: [*by_text[text], ("edit", "identity", "e1", "name", "Ramesh")]
    )
    assert smuggler.out_of_catalogue, "an identity row must be caught"
    assert smuggler.failed


# ── 3. containment ───────────────────────────────────────────────────────────────────────────


def test_every_expected_row_is_inside_the_catalogue():
    rows = [row for _text, expected in edit_gold.CASES for row in expected]
    assert edit_gold.rows_outside_catalogue(rows) == []


def test_a_field_less_row_is_reported_as_such():
    # The API drops a row with no field before any op check; the scorer must call it out rather
    # than let it hide inside the generic "not in the catalogue" line.
    bad = edit_gold.rows_outside_catalogue([("delete", "languages", "l1", None, None)])
    assert bad == ["languages: delete row names no field"]


def test_every_gold_delete_names_the_anchor_the_prompt_tells_the_model_to_use():
    """The gold rows and the prompt must agree on WHICH field a delete names, or a model that
    follows the prompt misses the exact-row bar. The rule (prompts.py): the row's only field, or
    the named anchor for a multi-field row."""
    from app.companion import eval_cli
    from app.companion.prompts import EDIT_PARSE_SYSTEM_PROMPT

    snapshot = {row["ref"]: row["fields"] for row in eval_cli._EDIT_SNAPSHOT}
    for text, rows in edit_gold.CASES:
        for op, _section, ref, field, _value in rows:
            assert field is not None, f"{text!r}: every gold row names its field"
            if op != "delete":
                continue
            fields = snapshot[ref]
            if len(fields) == 1:
                assert [field] == list(fields), f"{text!r}: a one-field row deletes by that field"
            else:
                assert f'"{field}"' in EDIT_PARSE_SYSTEM_PROMPT, (
                    f"{text!r}: {field} is not an anchor the prompt names"
                )


def test_no_gold_message_is_quoted_in_the_edit_prompt():
    """A gold line in the prompt turns the eval into a memory test: the model can echo that
    example's rows without applying the rule the example illustrates, and the exact-row bar
    stops measuring the rule. The prompt's examples ("carpenter nikal do", "Bajaj wali naukri
    hata do") are deliberately NOT gold lines. Whitespace-folded and case-insensitive, so a
    rewrap or a capital cannot sneak one in."""
    from app.companion.prompts import EDIT_PARSE_SYSTEM_PROMPT

    prompt = " ".join(EDIT_PARSE_SYSTEM_PROMPT.split()).casefold()
    quoted = [
        text for text, _rows in edit_gold.CASES if " ".join(text.split()).casefold() in prompt
    ]
    assert quoted == []


def test_a_job_delete_is_never_an_expected_row():
    """The owner's "Never from chat" ruling (2026-10-01): the job-delete lines expect NO rows,
    and the trade lines expect the occupations delete — never an employment row."""
    by_text = dict(edit_gold.CASES)
    assert by_text["purana employer hata do"] == []
    assert by_text["Tata wala kaam delete karo"] == []
    trade_delete = [("delete", "occupations", "o1", "role_id", None)]
    assert by_text["welder hata do"] == trade_delete
    assert by_text["mujhe welder ka kaam nahi karna"] == trade_delete
    rows = [row for _text, expected in edit_gold.CASES for row in expected]
    assert not [row for row in rows if row[0] == "delete" and row[1] == "employment"]


def test_the_gold_catalogue_matches_the_api_catalogue():
    """The eval fixture mirrors `apps/api/.../edit-catalogue.ts` — read from source, not a copy.

    A field added or an op changed on the API side without this fixture following turns red HERE,
    which is what keeps "0 rows outside the catalogue" meaningful for the staging run.
    """
    source = _CATALOGUE_TS.read_text(encoding="utf-8")
    ops_by_const = {
        "EDIT": ("edit",),
        "ADD_DELETE": ("add", "delete"),
        "EDIT_DELETE": ("edit", "delete"),
    }
    pairs = re.findall(r'\{ section: "([a-z_]+)", field: "([a-z_]+)", ops: ([A-Z_]+) \}', source)
    assert pairs, "catalogue regex found nothing — the API file moved"
    assert [(s, f, ops_by_const[o]) for s, f, o in pairs] == edit_gold.CATALOGUE


def test_the_catalogue_has_no_duplicate_pairs_and_matches_the_closed_sections():
    pairs = [(section, field) for section, field, _ops in edit_gold.CATALOGUE]
    assert len(set(pairs)) == len(pairs)
    assert {section for section, _f, _o in edit_gold.CATALOGUE} == set(edit_gold.SECTIONS)
    # Every legal op is one of the three the wire enum carries.
    for _section, _field, ops in edit_gold.CATALOGUE:
        assert set(ops) <= {"add", "edit", "delete"}


# ── 4. the staging CLI is the only real gate ─────────────────────────────────────────────────


def test_the_real_gate_lives_in_the_staging_cli():
    from app.companion import eval_cli

    # The CLI exposes both runners and refuses to invent a base URL.
    assert callable(eval_cli.run_classify_eval)
    assert callable(eval_cli.run_edit_parse_eval)
    assert eval_cli.THRESHOLDS["classify_accuracy"] == classify_gold.THRESHOLDS["accuracy"]
    assert eval_cli.THRESHOLDS["edit_exact"] == edit_gold.THRESHOLD
