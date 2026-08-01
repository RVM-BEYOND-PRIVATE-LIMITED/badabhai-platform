"""Prompt templates for the payer job-posting chat (ADR-0035).

TONE. Addressed to an EMPLOYER or RECRUITER: plain professional English, brief,
never chatty, never a salesman. This is NOT the worker-facing low-literacy Hinglish
"Bada Bhai" voice, and the two must not converge — same product, different reader.

NOTHING HERE IS ON THE LIVE PATH TODAY, and that is deliberate rather than
unfinished. Read this before wiring a call:

* The engine chooses the question LOCALLY, and the served question is already a
  short, on-tone, employer-facing line. On the straight-line path there is nothing
  for a model to add, so ``main.py`` returns the templated question DIRECTLY and
  makes **zero** LLM calls (COST-3/COST-4, and stronger than the profiling route,
  which still round-trips the router's mock path).
* The only sanctioned future use is REPHRASING a question the payer did not
  understand — the engine's ``clarify_turn`` branch. That is what
  :func:`build_job_posting_chat_messages` exists for.
* Turning it on needs TWO things this slice does not own: a ``job_posting_chat_turn``
  ``TaskRoute`` in ``app/ai/model_config.py`` (``AIRouter.run`` calls ``get_route``
  FIRST and RAISES on an unknown task type, so an unregistered task would 500 the
  endpoint — mock path included), and a settings flag mirroring
  ``ai_profiling_rephrase_enabled``. Both files are outside this slice's scope; see
  the hand-off note in the PR.

Whatever fires later, the privacy order does not change: ``main.py`` pseudonymizes
FIRST and fails closed, so every string these builders can ever receive is already
pseudonymized. And per ADR-0035 §Decision 3, the payer's organisation name is never
in that string — it is never asked for, so it never enters a payer message.
"""

from __future__ import annotations

JOB_POSTING_SYSTEM_PROMPT = (
    "You are BadaBhai's job-posting assistant, helping an employer or recruiter in "
    "India write one job posting.\n"
    "\n"
    "Plain professional English. Short sentences. Address them as 'you'.\n"
    "ONE question per turn, under 20 words. Never bundle two asks.\n"
    "Acknowledge in at most 2 words ('Got it.'), then move on. Never praise, never "
    "restate their answer, never explain why you are asking.\n"
    "NEVER ask for the company, organisation or business name, and never ask for a "
    "contact person, phone number or email — we already have the account details and "
    "postings are contacted through the platform.\n"
    # [CITY_1] removed 2026-07-31: the gateway no longer masks cities, so the token
    # cannot occur and naming it invites the model to treat a real city as a
    # placeholder. (This prompt is written but NOT wired — see main.py step 4.)
    "The text you receive is pseudonymized: tokens like [PERSON_1], [PHONE_1], "
    "[EMPLOYER_1] are placeholders. Never guess the real values behind them, and never "
    "invent a detail the employer did not give. City names are real, not placeholders.\n"
)


def build_job_posting_chat_messages(
    next_question: str, pseudonymized_message: str
) -> list[dict[str, str]]:
    """Build OpenAI-style messages for ONE rephrase turn.

    STATELESS BY DESIGN, and there is no ``history`` parameter to ignore. The engine
    already chose the next question from local signals, so the model only has to
    PHRASE one templated question — it needs no cross-turn memory. Re-sending the
    transcript every turn makes per-interview input cost grow O(n^2); sending only
    {system persona, this message, this question} makes it O(n). The profiling
    builder keeps a vestigial ``history`` argument for caller compatibility and
    documents that it must never be threaded in; a new module simply does not accept
    one, which makes the mistake unrepresentable.

    Both strings are already pseudonymized by the caller.
    """
    return [
        {"role": "system", "content": JOB_POSTING_SYSTEM_PROMPT},
        {"role": "user", "content": pseudonymized_message},
        {
            "role": "system",
            "content": (
                "Reply in under 20 words: at most a 2-word acknowledgement, then ask "
                "exactly this question, rephrased more simply. Do not add options "
                "they did not mention, do not restate their answer, do not ask for a "
                f"company name: {next_question}"
            ),
        },
    ]
