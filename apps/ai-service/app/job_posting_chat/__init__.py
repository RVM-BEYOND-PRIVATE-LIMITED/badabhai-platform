"""Payer job-posting chat: question bank, deterministic interview engine, local
answer detection, and the (rephrase-only) prompt seam — ADR-0035.

A SIBLING of ``app.profiling``, deliberately NOT a parameterization of it
(ADR-0035 §Decision 2): the worker engine's ESSENTIAL_TOPICS / MUST_ASK_TOPICS are
module-level constants hardcoded to worker-profiling topic ids, and there is no
seam to swap a topic set without editing every function in a shipped module.

Nothing here imports ``app.profiling``. The two engines share a PATTERN, not code.
"""
