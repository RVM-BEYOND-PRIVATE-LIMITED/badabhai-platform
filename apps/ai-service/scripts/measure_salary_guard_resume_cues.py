"""Measure #2043: which résumé cues can the salary guard take without dropping real wages?

    cd apps/ai-service && python scripts/measure_salary_guard_resume_cues.py

The salary detector drops a number when its line, up to the number, ends in a credential cue, a
connector and an identifier-like run (lexicon `salary.json` `credentialBefore`). The guard knows
only the credential cues (roll, reg, certificate, licence, …), so an identifier the G1/G2 floor
refuses on its RÉSUMÉ cue ("Passport No. M123456", "UAN 101234567890") is still recorded as pay.

BEFORE is the guard as #1950 shipped it, frozen below. Each VARIANT is BEFORE with one edit, and
the last one is what #2043 ships (asserted against the lexicon). Every variant, and BEFORE as the
baseline, is swapped into the real `signals.detect` (the pattern only, nothing else touched) and
run over four corpora:

  ids      identifier lines the guard SHOULD drop (fabricated, every résumé cue);
  wages    realistic wage lines with a résumé cue right before or near the figure;
  lexicon  the lexicon parity utterances (`packages/profiling-lexicon/__fixtures__`);
  repo     every distinct string of the repo's tracked text (#1933's reader) holding a digit and
           a cue word.

For each variant it prints every text whose (current_salary, expected_salary) differs from
BEFORE's. Stdlib and git only. All inputs are fabricated. Re-run on the commit you judge.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

AI_SERVICE = Path(__file__).resolve().parents[1]
REPO = AI_SERVICE.parents[1]
sys.path.insert(0, str(AI_SERVICE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import measure_cued_id_linear as linear  # noqa: E402
from measure_title_employer_bound import distinct  # noqa: E402

from app.profiling import lexicon, signals  # noqa: E402

# --- the variants ---------------------------------------------------------------------------------

#: The guard as #1950 shipped it (lexicon `credentialBefore`, `{WE}` unexpanded).
BEFORE = (
    r"(?:roll|reg|regd|regn|registration|certificate|cert|enrol(?:l)?ment|licence|license|ncvt|"
    r"scvt|nsqf|nsdc){WE}\.?(?:\s+(?:ka|ki|ke|mera|meri))?\s*(?:(?:no\.?|number|num|#)\s*)?"
    r"(?:[:-]-?\s*)?[A-Za-z0-9/-]{0,20}$"
)
#: The résumé cues #2043 adds.
SHIPPED_CUES = ["passport", "voter", "gstin", "uan", r"provident\s+fund", "ifsc", "dob",
                r"date\s+of\s+birth"]  # fmt: skip
#: The résumé cues measured and left out: each sits right before a real wage.
LEFT_OUT = ["esic", "account", "a/c"]
#: The connector's "no"-word slot, and #2043's, which also reads "id" ("Voter ID ABC1234567") as
#: the G1/G2 résumé rule's connector does.
NO_WORD = r"(?:no\.?|number|num|#)"
NO_WORD_2043 = r"(?:no\.?|number|num|id|#)"


def with_cues(extra: list[str], *, boundary: bool, id_word: bool = True) -> str:
    """BEFORE with `extra` cues added to the group, an optional leading `{WB}` and the "id" word."""
    source = BEFORE.replace("|nsdc)", "|nsdc|" + "|".join(extra) + ")", 1) if extra else BEFORE
    if id_word:
        source = source.replace(NO_WORD, NO_WORD_2043, 1)
    return ("{WB}" if boundary else "") + source


def shipped_source() -> str:
    """The guard #2043 ships, which must be BEFORE with exactly #2043's edits."""
    source = lexicon.load("salary")["credentialBefore"]["source"]
    assert source == with_cues(SHIPPED_CUES, boundary=True), source
    return source


def variants() -> dict[str, str]:
    out = {
        "boundary only ({WB})": with_cues([], boundary=True, id_word=False),
        "boundary + the id word": with_cues([], boundary=True),
        "shipped (#2043): boundary + id word + the identifier cues": shipped_source(),
        "shipped + esic, account, a/c (rejected)": with_cues(
            SHIPPED_CUES + LEFT_OUT, boundary=True
        ),
    }
    for cue in SHIPPED_CUES + LEFT_OUT:
        out[f"  one cue: {cue}"] = with_cues([cue], boundary=True)
    return out


