"""``POST /profile/extract`` must read the WORKER's lines, not our own questions.

The deterministic detector is a keyword/regex reader with no notion of who is
speaking. Given the whole conversation as one blob it read BadaBhai's question
text as the worker's answers — a controller question listing five controllers
produced five controllers from a worker who named one; a retry worded "jaise 2
saal ya 5 saal" produced 2.0 years from a worker who said "5 saal"; the education
question's own examples produced ``["ITI", "Diploma"]`` from a worker who had not
been asked yet.

The fix is a role-typed split: `messages` (role-tagged) feeds the detector,
`transcript` (flat, both directions) still feeds the model, which needs the
question to read the answer in context.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

# One conversation, two shapes. Every value below is the worker's, and only theirs.
CONVERSATION = [
    ("assistant", "Namaste! Aap kaunsa kaam karte hain?"),
    ("worker", "vmc operator hu"),
    ("assistant", "Kitne saal se yeh kaam kar rahe hain — jaise 2 saal ya 5 saal?"),
    ("worker", "5 saal ho gaye"),
    ("assistant", "Abhi aap kis sheher mein rehte hain — jaise Pune, Delhi ya Rajkot?"),
    ("worker", "pune"),
    ("assistant", "Kaunse sheher mein kaam karna chahenge?"),
    ("worker", "Nashik ya Aurangabad chalega"),
    ("assistant", "Controller kaunsa — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?"),
    ("worker", "fanuc"),
    ("assistant", "Aapne kahan tak padhai ki hai — ITI, Diploma, 10th ya 12th?"),
    ("worker", "ITI kiya hai"),
]

MESSAGES = [{"role": role, "text": text} for role, text in CONVERSATION]
TRANSCRIPT = "\n".join(
    f"{'Worker' if role == 'worker' else 'Bada Bhai'}: {text}" for role, text in CONVERSATION
)


def _extract(**payload):
    response = client.post("/profile/extract", json={"worker_ref": "w-split", **payload})
    assert response.status_code == 200
    body = response.json()
    return body["profile"], body["worker_profile_draft"] or {}


def test_detector_reads_only_the_workers_lines():
    profile, draft = _extract(transcript=TRANSCRIPT, messages=MESSAGES)

    # The worker named ONE controller. Our question named five.
    assert draft["controllers"] == ["Fanuc"]
    assert "skill_siemens" not in profile["skills"]
    assert "skill_mitsubishi" not in profile["skills"]

    # The worker said "5 saal". Our retry question says "jaise 2 saal ya 5 saal".
    assert profile["experience"]["total_years"] == 5.0
    assert draft["experience_years"] == 5.0

    # The worker named two cities. Our question named three others as examples.
    assert profile["location_preference"]["preferred_cities"] == ["Nashik", "Aurangabad"]
    assert profile["location_preference"]["current_city"] == "Pune"

    # The worker said ITI. Our question also lists Diploma / 10th / 12th.
    assert draft["education"] == ["ITI"]


def test_questions_alone_extract_nothing():
    """A conversation of OUR questions with no worker answer must yield an empty
    profile. Before the split this returned a complete, entirely fabricated one.

    This pins the DETERMINISTIC path (`AI_ENABLE_REAL_CALLS=false`, the default).
    With real calls on, the model still fabricates a `canonical_role_id` from the
    question text via the lenient canonicalization overlay — measured identically
    on the pre-split `transcript` path, so it is a separate defect this split
    neither owns nor regresses, and `canonical_role_id` is asserted here only for
    the mock path.
    """
    questions = [m for m in MESSAGES if m["role"] == "assistant"]
    profile, draft = _extract(
        transcript="\n".join(f"Bada Bhai: {m['text']}" for m in questions),
        messages=questions,
    )

    assert profile["canonical_role_id"] is None
    assert profile["machines"] == []
    assert profile["skills"] == []
    assert profile["experience"]["total_years"] is None
    assert profile["location_preference"]["preferred_cities"] == []
    assert draft["education"] == []
    assert draft["controllers"] == []


def test_transcript_without_messages_is_unchanged():
    """The rollback lever. Callers that send only `transcript` must behave exactly
    as they did before the split — including reproducing the old wrong values, so
    this test fails loudly if the fallback silently changes."""
    profile, _ = _extract(transcript=TRANSCRIPT)

    assert profile["experience"]["total_years"] == 2.0  # read from our retry question
    assert "Delhi" in profile["location_preference"]["preferred_cities"]


def test_a_worker_who_types_our_prefix_is_still_read():
    """The split is by message role, never by parsing a "Bada Bhai:" prefix out of
    the text. A worker whose own answer contains that string must still be read."""
    own_prefix = [{"role": "worker", "text": "Bada Bhai: Delhi me kaam karta hu"}]
    profile, _ = _extract(messages=own_prefix)

    assert profile["location_preference"]["current_city"] == "Delhi"


def test_adjacent_salary_answers_do_not_poison_each_other():
    """Two salary answers on their own lines. The expected-salary cue on the second
    line must not retag the first line's number — it did, which silently dropped
    the worker's expected salary."""
    messages = [
        {"role": "assistant", "text": "Abhi kitni salary milti hai?"},
        {"role": "worker", "text": "25000"},
        {"role": "assistant", "text": "Kitni salary expect karte hain?"},
        {"role": "worker", "text": "35000 chahiye"},
    ]
    profile, _ = _extract(messages=messages)

    assert profile["salary_expectation"]["amount_min"] == 25000
    assert profile["salary_expectation"]["amount_max"] == 35000
