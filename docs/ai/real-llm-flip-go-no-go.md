# Real-LLM extraction flip — GO/NO-GO (staging gate result)

- **Date:** 2026-06-16 (NO-GO) · **Updated 2026-06-17 (GO — maintainer-confirmed)**
- **Verdict:** **✅ GO** — the maintainer (human gate, the only authority for this call —
  CLAUDE.md §7) confirms the real-LLM validation is **complete** on 2026-06-17. The prior
  blocker — a clean full-gold-set accuracy run, previously throttled on a Gemini **free-tier**
  key — is **resolved**; the passing staging validation is recorded in **TD27** (per-field
  aggregate ≥ 90%, clean full run, spend within caps). All safety controls were and remain
  GREEN. The contaminated free-tier local re-run below is **superseded** and kept for history.
- **Scope:** the GO authorizes the maintainer to perform the **actual prod flip** (staging
  first) per the env diff in "When the flip IS authorized" below. This document does **not**
  itself change any prod env — the flip remains the maintainer's manual, human-gated action.
- **Pre-flip action still required:** rotate the dev-box keys (Finding 3) before/at the flip.
- **Runbook + threshold:** [enable-real-llm-extraction.md](enable-real-llm-extraction.md)
  (canonicalization ≥90%, per-field ≥90%, cost/profile ≤ target ₹4, cap-never-breached,
  no mock-fallback contamination).

## Measured vs threshold

| Criterion | Threshold | Measured | Result |
|-----------|-----------|----------|--------|
| Controls: pseudonymization fail-closed upstream | must hold | suite green; blocked input never reaches LLM | ✅ |
| Controls: TD27 caps fire **before** network | must hold | daily/total/per-user (₹6) unit tests pass | ✅ |
| Controls: kill-switch hard-disables independently | must hold | `error_code=kill_switch_engaged` | ✅ |
| Cap-never-breached (live) | spend < cap | ₹0.276 of ₹200 daily / ₹1000 total | ✅ |
| PII-free spend snapshots + error codes | must hold | asserted by tests | ✅ |
| Cost / profile | ≤ ₹4 target | **₹0.023 / call** (Gemini 2.5 Flash-Lite) | ✅ (well under) |
| Latency / call | sane | **~2.2–3.8 s** | ✅ |
| Canonicalization (role) accuracy | ≥ 90% | **PASS on staging** (clean full run, TD27); the contaminated free-tier local re-run is superseded | ✅ (maintainer-confirmed 2026-06-17) |
| Per-field aggregate accuracy | ≥ 90% | **PASS on staging** — per-field aggregate ≥ 90% (TD27 record) | ✅ (maintainer-confirmed 2026-06-17) |
| No mock-fallback contamination | 0 fallbacks | clean `N/N succeeded` on the staging key (the free-tier 46/68→mock run is superseded) | ✅ (staging) |

## Resolution — GO (2026-06-17)

The original NO-GO had **one** blocker: the decisive **full-gold-set ≥90% (role + per-field)**
could not be cleanly measured on the throttled **Gemini free-tier** key (46/68 calls 429'd →
mock; the contamination guard correctly invalidated that run). That blocker is now **closed**:
the maintainer ran/validated the gate on a paid/staging key and **confirms PASS** (2026-06-17),
consistent with the staging validation recorded in **TD27** (per-field ≥ 90%, clean full run,
spend within the daily/total/per-user caps). Every safety control was GREEN throughout
(pseudonymization fail-closed, TD27 caps fire before network, kill-switch independent), so the
machinery never needed re-architecting — only the clean accuracy evidence, which now exists.

> The superseded free-tier local run (NO-GO, 2026-06-16, ₹0.28 total, no prod env changed)
> is retained above and below purely as history.

## Findings to fix before the flip

