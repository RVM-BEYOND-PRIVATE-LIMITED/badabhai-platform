# Observability Runbook

> What exists today for seeing whether BadaBhai is working — and finding out fast
> when it isn't — plus the forward plan. Phase 1 observability is deliberately
> lightweight and **placeholder-driven**: structured JSON logs, the `events` table
> as the audit/observability spine, read-only ops console views, and a Langfuse
> _placeholder_ for LLM traces. Sentry / OpenTelemetry are **PLAN only** (env
> placeholders, no integration).
>
> Privacy first: every signal here is PII-free by construction. Logs, events,
> `ai_jobs`, traces, and metrics carry ids / hashes / numbers only — never phone,
> name, address, or employer (CLAUDE.md §2). If a signal would require PII to be
> useful, that is a design bug, not a logging gap.

Companion docs (link, don't duplicate):
[infra/monitoring/README.md](../infra/monitoring/README.md) ·
[bb-monitoring skill](../.claude/skills/bb-monitoring/SKILL.md) ·
[docs/ai/phase-1-ai-privacy-review.md](ai/phase-1-ai-privacy-review.md) ·
[.env.example](../.env.example) (template; placeholders only).

---

## 1. Structured logging convention

Both backends emit **one JSON object per line** to stdout (stderr for `error`/
`fatal`), so logs are machine-parseable in any environment with no log agent
required.

- **API (NestJS)** — [`apps/api/src/common/logging/structured-logger.ts`](../apps/api/src/common/logging/structured-logger.ts).
  Wired via `app.useLogger(...)` so NestJS's own `Logger` calls also route through
  it. Fields: `level`, `time` (ISO 8601), `service` (`"api"`), `context`,
  `message`. `error`/`fatal` go to **stderr**; everything else to **stdout**.
- **AI service (FastAPI)** — [`apps/ai-service/app/logging_config.py`](../apps/ai-service/app/logging_config.py).
  `JsonFormatter` emits `level`, `time`, `service` (`"ai-service"`), `logger`
  (logger name, e.g. `ai.cost`, `ai.langfuse`), `message`, plus any structured
  extras passed as `logger.info(..., extra={"extra": {...}})`.

**Rules.**

- Log **ids / hashes / opaque refs**, never raw PII. The AI cost log
  ([`cost_tracker.py`](../apps/ai-service/app/ai/cost_tracker.py) `ai_call`) is the
  model: model name, tokens, INR, ids — no message content.
- Prefer logging _that_ something happened plus the event/job id; the **event row**
  is the durable record, the log line is the breadcrumb to it.
- No stack traces or internal payloads to clients — only to server-side error logs
  (see §3).

---

## 2. Request-id / correlation-id propagation (API → AI)

[`apps/api/src/common/middleware/request-id.middleware.ts`](../apps/api/src/common/middleware/request-id.middleware.ts)
assigns, per request:

- **`requestId`** — free-form, honors inbound `x-request-id` (≤128 chars) else a
  fresh UUID. Echoed in the `x-request-id` response header.
- **`correlationId`** — UUID, honors inbound `x-correlation-id` only if it is a
  valid UUID, else fresh. Echoed in `x-correlation-id`. This is the id that ties
  together **all events** produced while handling one request.

Both are read in controllers via the `@Ctx()` decorator
([`apps/api/src/common/request-context.ts`](../apps/api/src/common/request-context.ts))
and threaded into emitted events for tracing.

**Cross-service tracing.** When the API calls the AI service, propagate
`x-request-id` / `x-correlation-id` on the outbound request so the AI-service log
lines for that work can be joined to the originating API request. The middleware
already accepts inbound values, so propagation is the only missing link to verify
per call site.

> TODO(verify): confirm the API HTTP client to `AI_SERVICE_URL` forwards
> `x-request-id` / `x-correlation-id` on every call; if any call site omits them,
> AI-service logs for that path cannot be correlated back to the API request.

---

## 3. API error / exception format

[`apps/api/src/common/filters/all-exceptions.filter.ts`](../apps/api/src/common/filters/all-exceptions.filter.ts)
is the global filter. Every error response is the same JSON shape:

```json
{
  "statusCode": 500,
  "error": { "message": "..." },
  "requestId": "<x-request-id>",
  "path": "/...",
  "timestamp": "<ISO 8601>"
}
```

- `5xx` (`status >= 500`) are logged server-side as
  `error("<METHOD> <url> -> <status>: <stack>")`; the **stack never reaches the
  client**.
- `4xx` carry the `HttpException` payload but no stack.
- The `requestId` in the body is the join key back to the server log line and to
  any correlated events — quote it in incident notes.

---

## 4. Events table — the audit / observability surface

The `events` table is the **audit spine and the primary operational signal**
(CLAUDE.md §2.1: no important state change without a validated event). Treat
"events flowing" as the first health check for any flow — a flow that goes quiet
in the event stream is the earliest "unhealthy" signal we have today.

Read-only ops console views (internal, [`apps/web/src/app/ops`](../apps/web/src/app/ops)):

| View    | Path                                                               | Use for                                             |
| ------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| Events  | [`ops/events/page.tsx`](../apps/web/src/app/ops/events/page.tsx)   | Live event stream — confirm a flow is emitting      |
| AI jobs | [`ops/ai-jobs/page.tsx`](../apps/web/src/app/ops/ai-jobs/page.tsx) | `ai_jobs` rows + `ai.*` events — AI work visibility |
| Workers | [`ops/workers/page.tsx`](../apps/web/src/app/ops/workers/page.tsx) | Worker / per-worker drill-down (PII-gated)          |

**Health endpoint.** [`apps/api/src/health/health.controller.ts`](../apps/api/src/health/health.controller.ts)
`GET /health` returns `{ status, service, environment, timestamp }` — a liveness
probe only (no dependency checks today).

> TODO(verify): `/health` does not currently probe DB / Redis / AI-service
> reachability — readiness/dependency checks are a follow-up (see §8).

---

## 5. LLM traces — Langfuse (PLACEHOLDER)

[`apps/ai-service/app/ai/langfuse_tracing.py`](../apps/ai-service/app/ai/langfuse_tracing.py)
is a **safe no-op wrapper**. It initializes only when both Langfuse keys are
present **and** the package is installed; otherwise every method is a no-op, so
local dev never depends on or crashes from Langfuse.

- Env (NAMES only — values never in git):
  `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`
  ([.env.example](../.env.example) "Observability (Langfuse placeholders)").
- **Privacy contract:** only **pseudonymized** `input_text` / `output_text` may be
  passed to `trace_generation(...)`. This wrapper must never receive or log raw
  phone / name / address / employer. Pseudonymization runs and fails closed
  _before_ any LLM call (CLAUDE.md §2.3).
- Until real LLM traces are live, **`ai_jobs` + `ai.*` events + the `ai_call`
  cost log are the AI observability surface.** Langfuse is a known gap, tracked in
  [infra/monitoring/README.md](../infra/monitoring/README.md).

A real Langfuse integration is gated on `AI_ENABLE_REAL_CALLS` being turned on in
staging first (CLAUDE.md §2.5).

---

## 6. Alert severity levels

No automated alerting is wired in Phase 1 (logs + ops console are pull-based).
These levels define how we _triage_ and, when alerting lands (§8), how routes map.
Examples are specific to this system.

| Sev      | Meaning                                | Examples (this system)                                                                                                                                                                                                                        | Response                                                                                                                                                          |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEV1** | PII exposure or platform down          | Raw PII (phone/name/address/employer) found in a log, event, `ai_jobs`, `audit_logs`, or an LLM input; pseudonymization bypass; API down / `/health` failing; DB unreachable.                                                                 | Page immediately, stop the bleed, **escalate to human** (CLAUDE.md §7). Treat any PII exposure as a privacy incident.                                             |
| **SEV2** | Core worker flow broken, no PII breach | Profiling chat / extraction failing for all workers; consent gate failing open or shut; events not emitting for a key flow; AI spend **daily/cumulative cap exceeded** (real calls now blocked); kill-switch unexpectedly engaged in staging. | Urgent triage same shift; mitigate (e.g. confirm gate defaults safe); root-cause via [bb-root-cause-analysis](../.claude/skills/bb-root-cause-analysis/SKILL.md). |
| **SEV3** | Degraded / partial, with fallback      | Elevated `5xx` on a non-core endpoint; AI provider fallback (Gemini → Claude) firing repeatedly; pseudonymization `blocked=True` rate elevated (workers get safe fallback, not failure); failed BullMQ jobs accumulating but retrying.        | Investigate within the day; log as tech-debt if structural.                                                                                                       |
| **SEV4** | Cosmetic / informational               | Single transient `4xx`; one-off provider timeout that retried green; `cost_alert` / `above_target` flags on individual AI calls (within caps); noisy but harmless log.                                                                        | Batch; note trends; no immediate action.                                                                                                                          |

**Escalation reminder.** Anything that could **expose secrets or PII**, any
**production data operation**, or **enabling a real external provider in a shared
env** is an automatic escalate-to-human regardless of Sev (CLAUDE.md §7).

---

## 7. Failed-work visibility

The places where work can fail silently today, and how you'd see it:

### Failed BullMQ jobs

Resume render runs on BullMQ
([`apps/api/src/resume/resume-render.processor.ts`](../apps/api/src/resume/resume-render.processor.ts):
`@nestjs/bullmq` `WorkerHost`). Retries are bounded; **terminal failure is marked
only on the last attempt**. Signals: the processor's terminal-failure log line +
the failure event/`ai_jobs`-style row, and (forward) the BullMQ failed-jobs set in
Redis.

> TODO(verify): there is no dashboard for the BullMQ **failed set** today —
> visibility is via logs + the terminal-failure event. A Bull Board / failed-job
> view is a follow-up.

### AI spend-cap exceeded

[`apps/ai-service/app/ai/cost_tracker.py`](../apps/ai-service/app/ai/cost_tracker.py)
`SpendLedger.would_exceed_spend(...)` blocks a real call **before** the network
hop when projected cost would breach a cap, returning a reason:
`user_daily_cap_exceeded` · `daily_cap_exceeded` · `cumulative_cap_exceeded`.
Caps (env NAMES; INR defaults live in [`config.py`](../apps/ai-service/app/config.py)):
`AI_MAX_USER_DAILY_COST_INR`, `AI_MAX_DAILY_COST_INR`, `AI_MAX_TOTAL_COST_INR`,
plus per-call `AI_MAX_CALL_COST_INR` and the independent hard
`AI_REAL_CALLS_KILL_SWITCH`. A breach means real calls are now **blocked** (safe,
but worker-facing AI degrades) → treat as **SEV2**. Visibility: the `ai_call` cost
log, the block reason, and `SpendLedger.snapshot(...)` (PII-free usage-vs-cap).

> Note: the ledger is **per-process** (per Uvicorn worker), so caps are per-worker,
> not global, until a shared Redis-keyed store lands (TD27, see the `SpendLedger`
> docstring).

### Fail-closed pseudonymization

[`apps/ai-service/app/pseudonymize.py`](../apps/ai-service/app/pseudonymize.py)
returns `blocked=True` on parse error, oversize input, or a **residual numeric
sequence** (`\d{7,}`) that looks like un-masked PII — and the LLM is then **never
called**; a safe fallback is returned. This is correct, protective behavior, not an
outage. An **elevated `blocked` rate** is the signal: SEV3 (workers still get a
fallback), but investigate the input shape driving blocks.

### OTP / SMS delivery (F4 — worker login path)

Real Fast2SMS is the **only** worker-OTP send path (no console/mock), so SMS
delivery failing = **workers cannot log in**. Two PII-free event-spine signals
(both `actor_type: "system"`, aggregate payloads — never a phone/hash/code):

- **`worker.otp_send_failed`** — one per failed real send, payload
  `{provider: "fast2sms", reason}` with `reason` ∈ `transport` (network/DNS/TLS to
  the provider) · `http_error` (provider answered non-2xx) · `provider_rejected`
  (provider answered 200 but `return:false`, or an unparseable body). Emitted by
  [`auth.service.ts`](../apps/api/src/auth/auth.service.ts) from the tagged 502;
  the worker sees the same neutral "Could not send the code, please retry".
- **`worker.otp_send_cap_exceeded`** — the OTP-5 **global daily send
  circuit-breaker** (the spend ceiling / kill-switch `OTP_GLOBAL_MAX_SENDS_PER_DAY`,
  `0` = paused) tripped. One per breach, payload `{channel, cap, limit, window}`.

**What to watch:** the **send-failure rate** — `worker.otp_send_failed` count vs
`worker.otp_requested` count over the same window — plus any
`worker.otp_send_cap_exceeded` occurrence (the breaker firing is always
notable: either real abuse pressure or the cap/kill-switch engaged).

**Suggested alert threshold** (wire when alerting lands, §8): send-failure rate
**> 10% over 15 minutes with ≥ 5 failures**, or **≥ 3 consecutive** failures with
zero successes → treat as **SEV2** (core worker flow broken — login is blocked for
new/returning devices). A lone `transport` blip that recovers is SEV4-noise.

**First response:**

1. Split by `reason` (the events list / ops console filter on
   `worker.otp_send_failed`): `transport` → egress/DNS/provider reachability;
   `http_error` → check the Fast2SMS status page + the API key/quota (a sudden
   401/402-shaped burst after a deploy = credential/config regression);
   `provider_rejected` → DLT template/sender-id/route problem or provider-side
   balance — check the Fast2SMS dashboard delivery report.
2. Correlate with `worker.otp_send_cap_exceeded`: if the breaker fired, failures
   may be the cap (by design), not the provider — confirm
   `OTP_GLOBAL_MAX_SENDS_PER_DAY` wasn't left at `0` (kill-switch) unintentionally.
3. Cross-check the API logs for the paired `Fast2SMS …` / `OTP send failed`
   `logger.error` lines (phone-hash prefix + status only) for the HTTP status
   detail the event deliberately omits.
4. If the provider is down hard: there is no fallback SMS provider (locked stack,
   §3) — escalate to human per CLAUDE.md §7 before touching provider config.

---

## 8. Plan (NOT integrated — env placeholders only)

The following are roadmap, consistent with the "TODO (later)" in
[infra/monitoring/README.md](../infra/monitoring/README.md). **No DSNs, keys, or
live wiring exist; do not claim integration.**

- **Sentry (PLAN)** — error/exception aggregation + alert routing for the Sev
  levels in §6. Would consume the `requestId` from §3 as the trace key.
  Reserved env NAMES (placeholders only, never values): `SENTRY_DSN`,
  `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`.
  > TODO(verify): these env names are **proposed**, not yet in
  > [packages/config/src/server.ts](../packages/config/src/server.ts) or
  > [.env.example](../.env.example) — add them under a Zod gate before use.
- **OpenTelemetry (PLAN)** — distributed traces + metrics across API ↔ AI service,
  reusing the existing `x-correlation-id` propagation (§2) as the trace context.
  Reserved env NAMES (placeholders only): `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER`.
  > TODO(verify): not present in config/env today — proposed names only.
- **Langfuse (PLACEHOLDER → real)** — flip from no-op to live once
  `AI_ENABLE_REAL_CALLS` is on in staging (§5). Env names already reserved.
- **Health readiness** — extend `/health` (§4) with DB / Redis / AI-service
  dependency probes for a true readiness signal.
- **Failed-job dashboard** — a BullMQ failed-set view (§7) and a shared,
  Redis-keyed spend ledger so caps are global, not per-process.

Any of these that touches a real external provider, a shared environment, or
secrets is an **escalate-to-human** step before enabling (CLAUDE.md §7).
