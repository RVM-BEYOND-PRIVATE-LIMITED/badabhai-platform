# Local Setup — Running the Payer + Agency Portal

**Status:** Inventory COMPLETE and verified against `docker-compose*.yml`, root `package.json`,
and `packages/config/src/server.ts`. **Not executed end-to-end** — the recipe below is
read-derived, not run-verified. The login blocker in §4 is the known hazard.

---

> # 🛑 STOP — the repo's `.env` currently points at PRODUCTION
>
> Verified 2026-08-11: root `.env` `DATABASE_URL` resolves to
> `aws-1-ap-south-1.pooler.supabase.com / postgres` — **the production database**.
>
> Every command in this repo that loads `.env` therefore targets production, including:
>
> - `pnpm db:migrate` · `pnpm db:seed:*` · `pnpm db:studio` · every `db:*` script
> - `pnpm --filter @badabhai/api dev` — a local API server writing to prod
> - any `npx tsx` script under `packages/db` (they all `config({ path: "../../.env" })`)
>
> **Before running anything below, point `DATABASE_URL` at the local Docker Postgres.** The
> compose stack (`pnpm db:up`) is disposable and unrelated to production. Treat a local run
> against prod as an incident, not an inconvenience — `db:migrate` in particular would attempt
> DDL, and `db:seed:*` would write rows.
>
> This also means the "cp .env.example .env" step below is **not** what is currently in place.

## 1. Prerequisites

| Requirement | Value |
|---|---|
| Node | `>=20` (root `package.json`) |
| pnpm | `11.5.2` |
| Docker | for Postgres (pgvector/pg16) + Redis 7 |
| Python | only if you want the real `ai-service` (optional — the API mocks it) |

---

## 2. Ports

| Service | Port |
|---|---|
| `apps/api` | 3001 |
| `apps/web` (ops) | 3000 |
| **`apps/payer-web`** | **3002** |
| `apps/admin-web` | 3003 |
| `ai-service` | 8000 |
| Postgres | 5432 — **remapped to 5433** by `docker-compose.override.yml` (Windows host-Postgres collision) |
| Redis | 6379 |
| Adminer | 8080 |
| Mailpit | via `pnpm mail:up` |

---

## 3. The recipe

```bash
pnpm install

cp .env.example .env                                    # root — API + db + redis
cp apps/payer-web/.env.example apps/payer-web/.env.local # PAYER_API_URL=http://localhost:3001

pnpm db:up          # postgres + redis via docker compose
pnpm db:migrate     # apply all 74 migrations (0000 → 0073)

pnpm build          # REQUIRED FIRST — workspace packages must exist in dist/
                    # before apps/api typechecks or runs

pnpm --filter @badabhai/api dev         # :3001
pnpm --filter @badabhai/payer-web dev   # :3002
```

`pnpm build` before running is not optional — `apps/api` imports 11 workspace packages from
their built `dist/`.

There is **no `payer-web` service in any compose file** (`docker-compose.yml`,
`.override.yml`, `.e2e.yml`, `.staging.yml` define only `postgres`, `redis`, `adminer`, `api`,
`ai-service`, `proxy`, `mailpit`). The portal runs on the host only.

---

## 4. ⚠️ The local login blocker — read this before you start

**Payer login is EMAIL OTP.** There is:

- **no** `dev_otp` echo in the response,
- **no** mock auth provider (`lib/auth/index.ts:15` returns the HTTP provider unconditionally;
  `mock-provider.ts` was deleted),
- **no** payer analogue of the worker's `TEST_LOGIN_ENABLED` seam.

So you cannot complete a payer login without capturing the email. Start Mailpit:

```bash
pnpm mail:up
```

> **`GAP-LOCAL-01` (P1).** Whether `EMAIL_PROVIDER=smtp` is actually wired to Mailpit in the
> compose network — and therefore whether local payer login works at all out of the box — was
> **not verified in this audit**. `PAYER_LOGIN_METHOD` ∈ `email_otp | whatsapp | supabase`
> selects the channel (`packages/config/src/server.ts:429`); the ZeptoMail implementation is
> `apps/api/src/payers/zeptomail-email-login-channel.ts`.
>
> **This is the first thing to check before any local E2E work**, because it gates every payer
> and agency flow. If it does not work, the smallest correct fix is a payer test-login seam
> mirroring `apps/api/src/auth/test-login.guard.ts` — neutral-404 unless enabled, HMAC token,
> boot-refused in production. That seam also un-blocks the four hard-skipped e2e suites
> (`GAP-XC-07`), so it is one fix for two problems.

