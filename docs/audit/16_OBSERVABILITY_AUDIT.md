# 16 — Observability Audit

Evidence-based inspection of how badabhai-platform answers "why did this request fail?" — logging, request/correlation-id propagation across the api → ai-service → provider boundary, the event stream as an audit/observability signal, health-check depth, and alerting. This document assumes Batch 1's finding that `infra/monitoring/README.md` is stale (documents Langfuse as "reserved, no live integration" while real, key-gated tracing code already exists) — not re-derived here.

## 1. How apps/api logs

**Structured, JSON, one line per entry.** `apps/api/src/common/logging/structured-logger.ts` implements Nest's `LoggerService` and is wired via `NestFactory.create(AppModule, { logger: new StructuredLogger("api") })` in `main.ts`, so every `Logger.log/warn/error/debug` call — including Nest's own framework logs — routes through it. Each line: `{level, time, service, context, message}`; `error`/`fatal` → stderr, else stdout. No Winston/Pino dependency — a ~40-line hand-rolled formatter.

**Request/correlation id middleware exists and is globally wired.** `apps/api/src/common/middleware/request-id.middleware.ts` mints a `requestId` (free-form, honors inbound `x-request-id`, echoed on response) and a `correlationId` (strict UUID, honors inbound `x-correlation-id`) on **every** inbound request (`consumer.apply(RequestIdMiddleware).forRoutes("*")` in `app.module.ts`). A `@Ctx()` decorator surfaces both to any controller.

**These ids are threaded into the event stream, not just logs.** 42 non-test files reference `requestId`/`correlationId` outside the middleware — every `EventsService.emit()` call site persists both (`events.correlation_id`/`events.request_id` columns), and BullMQ job payloads carry them explicitly across the async boundary (e.g. `profile-extraction.processor.ts` reads `job.data.{correlationId,requestId}` and threads them into every event it emits, including the terminal-failure one). No `AsyncLocalStorage`/CLS anywhere — propagation is 100% explicit parameter-passing, which is why it survives the HTTP→queue-job boundary correctly.

**Gap: the global exception filter doesn't log the id it returns to the client.** `all-exceptions.filter.ts` puts `requestId` in the **HTTP response body** on every error, but the **server-side log line** omits it entirely — a client reporting "my request failed, id X" cannot be grepped for directly; only correlated by timestamp+method+path, ambiguous under concurrent identical requests.

## 2. How apps/ai-service logs

Also structured JSON, independently implemented — `app/logging_config.py`, a ~35-line `JsonFormatter`, wired at import time. 70+ `logger.{info,warning,debug}` sites across the service, most passing structured `extra={"extra": {...}}` payloads of PII-free scalars.

**No per-request access log and no request-id middleware.** The only Starlette middleware registered is `service_auth` (TD67). Nothing reads an inbound `x-request-id`/`x-correlation-id`, attaches it to a per-request context, or logs "received"/"responded" for every call. Individual routers log selectively — e.g. a request that 401s at the auth middleware, times out, or throws before the success-path log line produces **no log line identifying which request it was**.

**The one place a request id is threaded is disconnected from the real one.** `AiService.pseudonymize()` (apps/api) sends `{ text, request_id: randomUUID() }` — a **freshly minted UUID generated inside the call**, unrelated to the actual `req.requestId`/`req.correlationId` of the HTTP request that triggered it. This is the only field named `request_id` that crosses the api→ai-service wire on any route.

## 3. Is there a correlation id across api → ai-service → external provider?

**No — the wire carries none.** `AiService`'s private `post()` helper (the **sole** HTTP client apps/api uses to call ai-service — used by every method) sets exactly two headers: `content-type` and, if configured, `x-ai-internal-token`. **It never forwards `x-request-id` or `x-correlation-id`.** Combined with §2's finding that ai-service has no middleware to read such a header, no request-id/trace-id survives the api→ai-service hop at the transport level.

**A real but narrow and conditional correlation path exists via `ai_call_id`.** When a call reaches far enough to build an `AICallMetadata` (both success and most-failure paths), the service mints its own `ai_call_id`, logs it structurally, returns it in the response body, and `AiCostRecorder.record()` on the apps/api side uses it as the idempotency key of an `ai.cost_recorded` event that **does** carry the api-side `correlationId`/`requestId`. So: *if* you have access to both the ai-service's raw stdout (§7, not durably stored) and the `events` table, you can join a specific ai-service log line to the apps/api request. This only works when `meta` is non-null — it does **not** work for the single most important failure case, §4.

