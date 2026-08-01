"""Permanent persona-neutrality regression net (AI-PERSONA-1).

The profiling bot must sound like an efficient senior, not a gushing one. This
locks the WORKER-FACING output strings — the interview questions, the
acknowledgement, the wrap-up, the follow-up nudges, the extractor clarifications,
and the CLI's own copy — against every banned vocative, gush token, and tum-form,
and caps each question at 20 words.

Two subtleties this test bakes in on purpose:

- The persona is NAMED "Bada Bhai", so the proper noun legitimately appears in
  worker-facing copy (the bot introduces itself). We strip the bigram "Bada Bhai"
  before scanning, so the brand name is exempt but a bare "bhai" VOCATIVE is not.
- The SYSTEM PROMPTS must literally list the banned words to forbid them, so they
  are checked differently: we assert they ENFORCE the rules (mandate "aap", cap
  the words, forbid praise/restating) rather than that they are free of the words
  they ban.
"""

from __future__ import annotations

import re

from app.ai.model_config import get_route
from app.cli import onboarding_chat
from app.main import _BLOCKED_REPLY
from app.profiling import interview_engine, prompts
from app.profiling.profile_extractor import _CLARIFY
from app.profiling.question_bank import _TOPICS_BY_FAMILY, ONE_SHOT_OPENER, topics_for

# EVERY role family, not just cnc_vmc. THE HOLE THIS CLOSES: every scan in this file
# used to iterate `topics_for("cnc_vmc")` only, so five families' worth of questions,
# retry wordings and chips — welding, plumbing, carpentry, design, interior_design, and
# now generic — faced NO persona net at all. A banned vocative, a bundled two-part ask
# or a 25-word question could have shipped in any of them and every test here stayed
# green. Derived from the bank so the next family added is covered on the day it lands.
ALL_FAMILIES = tuple(_TOPICS_BY_FAMILY)


def _all_topics():
    """Every (family, Topic) pair in the product. De-duplication is deliberate: the
    shared topics are the SAME objects in every family, so scanning them once per
    family is redundant but harmless, and keeping the family label makes a failure
    message say which bank to look in."""
    for family in ALL_FAMILIES:
        for topic in topics_for(family):
            yield family, topic

# Banned in any worker-facing line (checked AFTER stripping the "Bada Bhai" brand).
#
# SOURCED FROM THE RATIFIED SHEET, docs/specs/persona-system-v3.2.md §3 "Never says":
#
#   waah · zabardast · shabaash · bahut acha (as praise of the person) · great ·
#   perfect · awesome · excellent · congratulations · badhai · bhai · bhaiya · beta ·
#   behen · yaar · tu · tum · guarantee · pakka job · interview (for this chat) ·
#   any exclamation mark · any emoji
#
# The lists below are a SUPERSET of that: every sheet token is present, plus the
# repo's own tum-form phrases. `test_the_banned_lists_cover_every_sheet_token` pins
# the superset relation so a sheet token cannot be dropped by accident.
#
# ONE DELIBERATE DEPARTURE, recorded rather than silently kept: "bilkul" was in this
# file's gush list, but §3 lists **"Bilkul."** as a PERMITTED acknowledgement. The ban
# is retained because nothing in the product says it (measured: 0 hits across every
# worker-facing string) and an unused permitted word is cheaper to keep banned than to
# re-litigate — but it is a place where this test is STRICTER than the sheet, not a
# place where the sheet was misread.
_BANNED_VOCATIVE = ("bhai", "bhaiya", "beta", "behen", "yaar")
_BANNED_INFORMAL = ("tu", "tum")  # whole word only
_BANNED_GUSH = (
    "waah",
    "zabardast",
    "bahut acha",
    "bahut accha",
    "bilkul",  # stricter than §3 — see the note above
    "shabaash",
    # §3 additions (English gush + congratulation, none of which occurred):
    "great",
    "perfect",
    "awesome",
    "excellent",
    "congratulations",
    "badhai",
)
_BANNED_TUMFORM = ("karte ho", "karoge", "karna pasand karoge")
# §3 + §7 Honesty: a promise, and the word "interview" for THIS chat (it is a
# profiling conversation; calling it an interview sets an expectation we cannot keep).
_BANNED_PROMISE = ("guarantee", "pakka job", "interview")

