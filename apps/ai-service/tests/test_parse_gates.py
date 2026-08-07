"""THE SIX GATES — one crafted hallucination per gate, plus the parity that keeps both walls honest.

Phase 7's acceptance criterion is literally "each gate has a test that a crafted hallucination fails
it", so every test below builds a parse output a model could plausibly return and asserts the
specific gate that catches it. Each one also asserts the HONEST version of the same field is
ACCEPTED — a gate that rejects everything would pass the first assertion and is not a gate.
"""

import re
from pathlib import Path

import pytest

from app.contracts import (
    AnswerRecord,
    EvidenceSpan,
    ParsedField,
    ProfileParseOutput,
    TargetField,
    TranscriptLine,
)
from app.profiling import parse_gates
from app.profiling.parse_gates import apply_parse_gates, count_by_gate

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_GATES = REPO_ROOT / "apps" / "api" / "src" / "profiling" / "parse-gates.ts"

# One interview, reused. `i` is deliberately NOT the list position anywhere it matters.
TRANSCRIPT = [
    TranscriptLine(i=0, role="assistant", text="Kitne saal se yeh kaam kar rahe hain?"),
    TranscriptLine(i=1, role="worker", text="saat saal ho gaye"),
    TranscriptLine(i=2, role="assistant", text="Controller kaunsa - Fanuc, Siemens ya Haas?"),
    TranscriptLine(i=3, role="worker", text="fanuc chalata hu"),
    TranscriptLine(i=4, role="assistant", text="Kitni salary chahiye?"),
    TranscriptLine(i=5, role="worker", text="pandrah hazaar mahina"),
    TranscriptLine(i=6, role="assistant", text="Abhi kahan rehte hain?"),
    TranscriptLine(i=7, role="worker", text="pune mein rehta hu"),
]

TARGETS = [
    TargetField(field_id="experience_years", type="number", unit="years", required=True),
    TargetField(field_id="salary_expected", type="number", unit="inr_per_month", required=True),
    TargetField(field_id="current_city", type="string", required=True),
    TargetField(
        field_id="availability",
        type="enum",
        enum=list(parse_gates.AVAILABILITY_VALUES),
    ),
    TargetField(field_id="tools_equipment", type="string_array"),
]

ANSWER_MAP = [
    AnswerRecord(
        question_key="q_experience",
        target_field="experience_years",
        value_raw="saat saal ho gaye",
        value_normalized=7,
        status="answered",
        turn=1,
    ),
    AnswerRecord(
        question_key="q_salary",
        target_field="salary_expected",
        value_raw="pandrah hazaar mahina",
        value_normalized=15000,
        status="answered",
        turn=3,
    ),
]


def field(value, index: int, quote: str) -> ParsedField:
    return ParsedField(
        value=value,
        evidence=EvidenceSpan(message_index=index, quote=quote),
        source="transcript",
        normalization="numeric",
        confidence=0.95,
    )


def clean(text: str) -> tuple[bool, str]:
    """A certifier that changes nothing, so every test but the PII ones isolates its own gate."""
    return False, text


def run(fields: dict, *, certify=clean, answer_map=None, targets=None):
    return apply_parse_gates(
        ProfileParseOutput(fields=fields),
        ANSWER_MAP if answer_map is None else answer_map,
        TRANSCRIPT,
        TARGETS if targets is None else targets,
        certify,
    )


def rejection(result, field_id: str):
    matches = [r for r in result.rejections if r.field_id == field_id]
    assert len(matches) == 1, f"expected exactly one rejection for {field_id}, got {matches}"
    return matches[0]


# ---------------------------------------------------------------------------
# Gate 1 — PROVENANCE
# ---------------------------------------------------------------------------


def test_gate_provenance_rejects_a_quote_that_appears_in_no_message():
    # THE ARCHETYPAL HALLUCINATION: a plausible number with a plausible-sounding citation. The
    # worker said "saat saal" (seven); the model reports twelve and invents the sentence it came
    # from. There is no way to write this quote honestly, which is why provenance is the strongest
    # gate.
    result = run({"experience_years": field(12, 1, "baarah saal ho gaye")})
    assert result.accepted == {}
    assert rejection(result, "experience_years").gate == "provenance"
    assert rejection(result, "experience_years").reason == "quote_not_in_message"


