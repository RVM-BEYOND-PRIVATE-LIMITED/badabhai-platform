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

## POSTURE — REAL-ONLY OTP (current, as of commit d2f228e)

> ⚠️ **Mode A ("Mode A + strong injected secrets") is OBSOLETE as of commit `d2f228e`.**
> `SMS_PROVIDER` is now `z.literal("fast2sms").default("fast2sms")` in
> [`packages/config/src/server.ts:221`](../../packages/config/src/server.ts) — the value `console`
> **fails Zod parse at boot** (boot error: `Expected "fast2sms", received "console"`). There is no
> mock or console SMS provider. `dev_otp` was removed from all OTP responses in the same commit.
> Any doc, script, or environment that sets `SMS_PROVIDER=console` or expects `dev_otp` in the
> OTP response **will not work**.

The CD workflow ([`.github/workflows/staging-cd.yml`](../../.github/workflows/staging-cd.yml)) already
reflects the correct posture:
- `NODE_ENV: staging`
- `SMS_PROVIDER: fast2sms`
- `assertAuthConfig` is active — **boot requires** `FAST2SMS_API_KEY` + `FAST2SMS_SENDER_ID` +
  `FAST2SMS_DLT_TEMPLATE_ID` + `FAST2SMS_ENTITY_ID` + `FAST2SMS_ROUTE` to be set (OTP-7, §7 gate).

**Implications for B1:**
- Rishi's device run requires a **real OTP send** to an allowlisted number.
- The smoke script steps (b)–(d) (`dev_otp` assertion + OTP round-trip) are **permanently broken as
  written** — `dev_otp` was removed from every OTP response in `d2f228e`, so **provisioning Fast2SMS
  creds does NOT restore them**: with real OTP there is no echoed code for a script to read. The
  **Mode-C fast-follow (staging-safe `mock` SMS provider) is CANCELLED** by owner decision
  2026-07-16 — real OTP is the path ([TD52](../registers/tech-debt-register.md)). The automated OTP
  leg must therefore be **re-worked**, owner's call between: (i) drop smoke to **health-only**;
  (ii) option **(C) `STAGING_OTP_BYPASS_TOKEN`** — a staging-only token the API echoes ONLY when
  `NODE_ENV=staging` AND the phone is synthetic-reserved AND the token matches (the recommendation
  in [doc-reconciliation-2026-07-15.md](../registers/doc-reconciliation-2026-07-15.md) ESC-1;
  keeps `SMS_PROVIDER=fast2sms` real, so it is **not** a mock provider); or (iii) the gated
  **test-session-mint** e2e seam (owner sign-off pending).
- Step (a) `GET /health → 200` still works and proves DB + Redis readiness.

**What to do now (owner: Prakash):**
1. Provision the Supabase staging project + API host + Redis (§7 human action, unchanged).
2. Obtain + set Fast2SMS staging creds (`FAST2SMS_API_KEY` etc.) — without them the API won't boot.
3. Set `NODE_ENV=staging`, `SMS_PROVIDER=fast2sms` (NOT `development`, NOT `console`).
4. Restrict OTP sends to the team allowlist via `OTP_MAX_SENDS_PER_HOUR` / `FAST2SMS_DLT_*` config.
5. For the smoke: verify (a) `/health 200` manually; confirm OTP round-trip by requesting an OTP to
   your own number + entering it; then share `STAGING_API_BASE_URL` with Rishi.

