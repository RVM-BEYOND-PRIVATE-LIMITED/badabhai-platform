"""#2003: the FIX-5 employer rescue keeps real Title-Case trade labels it used to drop.

`_COMPANY_SUFFIX` masks "Carbon Steel", "Power Tools", "Electrical Engineering" and the like as
`[EMPLOYER_1]`, and the rescue in `certified_clean_skill_labels` keeps such a label only when
every word is vocabulary. Measured on the parent of this change over the 23 trade probes below:
2/23 kept (only the two FIX-5 already rescued, "Stainless Steel" and "Diploma Mechanical
Engineering"). With the rescue-only words (`signals.EMPLOYER_RESCUE_ONLY_WORDS`): 23/23 kept,
while the employer-name probes stay at 0/10 kept (`_is_employer_only_mask` is unchanged).
Reads no flag.
"""

from __future__ import annotations

import pytest

from app.certified_values import certified_items, certified_scalar
from app.profiling import signals
from app.pseudonymize import certified_clean_skill_labels, is_certified_clean, pseudonymize

#: Every label the issue lists, plus the forms the same words take in model output. All are
#: masked as `[EMPLOYER_1]` by the gateway (asserted below), so only the rescue can keep them.
_TRADE_PROBES = (
    # materials_handled
    "Carbon Steel",
    "Alloy Steel",
    "Structural Steel",
    "Galvanized Steel",
    "Galvanised Steel",
    "Spring Steel",
    "Hot/Cold Rolled Steel",
    "Hot Rolled Steel",
    "Cold Rolled Steel",
    "Hardened Steel",
    # machines / inspection_tools
    "Pneumatic Tools",
    "Power Tools",
    "Hand Tools",
    "Cutting Tools",
    "Measuring Tools",
    # education
    "Electrical Engineering",
    "Diploma Electrical Engineering",
    # roles
    "Structural Steel Fitter",
    "Carbon Steel Welder",
    "Alloy Steel Welder",
    "Stainless Steel Fitter",
    # what the rescue already kept, so the probe set measures no regression
    "Stainless Steel",
    "Diploma Mechanical Engineering",
)

#: A company name carries a proper noun or a legal form no vocabulary contains. Each must drop.
_EMPLOYER_PROBES = (
    "Ramesh Steel Industries",
    "Jyoti CNC Industries",
    "Precision Engineering Works",
    "Carbon Steel Industries",
    "Ramesh Power Tools",
    "Power Tools Pvt Ltd",
    "Hand Tools Enterprises",
    "Hardened Steel Works",
    "Sharma Structural Engineering",
    "Spring Steel Traders",
)


@pytest.mark.parametrize("label", _TRADE_PROBES + _EMPLOYER_PROBES)
def test_every_probe_is_masked_as_an_employer_only(label: str) -> None:
    """Precondition: the gateway masks every probe as an EMPLOYER and nothing else, so the
    count below measures the RESCUE, not a label that was clean anyway."""
    result = pseudonymize(label)
    assert result.placeholder_tokens
    assert all(token.startswith("[EMPLOYER_") for token in result.placeholder_tokens)


def test_the_certifier_keeps_every_trade_probe_and_no_employer_probe() -> None:
    kept = certified_clean_skill_labels(list(_TRADE_PROBES))
    assert (len(kept), len(_TRADE_PROBES)) == (23, 23)
    assert kept == list(_TRADE_PROBES)  # original text, in order
    assert certified_clean_skill_labels(list(_EMPLOYER_PROBES)) == []


@pytest.mark.parametrize("label", _EMPLOYER_PROBES)
def test_an_employer_name_still_drops(label: str) -> None:
    assert certified_clean_skill_labels([label]) == []


def test_the_rich_draft_certifiers_inherit_the_rescue() -> None:
    """`certified_items` (rich-draft lists) and `certified_scalar` (`primary_role`) delegate to
    the same certifier, so `materials_handled` and roles keep the labels too."""
    assert certified_items(["Carbon Steel", "Ramesh Steel Industries", "Galvanized Steel"]) == [
        "Carbon Steel",
        "Galvanized Steel",
    ]
    assert certified_scalar("Structural Steel Fitter") == "Structural Steel Fitter"
    assert certified_scalar("Ramesh Steel Industries") is None


def test_the_rescue_only_words_are_pinned() -> None:
    """A word added here changes what the certifier keeps: a privacy-reviewed change."""
    assert signals.EMPLOYER_RESCUE_ONLY_WORDS == frozenset(
        {
            "carbon", "alloy", "structural", "galvanized", "galvanised", "spring", "rolled",
            "hot", "cold", "hardened", "pneumatic", "hand", "power", "cutting", "measuring",
            "tools", "electrical", "fitter",
        }
    )  # fmt: skip


def test_the_rescue_only_words_reach_nothing_but_the_rescue() -> None:
    """They are not curated vocabulary: the no-cue leading-name guess (#1728) and the
    clean-or-withhold condition (d) read `VOCABULARY_TOKENS`, which does not move."""
    added = signals.EMPLOYER_RESCUE_ONLY_WORDS - {"cutting"}  # "cutting" was already derived
    assert not added & signals.VOCABULARY_TOKENS
    assert not signals.is_curated_vocabulary_label("Power Tools")
    assert signals.is_employer_rescue_vocabulary_label("Power Tools")
    # The leading-name guess still masks a rescue-only word in "<Word>, ..." position ...
    assert pseudonymize("Spring, main welder hoon").text == "[PERSON_1], main welder hoon"
    # ... and condition (d) still withholds a name behind a released leading word.
    assert not is_certified_clean("Welding, power tools Ramesh")


@pytest.mark.parametrize("label", ["Power Tools", "Carbon Steel"])
def test_a_vocabulary_failure_drops_the_label(monkeypatch: pytest.MonkeyPatch, label: str) -> None:
    """Fail closed: the rescue keeps nothing it could not positively recognise."""

    def _boom(_label: str) -> bool:
        raise RuntimeError("vocabulary unavailable")

    monkeypatch.setattr(signals, "is_employer_rescue_vocabulary_label", _boom)
    assert certified_clean_skill_labels([label]) == []