def test_gate_provenance_rejects_a_citation_to_a_message_that_does_not_exist():
    result = run({"experience_years": field(7, 99, "saat saal")})
    assert rejection(result, "experience_years").reason == "message_index_out_of_range"


def test_gate_provenance_resolves_by_i_and_not_by_list_position():
    # The transcript reaching a parse has holes: this service DROPS any line pseudonymization
    # refuses, so position and `i` diverge. Cite `i=3` on a transcript whose list position 3 holds a
    # DIFFERENT line — a position-indexing gate would read the wrong message entirely.
    sparse = [TRANSCRIPT[0], TRANSCRIPT[3]]
    result = apply_parse_gates(
        ProfileParseOutput(fields={"current_city": field("Pune", 3, "fanuc")}),
        [],
        sparse,
        [TargetField(field_id="current_city", type="string")],
        clean,
    )
    assert "current_city" in result.accepted, "the cited line is at i=3, list position 1"


def test_gate_provenance_accepts_a_real_span_reflowed_by_whitespace():
    # The honest path, and the proof this gate is not simply rejecting everything: the model
    # collapses a double space, which is not a fabrication.
    result = run({"experience_years": field(7, 1, "saat   saal")})
    assert set(result.accepted) == {"experience_years"}
    assert result.rejections == []


# ---------------------------------------------------------------------------
# Gate 2 — ROLE
# ---------------------------------------------------------------------------


def test_gate_role_rejects_a_span_lifted_from_our_own_question():
    # THE DEFECT WE HAVE ALREADY PAID FOR. Our controller question lists Fanuc, Siemens and Haas as
    # examples; the model returns all three, and its quote is perfectly REAL — provenance passes it
    # happily. Sourcing from the assistant's own words is how a system interviews itself.
    result = run(
        {"tools_equipment": field(["Fanuc", "Siemens", "Haas"], 2, "Fanuc, Siemens ya Haas")}
    )
    assert result.accepted == {}
    assert rejection(result, "tools_equipment").gate == "role"
    assert rejection(result, "tools_equipment").reason == "span_not_from_worker"


def test_gate_role_accepts_the_one_controller_the_worker_actually_named():
    result = run({"tools_equipment": field(["Fanuc"], 3, "fanuc")})
    assert set(result.accepted) == {"tools_equipment"}


# ---------------------------------------------------------------------------
# Gate 3 — TYPE / ENUM / RANGE
# ---------------------------------------------------------------------------


def test_gate_type_range_rejects_an_annual_salary_read_as_monthly():
    # The 12x period error. The worker said "pandrah hazaar mahina" (15,000/month); a model that
    # reads a yearly figure and forgets to convert reports 4,200,000.
    result = run({"salary_expected": field(4_200_000, 5, "pandrah hazaar mahina")})
    assert rejection(result, "salary_expected").gate == "type_range"
    assert rejection(result, "salary_expected").reason == "salary_out_of_range"


def test_gate_type_range_rejects_an_impossible_career_length():
    result = run({"experience_years": field(75, 1, "saat saal")})
    assert rejection(result, "experience_years").reason == "experience_years_out_of_range"


def test_gate_type_range_rejects_an_invented_availability_value():
    result = run({"availability": field("maybe_next_month", 1, "saat saal")})
    assert rejection(result, "availability").reason == "availability_not_in_enum"


def test_gate_type_range_rejects_a_boolean_posing_as_a_number():
    # `isinstance(True, int)` is True in Python, so without an explicit bool check this reads as
    # "1 year" and passes the range. The TypeScript wall rejects it on `typeof`; this side has to
    # say so out loud.
    result = run({"experience_years": field(True, 1, "saat saal")})
    assert rejection(result, "experience_years").reason == "not_a_number"


