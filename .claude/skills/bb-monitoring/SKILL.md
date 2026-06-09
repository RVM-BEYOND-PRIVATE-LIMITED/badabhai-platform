---
name: bb-monitoring
description: Make a change observable — structured logs with request id, events flowing, AI jobs visible (Langfuse placeholder), and the change confirmable in the ops console. Use during the Monitoring stage and when adding a new flow.
---

# Skill: Monitoring

**Goal.** Ensure a change is visible in operation — you can tell whether it's
working and find out fast when it isn't — without logging anything sensitive.

**Inputs.** The change; the [structured logger](../../../apps/api/src/common/logging/);
the `events` table; the `ai_jobs` view; the ops console;
[monitoring notes](../../../infra/monitoring/README.md).

**Process.**
1. Confirm the flow emits its events and they validate — the `events` table is the
   primary signal.
2. Confirm structured logs carry the request id and **no PII** (ids/hashes only).
3. For AI work, confirm `ai_jobs` + the `ai.*` events make the job observable
   (Langfuse is a placeholder today — note the gap).
4. Verify the change is visible in the ops console (workers / events / ai-jobs).
5. Define what "unhealthy" looks like for this change and how you'd notice (logs,
   missing events, error rate) — note alerting gaps as tech-debt.

**Checklist.**
- [ ] Events emitted + validating for the new flow.
- [ ] Logs carry request id; no PII in logs.
- [ ] AI work observable via `ai_jobs` + `ai.*` events.
- [ ] Change visible in the ops console.
- [ ] "Unhealthy" signal defined; alerting gaps logged.

**Expected Output.** Confirmation the change is observable end-to-end (events, logs,
ops view) plus any logged observability gaps.

**Failure Conditions.** A flow with no event/log signal; PII in logs; AI work that's
a black box; declaring done without confirming ops visibility.