`tests/e2e/helpers/payer-session.ts` still assumes a payer `dev_otp` echo that no longer exists —
`tests/e2e/README.md` records this as an unresolved gap.

---

## 5. Required environment variables

`apps/api` runs **9 fail-closed asserts before Nest starts** (`main.ts:31-38`). A half-configured
"real" path refuses to boot rather than degrading silently. In dev the defaults are permissive;
the asserts bite outside dev/test.

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **must point at a `BYPASSRLS` role** or every read 42501s (`database.module.ts:11-21`) |
| `REDIS_URL` | — | sessions, OTP, rate limits — fail-closed on error |
| `API_PORT` | 3001 | |
| `JWT_SECRET` | dev default | warns in dev, refuses outside |
| `PII_HASH_PEPPER`, `PII_ENCRYPTION_KEY` | dev defaults | same |
| `PAYER_LOGIN_METHOD` | `email_otp` | selects the OTP channel |
| `CORS_ALLOWED_ORIGINS` | unset | **deny-all outside dev** — must include the payer-web origin |
| `PAYER_API_URL` (payer-web) | `http://localhost:3001` | **server-only**, deliberately not `NEXT_PUBLIC_*` |
| `PAYMENTS_ENABLE_REAL` | `false` | keep OFF for alpha |
| `AGENCY_PAYOUTS_ENABLED` | `false` | keep OFF for alpha |
| `PAYER_DEV_ORG_ROLE` | unset | **dev-only** Owner-UI preview; ignored outside dev — the only way to see `/credits` and `/team` today |

`PAYER_DEV_ORG_ROLE=owner` is how you view the Owner surfaces locally. It is gated by
`isDevEnv()` reading raw `NODE_ENV` and **cannot** unlock Owner in staging or production.

### Documented-but-dead variables

`apps/payer-web/.env.example:47,52,54` still document `PAYER_AUTH_MODE`, `DEV_QUICK_LOGIN`, and
`PAYER_SESSION_SECRET`. **None is read anywhere in `apps/payer-web/src`.** `apps/payer-web/README.md`
documents the same dead seam plus the deleted `src/lib/mock-store.ts`. See `GAP-XC-11`.

A full both-directions diff of `.env.example` against the config schema was **not performed**.

---

## 6. Seed data

Root `package.json` exposes `db:seed:*` scripts. **Which of them produce a usable payer/agency
account with postings and workers — so the portal is not empty on first login — was not
verified.** Without that, the first-run experience is empty states everywhere, which makes the
portal hard to evaluate and impossible to E2E.

Also available: `db:verify:packs`, `db:eval:occupation`, `db:studio`.

---

## 7. Verification commands

```bash
pnpm lint            # includes the DS token gate (bans raw hex / px in payer-web)
pnpm lint:oxlint     # the only payer-web-specific CI step
pnpm typecheck
pnpm test            # NOTE: `pnpm test -- <filter>` runs the WHOLE suite — the filter is dropped
pnpm build
```

`RUN_DB_TESTS=1` enables 4 DB-backed gate suites. `RUN_E2E=1` enables the e2e suites that are not
hard-skipped.

---

## 8. Honest expectation for a first local run

Based on the audit, on a clean machine today you should expect:

| Step | Expectation |
|---|---|
| Install, migrate, build, boot API + portal | should work |
| Reach `/login` | should work |
| **Complete a payer login** | ⚠️ **blocked unless Mailpit↔SMTP is wired** — verify first |
| Post a job, view postings | should work once logged in |
| `/credits`, `/team` | **404** unless `PAYER_DEV_ORG_ROLE=owner` in dev |
| Applicants / unlock / reveal | needs seeded workers **and** an applied application |
| Agency KYC / earnings / payouts | **404 by design** (alpha flags off) |
| `/agency/revenue`, `/agency/bulk-upload` | parked / deliberately dead |

Everything below the login row is **unverified** — no dimension of this audit ran the
application. Treat the table as a hypothesis to test, not a result.