**See also:** [ESC-1 in doc-reconciliation-2026-07-15.md](../registers/doc-reconciliation-2026-07-15.md)
for the three resolution options (A/B/C) for fixing the smoke script; Option C (staging-bypass token)
is the recommended path to unblock automated CI verification without real SMS spend.

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
| `NODE_ENV` | workflow **env** + **host** | `staging` (real-only posture; `assertAuthConfig` active; CORS fail-closed). **Not** a secret. | `staging` |
| `SMS_PROVIDER` | workflow **env** + **host** | `fast2sms` (REAL sends; requires Fast2SMS creds; OTP-7 §7 gate). `console` **fails boot** since `d2f228e`. | `fast2sms` |
| `FAST2SMS_API_KEY` | `staging` **secret** | Fast2SMS DLT credentials — **required** for boot when `SMS_PROVIDER=fast2sms`. | `<fast2sms-api-key>` |
| `FAST2SMS_SENDER_ID` / `_DLT_TEMPLATE_ID` / `_ENTITY_ID` / `_ROUTE` | `staging` **secret** | Fast2SMS DLT registration parameters. | `<per-key-value>` |
| `PAYMENTS_ENABLE_REAL` | workflow **env** + **host** | MOCK-only gate — **stays `false`** (§7 to flip). | `false` |
| `AI_ENABLE_REAL_CALLS` | workflow **env** + **host** | MOCK-only gate — **stays `false`** (§7 to flip). | `false` |
| `AI_INTERNAL_TOKEN` | `staging` **secret** (OPTIONAL — TD67) | ONE service-level bearer for the ai-service. Unset = open internal posture. When flipping: set the SAME value (≥16 chars) on the ai-service host env, the api host env, AND the db-runner env — a half-flip 401s api→ai calls (api degrades to mock, logged at ERROR). Verify via ai-service `/health.service_auth_enabled`. | `<random-32+char-secret>` |
| `MESSAGING_ENABLE_REAL` | workflow **env** + **host** | MOCK-only gate — **stays `false`** (§7 to flip). | `false` |
| `TEST_LOGIN_ENABLED` | workflow **env** + **host** (OPTIONAL — D-3) | Arms `POST /auth/test-login`, the gated worker session-mint seam the smoke's authed stage + the e2e suites use (worker OTP is real-only, so no test can drive a real code). Default **`false`** ⇒ the route is a **neutral 404**. Staging **may** set `true`; **PRODUCTION MUST NOT** — the API **refuses to boot** with it on unless `NODE_ENV` is explicitly `development`/`test`/`staging` (`assertAuthConfig`). Requires `TEST_LOGIN_TOKEN` (below) — enabled without it is also a **boot failure** (TD67: never arm vacuously). | `false` (staging: `true`) |
| `TEST_LOGIN_TOKEN` | `staging` **secret** (OPTIONAL — D-3) | The **≥32-char** secret `TestLoginGuard` compares (HMAC timing-safe) against the `x-test-login-token` header. Set but NOT enabled ⇒ **inert** (route still 404s). An **empty/short** value is a **Zod parse error at boot** in EVERY env — never "silently off". Pass the SAME value to the smoke as `SMOKE_TEST_LOGIN_TOKEN` (absent ⇒ the smoke runs **health-only**). Treat as a secret: never logged/evented. | `<random-32+char-secret>` |
| `API_PORT` | **host** | Port the API listens on (host-dependent; code default `3001`). | `3001` (or the host's injected `PORT`) |
| `CORS_ALLOWED_ORIGINS` | **host** (optional) | Allow-list if the ops/payer web call the API. In `NODE_ENV=development` CORS already reflects the origin; set this when you tighten. | `https://ops.<host>,https://app.<host>` |

> The `staging` **secret** rows are needed by the **CD job** (migrate + smoke); the `NODE_ENV` /
> `SMS_PROVIDER` / `*_ENABLE_REAL` / `API_PORT` / `CORS_ALLOWED_ORIGINS` rows must ALSO be set on the
> **host** that runs the long-lived API. The PII keys + `JWT_SECRET` must be **byte-identical** in
> both places.
>
> **D-3 test-login (`TEST_LOGIN_ENABLED` + `TEST_LOGIN_TOKEN`):** both are OPTIONAL and OFF by
> default. To run the smoke's authed stage on staging, set BOTH on the **host** (the API must see
> them) and give the CD job the same token as `SMOKE_TEST_LOGIN_TOKEN`. **PRODUCTION MUST NOT set
> `TEST_LOGIN_ENABLED=true`** — that is not a convention but a **structural block**: the boot
> guard rejects the flag outside an explicit `development`/`test`/`staging` `NODE_ENV`, so an
> unset/typo'd `NODE_ENV` on a prod box fails closed (the API will not start) rather than leaving
> an OTP-less login route armed.

---

## Verify — the `/health` + gated-authed smoke

The CD runs this automatically after deploy; you can also run it by hand:

```bash
# health-only (the default posture — no token needed)
STAGING_API_BASE_URL=https://staging-api.<your-host> pnpm staging:smoke

# + the authed stage (requires the API armed with TEST_LOGIN_ENABLED + TEST_LOGIN_TOKEN)
STAGING_API_BASE_URL=https://staging-api.<your-host> \
  SMOKE_TEST_LOGIN_TOKEN=<the API's TEST_LOGIN_TOKEN> pnpm staging:smoke
```

