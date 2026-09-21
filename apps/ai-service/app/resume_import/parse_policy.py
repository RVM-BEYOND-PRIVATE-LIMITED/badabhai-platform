"""THE TWO WALLS OF THE RÉSUMÉ PARSE, AND WHY THEY ARE NOT THE SAME WALL.

READ THIS FILE FIRST. It is the whole privacy surface of RI-3; everything else in the
package is plumbing around the two functions below.

ADR-0041 D5, as amended on 2026-09-10 ("go fully raw no need to hide anything to the ai
right now"), sends an uploaded résumé to the model **unmasked** — employer names,
government identifiers, phone and email included. That is a narrow, signed override of
CLAUDE.md §2 for one route, and it moves exactly ONE of the two questions this module
answers:

    INPUT   what may reach the MODEL.     ← D5 moved this, behind a flag.
    OUTPUT  what may reach the DATABASE.  ← D5 did not move this. §3.3 says so:
            "a PAN must still never reach `worker_attributes`, an event, a log, or
            the sheet."

**COLLAPSING THOSE INTO ONE MASKER IS THE FAILURE MODE THIS FILE EXISTS TO PREVENT.**
The obvious implementation — pick a masker from the flag and pass it to both
`mask_resume_lines` and `apply_parse_gates(certify=...)` — reads as symmetric and is
catastrophic: with the flag on, `passthrough_masker` certifies everything, gate 6 becomes
a function that always returns None, and the first résumé carrying a PAN writes it into
`worker_attributes`. The flag would have silently disabled the wall that the ruling
explicitly said to keep. Hence two separately-named functions, no shared parameter, and
`resume_value_certifier` taking no policy argument at all — there is no expression in
this module that can point the output wall at the input policy.

WHY THE OUTPUT WALL IS NOT THE FULL GATEWAY EITHER. `pseudonymize` masks employer names,
person names and money amounts, and D5 authorises employer names straight into
`employer_name_enc`. `_EMPLOYER_RE` also over-fires on ordinary trade vocabulary —
"Stainless Steel" and "Diploma Mechanical Engineering" both come back as `[EMPLOYER_1]`,
which is why `certified_clean_skill_labels` exists at all. Certifying résumé values with
the full gateway would reject nearly every honest value while the ruling says to keep
them. So the output wall is `contains_hard_identifier`: a NARROWING of gate 6 to the
classes no ruling has moved, not a disabling of it.

THE `right now` IN THE RULING IS LOAD-BEARING. This is the alpha posture, not a permanent
property of the design, so the input policy is a SWITCH — `default_masker` when the flag
is off, `passthrough_masker` when it is on — and never a prompt builder with the masking
step deleted. Tightening it later is a config change plus a test, not a re-plumb.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..profiling.parse_masking import Masker, default_masker, passthrough_masker
from ..pseudonymize import contains_hard_identifier
from .extract import Line


@dataclass(frozen=True)
class MaskedLines:
    """Résumé lines as the MODEL will see them. Never leaves the process."""

    lines: tuple[Line, ...]
    #: Counts only — a line the gateway refused is by definition the last text that may
    #: be logged.
    dropped: int = 0


def input_masker(*, raw_text_enabled: bool) -> Masker:
    """What reaches the MODEL. The one thing ADR-0041 D5 moved.

    KEYWORD-ONLY AND EXPLICIT, never read off the settings singleton in here. The
    security review's question is "who can turn masking off, and from where" — a function
    that reaches for global settings has the answer "anything that imports it", while this
    one has the answer "its caller, in the one route that calls it".
    """
    return passthrough_masker if raw_text_enabled else default_masker


def mask_resume_lines(lines: list[Line], mask: Masker) -> MaskedLines:
    """Mask each line ON ITS OWN, never the concatenated document.

    THE SAME BUG `parse_masking` WAS WRITTEN TO FIX, and a résumé walks into it harder
    than an interview does. `pseudonymize` refuses any input over 20,000 characters as a
    fail-closed guard; a three-page résumé concatenated is comfortably past that, so a
    whole-document call would return `blocked` and hand every uploading worker an empty
    parse — punished precisely for having a full career.

    A blocked line is DROPPED AND COUNTED, never fatal: the rest of the document is still
    a real résumé. And `index` is PRESERVED on survivors rather than renumbered, because
    `index` is what the model cites and what gate 1 resolves a citation by. Renumbering
    after a drop would silently re-point every citation at a different line.
    """
    kept: list[Line] = []
    dropped = 0
    for line in lines:
        blocked, text = mask(line.text)
        if blocked or not text.strip():
            dropped += 1
            continue
        kept.append(Line(index=line.index, page=line.page, text=text))
    return MaskedLines(lines=tuple(kept), dropped=dropped)


def resume_value_certifier(text: str) -> tuple[bool, str]:
    """What reaches the DATABASE. Gate 6's wall for this route, and NOT switchable.

    TAKES NO POLICY ARGUMENT ON PURPOSE. `apply_parse_gates` wants a
    `(text) -> (blocked, certified)` certifier, which is the same shape as a `Masker` —
    so a `certify=` parameter here would make it a one-character edit to hand gate 6 the
    input policy and turn the raw-text flag into a silent PII leak. There is deliberately
    no such parameter to fill in.

    Returns `(blocked, text)` and NEVER a rewritten string. Gate 6 rejects on `blocked`
    OR on `certified != item`, and rewriting would record that the worker's résumé said
    something it did not. A value carrying a hard identifier is refused outright; that is
    the whole decision.
    """
    return contains_hard_identifier(text) is not None, text