# §3 Acknowledgements — a CLOSED set, "nothing else", max 3 words.
_SHEET_ACKNOWLEDGEMENTS = (
    "Theek hai.",
    "Achha.",
    "Samajh gaya.",
    "Note kar liya.",
    "Chalo.",
    "Bilkul.",
)
# §3 Appreciation — the only four permitted, max 2 per conversation. The engine emits
# ZERO (owner ruling 2026-07-31: keep the neutral ack, build no appreciation engine —
# and 0 is inside the ≤2 budget). Listed so the "zero" claim is checked against the
# real vocabulary rather than against nothing.
_SHEET_APPRECIATIONS = ("Bahut khoob.", "Bahut bhadiya.", "Achha, badhiya.", "Solid.")
# §3 Softening — the two permitted lines. NEITHER is implemented (see the gap tests).
_SHEET_SOFTENERS = ("Koi baat nahi.", "Samajh sakta hoon.")
# §7 Memory — the deictics that break "every turn must stand alone" (Law 10).
_SHEET_DEICTICS = ("usme", "wahan", "uske baare mein")

_BRAND = re.compile(r"bada\s+bhai", re.IGNORECASE)

# §3 bans the word "guarantee" — meaning never PROMISE one. §5's own sanctioned line
# REFUSES one in its first three words ("Guarantee nahi de sakta — ..."), so the token
# is stripped before the promise scan, exactly as the brand name is stripped before the
# vocative scan. `test_the_word_guarantee_only_ever_appears_as_a_refusal` is the guard
# that stops this becoming a loophole.
_SANCTIONED_REFUSAL = re.compile(r"guarantee\s+nahi\s+de\s+sakta", re.IGNORECASE)


def _strip_brand(text: str) -> str:
    """Remove the proper-noun 'Bada Bhai' so the brand name never trips the
    vocative scan (only a bare 'bhai' addressed AT the worker is banned), and the
    sanctioned refusal so the honest "Guarantee nahi de sakta" is not read as a
    promise."""
    return _SANCTIONED_REFUSAL.sub("", _BRAND.sub("", text))


def _has_word(text: str, word: str) -> bool:
    return re.search(rf"\b{re.escape(word)}\b", text, re.IGNORECASE) is not None


def _worker_facing_strings() -> dict[str, str]:
    """Every string the WORKER reads as the bot's own words, ACROSS EVERY FAMILY."""
    out: dict[str, str] = {}
    for family, topic in _all_topics():
        out[f"{family}:question:{topic.id}"] = topic.question
        # INTERVIEW-1: the bounded RE-ask wording is worker-facing too.
        if topic.retry_question is not None:
            out[f"{family}:retry_question:{topic.id}"] = topic.retry_question
        # A tapped chip is echoed into the transcript as the worker's own message, but
        # it is also SHOWN as our copy — so it faces the same net.
        for i, option in enumerate(topic.options):
            out[f"{family}:option:{topic.id}:{i}"] = option
    out["ack"] = interview_engine._ACK
    # §5's acknowledgement variants + the guarantee line. Worker-facing in exactly the
    # same sense as the neutral ack — they occupy the same slot in the served turn —
    # so they face the same net (banned vocative/gush/tum-form/promise, no exclamation,
    # no emoji, no deictic).
    out["ack_dont_know"] = interview_engine._ACK_DONT_KNOW
    out["ack_hardship"] = interview_engine._ACK_HARDSHIP
    out["ack_abusive"] = interview_engine._ACK_ABUSIVE
    out["guarantee_line"] = interview_engine._GUARANTEE_LINE
    out["wrap_up"] = interview_engine._WRAP_UP
    for i, f in enumerate(interview_engine.suggested_followups("cnc_vmc")):
        out[f"followup:{i}"] = f
    for field, q in _CLARIFY.items():
        out[f"clarify:{field}"] = q
    # The PSEUDONYMIZATION-BLOCKED reply. Worker-facing in the strongest sense: apps/api
    # STORES it as an outbound chat message, so it enters the transcript AND the
    # extraction corpus. It was English ("Sorry, I couldn't process that safely...") in a
    # Hinglish product; pinned here so it can never drift back out of persona.
    out["blocked_reply"] = _BLOCKED_REPLY
    # The CLI's own worker-facing copy. CLI-1: the CLI no longer has a model-driven
    # path of its own — it drives THIS engine. Its only remaining own-words are the
    # intro banner: the "type anything to begin" kickoff nudge is GONE (the opener is
    # now interview_engine.first_question), so every question it shows — the opening
    # one included — comes from the question bank above.
    out["cli_intro"] = onboarding_chat._INTRO
    # The one-shot opener is worker-facing copy too, so it faces the same
    # banned-vocative / gush / tum-form net as every question in the bank.
    out["one_shot_opener"] = ONE_SHOT_OPENER
    return out


