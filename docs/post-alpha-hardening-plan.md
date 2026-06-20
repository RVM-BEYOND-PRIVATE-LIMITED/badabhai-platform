# Post-Alpha Hardening Plan (Medium / High tier)

> The sequenced backlog for everything the Phase-0 audit and the registers flagged as
> **Medium/High risk** — deferred out of the low-risk additive sweep (Phases 1/4/9) so it
> does **not** compete with the **2026-06-25 alpha cut** (blocker: B1 device-verify).
>
> **Operating rules for this backlog (do not skip):**
>
> 1. **Nothing here starts before the alpha cut ships.** B1 is the only thing that matters until then.
> 2. **Plan-first, then code.** Every item below gets a written approach **and rollback** before a line changes — most touch owned code, schema, auth, or RLS (CLAUDE.md §7). Route the build to the listed owning agent for the human owner's review.
> 3. **One concern per PR.** No bundling hardening with features.
> 4. This doc is the index; the **source of truth** for each item is its register entry
>    ([`docs/registers/tech-debt-register.md`](registers/tech-debt-register.md) /
>    [`risks-register.md`](registers/risks-register.md)). Update the register in the same PR that closes an item.

Owner key — route the build to the **agent**; the **human** owns review/merge (see
[`.claude/team-memory.md`](../.claude/team-memory.md)).

---

## Sequencing — four waves

Ordered by dependency and blast radius. Don't start a wave until the prior wave's
**gating** items land.

| Wave  | Theme                                              | Items                                                                                                                                                                | Gate to start next wave                              |
| ----- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **1** | Quick wins, no infra deps                          | Flip scanners → blocking · CORS allowlist (TD30) · trust-proxy + per-IP cap (TD25) · `/health` readiness · failed-job visibility                                     | All green on `main`; no regressions                  |
| **2** | Pre-production safety                              | **RLS least-privilege app role (TD4)** · secrets manager (TD10) · Sentry wiring · transactional outbox for events                                                    | TD4 + secrets manager **done** (both are prod gates) |
| **3** | Delivery pipeline                                  | **Deploy-target ADR** → staging-deploy → production-promote (`workflow_dispatch`) → rollback (immutable tags) · OpenTelemetry · Langfuse real (with AI staging flip) | Deploy target chosen + first staging deploy verified |
| **4** | Phase-2 commercial (only when those surfaces ship) | PayerAuthGuard real identity (TD33) · real payments (TD34) · Reach ranking                                                                                           | Phase-2 go decision                                  |

**Decisions that must precede code (escalate — human-only, CLAUDE.md §7):**

- **Deploy target** (Vercel / Fly / Render / containers + where) — an ADR. Blocks all of Wave 3 and shapes Wave 2's secrets manager.
- **Secrets manager** choice (Supabase env / Doppler / SOPS / cloud KMS) — blocks multi-env (TD10).
- **Real-LLM staging flip** go/no-go ([`docs/ai/real-llm-flip-go-no-go.md`](ai/real-llm-flip-go-no-go.md)) — gates Langfuse-real.

---

## Wave 1 — quick wins (Medium, no infra dependencies)

### 1.1 Flip CI scanners to blocking

- **Why / source:** [`security-scan.yml`](../.github/workflows/security-scan.yml) + [`supabase-checks.yml`](../.github/workflows/supabase-checks.yml) ship non-blocking; the flip is the point. **Owner:** `devops-engineer`.
- **Approach:** run each once on `main`, triage to a clean baseline. Secret-scan **first**: author a `.gitleaks.toml` allowlisting the `.env.example` placeholders + the dev-default constants (`DEV_PII_*`, `DEV_JWT_SECRET` in [`server.ts`](../packages/config/src/server.ts)), then drop `continue-on-error`. Then `supabase-checks` drift, then `sast`/`dependency-audit`.
- **Rollback:** re-add `continue-on-error` (one-line revert per job).
- **Done:** each gate blocks on a real finding, green on a clean tree; criteria recorded in the YAML header.

### 1.2 CORS allowlist — TD30

- **Why / source:** [`apps/api/src/main.ts`](../apps/api/src/main.ts) calls `app.enableCors()` with no allow-list (every origin, every env). **Owner:** `backend-engineer` (Prakash). **Risk:** Medium.
- **Approach:** env-driven origin allowlist (`CORS_ALLOWED_ORIGINS`, added to [`server.ts`](../packages/config/src/server.ts) + `.env.example`), **fail-closed** outside dev (route through `isDevEnv()`); dev stays permissive. Smallest version: allow the ops-console origin(s) only.
- **Rollback:** env var unset → keep the current open behavior behind an explicit `CORS_OPEN=true` dev escape hatch (never in prod).
- **Done:** prod rejects unknown origins; ops console + worker app unaffected; unit test for allow/deny.

