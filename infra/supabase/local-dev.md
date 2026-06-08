# Local Development — Database Options

You have three options for a local/dev database. Pick one and set `DATABASE_URL`.

## Option A — docker-compose Postgres (no Supabase, simplest)

```bash
docker compose up -d            # starts postgres on :5432 (+ redis, adminer)
# DATABASE_URL=postgresql://badabhai:badabhai@localhost:5432/badabhai
pnpm db:migrate                 # apply Drizzle migrations
```

Best when you just need a Postgres to develop against. Adminer UI: http://localhost:8080

## Option B — Supabase local stack (needs Docker)

```bash
supabase init                   # if infra/supabase/config.toml doesn't exist yet
supabase start                  # spins up local Supabase (Postgres, Auth, Storage, Studio)
supabase status                 # shows local URLs + keys
```

> Requires Docker Desktop running. On this machine Docker is **not installed**, so
> `supabase start`/`status` will fail until you install it.

## Option C — Remote Supabase project

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
# Set DATABASE_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env from the dashboard
pnpm db:migrate                 # or: supabase db push
```

## After choosing

```bash
pnpm db:generate     # regenerate migrations after editing schema.ts
pnpm db:migrate      # apply
pnpm db:studio       # browse data (Drizzle Studio)
```

## Environment variables

See `.env.example` at the repo root. Minimum for DB work:

```env
DATABASE_URL=postgresql://badabhai:badabhai@localhost:5432/badabhai
```

For Supabase also set (backend only):

```env
SUPABASE_URL=https://<PROJECT_REF>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```
