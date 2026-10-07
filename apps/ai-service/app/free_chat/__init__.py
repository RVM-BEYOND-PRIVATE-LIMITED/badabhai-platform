"""The profiling-stage free chat (ADR-0051, #2027).

Pure helpers behind the three ``/free-chat/*`` routes: the prompts and message builders
(:mod:`app.free_chat.prompts`), the classifier's fail-closed parser
(:mod:`app.free_chat.classify`), the reply's fail-closed parser plus its per-category prompt
choice (:mod:`app.free_chat.reply`) and, Release 2 (§8), the rolling summary's fail-closed parser
(:mod:`app.free_chat.summary`). No router lives here: the endpoints are in
:mod:`app.routers.free_chat`, and they own the privacy order (the masking policy FIRST).

It reuses the companion's helpers rather than copying them (ADR-0051 reuses ADR-0046's router
pattern on a different surface): the recent-turn masking, the classify and career message
builders, and the persona banned-token render.

Everything here treats model output as untrusted: a miss produces the fail-closed value
(``unclear`` / a refusal on ``unsafe_other`` / a null summary), never an exception. Nothing here
decides anything: the API maps a category to a deterministic handler, applies the priority and
the confidence floor, re-validates every reply line before a worker reads it, and validates every
summary before it stores one.
"""
