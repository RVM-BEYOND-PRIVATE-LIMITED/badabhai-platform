"""Security-review fixes for the profiling-quality series (2026-07-22).

Making the certifications question MUST_ASK invites every worker to type a roll or
registration number. Measured before these fixes:

  * the gate let them through verbatim — `_PHONE_RE` accepts many separators but
    not "/", and `_RESIDUAL_DIGITS_RE` needs 7+ CONSECUTIVE digits, so
    "R/2019/123456" reached the LLM with `blocked=False, replaced=0`;
  * `_detect_salary` is topic-blind and only rejects amounts under 1,000, so the
    same digits landed in `salary_expectation.amount_min` — onto the resume and
    into the deterministic ranking factor `reach.mappers.ts` reads.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.profiling.signals import detect
from app.pseudonymize import pseudonymize

client = TestClient(app)


@pytest.mark.parametrize(
    "text",
    [
        "NCVT roll number R/2019/123456",
        "mera NCVT reg no MH2019CN4471 hai",
        "certificate ka number NAPS/2020/44521",
        "NSQF certificate no 45-2021-8891",
        "enrolment number ABC123456",
        "licence no DL/2018/9987",
        "roll no 2019CN4471",
    ],
)
def test_a_cued_credential_id_never_reaches_the_model(text):
    result = pseudonymize(text)
    assert "[ID_" in result.text, result.text
    # The raw identifier itself must be gone, not merely accompanied by a token.
    for fragment in ("123456", "4471", "44521", "8891", "9987"):
        if fragment in text:
            assert fragment not in result.text, result.text


@pytest.mark.parametrize(
    "text",
    [
        "NCVT certificate hai",
        "certificate nahi hai",
        "certificate hai par naam yaad nahi",
        "certificate number chahiye",
        "registration ke liye documents chahiye",
        "NCVT aur NSQF dono hai",
        "25000 milta hai",
        "fanuc controller chalaya hai",
    ],
)
def test_ordinary_certification_talk_is_left_alone(text):
    """The mask is cue-anchored AND digit-requiring. Two measured regressions it
    guards: the bare `cert` alternative eating the middle of "certificate", and a
    digitless group masking the Hindi word "chahiye"."""
    result = pseudonymize(text)
    assert result.text == text
    assert result.replaced_entities == 0


@pytest.mark.parametrize(
    "text",
    [
        "NCVT hai, roll number R/2019/123456",
        "certificate number 4471 hai",
        "NSQF certificate no 45-2021-8891",
        "roll no 2019CN4471",
    ],
)
def test_a_credential_number_is_never_read_as_a_salary(text):
    sig = detect(text)
    assert sig.current_salary is None, text
    assert sig.expected_salary is None, text


@pytest.mark.parametrize(
    "text",
    [
        # A worker answering several questions in ONE message — which the engine
        # supports, and which is a single line. An earlier cut of the credential
        # suppression scanned the whole line and silently dropped BOTH salaries
        # here because a certificate was mentioned later in the same sentence. A
        # 30-character backward window still dropped the salary from the third one.
        "abhi 25000 milta hai, 35000 chahiye, NCVT certificate hai",
        "VMC operator hu, abhi 25000 milta hai, 35000 chahiye, ITI kiya hai",
        "NCVT certificate hai, abhi 25000 milta hai",
    ],
)
def test_a_certificate_elsewhere_in_the_message_does_not_eat_the_salary(text):
    """The suppression is ADJACENCY-based: the cue must sit immediately before the
    digits, separated by at most a no/number connector and the rest of the
    identifier. A certificate mentioned anywhere else in the sentence is irrelevant."""
    assert detect(text).current_salary == 25000, text


def test_real_salaries_still_parse():
    sig = detect("abhi 25000 milta hai, 35000 chahiye")
    assert sig.current_salary == 25000
    assert sig.expected_salary == 35000

    multiline = detect("NCVT roll number R/2019/123456\n25000 milta hai")
    assert multiline.current_salary == 25000


# --- fail-closed on the split path ------------------------------------------


def test_extraction_fails_closed_when_the_worker_lines_block():
    """The gate runs on BOTH texts. A caller that sends a benign `transcript` and
    a blocking `messages` must still be refused — otherwise the detector consumes
    text the gate would have rejected."""
    response = client.post(
        "/profile/extract",
        json={
            "worker_ref": "w-gate",
            "transcript": "Bada Bhai: Namaste\nWorker: haan",
            "messages": [
                {
                    "role": "worker",
                    "text": "my reference number is 12345678 aur main vmc operator hu",
                }
            ],
        },
    )
    body = response.json()
    assert body["blocked"] is True
    assert body["extraction_status"] == "blocked"
    assert body["worker_profile_draft"] is None
    assert body["profile"]["canonical_role_id"] is None


def test_extraction_fails_closed_when_the_transcript_blocks():
    """The mirror of the case above. Note the input is an 8-digit run, NOT a phone
    number: a 10-digit phone is MASKED to [PHONE_n] and passes, while a residual
    run the maskers did not claim is what actually blocks."""
    response = client.post(
        "/profile/extract",
        json={
            "worker_ref": "w-gate",
            "transcript": "Worker: mera reference 12345678 hai aur main vmc operator hu",
            "messages": [{"role": "worker", "text": "vmc operator hu"}],
        },
    )
    body = response.json()
    assert body["blocked"] is True
    assert body["extraction_status"] == "blocked"


def test_a_phone_number_is_masked_rather_than_blocked():
    """Pins the distinction the test above depends on, so a future change to the
    phone masker cannot silently turn these two cases into the same case."""
    result = pseudonymize("Worker: mera number 9876543210 hai")
    assert result.blocked is False
    assert "[PHONE_1]" in result.text
    assert "9876543210" not in result.text


def test_a_clean_split_request_is_not_blocked():
    """The second gate call must not turn benign traffic away."""
    response = client.post(
        "/profile/extract",
        json={
            "worker_ref": "w-gate",
            "transcript": "Bada Bhai: Aap kaunsa kaam karte hain?\nWorker: vmc operator hu",
            "messages": [
                {"role": "assistant", "text": "Aap kaunsa kaam karte hain?"},
                {"role": "worker", "text": "vmc operator hu"},
            ],
        },
    )
    body = response.json()
    assert body["blocked"] is False
    assert body["profile"]["canonical_role_id"] == "role_vmc_operator"
