# Staging Service Deploy Runbook

Reconstructed from `.github/workflows/staging-cd.yml`'s own header/inline comments — the file
was deleted in the 2026-08-05 docs purge (`eb151468`) but is cited 3 times by that workflow,
plus `apps/api/src/auth/auth.service.ts:196` and `docs/payer-agent/TESTING_STRATEGY.md`
(`docs/audit/22_REMEDIATION_BACKLOG.md` BL-20, `docs/audit/24_RISK_REGISTER.md` R46).

## What this covers, and what it does not

`staging-cd.yml` ("Staging CD (persistent @badabhai/api)") is a **manual-trigger-only**
(`workflow_dispatch`, no push/PR trigger), **guarded-inert-by-default** workflow that builds the
API, migrates a disposable staging database, seeds reference data, triggers a managed host's
deploy (optional webhook), and smokes the public `/health` URL. It is a **separate pipeline from
`ci.yml`'s `deploy-lightsail`** (see `docs/rollback-guide.md`), targeting a **persistent staging
host** this repo does not itself provision — the host (Render/Railway/Fly/Coolify/a VM) is a
human's choice, made outside this repo.

This workflow deploys **no ai-service**. The FastAPI service is containerized and wired only into
the Lightsail path (`ci.yml`'s `deploy-lightsail`). Whatever host this workflow's build targets,
its `AI_SERVICE_URL` is that host's own config; if it points at nothing, the API still degrades
to its safe TypeScript mock (`/health` still reports 200) — activating this path means either
pointing that host at a real ai-service or knowingly accepting mocked AI.

## Is it wired? (the guard)

The workflow's first step checks that every required secret from the GitHub `staging`
**Environment** is non-empty, and additionally rejects a `DATABASE_URL`/`REDIS_URL` that still
resolves to the compose-internal throwaway host (`*@postgres:*` / `*@redis:*` — the literal check
in the guard step). If anything is missing or rejected, the job prints an `::notice::` naming
exactly what's missing and exits 0 (no-op) **without building, migrating, or deploying anything.**

**Required secrets** (all must be non-empty and pass the compose-default rejection check above):

| Secret | Purpose |
|---|---|
| `DATABASE_URL` | The disposable staging Postgres — must NOT be the compose-internal default |
| `PII_ENCRYPTION_KEY` | PII crypto (legacy single key — see `docs/pii-key-rotation-runbook.md`) |
| `PII_HASH_PEPPER` | Keyed HMAC pepper for phone/IP hashing |
| `INTERNAL_SERVICE_TOKEN` | Shared secret for the ops/backend-only internal routes |
| `JWT_SECRET` | Worker/payer session signing — real, non-forgeable sessions even in Mode A |
| `REDIS_URL` | Must NOT be the compose-internal default |
| `STAGING_API_BASE_URL` | The public HTTPS base URL the smoke step polls |
| `FAST2SMS_API_KEY` / `FAST2SMS_SENDER_ID` / `FAST2SMS_DLT_TEMPLATE_ID` | Worker OTP — real-only, no mock provider exists |
| `ZEPTOMAIL_API_TOKEN` / `ZEPTOMAIL_MAIL_AGENT` / `EMAIL_FROM_ADDRESS` | Payer OTP — real-only |

**Optional:** `STAGING_DEPLOY_HOOK_URL` (webhook to trigger the host's deploy — skipped with a
notice if unset; the host may auto-deploy from the repo, or a human deploys via their own host
CLI) and `FAST2SMS_ENTITY_ID`.

To activate: create the `staging` GitHub Environment and add every required secret above.

## Posture: real-only OTP, everything else mocked

`NODE_ENV=staging` (not `development`) — this environment sends **real** OTPs:

- Worker OTP: `SMS_PROVIDER=fast2sms`, real Fast2SMS credentials — there is no console/mock SMS
  provider in this codebase, so the app **fails closed at boot** without them
  (`assertAuthConfig`).
- Payer OTP: `EMAIL_PROVIDER=zeptomail`, real ZeptoMail credentials — same fail-closed rule
  (`assertPayerAuthConfig`).
- `PAYMENTS_ENABLE_REAL` / `AI_ENABLE_REAL_CALLS` / `MESSAGING_ENABLE_REAL` are **forced `false`**
  in the workflow's own `env:` block — non-negotiable, flipping any of them is a separate
  CLAUDE.md §7 human-gated action and explicitly out of scope for this workflow.

Because real SMS/email is real spend and this environment has real-only OTP, **staging must be
synthetic-data-only and team-restricted.** Activating the real-send path at all (i.e. wiring the
secrets and running this workflow the first time) is the OTP-7 human gate — see
`docs/ops/otp-real-send-staging-runbook.md`.

## Procedure (what the job actually does, in order)

1. **Guard** — see above. Stops here if not wired.
2. **Checkout, install pnpm/Node** (same pins as `ci.yml`: `pnpm@11.5.2` via `packageManager`,
   Node 22).
3. **Build** — `pnpm --filter "@badabhai/api..." build` (API + workspace deps only — the Next.js
   apps fail `next build` under `NODE_ENV=development`, and this pipeline has no use for them).
4. **Migrate** — `pnpm db:migrate` against the disposable staging `DATABASE_URL`. Runs **before**
   seeding and before the deploy trigger — migrations apply before the code that assumes them.
5. **Seed reference data** — in this exact order (order is load-bearing, not arbitrary):
   ```bash
   pnpm --filter @badabhai/db db:seed:domains --apply
   pnpm --filter @badabhai/db db:normalize:aliases --apply
   pnpm --filter @badabhai/db db:seed:packs --apply
   ```
   Since the OIE Phase 8 cutover, the profiling orchestrator resolves a question pack **on every
   chat turn** and fails closed when the universal pack is missing — an unseeded staging answers
   every worker with the "unavailable" line while `/health` stays green (nothing about an empty
   reference table is unhealthy). `--apply` is required on every one of these — they are dry-run
   by default and print-only without it. `db:normalize:aliases` must run **between** the domain
   seed and any retrieval, or aliases are invisible to L0/L2 occupation retrieval.
6. **Verify (live DB)** — `pnpm --filter @badabhai/db db:verify:packs` and `db:verify:domains`,
   checking what actually landed (not the corpus file) — "exactly one active pack per
   (family, locale)" and similar live-DB-only assertions.
7. **Trigger the host's deploy** — `POST` to `STAGING_DEPLOY_HOOK_URL` if set (the URL itself is
   never echoed/logged); otherwise a `::notice::` explains the host either auto-deploys from the
   repo or needs a manual deploy via its own CLI.
