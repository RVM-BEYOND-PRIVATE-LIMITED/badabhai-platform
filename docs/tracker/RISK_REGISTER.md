# Risk Register (alpha control-room view)

**Source of truth is [docs/registers/risks-register.md](../registers/risks-register.md)** (R1–R25) and
[tech-debt-register.md](../registers/tech-debt-register.md) (TD1–TD55). This file is the **alpha-facing
slice** — the risks that gate alpha/staging right now. Do not duplicate; link back.

Severity: Critical / High / Medium / Low · Status: Open / Mitigated / Accepted / Closed.

| ID | Risk | Sev | Prob | Owner | Mitigation | Status |
| -- | ---- | --- | ---- | ----- | ---------- | ------ |
| RT-1 | ~~posting-plans money routes unguarded (IDOR)~~ | High | ~~High~~ | Divyanshu | InternalServiceGuard (#174) → PayerAuthGuard + session payer_id (#179); LC-1 CLOSED for money routes | **CLOSED 2026-07-01** |
| RT-2 | Unlock/reveal rides `InternalServiceGuard` + body `payer_id` (LC-1, TD33/TD50) | High | Med | Divyanshu + security | plan/boost closed (#179); unlock/reveal InternalServiceGuard still open — PayerAuthGuard before prod (D3a) | Open (P1 — partially mitigated) |
| RT-3 | **Staging not deployed → alpha PAST DEADLINE** | High | **Critical** | Prakash | D1 DECIDED 2026-06-29 (Lightsail/EC2); implementation still pending 2026-07-09 | **ESCALATED — past deadline 2026-07-04** |
| RT-4 | ADMIN-3b PII-reveal — most sensitive op (decrypt phone) | High | Med | Prakash + security | D4 DECIDED: Prakash owns weekly `admin.pii_viewed` review; 1-yr retention confirmed; enable once cadence live | Partially mitigated (D4✅ — cadence not yet established) |
| R1/TD4 | RLS not finalized; service-role BYPASSRLS | High | Med | database-architect | D6 DECIDED 2026-06-29: deferred for alpha; finalize before prod (Phase 6) | Accepted for alpha (D6✅) |
| R2 | Pseudonymization is heuristic (could miss a PII pattern) | High | Low | ai-engineer | Fail-closed gateway; oversize/parse/digit-run blocks LLM | Mitigated |
| TD30 | CORS open to all origins | Med | Med | backend | Internal-only today; allow-list before cross-origin client | Open |
| TD25 | `trust proxy` unset → `req.ip` = egress IP | Med | Med | backend | Rate-limit is coarse backstop; fix before prod | Open |
| R12/TD49 | `voice_notes.transcript_text` plaintext at rest | Med | Low | database-architect | Voice is PARKED; encrypt before real voice | Open (parked feature) |
| RT-5 | Real OTP = real spend; mis-config could burn cost/leak | Med | Low | DevOps + Prakash | D2 DECIDED 2026-06-29: approved with caps + team allowlist; activate per OTP-7 runbook after D1 | Mitigated (D2✅) |
| RT-6 | No DR plan / no cost strategy doc | Med | Med | DevOps + Founder | Author before prod (Phase 6) | Open |
| RT-7 | Dark-theme parity + formal a11y unverified | Low | Med | design-engineer | DS lint enforces tokens; needs visual QA | Open |
| RT-8 | Schema doc drift (30 vs 32 tables) | Low | Low | database-architect | Reconcile CLAUDE.md / ADR-0014 | Open (cosmetic) |

## Privacy invariants — current standing (from audit, code-level)
- ✅ No raw PII in events/ai_jobs/logs (verified in code: hashes/opaque ids; PII encrypted at rest).
- ✅ Pseudonymization runs before every LLM call, fails closed.
- ✅ Real LLM/payments/WhatsApp gated OFF by default; fail-closed boot gates.
- ✅ DPDP consent gate present (production legal copy deferred = LEGAL_GATE).
- ⚠️ Authz on money routes incomplete (RT-1/RT-2) — the main open privacy/security item for alpha.

---
_When a risk closes, update BOTH this slice and the canonical [registers/risks-register.md](../registers/risks-register.md) with the closing evidence + date._
