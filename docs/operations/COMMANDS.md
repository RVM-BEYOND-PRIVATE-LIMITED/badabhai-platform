# Operations — running locally, and deployment paths

Two sections, deliberately separate:

- **[Running locally](#running-locally)** — the commands to bring a surface up on this
  machine. Verified by running them, not by reading scripts.
- **[Deployment paths](#deployment-paths)** — where each surface actually ships to.

---

## Running locally

### Port map

Every port below is the app's own default, taken from its `package.json` `dev` script or
its config schema — none of them is a convention someone has to remember.

| surface                           | port | source of the port                                                                                                 |
| --------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/web` (internal ops console) | 3000 | `apps/web/package.json` → `next dev -p 3000`                                                                       |
| `apps/api`                        | 3001 | `API_PORT: portSchema.default(3001)` — [`packages/config/src/server.ts`](../../packages/config/src/server.ts) |
| `apps/payer-web`                  | 3002 | `apps/payer-web/package.json` → `next dev -p 3002`                                                                 |
| `apps/admin-web`                  | 3003 | `apps/admin-web/package.json` → `next dev -p 3003`                                                                 |
| `apps/ai-service`                 | 8000 | root `dev:all` → `uvicorn app.main:app --reload --port 8000`                                                       |
| Postgres                          | 5432 | `docker-compose.yml` service `postgres`                                                                            |
| Redis                             | 6379 | `docker-compose.yml` service `redis`                                                                               |

**The defaults already line up — there is nothing to configure for the common case.**
`apps/admin-web` reads `ADMIN_API_BASE_URL`, defaulting to `http://localhost:3001`
([`apps/admin-web/src/lib/server-config.ts`](../../apps/admin-web/src/lib/server-config.ts)),
which is exactly where `apps/api` listens. Set the variable only to point at something else.

### Backing services

`apps/api` requires **both** Postgres and Redis; it fails its health checks without them.
Two ways to get them, and they are mutually exclusive on the same ports:

```bash
# Docker (the committed path)
pnpm db:up            # docker compose up -d postgres redis
pnpm mail:up          # optional: mailpit, for OTP emails
pnpm db:down

# Native (Windows, no Docker — scoop-installed postgres + redis)
redis-server --port 6379 --save "" --appendonly no    # foreground; use a separate terminal
redis-cli ping                                        # expect: PONG
```

If Postgres is already running natively on 5432, do **not** also run `pnpm db:up` — the
Docker container will fail to bind. Check first:

```bash
netstat -ano | grep LISTENING | grep -E ":5432|:6379"
```

### The admin portal (`apps/admin-web`)

The portal is a presentation layer over the admin API — it is not usable without
`apps/api` running. Start them in this order:

```bash
# 1. backing services (see above), then:
pnpm --filter @badabhai/api dev          # → http://localhost:3001
pnpm --filter @badabhai/admin-web dev    # → http://localhost:3003
```

Open **<http://localhost:3003/login>**. (`/` returns a 307 to `/login` when unauthenticated.)

Confirm the API before blaming the UI:

```bash
curl -s http://localhost:3001/health
```

A healthy local response looks like this — `ai_service: down` / `ai_posture: mock` is
**expected** when you have not started `apps/ai-service`, and the admin login path does
not need it.

**This is an excerpt, not the whole body.** Only the members that tell you whether the
API is usable are shown. The real response also carries `environment`, `build` and
`timestamp` at the top level, and a `storage_config` object inside `checks`
(see [`apps/api/src/health/health.controller.ts`](../../apps/api/src/health/health.controller.ts)
and [`health.service.ts`](../../apps/api/src/health/health.service.ts) for the full shape).
Extra fields in your output are not a fault:

```json
{
  "status": "ok",
  "service": "api",
  "checks": {
    "database": "up",
    "redis": "up",
    "deletion_sweep": "up",
    "ai_service": "down",
    "ai_posture": "mock"
  }
}
```

#### Admin login gotchas

Admin auth is email → OTP → **TOTP MFA**
([`apps/api/src/admin/admin-auth.controller.ts`](../../apps/api/src/admin/admin-auth.controller.ts)).

- **Never set `ADMIN_MFA_REQUIRED=false` to skip MFA.** It defaults to `true`
  ([`packages/config/src/server.ts`](../../packages/config/src/server.ts)) and
  turning it off makes the API mint a session directly at
  [`admin-auth.service.ts`](../../apps/api/src/admin/admin-auth.service.ts) — but
  `apps/admin-web` has **no reference to that variable anywhere in `src`**, so its login
  UI still walks the MFA step and breaks. It does not become a bypass; it becomes a
  broken screen.
- **Lost/desynced TOTP — use the route, not the CLI.** The ordinary fix is
  `POST /admin/admins/:id/mfa/reset`, called by _another_ super*admin (it refuses a
  self-reset by design). The CLI below is **break-glass only**, for the case where the
  \_last* super_admin loses their device and nothing inside the application can help:

  ```bash
  # dry run first — it does nothing without --apply
  pnpm --filter @badabhai/db db:admin:reset-mfa -- --email ops@example.com
  pnpm --filter @badabhai/db db:admin:reset-mfa -- --email ops@example.com --apply
  ```

  That is the invocation the script's own header documents
  ([`packages/db/src/reset-admin-mfa.ts`](../../packages/db/src/reset-admin-mfa.ts)).
  If the `--filter` form fails to resolve on your machine, run the file directly with
  `pnpm exec tsx packages/db/src/reset-admin-mfa.ts -- --email …` instead. A reset is a
  security-relevant act on a live account and writes **no** event — the script prints who
  was reset and the operator is expected to log it by hand.

- First/only root account is minted by `db:bootstrap:admin`
  ([`packages/db/src/bootstrap-admin.ts`](../../packages/db/src/bootstrap-admin.ts)).
  It refuses once any super_admin exists; further admins come from `POST /admin/admins`
  (`@Post("admins")` in [`apps/api/src/admin/admin-actions.controller.ts`](../../apps/api/src/admin/admin-actions.controller.ts)).
  **Note the script itself tells you the wrong route.** `bootstrap-admin.ts` prints
  "must come from POST /admin/invite" to the operator on success, and repeats it in its
  refusal message. That route does not exist and 404s. Parked as P-004 — believe this
  file, not the script's stdout.

### Other surfaces

```bash
pnpm --filter @badabhai/payer-web dev     # → http://localhost:3002
pnpm --filter @badabhai/web dev           # → http://localhost:3000
cd apps/ai-service && uvicorn app.main:app --reload --port 8000

pnpm dev                                  # turbo run dev — every JS/TS app at once
pnpm dev:all                              # the above + ai-service
```

### Stale-build note

`apps/api`'s `dev` script is `nest start --watch`, which resolves workspace packages from
their **built `dist/`**, not their source. After pulling changes that touch
`packages/event-schema`, `packages/validators`, `packages/config` or `packages/db`, a
stale `dist/` produces validation failures that look like application bugs. Rebuild first:

```bash
pnpm build            # turbo run build
```

---

## Deployment paths

> **Corrected 2026-09-01.** This section previously read _"Not deployed yet"_ for all three
> Next.js apps, on the basis that none had "a Dockerfile, a `docker-compose.staging.yml`
> service entry, or a CI deploy job" (owner-confirmed 2026-08-13/14, BL-1). **Two of the
> three now have all three.** The note below is re-derived from the repository, not carried
> forward.

| app                  | Dockerfile                     | staging compose service             | CI image row                                      | status           |
| -------------------- | ------------------------------ | ----------------------------------- | ------------------------------------------------- | ---------------- |
| `apps/payer-web`     | ✅ `apps/payer-web/Dockerfile` | ✅ `docker-compose.staging.yml` | ✅ [`ci.yml`](../../.github/workflows/ci.yml) | **deployed**     |
| `apps/admin-web`     | ✅ `apps/admin-web/Dockerfile` | ✅ `docker-compose.staging.yml` | ✅ [`ci.yml`](../../.github/workflows/ci.yml) | **deployed**     |
| `apps/web`           | ❌                             | ❌                                  | ❌                                                | **not deployed** |
| `apps/marketing-web` | ❌                             | ❌                                  | ❌                                                | **not deployed** |

**`apps/admin-web` specifics** (GAP-XC-06 / #920):

- Image tag is the immutable per-commit `ghcr … badabhai-admin-web:sha-<short7>`, exported
  by [`scripts/deploy/staging-deploy.sh`](../../scripts/deploy/staging-deploy.sh).
- **Loopback-bound on the box** — `127.0.0.1:${ADMIN_WEB_PORT:-3003}:3003`
  (`docker-compose.staging.yml`). This is the one place the block deliberately does
  _not_ copy `payer-web`, which binds every interface: the admin portal must **not** be
  reachable from outside the box.
- In-container it talks to the API by compose service name:
  `ADMIN_API_BASE_URL: http://api:3001` (`docker-compose.staging.yml`) — not
  `localhost`, which inside that container would be the container itself.
- Started **last**, after `payer-web`
  ([`staging-deploy.sh`](../../scripts/deploy/staging-deploy.sh)), so a broken
  admin portal cannot precede or block the two surfaces real users hit. Its failure still
  turns the job red.
- Built with `"next-public": false` ([`ci.yml`](../../.github/workflows/ci.yml)) — the
  security-relevant field. The admin bundle gets no `NEXT_PUBLIC_*` build args; its API
  origin is server-side only.

**`apps/web` and `apps/marketing-web`** still have no hosting target. They build via the
generic Turborepo CI step (`pnpm -w build`), so we know they compile — nothing more. When
either is ready, update this table with the actual path rather than leaving a "not yet"
note; see `docs/rollback-guide.md`'s "What this guide does not cover" section, which points
here.

For rollback and the full deploy runbook, see [`docs/rollback-guide.md`](../rollback-guide.md)
and [`docs/ops/staging-service-deploy-runbook.md`](../ops/staging-service-deploy-runbook.md).
