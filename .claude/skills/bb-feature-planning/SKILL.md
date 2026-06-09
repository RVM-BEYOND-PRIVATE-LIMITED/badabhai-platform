---
name: bb-feature-planning
description: Turn an idea into a scoped, phase-aware plan — problem, user, success metric, scope in/out, and the workflow stages it needs. Guards the Phase-1/Phase-2 boundary. Use during the Requirements stage.
---

# Skill: Feature Planning

**Goal.** Convert a raw idea into a crisp, scoped plan that fits the current phase
and routes cleanly through the development workflow.

**Inputs.** The idea/request; current scope ([Phase-1 plan](../../../docs/sprint-plans/phase-1-worker-profiling.md),
[bible](../../../docs/bible/README.md)); the registers; the user it serves.

**Process.**
1. Write the problem statement: who (worker / ops / future employer), what changes
   for them, why now.
2. Define success: the metric or observable outcome that means it worked.
3. Scope it: explicitly in vs. out; confirm it's in Phase 1, or flag that it needs
   a Phase-2 decision (logged in [team-decisions](../../../docs/registers/team-decisions.md)).
4. Map the workflow stages it needs (architecture? migration? new event? AI path?
   security review?).
5. Surface assumptions as [open questions](../../../docs/registers/open-questions.md);
   note risks.

**Checklist.**
- [ ] Problem names its user and success metric.
- [ ] Scope is explicit about what's *out*.
- [ ] Phase fit confirmed (or Phase-2 decision flagged).
- [ ] Workflow stages identified (DB/event/AI/security as applicable).
- [ ] Assumptions logged as open questions; risks noted.
- [ ] No conflict with the locked principles or launch gates.

**Expected Output.** A short, scoped plan: problem, user, success metric, scope
in/out, workflow stages, and logged assumptions/risks.

**Failure Conditions.** Vague problem with no metric; silent Phase-2 scope creep;
ignored privacy/DPDP gate; assumptions left unwritten.
