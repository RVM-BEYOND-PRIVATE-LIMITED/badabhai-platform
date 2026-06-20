---
name: observability-review
description: Verify a change is observable — structured logs with request id (no PII), events flowing, AI/async jobs visible, failure paths surfaced, and alert severity defined. Use when adding a flow; pairs with bb-monitoring.
---

# Skill: Observability Review

**Goal.** Ensure you can tell whether a change is working in production and find out fast when it
isn't — without logging anything sensitive.

**Inputs.** The change; the [structured logger](../../../apps/api/src/common/logging/); the `events`
table; `ai_jobs`; the ops console; [monitoring notes](../../../infra/monitoring/README.md).

**Process.**

1. **Events:** the flow emits its events and they validate (the `events` table is the primary signal).
2. **Logs:** structured, carry the request id / correlation id, and contain **no PII** (ids/hashes only).
3. **Errors:** failures go through the consistent API error shape (`AllExceptionsFilter`); the
   request id is in the response so a user report maps to a log line.
4. **AI / async work:** observable via `ai_jobs` + `ai.*` events; treat Langfuse / Sentry / OTel as
   gaps (placeholders today) rather than assuming coverage.
5. **Failure visibility:** failed jobs / webhooks / notifications are recorded, not silently dropped.
6. **Alerting severity** — define what "unhealthy" looks like and the level:
   - **SEV1** user-facing outage / data loss / PII leak — page immediately.
   - **SEV2** a degraded critical flow (extraction/resume failing) — urgent.
   - **SEV3** elevated errors / slow path — next business day.
     Log alerting gaps as tech-debt.

**Checklist.**

- [ ] Events emitted + validating for the new flow.
- [ ] Logs carry request id; no PII.
- [ ] Errors use the standard shape; request id is traceable end-to-end.
- [ ] AI/async work observable; failures recorded, not dropped.
- [ ] "Unhealthy" signal + severity defined; gaps logged.

**Expected Output.** Confirmation the change is observable end-to-end (events, logs, ops view) plus
logged observability gaps and their severities.

**Failure Conditions.** A flow with no event/log signal; PII in logs; silent failure paths;
declaring done without ops visibility.

**See also.** [`bb-monitoring`](../bb-monitoring/SKILL.md) · `docs/observability-runbook.md` (Phase 7).