**Rewritten for D-3** (owner ruling: [team-decisions.md](../registers/team-decisions.md) 2026-07-17
item 9). The old smoke's load-bearing assertion was `dev_otp` presence ⇒ *"PROVES
SMS_PROVIDER=console"* — a posture the config now **forbids** (`SMS_PROVIDER: z.literal("fast2sms")`
⇒ `console` fails Zod parse at boot since `d2f228e`), so steps (b)–(d) were **permanently red**.
It now asserts, failing loudly on any miss ([scripts/staging-smoke.mjs](../../scripts/staging-smoke.mjs)):

**Stage 1 — always:**

- **(a)** `GET /health` → `200` + `status:"ok"` — a **real readiness check**: it probes Postgres +
  Redis and returns `{ status, service, environment, timestamp, checks: { database, redis } }`,
  responding **503** (with `checks` showing which is `down`) when a dependency is unreachable. So the
  CD's `/health` wait genuinely gates on DB + Redis being up.

**Stage 2 — ONLY when `SMOKE_TEST_LOGIN_TOKEN` is set** (absent ⇒ skipped, and the smoke still
PASSes on health alone — the **default posture**):

- **(b)** `POST /auth/test-login` (`x-test-login-token` header + a synthetic `{phone}`) → `200` +
  `access_token` present. A **404** here means `TEST_LOGIN_ENABLED` is off on the target; a **401**
  means the token mismatches — both fail loudly.
- **(c)** `GET /auth/me` (Bearer) → `200` + `worker_id` — one cheap authed read proving the minted
  session actually resolves through `WorkerAuthGuard` + Redis.

Stage 2 also proves `REDIS_URL` end-to-end (the per-IP cap + session store fail closed without it).
**Privacy:** the smoke never prints the phone (fully masked), the gate token, or the access token.

> The **real** OTP round-trip (a live Fast2SMS code) remains a **manual** check with a
> team-allowlisted phone — the test-login seam deliberately does **not** exercise the SMS provider.

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
| `/health` returns **503** with `checks.database:"down"` | **Postgres unreachable** — `/health` now probes the DB (`select 1`). Check `DATABASE_URL` (disposable non-prod, `sslmode=require`). |
| `/health` returns **503** with `checks.redis:"down"` | **Redis unreachable** — `/health` now probes Redis (`PING`). Check `REDIS_URL` / the Redis host. (OTP also fails closed 429/503 until fixed.) |
| `/health` never responds (connection refused / times out) | The host process isn't up, or the URL isn't public — check the host logs + that `STAGING_API_BASE_URL` is the public HTTPS URL. |
| Smoke steps (b–d) fail (`dev_otp` not found) | Expected — `dev_otp` was removed in `d2f228e`; smoke steps (b)–(d) are permanently broken until ESC-1 is resolved. Only step (a) `/health` works. Verify OTP manually. See [doc-reconciliation-2026-07-15.md](../registers/doc-reconciliation-2026-07-15.md) ESC-1. |
| **API won't boot at all** (Zod parse error in `loadServerConfig`) | A malformed secret: `PII_ENCRYPTION_KEY` must be **base64 of exactly 32 bytes**, `JWT_SECRET` **≥16 chars**, `PII_HASH_PEPPER` **≥16 chars**. Regenerate to spec. |

---

## Cross-links

- [staging-cd.yml](../../.github/workflows/staging-cd.yml) — the guarded CD this runbook drives.
- [scripts/staging-smoke.mjs](../../scripts/staging-smoke.mjs) — the `/health` + mock-OTP smoke (`pnpm staging:smoke`).
- [bug2-staging-demand-deploy-runbook.md](./bug2-staging-demand-deploy-runbook.md) — the **ephemeral** demand-loop proof (the unlock loop), incl. the real-LLM flip + Redis-before-flip detail.
- [b1-device-capstone-runbook.md](../qa/b1-device-capstone-runbook.md) — Rishi's handset run; prereq #1 is exactly this staging URL.
- [TD52](../registers/tech-debt-register.md) — the Mode-C fast-follow (staging-safe `mock` SMS provider). [TD27](../registers/tech-debt-register.md) — Redis-before-AI-flip. [TD33](../registers/tech-debt-register.md) — payer auth.