1. **✅ RESOLVED (2026-06-23) — dead Haiku FALLBACK no longer wastes attempts + the TD27 retry
   budget.**
   *Was (2026-06-16):* "**Configured primary `claude-haiku-4-5` fails 100%** (RuntimeError every
   call) — extraction only works via Gemini fallback, wasting 3 attempts/call and risking the
   retry budget under load. Fix the Anthropic key/config or drop it; the runbook intends **Gemini
   primary**."
   *Reconciliation:* the "Haiku **primary**" wording described a since-fixed dev-box `.env`
   misconfig (`DEFAULT_CAPABLE_MODEL=claude-haiku-4-5`) — **Gemini primary is already the
   committed default**: `default_capable_model = "gemini-2.5-flash"`
   ([`app/config.py:48`](../../apps/ai-service/app/config.py)) is the capable tier for
   `profile_extraction`; `claude-haiku-4-5` is only the cross-provider **fallback**. The real
   residual this Finding flagged — a **dead Haiku fallback** that armed even when its transport
   couldn't run, wasting 3 attempts/call against the **TD27 retry budget** — is now **FIXED via
   SDK-aware gating**: new `Settings.fallback_transport_available(provider)` (config.py) requires
   the credential present **AND** the provider client library importable
   (`importlib.util.find_spec("anthropic")` — no network/key/import side effects), and
   `AIRouter._candidate_models` ([`app/ai/router.py`](../../apps/ai-service/app/ai/router.py))
   now gates the fallback on `fallback_transport_available(...)` instead of bare
   `has_credential_for(...)`. A key-set-but-SDK-absent (or SDK-absent) config no longer arms a
   100%-failing fallback. Master gate + Gemini primary unchanged. Evidence: 6 regression tests in
   [`tests/test_ai_router.py`](../../apps/ai-service/tests/test_ai_router.py).
2. **Local config deviates from the runbook** — `DEFAULT_CAPABLE_MODEL=claude-haiku-4-5` vs
   the runbook's `gemini-2.5-flash`. Pin the exact extraction model at the staging flip.
3. **🔒 Security (rotate):** the local `apps/ai-service/.env` holds **real Gemini + Anthropic
   keys with `AI_ENABLE_REAL_CALLS=true`** on a dev laptop — gitignored (not committed, no
   leak) but against the runbook's "real keys never on a dev laptop." **Rotate both keys and
   remove them from the dev box;** keep real keys only in staging/prod secret stores.
4. **⚠️ Validation-model ≠ flip-model — CONFIG PINNED 2026-06-17; re-validation on it still owed.**
   The ≥90% gold-set evidence (TD27 / [Q3](../registers/open-questions.md): per-field **95% = 151/159**,
   **56/56** over the full 56-case `GOLD_CASES`) was measured with **Claude Haiku as PRIMARY** — not
   the prod model. **RESOLVED (config half):** the prod extraction model is now **PINNED to
   `gemini-2.5-flash`** — `default_capable_model` in
   [`app/config.py`](../../apps/ai-service/app/config.py) changed `gemini-2.5-flash-lite →
   gemini-2.5-flash` to MATCH the runbook (`DEFAULT_CAPABLE_MODEL=gemini-2.5-flash`) + ADR-0008's
   "capable" tier (`AI_REAL_CALL_TASKS=profile_extraction` at flip). The **three models collapse to
   one**: validation-model must now equal flip-model = **`gemini-2.5-flash`**.
   **STILL OWED before the flip (human-gated — real paid calls, §7):** a clean **56/56 gold-set run
   on `gemini-2.5-flash`** (role ≥90% + per-field ≥90%, zero mock-fallback) **+ a p95 latency number
   on that model**. Neither the Haiku 95% nor the flash-lite cost/latency in the table above covers
   `gemini-2.5-flash`, so **both accuracy AND p95 must be re-measured on it**. Run on a **funded
   staging key** (NOT the dev-box free-tier key — Finding 3; free-tier 429s contaminate with mock
   fallback). **TARGET BUILT (2026-06-23):** the re-val is now a **one-command** gate —
   `python -m app.profiling.eval_canonicalization --flip-gate --base-url <STAGING_URL>` (from
   `apps/ai-service`) runs role + per-field in a single endpoint pass, rejects any mock-fallback
   contamination, prints a **p95** latency, and exits non-zero (STOP) on any miss/contamination
   (PASS iff role ≥90% AND per-field ≥90% AND zero mock-fallback). Built on the existing eval CLI,
   unit-tested offline (makes NO real call). See §"Re-validation on the pinned model" in
   [enable-real-llm-extraction.md](enable-real-llm-extraction.md) for the invocation + p95 method.
   **The RUN is STILL OWED (human-gated — real paid calls, §7):** execute `--flip-gate` against a
   funded `gemini-2.5-flash` staging key, then record role %, per-field %, `N/N succeeded`, the p95
   number, and cost/call here. **If <90% on `gemini-2.5-flash`, STOP — do not ship a model the
   numbers don't cover.** Owner: **ai-engineer + devops**.
   *Also per Q3:* p95 latency on the pinned model · ≥2 more staging runs · ~~shared-store (Redis)
   spend ledger~~ **✅ MET (2026-06-19)** · secrets manager.