def test_gate_type_range_rejects_a_string_array_whose_items_are_not_strings():
    # `isinstance(value, list)` alone let `["lathe", {"note": "call 9876543210"}]` through as a
    # valid string_array, and gate 6 then skipped the dict because it only inspected string
    # members — so a nested object walked out with every counter at zero.
    result = run({"tools_equipment": field(["lathe", {"note": "x"}], 3, "fanuc")})
    assert rejection(result, "tools_equipment").gate == "type_range"
    assert rejection(result, "tools_equipment").reason == "not_a_string"


def test_gate_type_range_survives_an_integer_too_large_to_be_a_float():
    # THE HTTP 500. Python ints are arbitrary precision and `math.isfinite` converts to float, so a
    # 401-digit value from the model raised OverflowError, escaped the wall, and took down every
    # honest field in the same response — the exact opposite of per-field fail-closed.
    huge = 10**400
    result = run({"experience_years": field(huge, 1, "saat saal")})
    assert result.accepted == {}
    assert rejection(result, "experience_years").reason == "experience_years_out_of_range"


def test_the_wall_is_total_even_if_a_gate_itself_raises():
    # The structural version of the same lesson: an unforeseen exception must cost ONE field, never
    # the interview — and must be COUNTED, not swallowed into something that looks like a pass.
    def exploding(_text: str) -> tuple[bool, str]:
        raise RuntimeError("certifier is down")

    result = run(
        {
            # Two STRING-bearing fields, so both actually reach the exploding certifier. A numeric
            # value has no strings to certify and would never call it — which is correct, and is
            # why `salary_expected` is deliberately not the fixture here.
            "current_city": field("Pune", 7, "pune mein rehta hu"),
            "tools_equipment": field(["Fanuc"], 3, "fanuc chalata hu"),
        },
        certify=exploding,
    )
    # Both fields die at gate 6 — but the wall RETURNED, and said so.
    assert result.accepted == {}
    assert {r.reason for r in result.rejections} == {"gate_error"}
    assert len(result.rejections) == 2


def test_a_field_with_no_strings_never_calls_the_certifier_at_all():
    # The companion to the above, so the totality test cannot be read as "gate 6 runs on
    # everything". Certification is for strings; a rupee figure has none.
    def exploding(_text: str) -> tuple[bool, str]:
        raise RuntimeError("certifier is down")

    result = run({"salary_expected": field(15000, 5, "pandrah hazaar mahina")}, certify=exploding)
    assert set(result.accepted) == {"salary_expected"}


def test_gate_type_range_keeps_an_unrecognized_city_rather_than_dropping_it():
    # The ONE field kept on failure. A city missing from the gazetteer is still evidence of where
    # the worker lives; dropping it would lose a strong matching signal over a data gap. Flagged so
    # a human can extend the gazetteer — the recoverable direction.
    result = apply_parse_gates(
        ProfileParseOutput(
            fields={"current_city": field("Chikhli Kalan", 7, "pune mein rehta hu")}
        ),
        [],
        TRANSCRIPT,
        TARGETS,
        clean,
    )
    assert "current_city" in result.accepted
    assert result.unrecognized_cities == ["current_city"]


def test_gate_type_range_does_not_flag_a_city_the_gazetteer_knows():
    result = apply_parse_gates(
        ProfileParseOutput(fields={"current_city": field("Pune", 7, "pune mein rehta hu")}),
        [],
        TRANSCRIPT,
        TARGETS,
        clean,
    )
    assert result.unrecognized_cities == []


# ---------------------------------------------------------------------------
# Gate 4 — ANSWER-MAP AGREEMENT
# ---------------------------------------------------------------------------


def test_gate_agreement_discards_a_model_value_that_contradicts_the_record():
    # The fabrication that survives every other gate: a REAL worker line, quoted correctly, typed to
    # a different number. This is the gate that makes the model structurally incapable of overriding
    # the record — it may reformat what the worker said, never change it.
    result = run({"experience_years": field(12, 1, "saat saal ho gaye")})
    assert result.accepted == {}
    assert rejection(result, "experience_years").gate == "agreement"
    assert result.disagreements == ["experience_years"]


