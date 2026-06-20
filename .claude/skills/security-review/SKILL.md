---
name: security-review
description: Security & authorization review — auth, RLS, secrets, IDOR / never-trust-body-IDs, input validation, and the PII/pseudonymization boundary. Use for any change touching auth, data access, or PII; pairs with bb-security-review.
---

# Skill: Security Review

**Goal.** Prove a change introduces no authorization, secret, or PII leak, and upholds BadaBhai's
two hard guarantees: no raw PII to an LLM, and fail-closed pseudonymization.

**Inputs.** The diff; the data flow; event payloads; the
[pseudonymization contract](../../../docs/ai/pseudonymization.md); the PR's security/privacy
sections; the current auth/RLS posture (project-memory, team-memory).

**Process.**

1. **PII trace:** every PII field (phone, name, address, employer, ID) stays only in `workers`;
   never in events / ai_jobs / audit_logs / logs / LLM input.
2. **Pseudonymization:** runs before any LLM call and fails closed; the original↔token mapping is
   never persisted or returned; `AI_ENABLE_REAL_CALLS` defaults false.
3. **Authorization / IDOR:** the actor is derived from the authenticated session, never from a
   body-supplied id; every object access has an ownership check; enumerable ids grant no access.
4. **Input validation:** Zod/Pydantic at every boundary; reject — don't coerce — hostile input.
5. **Secrets:** none committed or client-exposed; server/public env split honored; service-role /
   admin clients isolated from request-scoped paths.
6. **Abuse backstops:** rate limiting present; CORS not blanket-open in prod; session security sound.
7. **Audit:** sensitive actions land an `audit_logs` / event entry (no PII).
8. Assign severity; a Critical finding blocks merge and is never downgraded to tech-debt.

**Checklist.**

- [ ] No raw PII in events / ai_jobs / audit_logs / logs / LLM input.
- [ ] Pseudonymization fail-closed; mapping never leaves the request.
- [ ] Authorization derived from session; no trust in body IDs; no IDOR.
- [ ] Validation at every boundary; secrets not committed/exposed.
- [ ] Rate limit / CORS / session posture sound; sensitive actions audited.

**Expected Output.** Pass/block verdict with file:line findings, severity, and required fixes;
risk-register updates.

**Failure Conditions.** Any PII path to an LLM/logs; fail-open pseudonymization; IDOR/auth bypass;
a committed/exposed secret; downgrading a Critical finding.

**See also.** [`bb-security-review`](../bb-security-review/SKILL.md) · agents
[`security-reviewer`](../../agents/security-reviewer.md), [`security-engineer`](../../agents/security-engineer.md).
