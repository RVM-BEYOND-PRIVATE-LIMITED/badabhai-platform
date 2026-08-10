"""#747 leg (a) — spoken phone numbers must not survive the STT response.

THE PERMITTED CASES ARE THE HARD HALF. Digit words are ordinary Hinglish: "do saal" is two
years, "saade teen saal" is three and a half, "char logon ki team". A redactor that fired on any
digit word would destroy exactly the answers this form exists to capture, and would look like a
privacy win while doing it. Every "must NOT redact" row below is a row that a naive
lexicon-matches-anything implementation fails.
"""

from __future__ import annotations

import pytest

from app.spoken_digits import PLACEHOLDER, redact_spoken_digits

# A 10-word spoken mobile — the shape this exists for.
TEN_SPOKEN = "nau aath saat chhe paanch char teen do ek shunya"


class TestRedactsPhoneShapedRuns:
    def test_a_ten_word_spoken_number_is_removed(self):
        r = redact_spoken_digits(f"mera number {TEN_SPOKEN} hai")
        assert r.count == 1
        assert PLACEHOLDER in r.text
        # Not one digit word of it survives.
        for word in TEN_SPOKEN.split():
            assert word not in r.text

    def test_devanagari_spoken_digits_are_removed(self):
        # saarika at hi-IN returns Devanagari, so the Roman lexicon alone would be a gate that
        # never fires in production.
        dev = "नौ आठ सात छह पांच चार तीन दो एक शून्य"
        r = redact_spoken_digits(f"मेरा नंबर {dev} है")
        assert r.count == 1
        assert PLACEHOLDER in r.text

    def test_a_devanagari_run_split_by_dandas_is_still_one_number(self):
        r"""REGRESSION on the tokeniser, which is where this first broke.

        The first implementation tokenised with `\w+`. Devanagari vowel signs are non-spacing
        marks, so Python's `\w` excludes them and the word SHATTERS — "नौ" became "न", "सात"
        became "स" + "त". Roman input matched while the identical Devanagari utterance produced
        fragments matching nothing, which is exactly what saarika returns at hi-IN. The danda is
        in here too because it is sentence punctuation outside ASCII and easy to forget.
        """
        dev = "नौ। आठ। सात। छह। पांच। चार। तीन। दो। एक। शून्य"
        r = redact_spoken_digits(dev)
        assert r.count == 1

    def test_separators_between_the_words_do_not_break_the_run(self):
        r = redact_spoken_digits("nau, aath, saat, chhe, paanch, char, teen, do, ek, shunya")
        assert r.count == 1

    def test_a_mixed_spoken_and_numeric_run_is_caught(self):
        # The seam between this net and pseudonymize's: five words plus a five-digit numeral is
        # ten digits, and would fall between them if each only counted its own kind.
        r = redact_spoken_digits("nau aath saat chhe paanch 43210")
        assert r.count == 1
        assert PLACEHOLDER in r.text

    def test_two_numbers_in_one_transcript_are_both_removed(self):
        r = redact_spoken_digits(f"ghar {TEN_SPOKEN} aur kaam {TEN_SPOKEN}")
        assert r.count == 2
        assert r.text.count(PLACEHOLDER) == 2


class TestPermitsOrdinarySpeech:
    """What it must NOT touch. These are the rows that keep the form usable."""

    @pytest.mark.parametrize(
        "text",
        [
            "do saal ka experience hai",
            "saade teen saal welding kiya",
            "char logon ki team thi",
            "paanch hazaar mahina",
            "ek din chhutti chahiye",
            "main aath ghante kaam karta hoon",
            "teen shift chalti hai",
            "छह महीने का अनुभव है",
        ],
    )
    def test_ordinary_numbers_survive_untouched(self, text: str):
        r = redact_spoken_digits(text)
        assert r.count == 0
        assert r.text == text

    def test_a_short_run_is_not_phone_shaped(self):
        # Four digit words in a row is not a phone number; a threshold that caught it would eat
        # "do teen char paanch log" (two three four five people).
        r = redact_spoken_digits("do teen char paanch log the")
        assert r.count == 0

    def test_a_run_LONGER_than_a_phone_number_is_left_alone(self):
        # 20 digit words is a recital or a miscount, not a mobile. Redacting it would be a
        # different (and unreviewed) rule than the one _PHONE_RE applies to numerals.
        r = redact_spoken_digits(" ".join(["ek"] * 20))
        assert r.count == 0

    def test_a_PURELY_NUMERIC_phone_is_left_to_pseudonymize(self):
        """The boundary between this module and the existing gate, pinned.

        `pseudonymize.py` already masks numeric phones, with NUMBERED masks ([PHONE_1]) so a
        reader can correlate the same number across a document. An earlier version of this
        module fired on numerals too, pre-empting that gate and flattening the label — a
        duplicated responsibility and a silently changed mask. The egress-gate test caught it.
        Only runs containing a spoken WORD belong here.
        """
        text = "mera number 9876543210 hai"
        r = redact_spoken_digits(text)
        assert r.count == 0
        assert r.text == text

    def test_an_empty_transcript_is_returned_unchanged(self):
        assert redact_spoken_digits("").count == 0
        assert redact_spoken_digits("").text == ""

    def test_a_transcript_with_no_digits_is_returned_byte_for_byte(self):
        text = "main VMC operator hoon, Pune mein kaam karta hoon."
        r = redact_spoken_digits(text)
        assert r.text == text
        assert r.count == 0


class TestPreservesTheRestOfTheAnswer:
    def test_surrounding_words_and_punctuation_are_kept(self):
        # The transcript is the worker's answer of record. Removing one span must not reformat
        # the rest of it.
        r = redact_spoken_digits(f"mera number {TEN_SPOKEN} hai, call kar lena.")
        assert r.text.startswith("mera number ")
        assert r.text.endswith(" hai, call kar lena.")

    def test_the_placeholder_carries_no_digits_of_its_own(self):
        # It passes through pseudonymize downstream; a numbered or digit-bearing placeholder
        # could trip the residual-digit net and be masked twice.
        assert not any(ch.isdigit() for ch in PLACEHOLDER)
