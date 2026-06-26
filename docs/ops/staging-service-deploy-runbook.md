# Persistent staging SERVICE deploy runbook (BLOCKER #1)

> **Why this exists:** the entire alpha is blocked on one thing — there is **no
> persistent HTTPS staging API**. BUG-2's run #7 was **CI-ephemeral** (a throwaway
> runner), and `apps/worker-app` / the device-verify / the demand-loop runtime checks
> all default to `http://localhost:3001` with nothing to point at
> ([b1-device-capstone-runbook.md](../qa/b1-device-capstone-runbook.md) prereq #1). This
> runbook makes standing up a **persistent** staging service turnkey + self-verifying.
> The companion CD workflow is
> [`.github/workflows/staging-cd.yml`](../../.github/workflows/staging-cd.yml).
>
> **Not this:** the **ephemeral demand-loop proof** (migrate→seed→verify on a runner) is
> [staging-demand-verify.yml](../../.github/workflows/staging-demand-verify.yml) +
> [bug2-staging-demand-deploy-runbook.md](./bug2-staging-demand-deploy-runbook.md). That
> proves the unlock loop; **this** stands up the long-lived API that Rishi's B1 handset
> run and Prakash's runtime-verify point at.
>
> **MOCK-only, non-negotiable:** `PAYMENTS_ENABLE_REAL=false`, `AI_ENABLE_REAL_CALLS=false`,
> `MESSAGING_ENABLE_REAL=false`. Flipping any provider is a separate **CLAUDE.md §7** gate.

---

## Scope

| | |
| --- | --- |
| **Goal** | A **persistent** HTTPS staging API answering `GET /health` → `200` with **mock-OTP** working, Redis wired, all real-provider gates `false` — handed to Prakash + Rishi. |
| **In scope (codeable, done)** | The guarded CD workflow, the `/health` + mock-OTP smoke ([`scripts/staging-smoke.mjs`](../../scripts/staging-smoke.mjs), `pnpm staging:smoke`), and this runbook (the env-var SoT). |
| **Out of scope — HUMAN §7** | **Provisioning** the Supabase staging project + the API host + Redis, **holding the secrets**, and **running** the deploy. Claude cannot hold cloud creds — these are a CLAUDE.md §7 human action. |
| **Done bar** | The smoke (`pnpm staging:smoke`) is green against the public `STAGING_API_BASE_URL`, and the URL is shared with Prakash + Rishi. |

---

## The §7 human gate (cannot be automated)

The CD workflow is **inert** until these are done by a human/devops:

1. **Provision a disposable, non-prod Supabase STAGING project** (separate from prod) and capture
   its session-pooler connection string (`sslmode=require`) as `DATABASE_URL`.
2. **Provision a persistent API host** (Render / Railway / Fly / Coolify / a VM) that builds + runs
   [`apps/api/Dockerfile`](../../apps/api/Dockerfile), and **provision Redis** (managed or a
   container) for `REDIS_URL`. A GitHub Actions runner is **ephemeral** and cannot host the API —
   it only builds, migrates, triggers the host deploy, and smokes the public URL.
3. **Set the runtime env in TWO places** (they must match — esp. the PII keys + `JWT_SECRET`):
   - the **GitHub `staging` Environment secrets** (used by the CD job to migrate + smoke), and
   - the **host's runtime config** (used by the long-lived `node dist/main.js`).
   Fill from the env-var table below. **No secret value belongs in git** (placeholders only here).
4. **Run the CD:** Actions → **"Staging CD (persistent @badabhai/api)"** → *Run workflow*. It no-ops
   loudly if any required secret is missing.
5. **Share the HTTPS `STAGING_API_BASE_URL`** with Prakash (runtime-verify) + Rishi (B1 device-verify,
   via `--dart-define=API_BASE_URL=https://<staging-api>`).

---

## POSTURE — "Mode A + strong injected secrets" (interim)

A persistent env **cannot be both** true `NODE_ENV=staging` **and** mock-OTP today:
`assertAuthConfig` ([packages/config/src/server.ts](../../packages/config/src/server.ts)) **fails
boot** if `SMS_PROVIDER=console` outside dev, and `console` is the mock-OTP path (it echoes
`dev_otp`). Rishi's B1 device-verify expects **mock login**, not a real SMS. So:

- **`NODE_ENV=development` is deliberate** — the only way `SMS_PROVIDER=console` boots and the
  `dev_otp` is echoed for the team's login.
- **We compensate by injecting STRONG REAL secrets anyway** from the `staging` environment: a real
  `JWT_SECRET` (sessions non-forgeable — the dev default would let anyone forge one) and real
  `PII_ENCRYPTION_KEY` / `PII_HASH_PEPPER` (crypto is real). The boot asserts don't *enforce* these
  in dev, so the **smoke** + this runbook are the enforcement.
- **This env is SYNTHETIC-DATA-ONLY and TEAM-RESTRICTED** — it must **not** be internet-public with
  real worker PII. CORS is permissive in `NODE_ENV=development` (the dev branch of `resolveCorsOrigins`
  reflects the request origin), so network-restrict the host.
- **True `NODE_ENV=staging` strength *with* mock-OTP** needs a staging-safe `mock` SMS provider — the
  **Mode-C fast-follow tracked as [TD52](../registers/tech-debt-register.md).** Until then this Mode-A
  posture is the interim unlock.

---

## Env vars — the SoT (placeholders only; NO secret values in git)

The PreToolUse guard blocks editing `apps/api/.env.staging.example`, so **this table is the
authoritative env spec.** "Kind" = where it lives.

| Var | Kind | Purpose | Placeholder |
| --- | --- | --- | --- |
| `DATABASE_URL` | `staging` **secret** | Disposable **non-prod** staging Postgres (Supabase session pooler, `sslmode=require`). | `postgresql://USER:PASS@HOST:5432/postgres?sslmode=require` |
| `PII_ENCRYPTION_KEY` | `staging` **secret** | **Strong, real** AES-256-GCM key (NOT the dev default). | `<32-byte-base64-key>` |
| `PII_HASH_PEPPER` | `staging` **secret** | **Strong, real** HMAC pepper for the peppered phone hash. | `<random-pepper>` |
| `INTERNAL_SERVICE_TOKEN` | `staging` **secret** | Shared secret for `InternalServiceGuard` (ops/backend routes). | `<strong-random-secret>` |
| `JWT_SECRET` | `staging` **secret** | **Strong (≥16), real** worker/payer session signing secret — injected even in Mode A so sessions are non-forgeable. | `<random-32+char-secret>` |
| `REDIS_URL` | `staging` **secret** | Backs the OTP per-IP cap + HMAC code store + BullMQ. The mock-OTP smoke implicitly proves it is reachable. | `redis://USER:PASS@HOST:6379` |
| `STAGING_API_BASE_URL` | `staging` **secret** | The **public HTTPS URL** of the deployed API — what the smoke hits and what the handset/payer-web point at. | `https://staging-api.<your-host>` |
| `STAGING_DEPLOY_HOOK_URL` | `staging` **secret** (OPTIONAL) | Managed-host deploy webhook the CD POSTs to. Empty ⇒ the CD skips the trigger (host auto-deploys from the repo, or you deploy via your host CLI). | `https://api.<host>/deploy/hooks/<id>` |
| `NODE_ENV` | workflow **env** + **host** | `development` (Mode A — permits console mock-OTP). **Not** a secret. | `development` |
| `SMS_PROVIDER` | workflow **env** + **host** | `console` (mock-OTP; echoes `dev_otp`). | `console` |
| `PAYMENTS_ENABLE_REAL` | workflow **env** + **host** | MOCK-only gate — **stays `false`** (§7 to flip). | `false` |
| `AI_ENABLE_REAL_CALLS` | workflow **env** + **host** | MOCK-only gate — **stays `false`** (§7 to flip). | `false` |
| `MESSAGING_ENABLE_REAL` | workflow **env** + **host** | MOCK-only gate — **stays `false`** (§7 to flip). | `false` |
| `API_PORT` | **host** | Port the API listens on (host-dependent; code default `3001`). | `3001` (or the host's injected `PORT`) |
| `CORS_ALLOWED_ORIGINS` | **host** (optional) | Allow-list if the ops/payer web call the API. In `NODE_ENV=development` CORS already reflects the origin; set this when you tighten. | `https://ops.<host>,https://app.<host>` |

> The `staging` **secret** rows are needed by the **CD job** (migrate + smoke); the `NODE_ENV` /
> `SMS_PROVIDER` / `*_ENABLE_REAL` / `API_PORT` / `CORS_ALLOWED_ORIGINS` rows must ALSO be set on the
> **host** that runs the long-lived API. The PII keys + `JWT_SECRET` must be **byte-identical** in
> both places.

---

## Verify — the `/health` + mock-OTP smoke

The CD runs this automatically after deploy; you can also run it by hand:

```bash
STAGING_API_BASE_URL=https://staging-api.<your-host> pnpm staging:smoke
```

It asserts, failing loudly on any miss ([scripts/staging-smoke.mjs](../../scripts/staging-smoke.mjs)):

- **(a)** `GET /health` → `200` + `status:"ok"`.
- **(b)** `POST /auth/otp/request {phone}` → `200` **and `dev_otp` present** — the load-bearing check
  that the env is in **mock-OTP / `console` mode** (absent ⇒ a real provider is wired or `NODE_ENV`
  drifted → FAIL).
- **(c)** `POST /auth/otp/verify {phone, dev_otp}` → `200` + `access_token`.
- **(d)** `GET /auth/me` (Bearer) → `200` + `worker_id`.

Steps (b)–(d) also implicitly prove **Redis is wired** (OTP fails closed without it). It uses a
**synthetic** reserved phone and never prints the phone/`dev_otp`/token (CLAUDE.md §2).

---

## Guardrails to confirm on stand-up

- **OBS-4 — ops-web / payer-web must NOT be publicly reachable.** `apps/web` has no auth gate
  (protection is deployment-level); keep the ops console + payer-web **network-internal**. The API's
  cross-origin surface is the `CORS_ALLOWED_ORIGINS` allow-list (deny-all if unset outside dev).
- **Redis BEFORE any real-AI flip (TD27).** This runbook keeps `AI_ENABLE_REAL_CALLS=false`. If the
  AI service is ever flipped real, `REDIS_URL` must be set first or the spend caps run **per-worker**
  (N × cap) — see the flip section of
  [bug2-staging-demand-deploy-runbook.md](./bug2-staging-demand-deploy-runbook.md) + TD27.
- **Synthetic data only.** Mode A allows dev-default secrets at the boot layer; we inject strong ones,
  but the env is still pre-prod — never load real worker PII here.

---

## Rollback

| Situation | Action |
| --- | --- |
| Bad code shipped to staging | **Revert the PR**; redeploy the prior image/tag on the host. Code rollback is independent of data. |
| Corrupt staging DB | It is **disposable non-prod** — reset the DB and re-run the CD (build→migrate→deploy→smoke). |
| A provider gate accidentally flipped | Restart the host with `PAYMENTS_ENABLE_REAL`/`AI_ENABLE_REAL_CALLS`/`MESSAGING_ENABLE_REAL=false` (they default safe; an explicit `true` is a §7 violation here). |
| Smoke fails on `/health` | The host isn't up / URL not public — check the host logs + that `STAGING_API_BASE_URL` is the public HTTPS URL. (`/health` has **no DB/Redis dependency** — it 200s as soon as the process listens, so a `/health` miss means the host process isn't up.) |
| Smoke fails "no `dev_otp`" | The env drifted off Mode A (`SMS_PROVIDER`≠`console` or `NODE_ENV`≠`development`) — fix the host env. |
| Smoke fails at OTP with **429 / 503** (but `/health` is 200) | **Redis unreachable.** The API boots **without** Redis (lazy BullMQ connection), so `/health` stays 200, but OTP fails closed — 429 (per-IP cap) or 503 (code store). Fix `REDIS_URL` / the Redis host. |
| Smoke fails at OTP **verify** (step c) with a 5xx | **Postgres unreachable.** `/auth/otp/verify` + `/auth/me` create/read the worker row, so a DB outage surfaces here (not at `/health`). Check `DATABASE_URL`. |
| **API won't boot at all** (Zod parse error in `loadServerConfig`) | A malformed secret: `PII_ENCRYPTION_KEY` must be **base64 of exactly 32 bytes**, `JWT_SECRET` **≥16 chars**, `PII_HASH_PEPPER` **≥16 chars**. Regenerate to spec. |

---

## Cross-links

- [staging-cd.yml](../../.github/workflows/staging-cd.yml) — the guarded CD this runbook drives.
- [scripts/staging-smoke.mjs](../../scripts/staging-smoke.mjs) — the `/health` + mock-OTP smoke (`pnpm staging:smoke`).
- [bug2-staging-demand-deploy-runbook.md](./bug2-staging-demand-deploy-runbook.md) — the **ephemeral** demand-loop proof (the unlock loop), incl. the real-LLM flip + Redis-before-flip detail.
- [b1-device-capstone-runbook.md](../qa/b1-device-capstone-runbook.md) — Rishi's handset run; prereq #1 is exactly this staging URL.
- [TD52](../registers/tech-debt-register.md) — the Mode-C fast-follow (staging-safe `mock` SMS provider). [TD27](../registers/tech-debt-register.md) — Redis-before-AI-flip. [TD33](../registers/tech-debt-register.md) — payer auth.