**Langfuse, if enabled, has the same disconnection.** Well-built (per-task-type trace names, cost masking, fail-open/never-raise) but key-gated and dormant (Batch 1), and NOT VERIFIED whether a trace would carry the apps/api `correlationId` as a session/user id — no evidence found of the api-side id being passed to any `langfuse` call site.

## 4. The concrete failure mode: what happens when the ai-service call itself fails

**This is the load-bearing gap.** `AiService.post()` degrades **every** failure — non-200, 401 (token mismatch), timeout, network error — to a `null` return, with only a warn/error log line on the apps/api side. That log line carries no `requestId`/`correlationId` (AiService has no request context — it's called from queue processors as often as HTTP paths). It is the **only** durable trace of the failure for most call sites, because `AiCostRecorder.record(meta, ...)` **no-ops when `meta` is null** — a total transport failure produces **no `ai.cost_recorded` event, no `ai.spend_cap_exceeded` event, nothing in the `events` table at all**.

The one call site that **does** durably record this class of failure is the profile-extraction BullMQ job: `ProfileExtractionProcessor` distinguishes a genuine LLM outage from a spend-cap refusal or a quiet worker, retries the outage case via BullMQ's own budget, and on the **final** attempt emits `profile.extraction_failed` (with a reason string) and calls `aiJobs.markFailed()` — populating the queryable `ai_jobs.error_message` column. **This is genuinely good, and it is the exception, not the rule** — it exists for exactly one of the eight `AiService` methods. The synchronous/inline callers (`chat`'s `llmTurn`, `resume.service.ts`'s `generateResume`, `job-posting-chat.service.ts`'s `jobPostingChatRespond`) have no equivalent retry-then-durably-record path; they receive `null`, fall back silently (by design, for UX continuity), and the only trace is the untagged log line.

One partial mitigant: when the LLM-led interview (Phase A) degrades, the orchestrator emits `profile.llm_interview_fallback` — but the payload schema's own documented design collapses "down, 429, deadline, schema reject, an empty reply, or the mock posture" into **one deliberately-coarse reason bucket, `unavailable`**, because "the API cannot tell them apart from the null it receives." Tells you a fallback happened; not why.

**Concrete, verified answer to the central question**: a worker's chat turn calls `POST /profiling/turn`, the ai-service is briefly unreachable. **Cannot be answered today** — which HTTP request this was, what `correlationId` it had, or precisely why it failed — beyond an untagged log line with no request id, no worker id, no session id, no corresponding event row. The worker sees a silent, correct fallback (functionally fine); an operator investigating "did workers see degraded interviews last night, which ones" has no queryable answer beyond eyeballing raw stdout and correlating by timestamp.

## 5. `ai.cost_recorded` drops the one field that would answer "did it fail"

`AICallMetadata` carries `success: bool`, `error_code`, `failure_reason`. The event built from it, `AiCostRecordedPayload`, does **not** include any of the three — confirmed by direct reading of `AiCostRecorder.record()`'s emitted payload. **Consequence**: a row with `event_name='ai.cost_recorded'` and `real_call=true` looks identical whether the provider call **succeeded** or was **reached and failed every candidate** (an expected state the cost_tracker's own comment names explicitly: "a provider that was reached and failed every candidate may well have been billed for the tokens it received"). The only durable signal for that state is ai-service's own non-persisted stdout. A dashboard built off `events` alone (§6) cannot distinguish "spent ₹X successfully" from "spent ₹X and the call still failed." A narrower, purpose-built event, `AiSpendCapExceededPayload`, *is* descriptive but only covers deliberate refusals, not provider-side failures.

## 6. Events as the audit/observability signal — and how it's queried

Extends [03_API_INVENTORY.md](03_API_INVENTORY.md)'s note on `GET /events`/`/admin/events*`. `GET /events` is thin — `SELECT * FROM events ORDER BY occurred_at DESC LIMIT ?`, **no filter parameters at all** beyond `limit`; no way to ask "events for correlation_id X."

**`/admin/events*` is materially richer** — and is the actual answer to "trace a failed request," if reachable. Six routes including **`GET /admin/events/trace/:correlationId`** ("the causal chain for a correlation id," backed by an indexed `traceByCorrelation` query, `ADMIN_TRACE_MAX=500`), `entities/:type/:id/timeline`, `events/metrics` (k-anon-floored dashboard), `events/export` (bounded, audited).

