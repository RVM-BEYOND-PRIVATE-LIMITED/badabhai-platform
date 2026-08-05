"""The one-shot opener — the first line a worker ever reads.

LIFTED VERBATIM from the deleted `question_bank.py`, and it must STAY byte-identical:
`apps/worker-app/test/persona_neutrality_test.dart` pins the Flutter constant
`kChatOpeningText` against this string. In production the client renders the opener
itself so `/chat/session` takes no network hop at all, which means the two copies can
drift silently — the Dart test is the only thing that catches it. Change one, change
both, in the same PR.

Deliberately NOT model-generated, unlike every other turn. Three reasons:

  * It is served before the worker has said anything, so there is nothing for a model
    to adapt to. A real call here would buy variation nobody asked for.
  * The client renders it locally, so a generated opener could not reach the worker
    without adding a round trip to session creation.
  * It must be INERT to the extraction pass. The opener enters the transcript as an
    assistant line, and a question that keys the detector would fabricate fields the
    worker never answered — a defect the bank's own notes documented at length. A fixed,
    measured string is what keeps that property checkable.

It carries NO vocative, which is what keeps this module PII-free by construction.
"""

from __future__ import annotations

ONE_SHOT_OPENER: str = (
    "Namaste. Main aapka Bada Bhai. Chalo, ab aapka accha sa resume banate hain. "
    "Chaliye shuru karte hain — aap kaunsa kaam karte hain?"
)


def one_shot_opener_for(role_family: str | None) -> str:
    """The opener for a role family. Every trade shares one copy today.

    Takes `role_family` so a trade could diverge later without a caller change, but the
    shared copy is CORRECT rather than lazy: the opener is a greeting plus the neutral
    "what work do you do" question, naming no machine, controller or software. Being
    trade-free is precisely why a worker in a trade we have never seen gets exactly the
    same first message as everyone else — the "same warmth, plainer voice" the persona
    asks for, achieved by not having a trade-specific opener at all.
    """
    _ = role_family  # accepted for forward compatibility; copy is shared today
    return ONE_SHOT_OPENER
