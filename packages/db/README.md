# @badabhai/db

Drizzle schema, migrations, and client for BadaBhai's **Supabase Postgres**.

## Tables (Phase 1)

`workers` · `worker_consents` · `worker_profiles` · `chat_sessions` ·
`chat_messages` · `voice_notes` · `generated_resumes` · `events` · `ai_jobs` ·
`audit_logs`

Row types are exported for every table (`Worker`/`NewWorker`, etc.).

## Privacy model

PII (phone, full name) lives **only in `workers`**. It is never copied into
`events`, `audit_logs`, or `ai_jobs`, and never sent to an LLM. RLS will lock
sensitive tables to the backend service role — see
[../../infra/supabase/rls-plan.md](../../infra/supabase/rls-plan.md). RLS is
**planned, not finalized** in Phase 1.

## Client usage

```ts
import { createDbClient, workers } from "@badabhai/db";

const { db } = createDbClient(process.env.DATABASE_URL!);
const rows = await db.select().from(workers).limit(10);
```

Prefer dependency injection (create one client at startup). `getDb()` is a lazy
singleton for CLI scripts/seeds only.

## Migration workflow (Drizzle)

```bash
pnpm db:generate      # diff schema.ts -> ./migrations/*.sql  (no DB connection)
pnpm db:migrate       # apply migrations to $DATABASE_URL
pnpm db:studio        # open Drizzle Studio
pnpm --filter @badabhai/db db:seed   # run the seed placeholder
```

> Drizzle and Supabase CLI are complementary. You can apply schema with Drizzle
> (`db:migrate`) **or** copy generated SQL into a Supabase migration. Pick one
> source of truth per environment — see
> [../../infra/supabase/migration-plan.md](../../infra/supabase/migration-plan.md).

Set `DATABASE_URL` (local docker Postgres or your Supabase connection string)
before running migrate/studio.