8. **Smoke** — poll `${STAGING_API_BASE_URL}/health` every 5s for up to 60 attempts (5 minutes)
   until it returns HTTP 200. On timeout, the job fails and dumps the last `/health` response body
   (readiness checks only — no secrets in that body) plus a hint: "is the host deployed + the URL
   public, and are DB + Redis reachable? The app fails closed at boot if the Fast2SMS/ZeptoMail
   credentials are missing."

**What the automated smoke does NOT prove:** a 200 on `/health` is connectivity-only
(`SELECT 1` + Redis `PING`) — it does not exercise a real OTP send/verify round trip. That
end-to-end proof is the separate, manual OTP-7 check —
see `docs/ops/otp-real-send-staging-runbook.md`.

## The synthetic test-login seam, if enabled against this host

`POST /auth/test-login` (`auth.service.ts`) is a separate seam some environments enable for
automated login testing without a real OTP round-trip. It is invisible (neutral 404) unless
`TEST_LOGIN_ENABLED=true` **and** `TEST_LOGIN_TOKEN` (≥32 chars) are both set — neither is in
`staging-cd.yml`'s own `env:` block above, so it is off on this pipeline's target by default. If
a human enables it on the persistent staging host outside this workflow (e.g. to smoke-test login
without spending real SMS/email), it serves **only** phone numbers matching
`+910{5}\d{5}` (`SYNTHETIC_TEST_PHONE_PATTERN`, hard-coded — deliberately not an env-configurable
allowlist) — any other phone is refused with the same neutral 404 a disabled seam returns, logged
PII-free ("phone outside the reserved synthetic range"). This is what keeps the seam from being
able to mint a session for a real worker even if it is left on.

## What this runbook does not cover

Provisioning the persistent staging host itself (Render/Railway/Fly/Coolify/VM — a human's
choice outside this repo); the Lightsail always-on deploy path (`docs/rollback-guide.md`); the
retired `staging-demand-verify.yml` ephemeral demand-loop-proof workflow (removed 2026-08-13,
`#830`/BL-16/R41 — its guard never verified `DATABASE_URL` was a disposable, non-production
database, and it shared this workflow's own `staging` Environment secret; if that demand-loop
proof is needed again, it must be rebuilt with a positive-match guard or a fully separate GitHub
Environment, not simply re-added here).
