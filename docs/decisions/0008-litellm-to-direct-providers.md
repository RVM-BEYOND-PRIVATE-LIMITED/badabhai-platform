# ADR 0008 — LiteLLM → direct Gemini/Claude provider calls

- **Status:** Accepted
- **Date:** 2026-06-15
- **Phase:** 1 (Worker Profiling)
- **Supersedes:** ADR-0001 decision #3 (LiteLLM adapter)

## Context

ADR-0001 §3 declared AI "API-first," mediated by a LiteLLM adapter. That adapter
was aspirational and never wired: routing, cost tracking, and spend control always
lived in the AI service's own modules, and `app/llm.py` was a stub. PRs #28/#29
shipped real LLM calls by going **directly** to providers — Gemini (Google AI
Studio, REST over httpx) as primary and Claude Haiku (official `anthropic` SDK) as
fallback — orchestrated by `app/ai/router.py` (`AIRouter`) and dispatched by
`app/ai/providers.py` (`provider_for_model`). On the Node side, the LiteLLM env
vars in `packages/config/src/server.ts` are vestigial (consumed only by
`config.test.ts`). This ADR ratifies the shipped design so canon matches code, and
records the seam where the deferred spend cap (TD27) and env unification (TD28)
land. Removing LiteLLM breaks no runtime behavior.

## Decisions

1. **Direct provider clients replace the never-wired LiteLLM adapter.** Gemini
   (REST/httpx, key via `x-goog-api-key`) is primary; Claude Haiku (anthropic SDK,
   lazy-imported) is fallback. Chain: **Gemini → Claude Haiku → deterministic
   mock**. `AIRouter.run()` is fail-safe and never raises; callers pre-pseudonymize.
2. **One provider-neutral seam: the `LlmAdapter`/`AIRouter` boundary.** Behind it,
   provider-specific transports live in `providers.complete` (dispatched by
   `provider_for_model`). `app/llm.py` is retained only as the documented seam
   example (`LlmAdapter.can_call()` delegates to `Settings.real_calls_blocked_reason()`;
   `complete()` is an unused `NotImplementedError` stub). The seam is provider-neutral;
   **credentials are necessarily provider-specific** — each direct provider has its
   own key.
3. **Model routing stays deterministic** in `app/ai/model_config.py`
   (`resolve_model` cheap-vs-capable per task, `get_route`, per-task `max_retries`).
   LLMs assist; they never rank, reject, score, or decide.
4. **Cost tracking stays in `app/ai/cost_tracker.py`** (`build_call_metadata`, INR
   estimate from rate cards). The per-call hard ceiling `AI_MAX_CALL_COST_INR` is
   enforced in `AIRouter.run` per candidate **before** the call: worst-case cost >
   ceiling → skip candidate → mock.
5. **TD27 hook point is named and reserved.** A process-level rolling daily INR
   counter in `cost_tracker`, checked in `AIRouter.run` before each real candidate
   (same mock-fallback pattern as the per-call ceiling), plus cutting retry
   multiplication. The master kill-switch remains `AI_ENABLE_REAL_CALLS` + the
   per-task allowlist `AI_REAL_CALL_TASKS`.
6. **Env naming unifies on the shipped AI-service scheme (TD28),** decided by the
   product owner: Node mirrors `GEMINI_FLASH_API_KEY` (master gate) + optional
   `ANTHROPIC_API_KEY`; drop `LITELLM_BASE_URL`; keep `LITELLM_API_KEY` →
   `GEMINI_FLASH_API_KEY` as a one-release **deprecated** back-compat alias. One
   naming scheme repo-wide.

**Invariants held (not bypassed by this change):** pseudonymization runs fail-closed
**upstream** of every provider call (gateway untouched); `AI_ENABLE_REAL_CALLS=false`
is the committed default and real calls additionally require `GEMINI_FLASH_API_KEY`;
LLMs assist (profile/canonicalize/explain) and never decide; no raw PII reaches any
provider, event, `ai_jobs`, `audit_logs`, or logs.

## Consequences

- **Positive:** no proxy hop and one fewer dependency; lighter runtime; real
  multi-provider failover (Gemini → Claude → mock); per-call cost and latency are
  visible in `cost_tracker`/Langfuse over already-pseudonymized text. `ANTHROPIC_API_KEY`
  only **adds** the Claude candidate — it is never a master gate.
- **Negative / risks:** a per-provider credential surface (two keys) widens
  secrets-sprawl (**R8**); there is still **no cumulative/daily spend cap** — only the
  per-call ceiling — so a stuck job can multiply real calls up to ~9× (BullMQ
  attempts:3 × AI-service max_retries:2) (**TD27 / R6**); pseudonymization stays
  heuristic in Phase 1 (**R2 / TD3**).
- **Reversibility:** the `AIRouter`/`LlmAdapter` seam keeps providers swappable.
  Reverting to a gateway is a transport change behind the same seam, not a caller
  change. The `LITELLM_API_KEY` → `GEMINI_FLASH_API_KEY` alias eases env rollback
  for one release.

## Related

- ADR-0001 (decision #3, superseded by this ADR)
- `docs/ai/enable-real-llm-extraction.md`
- Tech-debt **TD27** (cumulative spend cap + retry budget), **TD28** (env naming unify)
- Risks **R6** (spend), **R2** (heuristic pseudonymization), **R8** (secrets sprawl)
- `apps/ai-service/app/ai/router.py`, `providers.py`, `model_config.py`, `cost_tracker.py`