### 1.3 Trust-proxy + true client IP — TD25

- **Why / source:** the IP rate-limiter ([`ip-rate-limit.service.ts`](../apps/api/src/common/rate-limit/ip-rate-limit.service.ts)) keys on the egress/proxy IP until Express `trust proxy` is set. **Owner:** `backend-engineer`. **Risk:** Medium (sizing-sensitive).
- **Approach:** set `trust proxy` to the known proxy hop count/CIDR (NOT blanket `true`, which lets clients spoof `X-Forwarded-For`); verify the OTP/resume caps then key on the real client IP. Coordinate with 1.2 (same `main.ts`).
- **Rollback:** revert the `set('trust proxy', …)` line; caps fall back to egress-IP coarseness (current behavior).
- **Done:** caps key on real client IP behind the chosen proxy; no spoofing path; tests for forwarded-header handling.

### 1.4 `/health` readiness probes

- **Why / source:** [`health.controller.ts`](../apps/api/src/health/health.controller.ts) is liveness-only ([observability-runbook §4/§8](observability-runbook.md)). **Owner:** `backend-engineer`. **Risk:** Low/Medium.
- **Approach:** add a `/health/ready` that checks DB + Redis (+ AI-service reachability) with short timeouts; keep `/health` as pure liveness so the CI poll is unchanged.
- **Rollback:** remove the new route; liveness untouched.
- **Done:** readiness reflects dependency health; CI liveness poll still passes.

### 1.5 Failed-work visibility

- **Why / source:** BullMQ failed set + per-process spend ledger have no dashboard ([observability-runbook §7](observability-runbook.md)). **Owner:** `backend-engineer` + `devops-engineer`. **Risk:** Medium.
- **Approach (additive):** a read-only ops view of the BullMQ failed set (Bull Board or a thin `/ops` page) and a `system_events`/`failed_jobs` surfacing of terminal failures. Pairs with the outbox (2.4) but ships independently.
- **Rollback:** remove the view; no write-path change.
- **Done:** a failed render/extraction is visible in the ops console without log-diving.

---

## Wave 2 — pre-production safety (High)

### 2.1 RLS least-privilege app role — TD4 ⟵ the big pre-prod gate

- **Why / source:** backend connects as `postgres`/BYPASSRLS, not a least-privilege app role ([`infra/supabase/rls-plan.md`](../infra/supabase/rls-plan.md), TD4). **Owner:** `database-architect` + `security-engineer` + `devops-engineer`. **Risk:** High. **Escalate** (§7).
- **Approach:** follow the rls-plan: introduce an app role with table-scoped grants + `current_worker_id()` policies; migrate the backend connection to it behind a flag; keep the REVOKE spine (the [`rls-spine.e2e.test.ts`](../tests/e2e/rls-spine.e2e.test.ts) self-policing guard must stay green). **Expand→migrate→contract** — run BYPASSRLS and the app role in parallel, cut over, then drop BYPASSRLS.
- **Rollback:** flag back to the service-role connection (no schema rollback needed if grants are additive).
- **Done:** backend runs as least-privilege; RLS policies enforced; spine test + a positive/negative policy test green; sign-off recorded.

### 2.2 Secrets manager — TD10

- **Why / source:** secrets live in `.env`; no manager (TD10). Precondition for multi-env. **Owner:** `devops-engineer`. **Risk:** High. **Escalate** (decision first).
- **Approach:** after the manager is chosen (see decisions), bind CI/staging to it; keep `.env.example` as the names-only template; no values in git (the [`.claude` guard](../.claude/hooks/guard-secrets.mjs) + secret-scan back this).
- **Rollback:** env injection falls back to platform env vars.
- **Done:** staging/prod secrets sourced from the manager; rotation documented in [environment-variables.md](environment-variables.md).

### 2.3 Sentry wiring

- **Why / source:** error aggregation is PLAN-only ([observability-runbook §8](observability-runbook.md)). **Owner:** `devops-engineer`. **Risk:** Medium.
- **Approach:** add `SENTRY_DSN`/`SENTRY_ENVIRONMENT`/`SENTRY_TRACES_SAMPLE_RATE` to [`server.ts`](../packages/config/src/server.ts) (Zod-gated, optional, **off when DSN unset**); init in API + AI service; carry the `requestId` (§3) as the trace key. **No DSN in git.**
- **Rollback:** unset the DSN → SDK no-ops.
- **Done:** unhandled errors reach Sentry in staging with request-id correlation; PII scrubbed (no raw phone/name in event payloads).

