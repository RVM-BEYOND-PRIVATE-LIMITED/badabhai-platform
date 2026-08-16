# Observability Runbook

Reconstructed from live citations of this file (`docs/audit/22_REMEDIATION_BACKLOG.md` BL-20,
`docs/audit/24_RISK_REGISTER.md` R46) — the file was deleted in the 2026-08-05 docs purge
(`eb151468`) but `§7` specifically is still cited by name from three places in `apps/api`'s
running code and one ADR. This document reconstructs those citations plus the surrounding
health-check/logging surface from the code that actually implements it — `apps/api/src/health/`,
`apps/api/src/common/`, `packages/event-schema`, `infra/monitoring/README.md`. Where the repo's
own audits ([`16_OBSERVABILITY_AUDIT.md`](audit/16_OBSERVABILITY_AUDIT.md)) found a real gap
(no alerting, no log shipping), this doc says so plainly instead of inventing a dashboard that
does not exist.

## Who cites this file today

| Citing line                                                 | What it says                                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/health/health.controller.ts:34`               | "the alert threshold in `docs/observability-runbook.md §7` (SEV2 if [`deletion_sweep`] stays down — DPDP erasure has stopped)"                                    |
| `apps/api/src/auth/account-deletion-sweep.processor.ts:145` | Sweep-scheduler registration failure log: "`GET /health` reports `checks.deletion_sweep=down` until it is re-registered (see `docs/observability-runbook.md §7`)" |
| `packages/event-schema/src/registry.ts:166`                 | `worker.otp_send_failed` event comment: "an elevated rate = delivery degradation (see `docs/observability-runbook.md §7`)"                                        |
| `docs/decisions/0031-account-deletion-grace-window.md:119`  | "Alert threshold + triage: `observability-runbook.md §7`"                                                                                                         |

All four point at the same section — the deletion-sweep/otp-failure alert threshold — which is
why §7 is the one fully-specified section below. No live citation names any other section
number, so the rest of this document is a reconstruction of the surrounding mechanism (request
tracing, health checks, logging), not a citation-verified transcript.

## §1 — Request tracing

Every request gets two ids, assigned by `RequestIdMiddleware`
(`apps/api/src/common/middleware/request-id.middleware.ts`), registered globally:

- `requestId` — free-form (≤128 chars), echoed from an inbound `x-request-id` header or minted
  fresh (`randomUUID()`). Returned on every response as `x-request-id`.
- `correlationId` — a UUID, honored from an inbound `x-correlation-id` header (validated against
  a UUID regex — an invalid inbound value is replaced, never trusted verbatim) or minted fresh.
  Returned as `x-correlation-id`.

Both are attached to `req` (`req.requestId`/`req.correlationId`) and exposed to controllers via
the `@Ctx()` param decorator (`apps/api/src/common/request-context.ts`), "so they can be threaded
into events for tracing."

**R45 — CLOSED, in two stages.** This section used to read "the HTTP client between `apps/api`
and `apps/ai-service` does not forward `x-request-id`/`x-correlation-id`", and called it the
single largest hole in this runbook's own guarantee. It was, and it is now shut:

1. **BL-19** threaded both headers through `AiService.post()` (mirroring the `x-ai-internal-token`
   pattern) and added the ai-service-side middleware that validates them to UUID shape and binds
   them to every log line for that request (`apps/ai-service/app/main.py`, `request_id_tracing`).
2. The Langfuse work then made the same id the **trace** id (§6.2), and closed the remaining
   call sites that had a correlation id in scope and were still dropping it — `llmTurn`,
   `pseudonymize`, `canonicalizeSkill`, and both job-posting-chat calls. Each of those used to
   mint a fresh uncorrelated uuid per call, so the id existed but the join did not.

One residual worth knowing: a caller that sends a **non-UUID-shaped** header gets it silently
replaced with a fresh uuid4 (`_TRACE_ID_RE`, `app/main.py`). That is deliberate — it stops caller
free text reaching a log line or a trace attribute — but it means a malformed id degrades to _no
correlation_ with no error anywhere. Check this first when a trace looks orphaned.

**Trace lookup:** `GET /admin/events/trace/:correlationId` (backed by `apps/admin-web`'s
`getTrace(correlationId)`) surfaces every event emitted under one correlation id. With R45 closed,
the same id now also resolves the Langfuse trace — via `derive_trace_id`, not by equality, so the
two must be looked up by their own means rather than pasted into each other.

## §2 — Structured logging

`apps/api` boots with a custom `StructuredLogger`
(`apps/api/src/common/logging/structured-logger.ts`), wired via
`NestFactory.create(AppModule, { logger: new StructuredLogger("api") })` in `main.ts` — NestJS's
own `Logger` calls route through it too. Each line is one JSON object to stdout (or stderr for
`error`/`fatal`):

```json
{
  "level": "info",
  "time": "2026-08-14T...",
  "service": "api",
  "context": "Bootstrap",
  "message": "..."
}
```

Fields: `level`, `time` (ISO-8601), `service` (`"api"`), `context` (Nest's logger context, when
given), `message`. **The request/correlation ids from §1 are NOT currently included in this JSON
shape** — a caller must thread them into the message text itself if they want them in a specific
log line; there is no structured field for them today. No log destination beyond stdout/stderr is
configured anywhere in this repo — no shipping, no retention, no search
(`infra/monitoring/README.md`'s own words: "TODO (later): metrics ..., dashboards, alerting").

**PII discipline (CLAUDE.md §3):** every log line audited in this reconstruction follows the same
pattern — opaque ids, error _codes_/_names_, never a message that could carry a connection
string or credential. `HealthService.safeReason()` is the canonical example: it logs
`err.code ?? err.name`, explicitly never `err.message`, because a DB/Redis driver error message
can carry a connection string.

## §3 — Health checks (`GET /health`, `apps/api`)

Implemented in `apps/api/src/health/health.service.ts` + `health.controller.ts`. Every dependency
probe runs in parallel under a 2s timeout (`PROBE_TIMEOUT_MS`); a probe failure never throws out
of the request — it degrades to `"down"` and logs a secret-safe reason server-side only.

| Check                       | Gates 200/503?                                                                                                   | What it actually proves                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`                  | **Yes**                                                                                                          | `SELECT 1` over the pooled Drizzle connection                                                                                                                                                                                          |
| `redis`                     | **Yes**                                                                                                          | `PING` over the existing BullMQ ioredis client                                                                                                                                                                                         |
| `deletion_sweep`            | No (informational — see §7)                                                                                      | The ADR-0031 sweep's repeatable job scheduler exists in Redis (a live lookup, not a process-local flag — stays correct across replicas and after an out-of-band flush)                                                                 |
| `ai_service` / `ai_posture` | No (informational)                                                                                               | Whether `apps/ai-service` is reachable, and whether it reports real (vs. mocked) LLM calls. **Config-presence only — no LLM is ever actually called to produce this field.** A revoked/expired/quota-exhausted key still reads `real`. |
| `storage_config`            | **Partially** — `armed_without_credentials` gates outside dev/test (see below); everything else is informational | Whether a Supabase Storage consumer (a bucket env var, or `RESUME_RENDER_ENABLED`) is armed while `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are absent. Also config-presence only — no network call to Supabase.                      |

**The one field that flips the status code beyond database/redis:**
`storage_config.armed_without_credentials`. Added by #793 after a real incident — a deployed box
had Storage consumers armed (a bucket name set, or resume rendering on) with no Supabase
credentials, `/health` reported fully healthy, and every photo upload / resume download 503'd for
every worker. The gate is scoped to deployed environments only (`!isDevEnv()`), because the base
`docker-compose.yml` ships `RESUME_RENDER_ENABLED: "true"` with an empty `SUPABASE_URL` by
default — that is a legitimate, green state on a laptop and in CI.

`deletion_sweep`, `ai_service`/`ai_posture`, and the rest of `storage_config` are deliberately
**informational, never gating** — the documented reasoning (verbatim from `health.controller.ts`)
is that 503-ing on any of them would fail the CD `/health` poll and the staging smoke, converting
a delayed-but-recoverable background condition (a dead sweep clock, mocked AI, an unconfigured
bucket on a box with no Storage traffic) into a full outage that pulls a healthy API out of a
rotation. They are surfaced for **detection** instead — this section.

## §4 — AI posture logging (TD81)

`HealthService` logs the ai-service reachability/posture pair **on change only** (not on every
poll — `/health` is hit by the CD gate, the staging smoke, and any uptime check, so an
unconditional log would become wallpaper). Three branches, all secret-free:

- `real` → `log()` (not a warning): "the ai-service reports real calls ENABLED... a
  revoked/expired key still reads real." Worth a line because flipping an environment to real LLM
  spend should be stamped in the log.
- `unknown` (TD67-locked posture) → `warn()`: the ai-service is withholding
  `real_calls_enabled` because its own `AI_INTERNAL_TOKEN` is set; confirm real-vs-mock out of
  band via the token-gated `/ai/spend` endpoint.
- `mock` → `warn()`: either the ai-service is unreachable (every call falls back to the in-process
  TypeScript mock) or it is reachable but reports real calls disabled.

## §5 — Health-check probes NOT covered

Per [`16_OBSERVABILITY_AUDIT.md`](audit/16_OBSERVABILITY_AUDIT.md) §7 (re-verified against
current code for this reconstruction): BullMQ queue depth / failed-job count (no `QueueEvents`
listener, no Bull Board — grep returns nothing), external-provider reachability beyond the two
config-presence checks above (nothing is ever actually called), and Docker/box-level resource
pressure. `apps/ai-service`'s own `GET /health` is liveness-only, no dependency probes at all.

## §6 — Langfuse tracing (dormant by config, not by code)

`apps/ai-service/app/ai/langfuse_tracing.py` is real and wired into the router, embeddings, and
every LLM-touching route. It initializes only when both `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY` are set (`settings.langfuse_enabled`) and no-ops otherwise — dormant in
every committed environment today because no keys are configured, not because the integration is
unbuilt. `GET /health` on the ai-service reports `langfuse_enabled` live. Only pseudonymized text
is ever traced (CLAUDE.md §3 "Privacy First").

### §6.1 — The trace hierarchy

Three levels. The top one is a business operation, not an AI task, because "why did this
candidate get this result?" is asked at that grain:

```
WORKFLOW   build-worker-profile          <- the ROOT trace  (routers, via workflow_scope)
  ├─ TASK        parse-worker-profile    <- one unit of AI work  (AIRouter.run)
  │    └─ GENERATION  llm-call           <- one ACTUAL provider request  (per attempt)
  └─ SPAN        apply-parse-gates       <- the six-gate wall, counts only