def test_no_worker_facing_string_contains_a_banned_token():
    for name, raw in _worker_facing_strings().items():
        scanned = _strip_brand(raw)
        low = scanned.lower()
        for w in _BANNED_VOCATIVE:
            assert not _has_word(scanned, w), f"{name}: banned vocative {w!r} in {raw!r}"
        for w in _BANNED_INFORMAL:
            assert not _has_word(scanned, w), f"{name}: informal {w!r} in {raw!r}"
        for g in _BANNED_GUSH:
            assert g not in low, f"{name}: gush {g!r} in {raw!r}"
        for tf in _BANNED_TUMFORM:
            assert tf not in low, f"{name}: tum-form {tf!r} in {raw!r}"
        for p in _BANNED_PROMISE:
            assert not _has_word(scanned, p), f"{name}: promise/expectation {p!r} in {raw!r}"


# --- §3 / §7, enforced against the RATIFIED SHEET ----------------------------
# docs/specs/persona-system-v3.2.md. These exist because the sheet states rules the
# older tests here either compressed or omitted entirely — and a persona rule that is
# only in a document is a rule that drifts.


def test_the_banned_lists_cover_every_sheet_token():
    """The superset relation, asserted rather than assumed. Every token §3's "Never
    says" row names must be banned SOMEWHERE in this file."""
    sheet_never_says = (
        "waah zabardast shabaash great perfect awesome excellent congratulations badhai "
        "bhai bhaiya beta behen yaar tu tum guarantee interview"
    ).split() + ["bahut acha", "pakka job"]
    banned = set(
        _BANNED_VOCATIVE + _BANNED_INFORMAL + _BANNED_GUSH + _BANNED_TUMFORM + _BANNED_PROMISE
    )
    missing = [t for t in sheet_never_says if t not in banned]
    assert missing == [], f"§3 tokens not banned anywhere: {missing}"


def test_no_worker_facing_string_carries_an_exclamation_mark_or_an_emoji():
    """§3 bans "any exclamation mark" and "any emoji" WITHOUT qualification, and §7
    repeats the no-exclamation rule in the pre-ship checklist.

    THE ONE VIOLATION THIS CLOSES: `ONE_SHOT_OPENER` shipped as "Namaste! Main aapka
    Bada Bhai…" — the sheet names it by file and constant. It is now "Namaste." and
    must stay byte-identical to the Flutter twin (`kChatOpeningText`).
    """
    for name, raw in _worker_facing_strings().items():
        assert "!" not in raw, f"{name}: exclamation mark in {raw!r}"
        # Emoji/pictographs all sit far above the Latin/Devanagari ranges this product
        # writes in; the em dash (U+2014) and the danda (U+0964) are below the cut.
        offenders = [c for c in raw if ord(c) > 0x2190]
        assert offenders == [], f"{name}: emoji/symbol {offenders} in {raw!r}"


def test_the_acknowledgement_set_is_CLOSED_and_the_engine_uses_one_of_them():
    """§3: the acknowledgements are a closed list — "nothing else" — capped at 3 words.
    Both the neutral ack and the abusive-turn line come from that set."""
    for name in ("_ACK", "_ACK_ABUSIVE"):
        ack = getattr(interview_engine, name).strip()
        assert ack in _SHEET_ACKNOWLEDGEMENTS, f"{name}={ack!r} is not a §3 acknowledgement"
    for permitted in _SHEET_ACKNOWLEDGEMENTS:
        assert len(permitted.split()) <= 3, permitted