def test_gate_agreement_lets_the_model_reformat_the_same_answer():
    # 15000 is what the map holds; the model citing the worker's own phrase for it must PASS, or the
    # gate is just a value-deleter.
    result = run({"salary_expected": field(15000, 5, "pandrah hazaar mahina")})
    assert set(result.accepted) == {"salary_expected"}
    assert result.disagreements == []


def test_gate_agreement_is_case_and_whitespace_insensitive_for_strings():
    answer_map = [
        AnswerRecord(
            question_key="q_city",
            target_field="current_city",
            value_normalized="pune",
            status="answered",
        )
    ]
    result = run({"current_city": field("Pune ", 7, "pune mein rehta hu")}, answer_map=answer_map)
    assert set(result.accepted) == {"current_city"}


def test_gate_agreement_ignores_a_field_the_map_never_answered():
    # Only a LIVE record binds. Where the map holds nothing, the overlay is free to add coverage —
    # that is the entire purpose of running an LLM over a finished interview.
    result = run({"current_city": field("Pune", 7, "pune mein rehta hu")})
    assert set(result.accepted) == {"current_city"}


def test_gate_agreement_does_not_bind_to_a_declined_answer():
    answer_map = [
        AnswerRecord(
            question_key="q_salary",
            target_field="salary_expected",
            value_normalized=9999,
            status="declined",
        )
    ]
    result = run(
        {"salary_expected": field(15000, 5, "pandrah hazaar mahina")}, answer_map=answer_map
    )
    assert set(result.accepted) == {"salary_expected"}


# ---------------------------------------------------------------------------
# Gate 5 — CLOSED VOCABULARY
# ---------------------------------------------------------------------------


def test_gate_vocabulary_drops_a_field_nobody_asked_for():
    # §2 forbids storing employer names, so `employer_name` is not in TARGETS and can never be. A
    # model that helpfully volunteers one is answering a question the platform refused to ask.
    result = run({"employer_name": field("Tata Motors", 3, "fanuc chalata hu")})
    assert result.accepted == {}
    assert rejection(result, "employer_name").gate == "vocabulary"
    assert rejection(result, "employer_name").reason == "field_id_not_requested"


def test_gate_vocabulary_runs_first_so_an_unrequested_field_is_never_examined():
    # Order matters: an unrequested field with a fabricated span must be attributed to VOCABULARY,
    # not provenance. Otherwise the counters say "the model is hallucinating quotes" when what it
    # actually did was answer the wrong question.
    result = run({"employer_name": field("Tata Motors", 99, "never said this")})
    assert rejection(result, "employer_name").gate == "vocabulary"


# ---------------------------------------------------------------------------
# Gate 6 — PII RE-CERTIFICATION
# ---------------------------------------------------------------------------


def test_gate_pii_rejects_a_value_the_certifier_rewrites():
    # ALTERED IS THE LOAD-BEARING WORD. Storing the rewritten form would record that the worker said
    # something they did not — the masked text is our sentence, not theirs.
    def masking(text: str) -> tuple[bool, str]:
        return False, text.replace("Ramesh", "[PERSON_1]")

    result = run({"current_city": field("Ramesh nagar", 7, "pune mein rehta hu")}, certify=masking)
    assert result.accepted == {}
    assert rejection(result, "current_city").gate == "pii"
    assert rejection(result, "current_city").reason == "pii_altered"


def test_gate_pii_rejects_a_value_the_certifier_blocks():
    def blocking(_text: str) -> tuple[bool, str]:
        return True, ""

    result = run({"current_city": field("Pune", 7, "pune mein rehta hu")}, certify=blocking)
    assert rejection(result, "current_city").reason == "pii_blocked"


def test_gate_pii_inspects_every_string_in_an_array():
    def masking(text: str) -> tuple[bool, str]:
        return False, "[PHONE_1]" if text == "9876543210" else text

    result = run({"tools_equipment": field(["Fanuc", "9876543210"], 3, "fanuc")}, certify=masking)
    assert rejection(result, "tools_equipment").gate == "pii"


