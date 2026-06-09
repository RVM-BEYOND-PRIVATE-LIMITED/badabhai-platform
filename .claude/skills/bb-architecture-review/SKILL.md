---
name: bb-architecture-review
description: Review a proposed change against BadaBhai's architectural seams before it's built — event-first, AI privacy boundary, repository/service separation, typed contracts, and phase scope. Use during the Architecture stage for any non-trivial change.
---

# Skill: Architecture Review

**Goal.** Confirm a change fits BadaBhai's architecture and decide where it lives,
before implementation — catching seam violations while they're cheap.

**Inputs.** The feature/requirement; the [architecture overview](../../../docs/architecture/overview.md);
[ADR-0001](../../../docs/decisions/0001-mvp-infra-decision.md); the event registry,
DB schema, and package layout.

**Process.**
1. Restate the change and the user it serves; confirm it's in the current phase.
2. Identify which components it touches (API / AI service / web / worker app / DB).
3. Decide placement: which module/package owns it; event vs. direct call.
4. List the contracts it touches (events, DTOs, schema) and the version impact.
5. Check the seams hold: event-first, privacy boundary, repo/service split, typed
   contracts.
6. Decide if it's ADR-worthy; if so, draft the ADR. Record in the architecture log.

**Checklist.**
- [ ] In current phase scope (or has a logged decision to expand).
- [ ] Respects event-first — important actions emit a validated event.
- [ ] Respects the AI privacy boundary (no PII path toward an LLM).
- [ ] Repository/service separation and DI preserved.
- [ ] Contract/version impact identified; rollback considered.
- [ ] ADR written if heavyweight; architecture log updated.

**Expected Output.** A short decision: placement, contracts touched, seam check
result, ADR (if needed), and any new risks/open questions logged.

**Failure Conditions.** Violates a locked principle or ADR; silently expands the
phase; introduces a PII path to an LLM; changes a contract with no version plan;
proceeds with the seam decision unresolved.