### 2.4 Transactional outbox for events

- **Why / source:** events are emitted post-commit; a crash between the DB write and the emit can drop an event (audit-spine gap, CLAUDE.md §2.1). **Owner:** `backend-engineer` + `database-architect`. **Risk:** High (touches the write path).
- **Approach:** write the event row in the **same transaction** as the state change (outbox), then a relay drains it idempotently (the `events.idempotency_key` already gives ON CONFLICT DO NOTHING). Ship behind a flag; **transaction + tests required** before cutover. Coordinate with the event owners (Prakash core / both for `event-schema`).
- **Rollback:** flag back to post-commit emit (additive table can stay).
- **Done:** no event loss under an injected mid-write crash (test); throughput unchanged on the hot path.

---

## Wave 3 — delivery pipeline (High; needs the deploy-target ADR first)

### 3.1 Deploy-target ADR ⟵ blocks the rest of Wave 3

- **Owner:** `system-architect` + `devops-engineer` (drafts); **human decision**. Choose target + topology (staging/prod separation, migrate-then-deploy ordering, immutable build tags). Output: an ADR in [`docs/decisions/`](decisions/).

### 3.2 staging-deploy → 3.3 production-promote → 3.4 rollback

- **Owner:** `devops-engineer`. **Risk:** High. Per the audit + [github-actions.md](github-actions.md) "Deploy & rollback (not yet wired)".
- **Approach:** `staging-deploy.yml` (auto on `main`, migrate-then-deploy); `production-promote.yml` (**manual `workflow_dispatch`**, no native required-reviewer gate needed for a private repo); `rollback.yml` (redeploy a previous **immutable tag**). Encodes [release-checklist.md](release-checklist.md) + [rollback-guide.md](rollback-guide.md).
- **Rollback:** the rollback workflow _is_ the rollback; its own change reverts by deleting the workflow.
- **Done:** a promotion + a tag-rollback both exercised against staging.

### 3.5 OpenTelemetry · 3.6 Langfuse real

- **Owners:** `devops-engineer` (OTel) / `ai-engineer` + `devops-engineer` (Langfuse). **Risk:** Medium/High. OTel reuses the `x-correlation-id` propagation (verify the API→AI client forwards it — [observability-runbook §2 TODO](observability-runbook.md)). Langfuse-real is gated on the **AI staging flip** ([real-llm-flip-go-no-go.md](ai/real-llm-flip-go-no-go.md)) and must only ever receive **pseudonymized** text.

---

## Wave 4 — Phase-2 commercial (only when those surfaces ship)

Do **not** build ahead of the Phase-2 go decision (CLAUDE.md §1, §8). When they ship:

- **PayerAuthGuard real identity — TD33** (`security-engineer` + `backend-engineer`): replace the interim `InternalServiceGuard` before **any** payer-facing surface. **High.**
- **Real payments — TD34** (`backend-engineer` + `devops-engineer`): real Razorpay behind `PAYMENTS_ENABLE_REAL` (default false, human-gated, staging-first). **High, §7.**
- **Reach ranking** (`system-architect` → owners): deterministic, sort-never-block (ADR-0006). LLMs never rank (CLAUDE.md §2.4).

---

## "Production-ready" exit criteria (what closing this backlog buys)

- [ ] RLS least-privilege enforced (TD4 closed); REVOKE spine + policy tests green.
- [ ] Secrets sourced from a manager (TD10); secret-scan blocking + clean.
- [ ] CORS locked (TD30); rate limits key on real client IP (TD25).
- [ ] Events durable via outbox; failed jobs visible in ops.
- [ ] Errors in Sentry with request-id correlation; `/health/ready` reflects deps.
- [ ] Deploy → promote → rollback workflows exercised; migrate-then-deploy enforced.
- [ ] No raw PII anywhere it must not be (re-verified across the new surfaces) — CLAUDE.md §2.

## Related

- Audit + scope decision: the Phase-0 audit and the TPM / low-risk-additive scope call (session notes); this backlog is its "deferred, route-to-owners" list.
- Registers: [`tech-debt-register.md`](registers/tech-debt-register.md) · [`risks-register.md`](registers/risks-register.md) · [`future-improvements.md`](registers/future-improvements.md)
- Gates & runbooks: [release-checklist.md](release-checklist.md) · [rollback-guide.md](rollback-guide.md) · [security-checklist.md](security-checklist.md) · [observability-runbook.md](observability-runbook.md) · [github-actions.md](github-actions.md) · [supabase-workflow.md](supabase-workflow.md)
