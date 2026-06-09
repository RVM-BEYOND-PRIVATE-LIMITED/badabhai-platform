# E2E Tests

End-to-end Phase 1 flow across the NestJS API + Postgres + Redis:

> login (mock OTP) → consent → chat → profile extract (async) → confirm → resume
> generate — asserting the expected events were emitted and that **no raw PII
> (phone) ever lands in the `events` table**.

`/profile/extract` is **async**: it enqueues a BullMQ job (returns `202` +
`ai_job_id`) and the test polls `GET /ai-jobs/:id` until the job completes, then
reads `output_ref.profile_id`. So **Redis is required** for this flow.

The AI service is **not** required: the API falls back to safe mocks when it is
unreachable, so the flow (and its events) still complete.

## Run it

The suite is **opt-in** (gated on `RUN_E2E=1`) so the normal `pnpm test` /
CI run skips it when no infra is up.

```bash
# 1. Postgres + Redis (local docker) — or set DATABASE_URL to Supabase instead.
#    (Redis is needed because profile extraction runs on a BullMQ queue.)
pnpm db:up           # starts postgres + redis
pnpm db:migrate

# 2. Start the API (separate terminal)
pnpm --filter @badabhai/api dev

# 3. Run the e2e flow
#   bash/zsh:
RUN_E2E=1 pnpm --filter @badabhai/e2e test
#   PowerShell:
$env:RUN_E2E=1; pnpm --filter @badabhai/e2e test
```

> **Windows note:** if the host already runs PostgreSQL on `5432`, the compose
> Postgres is shadowed. Use the `docker-compose.e2e.yml` override (publishes the
> container on `5433`) and point the DB env vars at `5433` — see that file.

## Configuration

| Env var            | Default                                                  | Purpose                          |
| ------------------ | -------------------------------------------------------- | -------------------------------- |
| `RUN_E2E`          | _(unset → skipped)_                                      | Set to `1` to actually run.      |
| `E2E_API_URL`      | `http://localhost:3001`                                  | Base URL of the running API.     |
| `E2E_DATABASE_URL` | `DATABASE_URL` or `postgresql://badabhai:badabhai@localhost:5432/badabhai` | DB to read `events` from. |
