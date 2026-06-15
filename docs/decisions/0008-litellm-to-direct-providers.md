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

## Staging → Prod real-call flip threshold (added 2026-06-15)

Real calls run in **staging** behind the TD27 cap (`AI_ENABLE_REAL_CALLS=true`,
`AI_REAL_CALL_TASKS=profile_extraction` only; Claude Haiku primary). **Prod stays
OFF** until ALL of the bars below are met. This is the written, numeric gate; the
flip itself is a separate human-approved action.

**Measured in staging (2026-06-15 gate run — Claude Haiku 4.5 primary, behind the cap):**

| Metric | Measured | Source |
| --- | --- | --- |
| Per-field accuracy vs Hinglish gold set | **95%** (151/159) | eval_canonicalization run |
| Real calls completed (no fallback) | **56/56** → run error rate **0%** | same run |
| Cost / real call | **₹0.267** (₹14.95 / 56) | cost_tracker / run total |
| Cost / worker (extraction) | **≈₹0.27**; full journey ≈₹0.5 (TD27) | derived |
| TD3 over-masking regressions | **0** | run audit |
| Spend cap + kill-switch fire (block before network) | **15/15 tests pass** | `tests/test_spend_cap.py` |
| End-to-end latency (p50/p95) | **NOT MEASURED** — must be captured before flip | — (gap) |

**PROD-FLIP THRESHOLD — flip only when ALL hold:**

1. **Accuracy** ≥ **90%** per-field on the Hinglish gold set. *(95% ✅)*
2. **Cost/worker** ≤ **₹2.0** for the AI path (extraction + chat + resume combined),
   and the **₹6/user/day** cap is never the binding constraint in normal traffic.
   *(≈₹0.27–0.5 ✅)*
3. **Real-call error rate** (provider failure → mock fallback) ≤ **2%** over the
   qualifying runs. *(0% ✅)*
4. **Spend cap never breached** and **kill-switch verified firing** — 0 unintended
   breaches; every cap-block returns the safe mock. *(✅ by tests; re-confirm per run)*
5. **0 PII leakage / 0 TD3 over-masking** regressions (privacy invariant — never
   tradeable). *(0 ✅)*
6. **Latency** p95 end-to-end extraction ≤ **8 s** — ⚠️ **NOT YET MEASURED**; must be
   captured in the staging burn-in before flip (no invented number here).
7. **Stability over N runs**: bars 1–5 hold across **≥3 consecutive staging runs /
   ≥150 cumulative real calls**, **on the model prod will actually run**. *(1 run /
   56 calls so far → **2 more runs (or a ≥150-call burn-in) required**.)* ⚠️ The
   2026-06-15 evidence is **Claude-Haiku-4.5-primary**; the staging template default
   is `gemini-2.5-flash` capable — if prod runs Gemini-primary, the stability bar must
   be re-measured on Gemini (cost/accuracy/latency can differ by model).

**Hard prod prerequisites (independent of the metrics):**
- **Keys in a secrets manager**, not `.env` (R8/TD10) — staging-scoped → prod-scoped.
- **Shared-store (Redis) spend ledger** replacing the per-process singleton, so the
  cap is global across Uvicorn workers in prod (today caps are per-worker — R6/TD27
  residual). **Blocks prod**, not staging.
- A named human approves the flip; `AI_REAL_CALL_TASKS` widened deliberately (start
  with `profile_extraction` only).

**Status:** accuracy / cost / error-rate / privacy / cap bars **MET** on the 2026-06-15
run; **NOT yet flippable** — pending (a) latency measurement, (b) ≥2 more staging runs
for stability, (c) the shared-store ledger + secrets-manager prerequisites.

## Related

- ADR-0001 (decision #3, superseded by this ADR)
- `docs/ai/enable-real-llm-extraction.md`
- Tech-debt **TD27** (cumulative spend cap + retry budget), **TD28** (env naming unify)
- Risks **R6** (spend), **R2** (heuristic pseudonymization), **R8** (secrets sprawl)
- `apps/ai-service/app/ai/router.py`, `providers.py`, `model_config.py`, `cost_tracker.py`