**It is wired end-to-end on the frontend, but the frontend's deployment is unproven.** `apps/admin-web/src/lib/events.ts` defines `getTrace(correlationId)`, invoked from a real event-detail page — this refines Batch 1's note that only `/admin/events/metrics` has "a confirmed admin-web caller": direct grep found a second (`trace`, and `getOne`/detail too). But apps/admin-web has **no evidenced deployment path** (Batch 1) — code-complete on both ends, but whether an operator can actually load this page in production is UNVERIFIED.

**The chicken-and-egg limit**: `events/trace/:correlationId` only surfaces events that were actually emitted with that id. Per §4, the single most informative failure produces **no event**, so tracing through a session where that happened shows a gap — events before, a silent hole, then whatever the caller's fallback emits next — never the failure itself.

## 7. Health-check depth

**Deeper than a plain db/redis probe.** `apps/api`'s `GET /health` probes, in parallel with a 2s timeout each: `database` (SELECT 1, gates), `redis` (PING, gates), `deletion_sweep` (informational — a dead sweep delays erasure, doesn't break request paths, deliberately doesn't gate), `ai_service`+`ai_posture` (TD81, informational, logged on state CHANGE only), `storage_config` (**partially gates** — the `armed_without_credentials` flag DOES gate 503 outside dev/test, added specifically because #793 was health-green while photo/resume storage 503'd for every worker). This is a well-designed, incident-driven health check. Two self-documented caveats worth restating: `ai_posture` is **config-presence only** — "nobody ever asked Gemini whether that key works... a REVOKED, EXPIRED, quota-exhausted or typo'd key still reports `real`"; `storage_config` makes no network call to Supabase either. `/health` returning 200 is not proof any external provider is actually reachable.