def test_the_two_softeners_are_the_sheets_own_strings_and_nothing_else():
    """§3 Softening lists exactly two lines, and §5 pins where each fires. They must be
    byte-identical to the sheet — a softener is the most emotionally loaded copy in the
    product, so it is not a place for a paraphrase."""
    assert interview_engine._ACK_DONT_KNOW.strip() == "Koi baat nahi."
    assert interview_engine._ACK_HARDSHIP.strip() == "Samajh sakta hoon."
    assert set(_SHEET_SOFTENERS) == {
        interview_engine._ACK_DONT_KNOW.strip(),
        interview_engine._ACK_HARDSHIP.strip(),
    }
    # §5's shape budget for the hardship line, stated in the sheet as "<=8 words".
    assert len(interview_engine._ACK_HARDSHIP.split()) <= 8


def test_the_guarantee_line_is_the_sheets_own_string_and_asks_nothing():
    """§5 / conversation 06, verbatim. It occupies the acknowledgement slot and carries
    NO question of its own, so the turn it prefixes still has exactly one "?"."""
    line = interview_engine._GUARANTEE_LINE
    assert line.strip() == "Guarantee nahi de sakta — profile poora hoga toh companies dekhengi."
    assert "?" not in line
    assert "!" not in line


def test_the_word_guarantee_only_ever_appears_as_a_refusal():
    """The guard on the `_strip_brand` carve-out above, so stripping the sanctioned
    refusal cannot become a loophole: every worker-facing occurrence of "guarantee"
    must be inside the exact phrase "Guarantee nahi de sakta"."""
    for name, raw in _worker_facing_strings().items():
        occurrences = len(re.findall(r"guarantee", raw, re.IGNORECASE))
        refusals = len(_SANCTIONED_REFUSAL.findall(raw))
        assert occurrences == refusals, f"{name}: 'guarantee' outside a refusal in {raw!r}"


def test_the_engine_emits_zero_appreciations_which_is_inside_the_two_per_chat_budget():
    """§3 allows at most 2 appreciations, earned, work-aimed, never before turn 3.
    OWNER RULING 2026-07-31: keep the neutral ack and build NO appreciation engine —
    0 is inside the budget. This pins the ZERO so an appreciation cannot appear
    without a deliberate decision, and pins it against the sheet's real vocabulary
    rather than against an empty list.

    Swept over four worker personas so it is a property of the engine, not of one path.
    """
    for reply_for in (
        lambda _tid: "theek hai ji",
        lambda _tid: "haan",
        lambda _tid: "vmc chalata hu",
        lambda _tid: "nahi pata",
    ):
        state, served = None, []
        for _ in range(interview_engine.MAX_ENGINE_ASKS + 1):
            reply, asked_id, state, _ready = interview_engine.next_turn(
                state, reply_for(None), "cnc_vmc"
            )
            served.append(reply)
            if asked_id is None:
                break
        text = "\n".join(served).lower()
        for appreciation in _SHEET_APPRECIATIONS:
            assert appreciation.lower() not in text, f"appreciation {appreciation!r} emitted"


def test_no_worker_facing_string_uses_a_deictic_that_breaks_law_10():
    """§7 Memory / Law 10 — "every turn must stand alone". No "usme", "wahan", "uske
    baare mein": each answer is parsed WITHOUT the transcript, so a turn that points
    back at an earlier one cannot be understood by the detector either."""
    for name, raw in _worker_facing_strings().items():
        for deictic in _SHEET_DEICTICS:
            assert deictic not in raw.lower(), f"{name}: deictic {deictic!r} in {raw!r}"


def test_the_bot_never_asks_the_worker_for_their_name():
    """§2 Law 5 / §7 Address: "Never ask for the name. It is already on the account."

    Scoped to asking for the WORKER's name — "machine ka naam bataiye" (the name of the
    machine) is legal and common in the bank, and the blocked reply legitimately tells
    the worker NOT to type their full name."""
    asks_for_name = re.compile(r"(aapka|apna|aapke)\s+(poora\s+)?naam|your\s+name", re.IGNORECASE)
    for name, raw in _worker_facing_strings().items():
        if name == "blocked_reply":
            continue  # tells them NOT to send it — the opposite of asking
        assert not asks_for_name.search(raw), f"{name} asks for the worker's name: {raw!r}"


