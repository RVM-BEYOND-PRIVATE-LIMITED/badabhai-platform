# E2E Tests

End-to-end Phase 1 flow across the NestJS API + Postgres:

> login (mock OTP) → consent → chat → profile extract → confirm → resume
> generate — asserting the expected events were emitted and that **no raw PII
> (phone) ever lands in the `events` table**.

The AI service is **not** required: the API falls back to safe mocks when it is
unreachable, so the flow (and its events) still complete.

## Run it

The suite is **opt-in** (gated on `RUN_E2E=1`) so the normal `pnpm test` /
CI run skips it when no infra is up.

```bash
# 1. Postgres (local docker) — or set DATABASE_URL to Supabase instead
pnpm db:up
pnpm db:migrate

# 2. Start the API (separate terminal)
pnpm --filter @badabhai/api dev

# 3. Run the e2e flow
#   bash/zsh:
RUN_E2E=1 pnpm --filter @badabhai/e2e test
#   PowerShell:
$env:RUN_E2E=1; pnpm --filter @badabhai/e2e test
```

## Configuration

| Env var            | Default                                                  | Purpose                          |
| ------------------ | -------------------------------------------------------- | -------------------------------- |
| `RUN_E2E`          | _(unset → skipped)_                                      | Set to `1` to actually run.      |
| `E2E_API_URL`      | `http://localhost:3001`                                  | Base URL of the running API.     |
| `E2E_DATABASE_URL` | `DATABASE_URL` or `postgresql://badabhai:badabhai@localhost:5432/badabhai` | DB to read `events` from. |