`apps/ai-service`'s own `GET /health` is shallower — **liveness only**, no dependency probes at all. Under the default (unlocked) posture it returns `real_calls_enabled`/`langfuse_enabled`/spend snapshot (config-presence/in-memory reads only). Under the TD67-locked posture it trims to `{status, service, service_auth_enabled, build}` — apps/api's own probe is written to tolerate this ("`unknown` is honest ignorance, never silently downgraded to mock"). `build` (#965) is present in **both** postures on all three services: it is the short git sha of the running image, or the string `"unknown"` — never absent, never null. A sha is already public in the ghcr image tag, and the locked posture is the one deploys get debugged in, so it is deliberately not trimmed away.

**Not probed at all, on either service**: BullMQ queue depth/failed-job count (no `QueueEvents` listener, no Bull Board, grep returns nothing); external provider reachability (all inferred from config presence, never actually called); Docker/box-level resource pressure.

## 8. Alerting — does anything page a human?

**No.** Grep across `.github/workflows/*` for `slack|discord|webhook|notify|pagerduty` finds only the deploy-trigger webhook (unrelated to alerting) and email-provider config strings — no notification step exists anywhere in CI/CD. A failed `staging-cd.yml` run, a failed `/health` poll, or a red `ci.yml` job surfaces only as a red GitHub Actions run — no push (Slack/email/PagerDuty/SMS) reaches a human without them checking the Actions tab. `infra/monitoring/README.md`'s own "TODO (later): ... alerting" is accurate on this specific point.

## 9. Referenced runbooks that do not exist in the repository

**The most concrete, load-bearing finding in this document.** Code across the repo cites specific runbook paths, including section numbers, as the authoritative next step when something breaks — **none exist anywhere in git history** (confirmed: `git ls-files | grep -iE "runbook|rollback-guide|release-checklist|environment-variables|supabase-workflow|github-actions\.md"` → zero rows):

| Referenced path | Cited from | What it's supposed to say |
|---|---|---|
| `docs/observability-runbook.md` ("§7") | `health.controller.ts:34` | Alert threshold: "SEV2 if [deletion_sweep] stays down — DPDP erasure has stopped" |
| `docs/rollback-guide.md` | `ci.yml` (4 citations) | Export both image tags, re-run `compose up`, to roll back a deploy |
| `docs/ops/staging-service-deploy-runbook.md`, `docs/ops/otp-real-send-staging-runbook.md` | `staging-cd.yml` | Fresh-box config, real-OTP-send staging procedure |
| `docs/release-checklist.md`, `docs/github-actions.md`, `docs/environment-variables.md`, `docs/supabase-workflow.md`, `docs/pii-key-rotation-runbook.md` | Named in the devops-engineer role's own ownership mandate | Not evidenced anywhere in `docs/` |

The actual `docs/` tree contains only `architecture/`, `engineering-org/`, `payer-agent/`, `registers/`, `sprint-plans/` — **no `docs/ops/` directory exists at all**. Even in the one failure mode this audit found the code handles well in-band (§7's `deletion_sweep` health signal, correctly informational with a stated SEV2 threshold), the document that would tell an on-call engineer what SEV2 means operationally doesn't exist. The code's own citation is a promise the repository doesn't keep.

## 10. Summary — scenarios where "why did this request fail" cannot be answered today

| # | Scenario | What exists | What's missing |
|---|---|---|---|
| 1 | A synchronous ai-service call fails (chat, résumé gen, job-posting-chat) | One untagged log line, no event | No correlation to the originating request; no durable/queryable record beyond a silent (by-design) fallback |
| 2 | A total ai-service outage, sustained | `/health`'s `ai_posture` flips, logged on state change | No alert fires (§8); no aggregate "how many requests degraded" |
| 3 | Did an `ai.cost_recorded` row's call actually succeed? | The event row | `success`/`error_code`/`failure_reason` dropped from the payload (§5) |
| 4 | A BullMQ job fails after exhausting retries, on a non-extraction path | Varies per processor (not exhaustively audited) | No generic dead-letter visibility, no queue dashboard |
| 5 | A worker reports "my request failed, id X" | Response-body id exists | Server-side 5xx log line omits it (§1) |
| 6 | Admin wants to trace a correlation id end-to-end | `GET /admin/events/trace/:id` exists, indexed, wired to a real page | admin-web has no evidenced deployment (UNVERIFIED reachability); can only trace events that were actually emitted, which #1/#2 are exactly the cases where none were |
| 7 | On-call needs to know what to do about a named threshold (e.g. `deletion_sweep` SEV2) | The code names the threshold | The runbook that would say what to do doesn't exist (§9) |
| 8 | Any of the above, unwatched | — | No alerting mechanism exists at all (§8) |

## Key gaps for the remediation backlog

1. **`AiService.post()` forwards no request/correlation id, and its failure path produces no event.** Root cause of #1, #2, #5. Highest-leverage fix: thread `x-request-id`/`x-correlation-id` through `post()`'s headers (mirroring the existing `x-ai-internal-token` pattern) and add ai-service-side middleware to read/log them.
2. **`AiCostRecordedPayload` silently drops `success`/`error_code`/`failure_reason`** — a low-risk, additive schema widen (the event registry already has additive-only-widening precedent).
3. **Every DevOps-owned runbook referenced by name in code/CI does not exist** — 9 distinct citations across `health.controller.ts`, `ci.yml`, `staging-cd.yml`.
4. **No alerting mechanism exists anywhere** — confirmed, not merely stale-documented.
5. **No BullMQ queue/dead-letter visibility** beyond each processor's own terminal catch — profile-extraction's is good; the other five processor types not exhaustively audited this pass.
6. **Positive finding, for balance**: `GET /health` and the profile-extraction failure path are both genuinely well-engineered, incident-driven designs (#793's storage-armed-without-credentials gate; the LLM-outage-vs-posture retry distinction). The gap is that this quality isn't uniform across the codebase's other AI/queue call sites, not that the pattern is unknown to the team.

---

**Files referenced**: `apps/api/src/common/{logging/structured-logger.ts,middleware/request-id.middleware.ts,request-context.ts,filters/all-exceptions.filter.ts}`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/ai/{ai.service.ts,ai-cost-recorder.service.ts}`, `apps/api/src/profiles/profile-extraction.processor.ts`, `apps/api/src/profiling/orchestrator.service.ts`, `apps/api/src/events/{events.controller,events.repository}.ts`, `apps/api/src/admin/admin-events.{controller,service,dto}.ts`, `apps/admin-web/src/lib/events.ts`, `apps/admin-web/src/app/(portal)/events/[id]/page.tsx`, `apps/api/src/health/{health.service,health.controller}.ts`, `apps/ai-service/app/{main.py,logging_config.py,routers/{health,privacy,profile}.py,ai/{cost_tracker,langfuse_tracing}.py,contracts.py}`, `packages/ai-contracts/src/common.ts`, `packages/event-schema/src/payloads.ts`, `packages/db/src/schema/ops.ts`, `infra/monitoring/README.md`, `.github/workflows/{ci,staging-cd}.yml`.
