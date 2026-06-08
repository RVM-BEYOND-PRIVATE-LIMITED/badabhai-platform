# Supabase (Phase 1)

BadaBhai uses **Supabase Postgres** as the MVP database. This folder holds the
plans and workflow docs — it does **not** auto-link or push anything.

## Status of this environment

- Supabase CLI: installed ✅
- Project linked: **NO** (intentionally — link only when you decide to)
- Local stack (`supabase start`): requires **Docker**, which is not installed
  here. Use the docker-compose Postgres (`docker compose up -d`) or a remote
  Supabase project instead.

## Two ways to manage schema

We define the schema once in Drizzle (`packages/db/src/schema.ts`). You then
apply it through **one** source of truth per environment:

1. **Drizzle migrations (recommended for app dev)**
   ```bash
   pnpm db:generate      # schema.ts -> packages/db/migrations/*.sql
   pnpm db:migrate       # apply to $DATABASE_URL (local or Supabase)
   ```
2. **Supabase CLI migrations** — copy generated SQL into a Supabase migration if
   you want Supabase to own migration history (see `migration-plan.md`).

Do not mix both as the authority for the same environment.

## Linking a project (only when ready)

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push                 # apply local supabase/migrations to the project
supabase migration new <name>
supabase db diff                 # inspect drift
supabase gen types typescript --project-id <PROJECT_REF> > packages/db/src/supabase.types.ts
```

> Get `DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` from the
> Supabase dashboard (Project Settings → Database / API). Put them in `.env`
> (never commit). The service-role key is backend-only.

## Files

- [migration-plan.md](migration-plan.md) — how migrations flow Drizzle ↔ Supabase
- [rls-plan.md](rls-plan.md) — Row Level Security plan (TODO, not finalized)
- [local-dev.md](local-dev.md) — local development options