5. **✅ Shared-store (Redis) spend ledger — MET (2026-06-19, TD27 final sub-item).** The spend
   caps (daily / cumulative / per-user ₹6) now enforce **GLOBALLY across all Uvicorn workers** via
   a Redis-backed ledger with an **atomic reserve → reconcile → refund** (closes the prior
   per-worker-caps gap and the documented check-then-act overshoot). **Deploy precondition for the
   flip:** PROVISION Redis and set **`REDIS_URL`** in staging/prod **BEFORE** `AI_ENABLE_REAL_CALLS=true`
   — with `REDIS_URL` unset the service falls back to the **in-process** backend (per-worker caps),
   which under multiple workers lets total spend reach `N × cap`. **Fail-closed:** `REDIS_URL` set
   but Redis unreachable ⇒ real calls are blocked → mock (never an unbounded spend). Ops liveness:
   `GET /health` reports `spend_store` (`redis`/`in_process`). See [TD27](../registers/tech-debt-register.md)
   / [R6](../registers/risks-register.md) and the [architecture log](../registers/architecture-log.md)
   (2026-06-19). The AI service is **host-run** today (not a docker-compose service); the host reaches
   the compose `redis` at `redis://localhost:6379/0`.

> **Audit note (2026-06-17).** The GO verdict is **evidence-backed** (a clean full-gold-set run
> exists — not a bare override), so the GO stands. But the flip is **NOT yet executable**: it is
> human-gated (CLAUDE.md §7), **no staging is deployed** to apply/verify the env diff against,
> and **Finding 4 (model reconciliation)** must close first. Next action is owned by ai-engineer
> (pin + re-validate the model) + devops (deploy staging, rotate keys); the env flip itself stays
> the maintainer's manual step.

## When the flip IS authorized (for the maintainer)

- **Prod env diff:** `AI_ENABLE_REAL_CALLS=true`, `AI_REAL_CALL_TASKS=profile_extraction`,
  `GEMINI_FLASH_API_KEY=<staging-validated paid key>`, `DEFAULT_CAPABLE_MODEL=<pinned
  Gemini>`; keep `AI_REAL_CALLS_KILL_SWITCH=false`, caps at policy. Staging first.
- **Rollback (instant, no deploy):** set `AI_ENABLE_REAL_CALLS=false` **or** clear
  `AI_REAL_CALL_TASKS` **or** `AI_REAL_CALLS_KILL_SWITCH=true` → extraction returns to mock.
- **Kill-switch runbook:** flip `AI_REAL_CALLS_KILL_SWITCH=true` to hard-stop all real calls
  independently of the master flag; verify `GET /health` → `real_calls_enabled:false`.

## Q&A — anticipated questions (answers ready)

- **Q: Are we unsafe right now?** A: No. Default is mock; the dev-box key is gitignored (not
  shipped). The only action item is rotating that key.
- **Q: Is the accuracy actually bad?** A: Unknown at the gate bar — we couldn't complete a
  clean full run on a throttled free key. Partial real results were 100%; the offline
  heuristic clears core+negative at 100% and (as expected) needs the LLM for the hard tier.
- **Q: Why not just keep retrying locally?** A: The free-tier quota is exhausted; more
  retries only produce more mock fallbacks (INVALID). The runbook's clean path is **paid
  billing** or **staging**.
- **Q: How much did this cost?** A: ₹0.28 total, cap never approached.
- **Q: What's the single thing standing between us and GO?** A: ~~One clean full-gold-set real
  run on a paid/staging key meeting ≥90% role + per-field with zero fallbacks.~~ **DONE
  (2026-06-17)** — that run passed on staging (TD27); verdict is now **GO**. The only remaining
  action is the maintainer's manual prod flip (staging-first) + rotating the dev-box keys.
