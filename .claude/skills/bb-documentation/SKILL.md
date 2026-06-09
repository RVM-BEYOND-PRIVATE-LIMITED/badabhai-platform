---
name: bb-documentation
description: Keep BadaBhai's docs and registers true after a change — README, architecture/schema/event docs, ADRs, and the registers. Prefer linking the source of truth over duplicating it. Use during the Documentation stage.
---

# Skill: Documentation

**Goal.** Leave the docs accurate enough that a new contributor can work from them
alone, and the registers reliable as project memory.

**Inputs.** The change + its impact; the existing docs; the
[registers](../../../docs/registers/); the PR template sections.

**Process.**
1. Find every doc the change touches (README, architecture overview, schema/event
   docs, setup, ADRs).
2. Update them to match the code; link the source of truth (Drizzle schema, event
   registry) rather than copying it.
3. Update the registers: decisions/team-decisions, architecture-log, tech-debt,
   open-questions — whatever the change implies.
4. Write an ADR for any heavyweight decision; keep the decisions-log index in sync.
5. Verify links resolve and `file:line` references are correct.

**Checklist.**
- [ ] Affected docs updated and consistent with code + ADRs.
- [ ] Source of truth linked, not duplicated.
- [ ] Registers updated for what the change implies.
- [ ] ADR written + indexed for heavyweight decisions.
- [ ] Links resolve; references accurate.

**Expected Output.** Accurate, navigable docs and current registers — no
contradiction with the code.

**Failure Conditions.** Stale docs left behind; duplicated facts that will drift;
an undocumented heavyweight decision; broken links; registers not updated.
