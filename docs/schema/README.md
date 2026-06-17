# Schema Docs

**Status:** Phase-1 foundation **STABLE (ADR-0014, CEO-signed 2026-06-17)**
([ADR-0014](../decisions/0014-phase-1-schema-foundation-stable.md)). Change policy:
**additive + versioned + ADR for any breaking change** (CLAUDE.md §2 invariant 8).
This is **not** a hard freeze — Phase-2 additive tables continue.

The database schema is authored in Drizzle and is the source of truth:

- Schema: [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts)
- Generated SQL migrations: [`packages/db/migrations/`](../../packages/db/migrations/) (through `0017`)
- Migration & RLS plans: [`infra/supabase/`](../../infra/supabase/)

## Tables (25)

**Phase-1 core (14):** `workers` · `worker_consents` · `worker_profiles` ·
`chat_sessions` · `voice_notes` · `chat_messages` · `generated_resumes` · `events` ·
`ai_jobs` · `audit_logs` · `profiles` · `questions` · `profile_questions` ·
`worker_answers`

**Phase-2 additive, landed (11):** `job_postings` · `jobs` · `applications` ·
`unlocks` · `payer_credits` · `credit_ledger` · `unlock_routing` ·
`pricing_catalog` · `posting_plans` · `posting_boosts` · `resume_disclosures`

PII (phone, full name) lives **only** in `workers` (encrypted at rest, ADR-0004).
`events`, `ai_jobs`, and `audit_logs` carry ids/hashes only. All 25 tables are
RLS+REVOKE locked (TD20).

> Add ER diagrams / column dictionaries here as the schema stabilizes.