def test_gate_pii_reaches_a_string_nested_inside_an_object_inside_a_list():
    # THE LEAK THIS GATE SHIPPED WITH. An earlier version built `[item for item in value if
    # isinstance(item, str)]`, which silently DISCARDED the dict — so the phone number inside it was
    # certified by nothing, the field was ACCEPTED, and the per-gate counters reported a clean pass.
    # A string a walker cannot see is a string no wall can certify.
    def masking(text: str) -> tuple[bool, str]:
        return False, "[PHONE_1]" if "9876543210" in text else text

    result = run(
        {"tools_equipment": field([{"note": "call 9876543210"}], 3, "fanuc")},
        certify=masking,
        targets=[TargetField(field_id="tools_equipment", type="object")],
    )
    assert result.accepted == {}
    assert rejection(result, "tools_equipment").gate == "pii"


def test_gate_pii_certifies_object_KEYS_too():
    # The model chooses the keys as well as the values.
    def masking(text: str) -> tuple[bool, str]:
        return False, "[PHONE_1]" if text == "9876543210" else text

    result = run(
        {"tools_equipment": field({"9876543210": "ok"}, 3, "fanuc")},
        certify=masking,
        targets=[TargetField(field_id="tools_equipment", type="object")],
    )
    assert rejection(result, "tools_equipment").gate == "pii"


def test_gate_pii_runs_last_so_it_never_certifies_a_field_already_dead():
    # PII re-certification is the only gate with a real cost. A field that fails provenance must
    # never reach it.
    calls: list[str] = []

    def counting(text: str) -> tuple[bool, str]:
        calls.append(text)
        return False, text

    run({"experience_years": field(12, 1, "baarah saal")}, certify=counting)
    assert calls == []


# ---------------------------------------------------------------------------
# The wall as a whole
# ---------------------------------------------------------------------------


def test_a_null_field_is_an_honest_answer_and_not_a_rejection():
    # "I looked and found nothing citable" is the CORRECT response to an unanswerable field, and
    # counting it as a gate failure would make the honest model look like the dishonest one.
    result = run({"salary_expected": None})
    assert result.accepted == {}
    assert result.rejections == []


def test_one_bad_field_never_costs_the_others():
    # FAIL CLOSED, PER FIELD. The whole design rests on the overlay being additive.
    result = run(
        {
            "experience_years": field(12, 1, "saat saal ho gaye"),  # disagrees
            "salary_expected": field(15000, 5, "pandrah hazaar mahina"),  # honest
            "current_city": field("Pune", 7, "pune mein rehta hu"),  # honest
        }
    )
    assert set(result.accepted) == {"salary_expected", "current_city"}


def test_rejection_counts_are_ids_and_counts_only():
    result = run(
        {
            "experience_years": field(12, 1, "saat saal ho gaye"),
            "employer_name": field("Tata Motors", 3, "fanuc chalata hu"),
        }
    )
    counts = count_by_gate(result.rejections)
    assert counts == {
        "provenance": 0,
        "role": 0,
        "type_range": 0,
        "agreement": 1,
        "vocabulary": 1,
        "pii": 0,
    }
    # A `Rejection` carries a field id and a closed-set reason. Nothing else may be on it, because
    # everything else about a rejected field is the worker's text.
    for rejected in result.rejections:
        assert set(vars(rejected)) == {"field_id", "gate", "reason"}
        assert rejected.reason in parse_gates.REJECTION_REASONS


# ---------------------------------------------------------------------------
# PARITY — two walls are only worth one wall each if they disagree
# ---------------------------------------------------------------------------

