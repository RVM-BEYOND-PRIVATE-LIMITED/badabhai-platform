# ADR 0008 — LiteLLM → direct Gemini/Claude provider calls

- **Status:** Accepted
- **Date:** 2026-06-15
- **Phase:** 1 (Worker Profiling)
- **Supersedes:** ADR-0001 decision #3 (LiteLLM adapter)
- **Amended:** 2026-10-14 — Claude Haiku first, Gemini fallback (#2170; see the amendment below)

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
provider, event, `ai_jobs`, `audit_logs`, or logs. _(The last clause is amended by
[ADR-0047](0047-lift-pii-restriction.md), 2026-09-30: lifted for now; prompt masking
follows `AI_RAW_PII_ENABLED`, default off. The rest of this paragraph stands.)_

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

## Amendment 2026-10-14 — Claude Haiku first (#2170)

**Owner decision (2026-10-14): production runs Claude Haiku as the primary model. Gemini stays
configured as the fallback.** Decision 1's chain becomes **Claude Haiku → Gemini → deterministic
mock** for every tier-routed task. The rest of this ADR stands.

**Why.** From at least 2026-09-17 to 2026-10-14, every real call on the box was served by
`claude-haiku-4-5` (`ai.cost_recorded`, #2170). The box's Gemini key is set, so real calls were
armed, but Google rejected every call, so every Gemini-primary call paid a failed attempt and then
fell back to Haiku. The free-chat classifier measured p50 1,752 ms / p95 2,167 ms over 216 calls,
against the API's 2.5 s wait (2026-10-07 to 10-14), and 4 of 189 worker messages timed out into the
clarify fallback. Putting Haiku first removes the failed attempt. It changes no model a worker
meets, because Haiku already answered every call.

**How.** `AI_PRIMARY_PROVIDER` (`config.py` `ai_primary_provider`, default `anthropic`; compose
pass-through with the same default). Under `anthropic`, `get_route` gives every task whose tier
resolves to a Gemini model `DEFAULT_FALLBACK_MODEL` (Claude Haiku) as its model, and that tier's
Gemini model as its fallback. That is ADR-0046 O7's career-answer chain, applied to every tier
task. Unchanged:
- routes that already name their own model (the career answer, the free-chat reply and news);
- tier defaults and the extraction pin (`DEFAULT_CAPABLE_MODEL=gemini-2.5-flash`);
- the master gates (decision 6: `GEMINI_FLASH_API_KEY` is still required for any real call);
- a deployment without a usable Claude transport (no Anthropic key, or no `anthropic` SDK),
  which keeps Gemini first rather than failing a dead Claude attempt on every call.

**Evidence base.** Every eval behind a live prompt was scored on Haiku: the free-chat
classifier and reply (ADR-0051 §10, R32) and the 2026-06-15 extraction gate run above. So Haiku
first is also the order the evidence covers.

**Reverting to Gemini first** is `AI_PRIMARY_PROVIDER=google` on the box plus a redeploy. Two
gates come first:
1. A paid, working Gemini key, since `gemini-2.5-pro` is closed to new projects (HTTP 404 on
   2026-10-14) and `AI_CHAT_MODEL_TIER` would need a live model.
2. The R32 evals re-run on the Gemini models, e.g. the free-chat classifier with
   `--expect-model gemini-2.5-flash-lite`, and the R31 bar holding there.

**Consequence: one live provider.** While the Gemini key fails, the Gemini fallback fails too, so
an Anthropic outage still leaves the box on the deterministic mock. That is what happened on
2026-10-14, when the Anthropic credit ran out. A working Gemini key restores the second provider
without changing the order.

## Related

- ADR-0001 (decision #3, superseded by this ADR)
- `docs/ai/enable-real-llm-extraction.md`
- Tech-debt **TD27** (cumulative spend cap + retry budget), **TD28** (env naming unify)
- Risks **R6** (spend), **R2** (heuristic pseudonymization), **R8** (secrets sprawl)
- `apps/ai-service/app/ai/router.py`, `providers.py`, `model_config.py`, `cost_tracker.py`
