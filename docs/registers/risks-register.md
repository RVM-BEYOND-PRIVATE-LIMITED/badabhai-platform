# Risks Register

Severity: **Critical** (privacy leak / auth bypass / data loss / fail-open AI) ·
**High** · **Medium** · **Low**. Status: **Open** · **Mitigated** · **Accepted** ·
**Closed**.

Seeded 2026-06-09 from ADR-0001, the architecture overview, and the Phase-1 plan.

| ID | Risk | Sev | Status | Mitigation | Owner |
| -- | ---- | --- | ------ | ---------- | ----- |
| R1 | **Supabase RLS not finalized**; API uses the service role, so any accidental client-side or mis-scoped path could read across workers | High | Open | Service role stays server-only; never shipped to web/worker apps. RLS plan in [rls-plan.md](../../infra/supabase/rls-plan.md). Finalize before any direct client→DB access. | Security + DB |
| R2 | **Pseudonymization is heuristic** (regex + gazetteers); a missed entity could leak PII to an LLM | Critical (if real calls on) | Mitigated | Over-masking bias; **fails closed** on residual digit runs/oversize/parse error; `AI_ENABLE_REAL_CALLS=false` by default; real NER planned. See [pseudonymization.md](../../docs/ai/pseudonymization.md). | AI + Security |
| R3 | **Mock providers** (OTP, STT, LLM, payment) must be replaced before any real launch; easy to forget one | High | Open | Tracked in [tech-debt](./tech-debt-register.md); launch checklist gates each. | DevOps + Backend |
| R4 | **DPDP consent flows are structural placeholders**; production legal copy/flow not done | High | Open | Consent captured structurally now; `docs/legal-later` holds the gap. Launch gate. | Product + Security |
| R5 | **No disaster-recovery runbook / tested restore** for Supabase Postgres yet | Medium | Open | Rely on Supabase managed backups in Phase 1; write + test a [DR runbook](./tech-debt-register.md) before launch. | DevOps |
| R6 | **API-first LLM cost/latency at scale unknown**; per-worker AI cost could surprise | Medium | Open | Mock by default; LiteLLM adapter makes provider/model swappable; measure in staging before enabling. | AI + Performance |
| R7 | **Single point of failure on the AI service** for the profiling flow | Medium | Open | Keep AI path async/queued (BullMQ planned) so API stays up if AI degrades; fail-closed returns safe fallback. | Architect + DevOps |
| R8 | **Secrets sprawl** as real providers are added (.env across apps) | Medium | Open | Typed config split (server/public) already enforced; add a secrets manager before multi-env. | DevOps + Security |
| R9 | **Chat history reached LLM input + Langfuse raw** — `/profiling/respond` pseudonymized only the current message, not prior turns | High (Critical if real calls/Langfuse on) | Closed (2026-06-10) | Found in the Phase-1 AI privacy review; fixed via `_pseudonymized_history()` (history gated + dropped fail-closed) with regression test. See [phase-1-ai-privacy-review.md](../../docs/ai/phase-1-ai-privacy-review.md). | AI + Security |
| R10 | **New `worker-conversations` Storage bucket holds raw conversation JSON** (transcript can contain phone/name/employer); a mis-scoped ACL or un-erased object on consent revoke is a PII exposure | High | Open | Bucket private + backend service-role only (Storage Mode A, no public/anon access — same tier as `voice_notes`); object keys are opaque UUIDs only, enforced fail-closed by `conversationObjectKey` ([@badabhai/validators](../../packages/validators/src/index.ts)); events/ai_jobs/audit_logs reference the path, never the body; per-worker prefix makes DPDP erasure a single sweep. **Open until** the consent-revoke prefix-delete is wired (chat-persistence work). See [ADR-0003](../decisions/0003-worker-conversation-storage-boundary.md). | Security + Backend |

> Add a row the moment a risk is identified. Move to **Mitigated/Closed** with a
> dated note rather than deleting — the history is the value.
