"""Shared pieces of the employer-masking test files: the capitals rule (#1875,
`test_pseudonymize_allcaps_employer.py`) and the passes after it (#1892,
`test_pseudonymize_employer_residuals.py`). Stdlib only, like the files that import it.
"""

from __future__ import annotations

import re
from collections import Counter

import app.pseudonymize as gateway

#: A pattern that never matches: what a test swaps in to switch a rule off.
NEVER = re.compile(r"(?!x)x")
#: The five passes #1892 added around the capitals rule (the long pass just ahead of it, the rest
#: after it). The one list both files switch off, so a
#: sixth pass cannot be missed in one of them (`test_the_1892_rule_list_is_complete` pins it).
RULES_1892 = (
    "_EMPLOYER_LONG_RE",
    "_EMPLOYER_TITLE_FORM_RE",
    "_EMPLOYER_LOWER_RE",
    "_EMPLOYER_MS_CUE_RE",
    "_EMPLOYER_ABSORB_RE",
)


def raw_words(text: str) -> Counter[str]:
    """The words of ``text`` that no placeholder replaced."""
    return Counter(re.findall(r"[^\W_]+", re.sub(r"\[[A-Z]+_\d+\]", " ", text)))


def two_view_verdict(text: str) -> str:
    """How #1738's two-view check classifies ``text`` on the module as it stands.

    "blocks"  — a view's residual guard trips, or a spaced-view region overlaps no reader mask.
    "full"    — every offset of every spaced-view region that the reader view KEPT (did not
                delete) is reader-masked: `pseudonymize` passes it, nothing the spaced view found
                egresses raw.
    "partial" — a spaced-view region holds a kept offset the reader view left raw although it
                OVERLAPS a reader mask. That was R49: the overlap-only check passed it. Since #1890
                (covered only if every kept offset is reader-masked) `pseudonymize` BLOCKS it.
    """
    return raw_egress(text)[0]


def raw_egress(text: str) -> tuple[str, str]:
    """``(two_view_verdict(text), what a "partial" turn would leave raw under an overlap-only
    check)``: the characters of the kept offsets in spaced-view regions that the reader view did
    not mask ("" unless "partial")."""
    reader_view, spaced_view = gateway._build_views(text)
    reader, reader_regions = gateway._mask(reader_view, True)
    spaced, spaced_regions = gateway._mask(spaced_view, True)
    reader_masked: set[int] = set().union(*reader_regions)
    if (
        reader.blocked
        or spaced.blocked
        or any(not (region & reader_masked) for region in spaced_regions)
    ):
        return "blocks", ""
    kept = set(reader_view.src)
    raw = sorted(set().union(*((region & kept) - reader_masked for region in spaced_regions)))
    return ("partial" if raw else "full"), "".join(text[i] for i in raw)


def _overlap_covered(region: set[int], reader_masked: set[int], reader_kept: set[int]) -> bool:
    """`_is_covered` as it stood before #1890: one overlapping offset was enough (R49)."""
    return bool(region & reader_masked)


def containment_against_overlap(text: str, monkeypatch) -> str:
    """Compare `pseudonymize(text)` with the same module under the pre-#1890 overlap check, and
    assert containment only ever blocks MORE: a turn overlap blocked blocks the same way, a turn
    containment passes is byte-identical, and a turn only containment blocks is an R49 "partial"
    turn. Independently, every "partial" turn blocks. Returns "same" or "newly blocked"."""
    result = gateway.pseudonymize(text)
    with monkeypatch.context() as patch:
        patch.setattr(gateway, "_is_covered", _overlap_covered)
        overlap = gateway.pseudonymize(text)
    verdict = two_view_verdict(text)
    if verdict == "partial":
        assert result.blocked_reason == gateway._INVISIBLE_BYPASS_REASON, text
    if overlap.blocked or not result.blocked:
        assert result == overlap, (text, overlap, result)
        return "same"
    assert result.blocked_reason == gateway._INVISIBLE_BYPASS_REASON, text
    assert verdict == "partial", (text, verdict)
    return "newly blocked"
