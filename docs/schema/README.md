# Schema Docs

The database schema is authored in Drizzle and is the source of truth:

- Schema: [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts)
- Generated SQL migrations: [`packages/db/migrations/`](../../packages/db/migrations/)
- Migration & RLS plans: [`infra/supabase/`](../../infra/supabase/)

## Tables (Phase 1)

`workers` · `worker_consents` · `worker_profiles` · `chat_sessions` ·
`chat_messages` · `voice_notes` · `generated_resumes` · `events` · `ai_jobs` ·
`audit_logs`

PII (phone, full name) lives **only** in `workers`. `events`, `ai_jobs`, and
`audit_logs` carry ids/hashes only.

> Add ER diagrams / column dictionaries here as the schema stabilizes.