def test_every_interview_question_is_under_20_words():
    for family, topic in _all_topics():
        n = len(topic.question.split())
        assert n <= 20, f"{family}:{topic.id} question is {n} words: {topic.question!r}"


def test_every_retry_question_is_one_ask_under_20_words_and_actually_different():
    # INTERVIEW-1: the re-ask must obey B-5 (exactly one "?") and the 20-word cap,
    # and must NOT be the same string — re-serving verbatim reads as broken.
    for family, topic in _all_topics():
        rq = topic.retry_question
        if rq is None:
            continue
        assert rq.count("?") == 1, f"{family}:{topic.id} retry bundles asks: {rq!r}"
        assert len(rq.split()) <= 20, (
            f"{family}:{topic.id} retry is {len(rq.split())} words: {rq!r}"
        )
        assert rq != topic.question, f"{family}:{topic.id} retry is a verbatim re-serve"


def test_every_re_askable_essential_topic_has_a_retry_question():
    # Only ESSENTIAL topics are ever re-asked, and each must have distinct wording —
    # in EVERY family, using that family's own essentials (S1).
    for family in ALL_FAMILIES:
        for topic_id in interview_engine.essentials_for(family):
            topic = next(t for t in topics_for(family) if t.id == topic_id)
            assert topic.retry_question is not None, f"{family}:{topic_id}"


# --- B-5: ONE question per turn ---------------------------------------------
# docs/registers/context-drift-2026-07-16.md row B-5 (owner ruling 2026-07-17):
# 4 bank questions bundled two asks, and the register notes the existing persona
# test "counts WORDS, not questions, so it passes". These close that gap: they
# count ASKS. Bundled asks are now sequential topics — a longer flow is expected
# and correct per the locked decision.


def _ask_count(text: str) -> int:
    """Number of asks in a served turn = number of '?' terminators. A question may
    LIST alternatives ("Fanuc, Siemens ya Haas?") — that is ONE ask, one '?'."""
    return text.count("?")


def test_every_bank_question_is_exactly_one_ask():
    for family, topic in _all_topics():
        n = _ask_count(topic.question)
        assert n == 1, f"{family}:{topic.id} bundles {n} asks: {topic.question!r}"


def test_no_bank_question_conflates_current_and_preferred_location():
    # B-4's half of the same ruling, asserted on the question layer: the two
    # location topics exist and neither asks both — in every family.
    for family in ALL_FAMILIES:
        ids = {t.id for t in topics_for(family)}
        assert {"current_location", "preferred_locations"} <= ids, family
        assert "location" not in ids, family  # the conflated topic is gone


def test_no_chip_in_any_family_is_a_question():
    """A tapped chip is sent verbatim as the worker's message, so a chip that is a
    QUESTION puts a question in the worker's mouth. tests/test_answer_chips.py owns the
    detector-resolution property for cnc_vmc; this owns the cheap shape check for ALL
    families, which is the half that was never swept."""
    for family, topic in _all_topics():
        for option in topic.options:
            assert "?" not in option, f"{family}:{topic.id}: {option!r} is a question"
            assert len(option.split()) <= 6, f"{family}:{topic.id}: {option!r} is not a chip"


def test_every_served_turn_asks_exactly_one_question():
    # The turn the WORKER actually receives (vocative/ack + question) must carry
    # exactly one ask — this is what the register's word-count test missed. Swept over
    # every family, since each one serves its own wording.
    for family in ALL_FAMILIES:
        _tid, opening = interview_engine.first_question(family)
        assert _ask_count(opening) == 1, (family, opening)

        state = None
        seen = 0
        # Drive the interview with a non-answer so every topic is served in turn.
        for _ in range(interview_engine.MAX_ENGINE_ASKS + 1):
            reply, asked_id, state, _ready = interview_engine.next_turn(
                state, "theek hai ji", family
            )
            if asked_id is None:  # wrap-up: a statement, no ask
                assert _ask_count(reply) == 0, (family, reply)
                break
            assert _ask_count(reply) == 1, f"[{family}] turn asked {_ask_count(reply)}: {reply!r}"
            seen += 1
        assert seen >= len(topics_for(family)), family  # the whole bank was served


