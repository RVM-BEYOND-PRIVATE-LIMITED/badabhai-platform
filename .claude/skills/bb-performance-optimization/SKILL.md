---
name: bb-performance-optimization
description: Find and fix performance issues on BadaBhai's per-worker/per-message hot paths — N+1 queries, missing indexes, blocking work that should be queued, unbounded payloads. Evidence-driven, no premature optimization. Use during the Performance review stage.
---

# Skill: Performance Optimization

**Goal.** Keep the paths that run per-worker and per-message fast and cheap, with
slow AI work off the request thread — guided by evidence, not guesswork.

**Inputs.** The change/endpoint; the queries it runs; expected request volume; the
schema + indexes; measured latency where available.

**Process.**
1. Identify the hot path and what runs per request vs. per worker vs. per message.
2. Inspect queries for N+1s and missing indexes (read the query, check the schema).
3. Confirm slow work — profile extraction, transcription, future embedding/ranking
   — is queued (BullMQ), not inline (TD1 is the canonical example).
4. Check payload and event sizes are bounded; pagination is enforced.
5. Measure before optimizing; only change what the evidence implicates.
6. Re-measure to confirm the change helped.

**Checklist.**
- [ ] No new N+1; new query paths indexed.
- [ ] Slow/AI work queued, not blocking the request.
- [ ] Payloads/event volume bounded; lists paginated.
- [ ] Change is evidence-backed (plan/count/latency), not speculative.
- [ ] Correctness and privacy preserved.
- [ ] Improvement re-measured.

**Expected Output.** A performance assessment with specific findings and concrete,
evidence-backed recommendations (index / queue / query / payload).

**Failure Conditions.** Optimizing without evidence; trading correctness or privacy
for speed; leaving slow AI work inline; "fixing" perf with a guess and no measurement.