@contextmanager
def guard(source: str) -> Iterator[None]:
    """`signals.detect` with the guard compiled from ``source``, restored on exit."""
    saved = signals._CREDENTIAL_BEFORE_RE
    signals._CREDENTIAL_BEFORE_RE = lexicon.compile_pattern({"source": source, "flags": "i"})
    try:
        yield
    finally:
        signals._CREDENTIAL_BEFORE_RE = saved


def reading(text: str) -> tuple[object, object]:
    sig = signals.detect(text)
    return sig.current_salary, sig.expected_salary


# --- the corpora ----------------------------------------------------------------------------------

IDS = [
    "Passport No. M123456",
    "Passport No: K1234567",
    "Passport.No. M123456",
    "passport number Z7654321 hai",
    "Voter ID ABC1234567",
    "Voter ID: ABC1234567",
    "voter id no XYZ9876543",
    "UAN 101234567890",
    "UAN no: 100123456789",
    "mera UAN number 100987654321 hai",
    "ESIC no 3112345678",
    "ESIC number 1234567890",
    "Provident Fund no MH/BAN/12345/678",
    "provident fund number 45678",
    "GSTIN 27ABCDE1234F1Z5",
    "IFSC SBIN0001234",
    "IFSC code HDFC0004321",
    "DOB 12/05/1988",
    "Date of Birth: 05-11-1990",
    "dob 1995",
    "A/c no 1234567890",
    "Account No: 50100234567890",
    "account number 004512345678",
]

WAGES = [
    # account / a/c right before a figure
    "salary account 25000 aata hai",
    "a/c: 18000 credit hota hai",
    "account me 22000 aate hain",
    "account mein 25000 aata hai",
    "har mahine account 15000 credit",
    "bank account se 20000 milta hai",
    # PF / ESIC / UAN talk beside a wage
    "PF ESIC ke saath 18000 milta hai",
    "PF katke 15000 haath me",
    "ESIC 15000 milta hai",
    "esic aur pf ke baad 16500",
    "UAN hai, salary 20000",
    "uan number nahi hai, 18000 chahiye",
    "provident fund kat ke 17000",
    # passport / voter / dob near a wage
    "passport hai, 30000 chahiye gulf ke liye",
    "passport ready hai 45000 chahiye",
    "voter card hai 12000 milta hai",
    "dob 1995, salary 18000",
    "date of birth 12/05/1995 hai aur 20000 chahiye",
    # ifsc / gstin near a wage
    "ifsc diya hai, 21000 aayega",
    "gstin wali company 24000 de rahi",
    # payroll (the #1950 review nit)
    "Company payroll. 18000 milta hai",
    "on payroll:- 18000 milta hai",
    "payroll 18000",
    "payroll: 18000",
    "company payroll pe 19000",
]


def lexicon_texts() -> list[str]:
    path = REPO / "packages" / "profiling-lexicon" / "__fixtures__" / "utterances.jsonl"
    return [
        json.loads(line)["text"]
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


CUE_WORD = re.compile(
    r"roll|reg|cert|licen|ncvt|scvt|nsqf|nsdc|enrol|passport|voter|gstin|uan|esic|provident|"
    r"ifsc|dob|birth|account|a/c",
    re.IGNORECASE,
)


def repo_texts() -> list[str]:
    strings = distinct(linear.corpus())
    return [s for s in strings if any(c.isdigit() for c in s) and CUE_WORD.search(s)]


# --- the run --------------------------------------------------------------------------------------


def main() -> None:
    corpora = {
        "ids": IDS,
        "wages": WAGES,
        "lexicon": lexicon_texts(),
        "repo": repo_texts(),
    }
    print({name: len(texts) for name, texts in corpora.items()})
    with guard(BEFORE):
        base = {name: [reading(t) for t in texts] for name, texts in corpora.items()}
    for label, source in variants().items():
        with guard(source):
            moved = [
                (name, text, before, reading(text))
                for name, texts in corpora.items()
                for text, before in zip(texts, base[name], strict=True)
                if reading(text) != before
            ]
        print(f"\n{label}: {len(moved)} moved")
        for name, text, before, after in moved:
            print(f"  [{name:7}] {text[:70]!r:74} {before} -> {after}")


if __name__ == "__main__":
    main()
