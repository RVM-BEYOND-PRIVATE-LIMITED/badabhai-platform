"""City-alias + state-capture unit tests (WS3).

Hinglish/colloquial city names now normalize INTO the closed canonical city set,
and a state-level answer is captured as ``current_state`` instead of being
dropped. The pseudonymizer also masks the aliases (they must never reach an LLM
in the clear). All detection is local (trusted) over raw text — no network.
"""

from app.profiling import signals
from app.pseudonymize import pseudonymize

# --- City aliases normalize into the canonical KNOWN_CITIES set -------------

def test_dilli_alias_normalizes_to_delhi():
    sig = signals.detect("main dilli me kaam karta hu, 3 saal ka experience")
    assert sig.current_city == "Delhi"


def test_bombay_alias_normalizes_to_mumbai():
    assert signals.detect("bombay me rehta hu").current_city == "Mumbai"


def test_gurgaon_alias_normalizes_to_gurugram():
    assert signals.detect("gurgaon plant me tha").current_city == "Gurugram"


def test_canonical_city_unchanged():
    # A canonical name is Title-cased, not aliased away.
    assert signals.detect("Pune me operator hu").current_city == "Pune"


# --- State-level capture (no longer silently dropped) -----------------------

def test_named_state_is_captured():
    sig = signals.detect("abhi bihar me hu, kaam dhundh raha hu")
    assert sig.current_state == "Bihar"


def test_multiword_state_is_captured():
    assert signals.detect("uttar pradesh se hu").current_state == "Uttar Pradesh"


def test_uppercase_abbrev_is_a_state():
    assert signals.detect("main UP se hu").current_state == "Uttar Pradesh"


def test_lowercase_up_in_setup_is_not_a_state():
    # CRITICAL: "set up" / "setup" must NOT be misread as Uttar Pradesh — the
    # abbreviation match is uppercase + case-sensitive by design.
    sig = signals.detect("machine set up karta hu, setter hu")
    assert sig.current_state is None


def test_city_and_state_coexist():
    sig = signals.detect("dilli me tha, ab bihar me hu")
    assert sig.current_city == "Delhi"
    assert sig.current_state == "Bihar"


# --- Pseudonymizer still masks the aliases before any LLM call --------------

def test_pseudonymize_masks_city_alias():
    result = pseudonymize("main dilli me rehta hu")
    assert result.blocked is False
    assert "dilli" not in result.text.lower()
    assert "[CITY_1]" in result.text
