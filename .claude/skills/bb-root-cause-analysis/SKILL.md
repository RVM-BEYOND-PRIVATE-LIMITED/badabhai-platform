---
name: bb-root-cause-analysis
description: Go past the immediate fix to the systemic cause of an incident or recurring bug — 5-whys, contributing factors, and a prevention action. Use after a Critical/High issue or a repeating class of defect.
---

# Skill: Root Cause Analysis

**Goal.** Understand *why* a serious or recurring problem happened deeply enough to
prevent the class of it, not just patch the instance.

**Inputs.** The incident/bug and its fix; the timeline (events, logs, deploys); the
affected component and contracts.

**Process.**
1. Build the timeline from the `events` table, structured logs, and deploy history.
2. Run 5-whys from the symptom to the systemic cause; separate the trigger from the
   underlying weakness.
3. Identify contributing factors: missing test, missing event, weak boundary, an
   unlogged shortcut (check the [tech-debt register](../../../docs/registers/tech-debt-register.md)).
4. Decide the prevention: a test, a gate, a guardrail, a contract change, or an ADR.
5. Record it — risk register and/or an ADR; update tech-debt if a shortcut caused it.

**Checklist.**
- [ ] Timeline reconstructed from real signals (events/logs/deploys).
- [ ] Systemic cause reached, not just the proximate trigger.
- [ ] Contributing factors named.
- [ ] A concrete prevention action defined and owned.
- [ ] Registers/ADR updated.
- [ ] If privacy-related: confirmed blast radius and that no PII leaked.

**Expected Output.** A short RCA: timeline, root cause, contributing factors, and a
specific prevention action with an owner, recorded in the registers.

**Failure Conditions.** Stopping at the proximate cause; a "fix" with no prevention;
blaming a person instead of the system; not recording the learning.