def test_clarify_reserve_turn_also_carries_exactly_one_ask():
    # The COST-4 clarify path re-serves the last question verbatim — still one ask,
    # in every family.
    from app.contracts import ConversationState

    for family, topic in _all_topics():
        st = ConversationState(role_family=family, asked_question_ids=[topic.id], turn_count=1)
        out = interview_engine.clarify_turn(st, "matlab kya?", family)
        assert out is not None, f"{family}:{topic.id}"
        assert _ask_count(out[0]) == 1, f"{family}:{topic.id} re-serve: {out[0]!r}"


def test_followups_and_clarifications_are_one_ask_each():
    for f in interview_engine.suggested_followups("cnc_vmc"):
        assert _ask_count(f) == 1, f
    for field, q in _CLARIFY.items():
        assert _ask_count(q) == 1, f"clarify {field}: {q!r}"


def test_clarify_and_followup_questions_are_under_20_words():
    for field, q in _CLARIFY.items():
        assert len(q.split()) <= 20, f"clarify {field}: {q!r}"
    for f in interview_engine.suggested_followups("cnc_vmc"):
        assert len(f.split()) <= 20, f"followup: {f!r}"


def test_ack_is_at_most_two_words():
    assert len(interview_engine._ACK.split()) <= 2, interview_engine._ACK


# --- the pseudonymization-BLOCKED reply --------------------------------------
# It is stored as an outbound chat message, so it enters the worker's transcript and
# the extraction corpus — the strongest sense of "worker-facing copy" in this service.
# The generic net above already scans it for vocatives / gush / tum-forms (it is in
# _worker_facing_strings); these add the shape rules that net does not cover.


def test_the_blocked_reply_is_persona_compliant_hinglish():
    reply = _BLOCKED_REPLY
    assert "!" not in reply, "no exclamation mark — the bot does not shout at a worker"
    assert all(ord(ch) < 0x2190 for ch in reply), f"emoji/symbol in {reply!r}"
    sentences = [s for s in reply.split(".") if s.strip()]
    assert len(sentences) <= 2, f"{len(sentences)} sentences: {reply!r}"
    assert all(len(s.split()) <= 12 for s in sentences), reply
    # "aap" form, and no English apology/persona break.
    assert "aap" in reply.lower()
    for english in ("sorry", "please", "rephrase", "process", "safely", "error"):
        assert english not in reply.lower(), f"{english!r} in {reply!r}"


def test_the_blocked_reply_says_what_to_do_and_never_explains_our_internals():
    """It must be ACTIONABLE — the worker has to know what to change — without leaking
    that a privacy gateway, a rule or a token exists."""
    low = _BLOCKED_REPLY.lower()
    assert "dobara" in low  # ...try again
    assert "phone number" in low and "naam" in low  # ...without these
    for internal in ("pseudony", "token", "gateway", "block", "system", "server", "ai", "llm"):
        assert internal not in low, f"internal detail {internal!r} in {_BLOCKED_REPLY!r}"


def test_the_blocked_reply_is_what_the_endpoint_actually_serves():
    """Pinned through the ROUTE, so the constant cannot drift away from the wire."""
    from fastapi.testclient import TestClient

    from app.main import app

    body = (
        TestClient(app)
        .post(
            "/profiling/respond",
            json={
                "session_id": "11111111-1111-4111-8111-111111111111",
                "worker_ref": "w-blocked",
                # A 9-digit zero-led run: not phone-shaped, not an in-range amount, so
                # it survives to the residual-digit net -> the gateway BLOCKS.
                "message_text": "mera number 01234567 hai",
                "role_family": "cnc_vmc",
            },
        )
        .json()
    )
    assert body["blocked"] is True
    assert body["reply_text"] == _BLOCKED_REPLY


def test_system_prompts_enforce_the_neutrality_rules():
    # These are INSTRUCTIONS: they must name the banned words to forbid them, so
    # we assert they ENFORCE the persona rather than that they are token-free.
    # CLI-1: there is only ONE chat system prompt now. The CLI used to carry a
    # second, divergent copy for its own model-driven loop; it now calls
    # build_chat_messages, so BADA_BHAI_SYSTEM_PROMPT is the single source.
    for label, p in (("engine", prompts.BADA_BHAI_SYSTEM_PROMPT.lower()),):
        assert "aap" in p, label
        assert "20 word" in p, label
        assert "gender" in p, label  # "Never assume gender"
        assert "bhai" in p, label  # names the banned vocatives in a NEVER clause
        assert "waah" in p, label  # names the banned gush tokens
        assert "praise" in p or "gush" in p, label