```

A `task` opened with no workflow around it is still its own root, so any route that has not been
migrated behaves exactly as it did before the workflow layer existed.

**One generation per real provider request — never per logical call.** A cross-provider fallback
that succeeded on its third try shows three generations with `attempt` 1/2/3, the first two
`level=ERROR`. Internal retries that never reach the network do not create observations.

### §6.2 — Cross-service correlation

`apps/api` already stamps `x-request-id` / `x-correlation-id` on every ai-service call (BL-19),
and the ai-service middleware validates both to UUID shape. `workflow_scope` turns that existing
correlation id into the Langfuse trace id via `derive_trace_id` (SHA-256, first 32 hex = the
W3C shape). It is a **pure function with no shared store**, which is the whole mechanism: two
ai-service calls carrying the same correlation id land in the same trace. Hashed rather than
hex-stripped so the correlation id is never published verbatim as the trace id.

If correlation ever breaks, suspect `_TRACE_ID_RE` in `app/main.py`: a non-UUID-shaped header is
silently replaced with a fresh uuid4, so a bad caller loses correlation with **no error anywhere**.

### §6.3 — Scores (deterministic only)

Recorded from measurements that already ran for their own reasons. Nothing here is estimated and
nothing asks a model to judge a model (LLM-as-judge is deliberately a later stage).

| Score                               | Type        | Meaning                                                   |
| ----------------------------------- | ----------- | --------------------------------------------------------- |
| `parse_gate_acceptance`             | NUMERIC 0–1 | requested fields that survived the six-gate wall          |
| `parse_disagreement_count`          | NUMERIC     | fields where the LLM disagreed with the deterministic map |
| `parse_output_contract_valid`       | BOOLEAN     | did the model's JSON validate against the contract        |
| `interview_extract_certified_ratio` | NUMERIC 0–1 | Phase C values that survived PII re-certification         |
| `interview_extract_contract_valid`  | BOOLEAN     | as above, for Phase C                                     |

Scores are recorded only when `meta.real_call` is true — a mock call measures nothing. Score
comments carry closed-set codes and counts only, never a worker value.

### §6.4 — Prompt versions

Every generation records `prompt_name`, `prompt_version` and `prompt_source` in metadata.
**Versions work with Langfuse prompt management OFF** (the committed default): a local prompt is
versioned `local:<sha256[:12]>` of the exact text sent, which changes when and only when the
prompt changes. `LANGFUSE_PROMPTS_ENABLED=true` switches the source to Langfuse
(`langfuse:v<n>`) and links the generation to the managed prompt. Every fetch failure falls back
to the local text.

Three prompts are registered — the only three on a live LLM path: `worker-interview-turn`,
`worker-interview-extract`, `profile-parse`.

### §6.5 — Capability readout, and why it exists

`GET /health` reports `langfuse_capabilities`: `{scores, prompt_management, trace_continuation}`.
The `langfuse` SDK is an **optional dependency, installed in the Docker image
(`requirements-ai.txt`) but not by `requirements-dev.txt` or any CI job**, so the wrapper binds
scoring / prompt / trace-continuation methods by _probe_ at init rather than hardcoding names.
Every unbound capability degrades to a silent no-op by design — so without this readout, "no
scores in Langfuse" and "this SDK build has no scoring method" look identical from outside, and
only one of those is a bug. **Check this field first** when expected data is missing.

**Verified against langfuse 4.14.4** (the version the current pin resolves to). A healthy
install reports:

```json
{ "scores": "current", "prompt_management": true, "trace_continuation": true }
```

`"scores": "current"` means it bound `score_current_trace`, which addresses the active trace and
needs no id from us; `"explicit"` would mean it fell back to `create_score` and must be handed a
`trace_id`. Confirmed present on 4.14.4: `score_current_trace`, `create_score`, `get_prompt`
(with `fallback=` and `cache_ttl_seconds=`), `create_trace_id`, `get_current_trace_id`, and
`start_as_current_observation` accepting `trace_context`, `model_parameters` and `prompt`.
Notably **absent** on that version and deliberately not used: `start_as_current_span`,
`start_as_current_generation`, `update_current_trace`.

`tests/test_ai_observability.py` ends with a guard test that re-asserts this surface against the
installed package and skips when it is absent — so a version bump that moves any of these fails
CI rather than silently emptying the dashboards.

### §6.6 — Arming it

Order matters; each step is independently reversible.

1. Provision a Langfuse project. **Record data-retention / no-train terms first** — ADR-0030
   §7(e) requires that before a new external PII-egress surface goes live, and no ADR covers
   Langfuse as a processor yet. A trace store becomes a DSAR/erasure-relevant location that
   ADR-0026 / ADR-0031 deletion sweeps do **not** reach.
2. On the box: `export LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=…` plus
   `LANGFUSE_TRACING_ENVIRONMENT` (compose defaults it to `staging`) and `APP_VERSION=<git sha>`.
   `docker-compose.staging.yml` declares all of these on the **ai-service block only** — they are
   deliberately absent from the `api` block, where `packages/config`'s `.min(1).optional()` would
   reject the empty string a pass-through supplies and crash-loop the api at boot.
3. Re-run the deploy. Confirm `langfuse_enabled: true` and a fully-bound `langfuse_capabilities`
   on the token-gated `/health`.
4. **Rollback is one export**: `export LANGFUSE_PUBLIC_KEY=` and re-deploy. Tracing is fail-open
   everywhere, so removing it cannot affect AI behaviour.

Arming tracing is **independent of** arming real LLM calls. Tracing a mock-mode service is
useful and free — the calls an operator most needs to see are the ones that never reached a
provider, and those are exactly the ones a provider-level integration would never record.

## §7 — Alert thresholds and triage (the section every citation points at)

**This is the section every live citation names, and it is honestly the only place in this
document with a concrete, code-verified number.**

### `deletion_sweep` (ADR-0031)

- **Threshold: SEV2 if `checks.deletion_sweep` stays `"down"` on `GET /health`.** This is the
  exact wording `health.controller.ts` cites this section for: "SEV2 if it stays down — DPDP
  erasure has stopped."
- **Why it's SEV2, not SEV1:** a dead sweep does not break any request path — every worker/payer
  route keeps serving normally, and the DB marker (`workers.deletion_scheduled_at`) stays intact,
  so erasure is **delayed**, not lost. It becomes urgent because DPDP erasure has a legal
  time-bound obligation, not because anything user-visible is broken.
- **Self-healing window:** the sweep processor retries its own scheduler registration on a bounded
  backoff at boot (1 immediate attempt + retries at 1s/5s/15s/60s, ≈80s total cover). If it is
  still `down` after that, it is dead in that process until the next boot or another replica
  re-registers it — `checks.deletion_sweep` stays `"down"` until then.
- **Triage:**
  1. Confirm on `GET /health` that `checks.deletion_sweep == "down"` (not a one-off probe
     timeout — the probe itself has a 2s cap and can flap on Redis latency).
  2. Check the API process logs for `sweep scheduler registration FAILED after 5 attempts` — this
     is the loud, terminal log line (`account-deletion-sweep.processor.ts`), and it names the
     failure reason.
  3. Most likely cause: Redis unreachable/ACL-denied, or a BullMQ API mismatch after a dependency
     bump (both fail identically on every boot — not transient, so restarting alone will not fix
     an ACL/permissions problem).
  4. Restarting the API process re-attempts registration from scratch (the scheduler id is
     idempotent — `upsertJobScheduler` re-asserts the same scheduler rather than duplicating it).
  5. **There is currently no automated page for this** — see the gap below. An operator must be
     watching `/health` or the logs.

### `worker.otp_send_failed` (F4, #168 — real Fast2SMS send failures)

- **Signal:** an _elevated rate_ of the `worker.otp_send_failed` event (aggregate/PII-free —
  provider literal + failure-kind enum only, no phone/hash/worker id/code/HTTP status) "= delivery
  degradation," per `packages/event-schema/src/registry.ts`'s own comment citing this section.
- **No numeric threshold is defined anywhere in code** — this is a genuine gap this
  reconstruction cannot honestly fill in. Whoever owns this alert needs to pick a rate (e.g.
  "N failures in a rolling hour") and wire it — there is no dashboard or query pre-built for it
  today; it would need to be read out of the `events` table.
- **Triage direction:** distinguish a Fast2SMS-side outage (provider down/rate-limited) from a
  local misconfiguration (`FAST2SMS_API_KEY`/`FAST2SMS_SENDER_ID`/`FAST2SMS_DLT_TEMPLATE_ID`
  wrong or rotated) — both produce this event, only one needs a code/secret change.

### The gap this section cannot paper over: **no alerting exists**

Per [`16_OBSERVABILITY_AUDIT.md`](audit/16_OBSERVABILITY_AUDIT.md) §8 (re-verified for this
reconstruction — `grep` across `.github/workflows/*` for
`slack|discord|webhook|notify|pagerduty` finds only the unrelated staging deploy-trigger webhook
and email-provider config strings): **nothing pages a human.** A SEV2 `deletion_sweep` outage, a
failed `staging-cd.yml` run, or a red `ci.yml` job is visible only to someone who checks
`GET /health` or the GitHub Actions tab. Until that is wired (Slack/PagerDuty/email webhook from
CI and/or a scheduled `/health` poll), the thresholds above are triage criteria for a human who
already noticed something, not an automated alert.

## What this runbook does not cover

Metrics/dashboards (none exist — `infra/monitoring/README.md`'s own "TODO (later)"); log
shipping/retention/search (none exists — stdout/stderr only); the AI-service side of tracing a
failed call (R45, open, §1 above); a numeric threshold for the OTP-failure alert (undefined in
code, §7 above).
