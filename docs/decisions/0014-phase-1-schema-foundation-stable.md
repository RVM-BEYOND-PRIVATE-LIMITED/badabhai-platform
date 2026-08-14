# ADR-0014: Phase-1 schema foundation — declared STABLE, additive-only going forward

- **Status:** **ACCEPTED — CEO-signed 2026-06-17.** The Phase-1 schema foundation is
  **declared STABLE** under the additive-only + versioned + ADR change policy below; the
  long-open "item-10 / schema foundation" gate is **closed**. This locks the contract — the
  25 tables and their shipped event payloads will not change shape without an ADR + a
  versioned migration. (Additive Phase-2 growth continues; this is a guardrail, not a freeze.)
- **Date:** 2026-06-16 (drafted) · **Accepted:** 2026-06-17 (CEO sign-off)
- **Decision owners:** database-architect (technical facts) · product (framing) · **CEO
  (the sign-off gate — human, cannot be granted by engineering).**
- **Supersedes the informal "freeze item-10":** we are **NOT hard-freezing** the schema.
  Phase-2 work (monetization, reach) is actively and deliberately adding tables; a hard
  freeze would freeze the wrong thing. Instead this ADR declares the **Phase-1 foundation
  stable** and pins the **change policy** (additive + versioned + ADR) so we can keep
  shipping without breaking downstream contracts.

---

## Context

"Item-10" was tracked verbally as "the last open item before the database foundation is
frozen," but it was **never written down** — there was no enumerated checklist and no single
source of truth (search of `docs/schema`, `docs/registers`, `docs/sprint-plans`,
`docs/decisions` turned up nothing named/numbered "item-10"). This ADR creates that missing
artifact so the CEO sign-off becomes a concrete 2-minute yes/no instead of a blank cheque.

Two facts shape the framing:

1. **The foundation is real and working.** The Phase-1 profiling spine (workers → consent →
   chat → profile → resume + the events/ai_jobs/audit_logs audit spine) is built, tested,
   and stable. PII lives only in `workers` (encrypted, [ADR-0004]); the spine is RLS+REVOKE
   locked (TD20).
2. **The schema is still growing — on purpose.** It is now **25 tables** (migrations through
   `0016`), with the last several added this week under Phase-2 ADRs (0009 swipe, 0010
   contact-unlock, 0012 job-postings, 0013 monetization/pricing). A hard "no more changes"
   freeze contradicts the live roadmap. So the right commitment is **additive-only +
   versioned**, not "frozen."

## Decision

Declare the **Phase-1 schema foundation STABLE** as of CEO sign-off, and adopt this
**change policy** for everything after (the operational form of CLAUDE.md §2 invariant 8):

- **Allowed without re-sign-off:** purely **additive** changes — new tables, new nullable
  columns, new indexes — each with a generated migration + a rollback note (the
  `safe-db-migration` discipline).
- **Requires an ADR + a versioned migration:** any **breaking** change — dropping/retyping a
  column in use, renaming, or mutating a **shipped event payload** (those are versioned,
  never edited in place).
- **The contract downstream teams (API, AI, mobile) can rely on:** the 25 tables below and
  their shipped event payloads will not change shape under them without an ADR.

## The 25 tables this stabilizes

**Phase-1 core (14):** `workers` · `worker_consents` · `worker_profiles` · `chat_sessions` ·
`voice_notes` · `chat_messages` · `generated_resumes` · `events` · `ai_jobs` · `audit_logs` ·
`profiles` · `questions` · `profile_questions` · `worker_answers`.

**Phase-2 additive, already landed (11):** `job_postings` · `jobs` · `applications` ·
`unlocks` · `payer_credits` · `credit_ledger` · `unlock_routing` · `pricing_catalog` ·
`posting_plans` · `posting_boosts` · `resume_disclosures`.

(Source of truth: [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts), migrations
`0000`–`0017`. Migration `0017` is an additive column on `jobs` — `applicants_received` —
so the table count stays 25.)

## Readiness checklist (the "items" — what must be true to declare stable)

> These are the working default items. Maintainer/database-architect to confirm/finetune
> before sign-off. ✅ = done, ⏳ = open (does not block the *declaration*, tracked separately).