# Literal patterns selected by NAME, never one built from an f-string: an interpolated regex is what
# semgrep's detect-non-literal-regexp flags, and a lookup makes an unknown key a KeyError rather
# than a silently-empty match.
_TS_ARRAYS = {
    "GATE_IDS": re.compile(r"export const GATE_IDS = \[([\s\S]*?)\] as const;"),
    "REJECTION_REASONS": re.compile(r"export const REJECTION_REASONS = \[([\s\S]*?)\] as const;"),
    "AVAILABILITY_VALUES": re.compile(
        r"export const AVAILABILITY_VALUES = \[([\s\S]*?)\] as const;"
    ),
}
_TS_RANGES = {
    "EXPERIENCE_YEARS_RANGE": re.compile(
        r"export const EXPERIENCE_YEARS_RANGE = \{ min: ([\d_]+), max: ([\d_]+) \}"
    ),
    "SALARY_INR_PER_MONTH_RANGE": re.compile(
        r"export const SALARY_INR_PER_MONTH_RANGE = \{ min: ([\d_]+), max: ([\d_]+) \}"
    ),
}


def ts_source() -> str:
    return TS_GATES.read_text(encoding="utf-8")


def ts_array(name: str) -> list[str]:
    match = _TS_ARRAYS[name].search(ts_source())
    assert match, f"{name} not found in parse-gates.ts — the mirror has moved"
    return re.findall(r'"([^"]+)"', match.group(1))


def ts_range(name: str) -> tuple[int, int]:
    match = _TS_RANGES[name].search(ts_source())
    assert match, f"{name} not found in parse-gates.ts — the mirror has moved"
    return int(match.group(1).replace("_", "")), int(match.group(2).replace("_", ""))


def test_the_typescript_reader_is_capable_of_failing():
    # Guards against a regex that quietly matches nothing and makes every parity assertion vacuous.
    assert TS_GATES.is_file()
    assert len(ts_array("GATE_IDS")) == 6
    assert len(ts_array("REJECTION_REASONS")) > 10
    assert ts_range("SALARY_INR_PER_MONTH_RANGE")[1] > 1000


def test_gate_ids_are_identical_on_both_walls():
    assert list(parse_gates.GATE_IDS) == ts_array("GATE_IDS")


def test_the_rejection_vocabulary_is_identical_on_both_walls():
    # THE POINT OF THIS TEST. Two walls that report a field rejected for different reasons are two
    # dashboards that disagree about the same worker. A new reason has to be added on both sides.
    assert list(parse_gates.REJECTION_REASONS) == ts_array("REJECTION_REASONS")


def test_every_reason_the_python_wall_can_emit_is_in_the_closed_set():
    # The other direction: the mirror above proves the LISTS match, not that the CODE only returns
    # what it declared. Sweep the module for returned literals and check each is declared.
    source = (Path(parse_gates.__file__)).read_text(encoding="utf-8")
    returned = set(re.findall(r'return "([a-z_]+)"', source))
    returned |= set(re.findall(r'else "([a-z_]+)"', source))
    assert returned, "found no returned reason literals — this check would be vacuous"
    assert returned <= set(parse_gates.REJECTION_REASONS)


def test_the_bounds_are_identical_on_both_walls():
    assert (parse_gates.EXPERIENCE_YEARS_MIN, parse_gates.EXPERIENCE_YEARS_MAX) == ts_range(
        "EXPERIENCE_YEARS_RANGE"
    )
    assert (
        parse_gates.SALARY_INR_PER_MONTH_MIN,
        parse_gates.SALARY_INR_PER_MONTH_MAX,
    ) == ts_range("SALARY_INR_PER_MONTH_RANGE")


def test_the_availability_enum_is_identical_on_both_walls():
    assert list(parse_gates.AVAILABILITY_VALUES) == ts_array("AVAILABILITY_VALUES")


@pytest.mark.parametrize("gate_id", parse_gates.GATE_IDS)
def test_every_declared_gate_has_a_test_that_a_hallucination_fails_it(gate_id: str):
    # The acceptance criterion, asserted as a property rather than trusted to review: adding a
    # seventh gate id without a test named for it fails here.
    tests = Path(__file__).read_text(encoding="utf-8")
    assert f"def test_gate_{gate_id}_" in tests