def test_chat_turn_instruction_is_capped_and_forbids_praise():
    msgs = prompts.build_chat_messages([], "Kitne saal ka experience hai?", "vmc operator")
    instr = msgs[-1]["content"].lower()
    assert "20 word" in instr
    assert "no praise" in instr
    assert "restate" in instr
    assert "waah" in instr


_PLACEHOLDER = interview_engine.WORKER_NAME_PLACEHOLDER  # "{{worker_name}}"

_FULL_ANSWER = (
    "vmc operator, 4 saal, setting aur drawing reading karta hu, faridabad me hu pune chalega"
)

_UNSET = object()


def _drive_to_close(worker_name=_UNSET):
    """Run the interview to its CLOSE turn and return ``(close_message, ready)``.

    Since #424 a single essentials-answering message no longer wraps up: salary_current
    / salary_expected / availability are MUST_ASK, so the close is reached only after
    they have been RAISED. Non-answers are used deliberately — the ASK satisfies the
    gate, and this keeps the test about the VOCATIVE, not about detection.
    """
    kwargs = {} if worker_name is _UNSET else {"worker_name": worker_name}
    reply, asked, state, ready = interview_engine.next_turn(None, _FULL_ANSWER, "cnc_vmc", **kwargs)
    for _ in range(20):
        if asked is None:
            return reply, ready
        reply, asked, state, ready = interview_engine.next_turn(
            state, "theek hai ji", "cnc_vmc", **kwargs
        )
    raise AssertionError("interview never reached the close turn")


def test_default_emits_placeholder_token_at_open_and_close_never_a_real_name():
    # AI-PERSONA-2 (SG-1): the ai-service NEVER emits a real name — only the
    # {{worker_name}} TOKEN, at the OPEN (turn 1 / first_question) and CLOSE only.
    # The real name is interpolated downstream in NestJS, post-emit.
    _tid, opening = interview_engine.first_question("cnc_vmc")
    assert opening.startswith(f"{_PLACEHOLDER} ji, ")

    open_turn, asked_open, _st, ready_open = interview_engine.next_turn(None, "namaste", "cnc_vmc")
    assert ready_open is False and asked_open is not None
    assert open_turn.startswith(f"{_PLACEHOLDER} ji, ")  # turn 1 = open slot

    close, ready_close = _drive_to_close()
    assert ready_close is True
    assert close.startswith(f"{_PLACEHOLDER} ji, ")

    # A MID-interview ack turn (turn >= 2) carries NO vocative — ack only.
    _r1, _a1, st1, _rd1 = interview_engine.next_turn(None, "namaste", "cnc_vmc")  # turn 1
    mid, mid_asked, _st3, mid_ready = interview_engine.next_turn(
        st1, "cnc turner hoon", "cnc_vmc"
    )  # turn 2
    assert mid_ready is False and mid_asked is not None
    assert _PLACEHOLDER not in mid and "ji," not in mid
    assert mid.startswith("Theek hai.")


def test_worker_name_none_opts_out_of_the_vocative_cleanly():
    # Explicit opt-out: no vocative, and no stray token left behind.
    _tid, opening = interview_engine.first_question("cnc_vmc", worker_name=None)
    assert "ji," not in opening and _PLACEHOLDER not in opening

    close, ready = _drive_to_close(worker_name=None)
    assert ready is True
    assert "ji," not in close and _PLACEHOLDER not in close


def test_explicit_name_still_renders_but_no_production_caller_passes_one():
    # The param still accepts a literal name (used only by tests); production
    # callers rely on the placeholder default, so no real name is ever emitted.
    _tid, opening = interview_engine.first_question("cnc_vmc", worker_name="Nitin")
    assert opening.startswith("Nitin ji, ")


def test_profiling_chat_turn_output_is_capped_for_cost():
    route = get_route("profiling_chat_turn")
    assert route.max_output_tokens == 48
    assert route.temperature == 0.3