| # | Item | State | Note |
|---|------|-------|------|
| 1 | Schema authored in Drizzle as the single source of truth | ✅ | `schema.ts` |
| 2 | All migrations `0000`–`0017` generated with rollback notes | ✅ | `packages/db/migrations/` |
| 3 | PII isolated to `workers`, encrypted at rest | ✅ | ADR-0004 |
| 4 | Spine-wide RLS + REVOKE lock on all 25 tables, no-drift test | ✅ | TD20, `rls-spine.e2e.test.ts` |
| 5 | Events/ai_jobs/audit_logs are PII-free (ids/hashes only) | ✅ | invariant 2 |
| 6 | Event payloads versioned, never mutated | ✅ | invariant 8 |
| 7 | Schema doc reconciled to reality (25 tables) | ✅ | `docs/schema/README.md` (this PR) |
| 8 | Change policy (additive + versioned + ADR) written + agreed | ✅ | this ADR |
| 9 | Backward-compatibility / rollback discipline documented | ✅ | `safe-db-migration` skill |
| 10 | **CEO declares the Phase-1 foundation stable** | ✅ | **CEO-signed 2026-06-17** |
| — | Migrations applied to a shared/staging DB | ⏳ | needs ops sign-off (separate gate, not a blocker to *declaring* the contract) |
| — | Finalized RLS auth-identity model (Q5/Q11) | ⏳ | deferred-by-decision (service-role today); additive when it lands |
| — | Embeddings/model-training first use (Q8) | ⏳ | Phase-2 AI roadmap; additive |

**Item-10 is the CEO declaration itself — DONE (CEO-signed 2026-06-17).** Items 1–10 are
closed; the remaining ⏳ rows were explicitly *out of scope for the declaration* (additive/
operational, tracked in the registers) and the CEO accepted them as such.

## What signing commits us to / what it blocks if unsigned

- **Commits us to:** a stable, documented foundation downstream teams build against; no
  breaking schema/payload change without an ADR + versioned migration.
- **If left unsigned:** nothing is *technically* blocked today (work proceeds), but we
  cannot claim the "stable foundation" milestone, and there's no agreed line for "what
  counts as a breaking change" — so drift risk and re-litigation continue.

## Risk: sign now vs wait

- **Sign now (recommended):** low risk — we're declaring a *policy + a snapshot*, not
  freezing the roadmap. Additive Phase-2 work continues unaffected. Benefit: a firm contract
  + a closed governance item.
- **Wait:** only warranted if the CEO wants the migrations applied to a shared DB *first*
  (item row "—"), or wants different checklist contents. Cost: the governance item stays
  open and downstream teams keep building against an unratified contract.

## ASK (CEO — the 2-minute decision)

> **Do you approve declaring the Phase-1 schema foundation STABLE under the additive-only +
> versioned + ADR change policy above (25 tables, items 1–9 closed)?**
>
> ☐ **YES — declare stable** ☐ **NO / needs changes:** ______________________
>
> Signed: ____________________  Date: ____________

## Q&A — anticipated CEO questions (answers ready)

- **Q: Does "stable" mean we can't change the database anymore?**
  A: No. Additive changes (new tables/columns/indexes) continue freely. Only *breaking*
  changes need an ADR + a versioned migration. This is a guardrail, not a lock.
- **Q: Then why does the schema still have new tables landing this week?**
  A: That's Phase-2 (monetization/reach) — all **additive**, which the policy explicitly
  allows. "Stable" applies to the *contract* (existing shapes won't break under you), not to
  "no growth."
- **Q: What exactly am I signing — is anything irreversible?**
  A: A governance declaration + a change policy. No code or data changes. It's reversible by
  a later ADR if we ever need to revisit.
- **Q: Are there open risks I'm accepting?**
  A: Three, all explicitly *out of scope* and additive when resolved: migrations not yet
  applied to a shared DB (ops gate), the finalized RLS auth model (Q5/Q11; service-role
  today), and embeddings first-use (Q8). None changes the 25-table contract.
- **Q: What breaks if I don't sign?**
  A: Nothing technically — but the milestone stays open and there's no agreed definition of
  a "breaking change," so teams keep building against an unratified contract.
- **Q: Who is accountable for enforcing the policy?**
  A: The database-architect + the `/code-review` + `safe-db-migration` gates; any breaking
  change without an ADR fails review by definition.

## SIGN-OFF

- **CEO decision:** ✅ **YES — Phase-1 schema foundation declared STABLE.**  **Date:** 2026-06-17
- Done on YES: Status → **Accepted** (above); `docs/schema/README.md` Status → **Stable
  (ADR-0014)**; decisions-log timeline row updated to ACCEPTED. The additive-only + versioned
  + ADR change policy is now the binding contract for downstream teams.

## Related

- CLAUDE.md §2 invariant 8 (backward compatibility) · §4 (table map)
- [ADR-0004] PII-at-rest encryption · TD20 spine RLS/REVOKE
- [ADR-0013](0013-monetization-and-config-driven-pricing-engine.md) (Phase-2 additive tables) ·
  [ADR-0009](0009-alpha-swipe-to-apply-seeded-jobs.md) · [ADR-0010](0010-contact-unlock-and-reveal.md) ·
  [ADR-0012](0012-ops-job-postings-banded-stored-only.md)
- Open questions Q5/Q8/Q11 (deferred, additive when resolved)
