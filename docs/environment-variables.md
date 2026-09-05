# Environment Variables Reference

**Citation note:** no live code cites a specific procedure "from `docs/environment-variables.md`"
— the only citations of this exact path are `.claude/agents/devops-engineer.md`'s
ownership-mandate list and this repo's audit documents analyzing it
(`docs/audit/16_OBSERVABILITY_AUDIT.md`, `docs/audit/24_RISK_REGISTER.md` R46). This reference is
reconstructed from `.env.example` (the repo's own, already-extensively-commented template — the
real source of truth for every variable's purpose and default) plus the fail-closed boot
assertions in `apps/api/src/main.ts` / `packages/config/src/server.ts`. **`.env.example` is more
current than any snapshot of it here could stay** — this document organizes and cross-references
it; for the exact current default/placeholder of any one variable, read `.env.example` itself.

## The one rule that matters most: the server/public split

`NEXT_PUBLIC_*` is the **only** prefix Next.js ships to the browser bundle. Everything else in
`.env.example` is server-only by construction — a secret without that prefix cannot leak into a
client bundle by Next.js's own build behavior, but nothing stops a developer from *reading* a
server var somewhere that then echoes it client-side, so the discipline still has to be kept by
hand:

- `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ENVIRONMENT`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are the **entire** public surface today — the anon/publishable
  Supabase key, never the service-role key.
- `INTERNAL_SERVICE_TOKEN` read by `apps/web` is a **server-only** secret — `.env.example`'s own
  comment: "read only in Server Components (`apps/web/src/lib/api.ts` via `process.env`) — it is
  never inlined into the client bundle."
- Any new `NEXT_PUBLIC_*` variable is a **shared decision with DevOps** (per the DevOps-engineer
  role's own collaboration protocol) — Frontend owns the bundle, DevOps owns what's allowed to be
  in it.

## Fail-closed boot assertions (`apps/api/src/main.ts`, in call order)

Every one of these runs **before** `app.listen()` — a violation crashes the boot, it never lets
the process come up half-configured:

| Assertion | What it refuses |
|---|---|
| `assertPiiCryptoConfig` | Dev-default `PII_HASH_PEPPER`/`PII_ENCRYPTION_KEY`, or a malformed/half-set TD22-1 keyring pair, outside development/test — see `docs/pii-key-rotation-runbook.md` |
| `assertAuthConfig` | Dev-default `JWT_SECRET`, missing/half-set Fast2SMS credentials (worker OTP is real-only — no mock exists), or an unsafe `TEST_LOGIN_ENABLED` configuration, outside development/test/staging |
| `assertPaymentsConfig` | `PAYMENTS_ENABLE_REAL=true` with any of `PAYMENTS_PROVIDER_KEY` / `PAYMENTS_PROVIDER_SECRET` / `RAZORPAY_WEBHOOK_SECRET` unset or blank (ADR-0010 F-6) |
| `assertMessagingConfig` | `MESSAGING_ENABLE_REAL=true` without WhatsApp Cloud API credentials (ADR-0020) |
| `assertPushConfig` | `PUSH_ENABLE_REAL=true` without an FCM credential (ADR-0034) |
| `assertPayerAuthConfig` | A half-configured payer login method, or a dev-default JWT under the same rule as `assertAuthConfig` (ADR-0019 B) |
| `assertMemberInvitesConfig` | `MEMBER_INVITES_ENABLE_REAL=true` without real email credentials / `MEMBER_INVITE_ACCEPT_URL` (ADR-0027 B5.4) |
| `assertAdminAuthConfig` | A dev/shared `ADMIN_JWT_SECRET` (must differ from `JWT_SECRET` — principal separation), or half-set MFA/TOTP, outside development/test (ADR-0025 ADMIN-1) |

The common shape across all eight: **a real-provider flag flipped `true` with its credential(s)
missing/blank refuses to boot rather than silently running mocked** — this is the "a gate that
reads an empty-string secret must fail startup, never arm vacuously" rule made concrete
(`TD67`/`AI_INTERNAL_TOKEN` follows the identical rule on the ai-service side — see
`docs/ai/` — but is validated at the Pydantic `Settings()` construction layer instead of a
NestJS boot assertion).

## Categories (see `.env.example` for the authoritative variable list per category)

- **Runtime** — `NODE_ENV`. Governs which fail-closed assertions actually enforce (most refuse
  outside `development`/`test`, some also exempt `staging`).
- **Core datastores** — `DATABASE_URL`, `REDIS_URL`.
- **Supabase (backend-only)** — `SUPABASE_URL` (safe to expose), `SUPABASE_SERVICE_ROLE_KEY`
  (a god-key, backend-only, never `NEXT_PUBLIC_*`), the Storage bucket names
  (`RESUMES_BUCKET`, `INTERVIEW_KIT_BUCKET`, `VOICE_NOTES_BUCKET`, `WORKER_PHOTOS_BUCKET`,
  `WORKER_FEEDBACK_ATTACHMENTS_BUCKET`, `CONVERSATIONS_BUCKET`). An empty bucket var means
  that feature is **dormant by design**, not broken — see `docs/observability-runbook.md` §3 for how `GET /health` distinguishes "dormant"
  from "armed without credentials" (#793).
- **PII protection** — `PII_HASH_PEPPER`, `PII_ENCRYPTION_KEY` (legacy single-key), the TD22-1
  keyring pair. Full rotation procedure: `docs/pii-key-rotation-runbook.md`.
- **Worker auth** — `JWT_SECRET`, `SESSION_TTL_DAYS`, the `OTP_*` shape/lifecycle/rate-limit
  family plus `WORKER_OTP_MAX_SENDS_PER_HOUR` (the worker-only per-phone hourly cap — #1421 split
  it off `OTP_MAX_SENDS_PER_HOUR`, which is now admin + payer only),
  `SMS_PROVIDER`/`FAST2SMS_*` (real-only, no mock). Levers and their blast radius:
  `docs/otp-throttles-runbook.md`.
- **Payer auth** — `PAYER_LOGIN_METHOD`, `EMAIL_PROVIDER`/`ZEPTOMAIL_*`/`SMTP_*` (real-only email
  OTP), `PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY`.
- **PIN unlock** — `PIN_PEPPER` (ADR-0026 Phase 3).
- **Admin auth** — `ADMIN_JWT_SECRET` (ADR-0025, must differ from `JWT_SECRET`).
- **AI routing** — `GEMINI_FLASH_API_KEY`, `AI_ENABLE_REAL_CALLS` (master kill-switch, default
  `false`), `AI_REAL_CALL_TASKS` (per-task allowlist — **empty means NO task may go real**,
  fail-closed, owner-ruled 2026-08-01 after the inverse reading was found in an earlier version
  of this same template), `ANTHROPIC_API_KEY` (optional fallback), `SARVAM_*` (STT/TTS),
  `AI_INTERNAL_TOKEN` (TD67 service bearer — unset keeps the historical internal-only open
  posture; see `docs/audit/24_RISK_REGISTER.md` R40).
- **Offline corpus embed throughput** (ADR-0030 / TAX-3, ai-service) — `AI_EMBED_REQUEST_BATCH`
  (texts per provider request, default 100), `AI_EMBED_TEXTS_PER_MINUTE` (pacing; **0 = unpaced,
  the default**), `AI_EMBED_MAX_RETRIES` (default 2), `AI_EMBED_BACKOFF_BASE_SECONDS`,
  `AI_EMBED_BACKOFF_MAX_SECONDS`, `AI_EMBED_RATE_LIMIT_COOLDOWN_SECONDS` (default 60 — a 429
  waits out the rate window rather than backing off inside it), `AI_EMBED_RETRY_ON_READ_TIMEOUT`
  (default `false`: the request was sent and its outcome is unknown, so retrying can pay for the
  same texts twice), `AI_EMBED_MAX_PACING_WAIT_SECONDS`.
  Two provider quotas pull in opposite directions and each has its own control. The per-DAY
  REQUEST quota wants a LARGE batch (100 texts/request puts the 9,121-alias corpus at ~92
  requests; one text per request needs 9,121 and takes ten days). The per-MINUTE TEXT quota
  wants PACING, not a smaller batch — shrinking the batch spends the same text budget across
  more requests, which is strictly worse for the daily quota. Measured on our own Phase 5
  traces: request size does not predict failure (a 100-text request succeeded while a 50-text
  one was refused); what predicts it is how many texts went out in the preceding minute, and
  **refused attempts consume the quota too**. Free-tier operators should set
  `AI_EMBED_TEXTS_PER_MINUTE=90`; leaving it at 0 preserves today's behaviour so a paid tier is
  never throttled to a free-tier number.
- **Payments** — `PAYMENTS_ENABLE_REAL` + the three Razorpay vars, all-or-nothing per
  `assertPaymentsConfig` above.
- **Messaging / push** — `MESSAGING_ENABLE_REAL` (WhatsApp), `PUSH_ENABLE_REAL` (FCM, security
  alerts only in this phase — security pushes are exempt from the numeric daily ceiling).
- **Chat / profiling** — `CHAT_TRANSCRIPT_TTL_SECONDS`, `CHAT_ABANDON_AFTER_SECONDS`,
  `CHAT_MAX_TURNS` (the authoritative hard cap — the ai-service mirrors it but holds no
  per-session state, so it can only enforce what the API tells it).
- **Observability** — `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL` (tracing
  off unless both keys are set; see `docs/observability-runbook.md` §6).
- **Service URLs / ports** — `API_PORT`, `AI_SERVICE_PORT`, `AI_SERVICE_URL`, `WEB_PORT`.
- **Reverse proxy** — `TRUST_PROXY_HOP_COUNT` (not in `.env.example` as a var but read in
  `main.ts`; a hop **count**, never a blanket boolean — spoofable `X-Forwarded-For` would
  otherwise let an attacker rotate their rate-limit identity. Default 0 = trust nothing, use the
  raw socket peer, until the deploy edge's actual hop count is known).
- **CORS** — `CORS_ALLOWED_ORIGINS` (`resolveCorsOrigins`): permissive in dev, an explicit
  allow-list outside dev, **deny-all if unset** outside dev — fail closed, not fail open.

## Where each environment's real values actually live (never in this file, never in git)

- **Local dev**: copy `.env.example` to `.env` at the repo root (`.gitignore`d). See
  `docs/supabase-workflow.md` / the root `README.md` for the local-dev loop.
- **CI (`ci.yml`'s `e2e` job)**: obviously-fake literal placeholders set directly in the job's
  `env:` block (e.g. `ci-dummy-fast2sms-api-key`) — real enough to satisfy the fail-closed boot
  asserts, never a real credential, never reaching a real provider.
- **Lightsail (`deploy-lightsail`)**: GitHub **Environment** secrets (`environment: staging` in
  the job), bridged onto the box's shell environment via `appleboy/ssh-action`'s `env:`/`envs:`
  pair — GitHub secrets do not reach the box's compose interpolation on their own; this bridge is
  what makes them visible to `docker-compose.staging.yml`'s `${VAR:?}` gates. See
  `docs/rollback-guide.md` and `docs/release-checklist.md` for the exact secret list currently
  bridged.
- **Persistent staging (`staging-cd.yml`)**: the same GitHub `staging` Environment's secrets, read
  directly into the workflow's own `env:` block (a different job, a different consumption path,
  same Environment) — see `docs/ops/staging-service-deploy-runbook.md`.

## What this reference does not cover

The exact current default/placeholder text for any one variable (read `.env.example` — it is
authoritative and this document is not); the ai-service's own Python-side settings
(`apps/ai-service/app/config.py`) beyond the handful cross-referenced above; per-environment
actual values (never documented anywhere, by design — CLAUDE.md §3 "Privacy First" / secrets
never in git).
