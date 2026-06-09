---
name: bb-security-review
description: BadaBhai's privacy/security gate — verify no raw PII reaches an LLM, pseudonymization stays fail-closed, no secrets leak, and auth/RLS/DPDP posture holds. MANDATORY for heavyweight changes and anything near pseudonymization. (Distinct from the built-in /security-review.)
---

# Skill: Security Review

**Goal.** Prove a change does not break BadaBhai's two hard guarantees — no raw PII
to an LLM, and fail-closed pseudonymization — and introduces no auth/secret leak.

**Inputs.** The diff; the data flow; event payloads; the
[pseudonymization contract](../../../docs/ai/pseudonymization.md); the PR's
security/privacy + AI sections.

**Process.**
1. Trace every piece of PII (phone, name, address, employer, ID). Confirm it stays
   only in `workers` and never enters events, `ai_jobs`, `audit_logs`, logs, or
   LLM input.
2. Verify the pseudonymization gateway runs before any LLM call and **fails
   closed**; the original↔token mapping is never persisted or returned.
3. Confirm `AI_ENABLE_REAL_CALLS` defaults false; real keys aren't enabled in a
   shared env without sign-off.
4. Check secrets: none committed, none in the client bundle; server/public env
   split honored.
5. Review auth + service-role usage (RLS not finalized — confirm the gap is still
   contained, R1/TD4).
6. Assign severity; a Critical finding blocks merge.

**Checklist.**
- [ ] No raw PII in events / ai_jobs / audit_logs / logs / LLM input.
- [ ] Pseudonymization fail-closed; mapping never leaves the request.
- [ ] `AI_ENABLE_REAL_CALLS` safe-default; no real keys in shared env.
- [ ] No secrets committed or client-exposed.
- [ ] Auth / service-role usage sound; RLS gap still contained.
- [ ] Privacy-critical paths have explicit no-PII tests.

**Expected Output.** A pass/block verdict with file:line findings, severity, and
required fixes; risk-register updates.

**Failure Conditions.** Any PII path to an LLM/logs; fail-open pseudonymization; a
committed/exposed secret; downgrading a Critical finding to tech-debt; approving on
the PR description without verifying the diff.
