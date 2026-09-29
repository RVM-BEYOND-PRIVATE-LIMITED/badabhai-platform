"""The chat companion v2 module (ADR-0046 Phase 1).

Pure helpers behind the two ``/companion/*`` routes: the prompt builders
(:mod:`app.companion.prompts`), the classifier's fail-closed output parser
(:mod:`app.companion.classify`) and the edit-parse row parser
(:mod:`app.companion.edit_parse`). No router lives here — the endpoints are in
:mod:`app.routers.companion`, and they own the privacy order (pseudonymize FIRST).

Everything in this package treats model output as untrusted: a miss produces the
fail-closed value (``unclear`` / no rows), never an exception and never a
half-applied card. Nothing here writes anything anywhere: the API validates every
row again and only the worker's Haan can write (ADR-0046 O4).
"""
