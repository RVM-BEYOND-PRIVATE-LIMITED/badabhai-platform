---
name: bb-scalability-analysis
description: Assess whether a design holds as worker/employer volume grows — without over-engineering Phase 1. Checks statelessness, queueing, data growth, the AI service as a bottleneck, and the Supabase/single-region limits. Use for heavyweight or load-bearing changes.
---

# Skill: Scalability Analysis

**Goal.** Make sure a load-bearing change won't wall us in as volume grows, while
respecting the Phase-1 "lean and reversible" stance — design for the next 10×, not
the next 1000×.

**Inputs.** The design; expected growth (worker/employer/message volume — see
[open Q7](../../../docs/registers/open-questions.md)); the data model; ADR-0001's
reversibility intent.

**Process.**
1. Identify the scaling dimension that bites first (workers, messages, AI calls,
   events table growth).
2. Check statelessness of the API and that slow work is queue-able (BullMQ seam).
3. Assess data growth: will the `events`/`chat_messages` tables need partitioning
   or archival? Are indexes sufficient at 10×?
4. Evaluate the AI service as a single point of contention; confirm the async/
   fail-closed seam keeps the API up if AI degrades (R7).
5. Note Supabase/single-region limits and when they'd need revisiting.
6. Recommend the *reversible* seam now; defer the heavy build to when volume demands.

**Checklist.**
- [ ] First-to-bite scaling dimension named.
- [ ] API path stateless; slow work queue-able.
- [ ] Data growth + index strategy holds at ~10×.
- [ ] AI-service degradation can't take the API down.
- [ ] Reversible seam chosen; no premature 1000× build.
- [ ] Limits + revisit triggers logged (risks / future-improvements).

**Expected Output.** A scalability assessment: first bottleneck, the seam to add
now, and the deferred work with its trigger — recorded in the registers.

**Failure Conditions.** Over-engineering Phase 1; ignoring a known near-term
bottleneck; a design where AI failure cascades to the whole API; no reversibility.
