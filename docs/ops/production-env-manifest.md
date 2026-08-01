# BadaBhai — Production Environment Manifest

> **Single source of truth for configuring a production (or staging) `.env`.** This manifest is generated from the actual code — the Zod contract in `packages/config` (`server.ts` / `public.ts` / `shared.ts`), the FastAPI Pydantic `Settings` in `apps/ai-service/app/config.py`, the Next.js reads in `apps/web` and `apps/payer-web`, and the compose/CD required-secret lists — **not** from any `.env` file.
>
> **How to use this:** Fill every `CHANGE_ME_<purpose>` placeholder exactly once with a real value. Non-secret defaults are already correct and can be left as-is. **Anything marked "Fail-closed at boot? = Yes" will crash the process on startup if it is missing, malformed, or left at a dev default** — set those first (see the 🚫 list). Secrets are never committed to a file in this repo; in real deploys they are injected as host/CI environment variables (the repo-root loader only fills *missing/blank* keys, and the guard hooks block reading `.env*`). `NODE_ENV=production` must be set **explicitly** — a forgotten `NODE_ENV` fails *closed* (dev-default secrets are rejected, `TEST_LOGIN` is refused) because every security gate reads raw `process.env.NODE_ENV` via `isDevEnv()`, but you still want it set for correct behavior everywhere else.
>
> **Three services, three env sets.** `apps/api` (NestJS) and `apps/ai-service` (FastAPI) each read their **own** environment — they do **not** share one config module. `apps/web` and `apps/payer-web` (Next.js) read a small public schema plus a few server-only vars. Watch the naming-drift landmines called out in 🔗 and ⚠ below (`REDIS_URL` ≠ `AI_SPEND_REDIS_URL`; `INTERNAL_SERVICE_TOKEN` ≠ `AI_INTERNAL_TOKEN` ≠ `SKILLS_INTERNAL_TOKEN`; one Gemini key with three legacy names).

Legend for the **Required** column: `required` = must set in prod; `conditional` = required only when a named flag/provider is active; `optional` = safe default exists. **Secret?** `Yes` = must never appear in a log, event, `ai_jobs`, `audit_logs`, a client bundle, or a `NEXT_PUBLIC_` var.

---

## `apps/api` — NestJS backend (the largest surface)

Boot-time guards run in `main.ts` in this order and each **crashes boot** on violation: `assertPiiCryptoConfig` → `assertAuthConfig` → `assertPaymentsConfig` → `assertMessagingConfig` → `assertPushConfig` → `assertPayerAuthConfig` → `assertMemberInvitesConfig` → `assertAdminAuthConfig`. Schema-level parse failures (bad base64, wrong literal, short token, invalid keyring) also crash at `loadServerConfig()`.

### A. Core infrastructure & runtime

| Variable | Required | Secret? | Format / example (placeholder only) | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `NODE_ENV` | required | No | `production` (enum: development / test / staging / production) | `development` (parsed, **fail-open**) | No (but load-bearing) | `isDevEnv()` (raw env) gates every `assert*Config` dev-shortcut | Footgun: parsed value defaults to `development`, but all security gates read **raw** `process.env.NODE_ENV`, so unset/typo fails *closed*. **Set it explicitly to `production`.** |
| `DATABASE_URL` | required | Yes | `postgresql://USER:CHANGE_ME_DB_PASSWORD@HOST:5432/badabhai?sslmode=require` | `postgresql://badabhai:badabhai@localhost:5432/badabhai` | No (lazy connect; malformed URL fails parse) | Drizzle client (`@badabhai/db`), every repository, migrate steps | Must point at a **BYPASSRLS** role (Supabase session-pooler `postgres.<ref>`) or all `workers` reads/writes deny `42501`. **Never** the compose-internal `@postgres:` host (would write real PII to a disposable volume). |
| `REDIS_URL` | required | Yes | `redis://:CHANGE_ME_REDIS_PASSWORD@HOST:6379` | `redis://localhost:6379` | No (lazy) | BullMQ + all OTP/PIN/session/rate-limit/spend-breaker stores | **Runtime fail-closed:** a Redis outage makes per-IP/per-phone caps and OTP spend breakers **reject (429/deny)**, not uncap. On the box use `redis://redis:6379`, never the compose-internal `@redis:` in a manifest that also feeds ai-service. **Distinct from `AI_SPEND_REDIS_URL`.** |
| `API_PORT` | optional | No | `3001` (int 1–65535) | `3001` | No (out-of-range fails parse) | NestJS `app.listen` | — |
| `AI_SERVICE_URL` | required | No | `https://ai.internal.badabhai.in` | `http://localhost:8000` | No | `AiService` (all `/profiling`,`/extraction`,`/stt` forwards + `/health`) | Prod must point at the real FastAPI service; wrong URL degrades AI to fallback at call time. |
| `TRUST_PROXY_HOP_COUNT` | optional | No | `1` (non-negative int = real edge hop count) | `0` | No | Express `trust proxy` → `req.ip` for **every** per-IP cap | `0` = socket peer (fail-safe). In prod set to the **real** hop count, else all per-IP caps key on the shared proxy IP. **Never** a blanket `true` (spoofable XFF = rotatable rate-limit identity). |
| `CORS_ALLOWED_ORIGINS` | required | No | `https://ops.badabhai.in,https://app.badabhai.in` | `""` (empty) | No (runtime fail-closed) | `resolveCorsOrigins` → `enableCors` | Outside dev/test an **empty list denies all** cross-origin (never `*`). Unset breaks ops console + payer-web in prod. Ignored (origin reflected) in dev/test. |

### B. Supabase Storage & buckets

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `SUPABASE_URL` | conditional | No | `https://<ref>.supabase.co` | (unset) | Yes **only** when `PAYER_LOGIN_METHOD=supabase`; else runtime 503 | `StorageService.requireStorage`; `assertPayerAuthConfig` | Backend endpoint, not a credential. Also required (with the key) for real resume/interview-kit/photo render — `requireStorage` throws 503 naming the var on first use if unset. **Shared with `apps/ai-service`** (STT). |
| `SUPABASE_SERVICE_ROLE_KEY` | conditional | Yes | `CHANGE_ME_SUPABASE_SERVICE_ROLE_KEY` | (unset) | Yes only under `PAYER_LOGIN_METHOD=supabase`; else runtime 503 | `StorageService` bearer (bypasses RLS); `assertPayerAuthConfig` | Highest-privilege DB/storage secret. Backend-only — never `NEXT_PUBLIC_*`. **Shared with `apps/ai-service`.** |
| `CONVERSATIONS_BUCKET` | optional | No | `worker-conversations` (non-empty) | `worker-conversations` | No (empty override fails `.min(1)`) | conversation-artifact storage; account-deletion erase | Create **private** out-of-band (ACLs aren't in migrations). Keys are opaque UUIDs, no PII. |
| `RESUMES_BUCKET` | optional | No | `worker-resumes` | `worker-resumes` | No | resume PDF storage; render processor; account-deletion erase | Private bucket; name lives inside PDF bytes only. Real bucket names use hyphens. |
| `INTERVIEW_KIT_BUCKET` | optional | No | `interview-kits` | `interview-kits` | No | interview-kit PDF cache + signed URL | Keys are per-trade + content version, PII-free. |
| `VOICE_NOTES_BUCKET` | conditional | No | `worker-voice-notes` | `""` (empty — **dormant**) | No | `VoiceService` seam; `AccountDeletionService` DSAR audio-erase leg | **Empty = dormant** (voice surface 503, DSAR audio-erase skipped). Setting it simultaneously arms erasure of raw-PII audio (§2). **Drift:** `apps/ai-service` defaults this to `worker-voice-notes`, not empty — see ⚠. |
| `WORKER_PHOTOS_BUCKET` | conditional | No | `worker-photos` | `""` (empty — **inert**) | No | worker photo endpoints; render processor; account-deletion erase | Empty = photo endpoints 503 (feature inert). Setting it arms the photo-erase leg. **Face photo = high-sensitivity PII** — never to payer/disclosure/events/`ai_jobs`/logs. |
| `RESUME_RENDER_ENABLED` | optional | No | `false` / `true` | `false` | No | WeasyPrint render step (resume + interview-kit) | Master render kill-switch (the requested `WEASYPRINT_ENABLED` maps here). OFF → renderer returns null (no binary needed). Turning ON in prod presupposes `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`. |

### C. PII crypto — all boot-gated

| Variable | Required | Secret? | Format / example | Default (dev-only, **rejected in prod**) | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `PII_HASH_PEPPER` | required | Yes | `CHANGE_ME_PII_HASH_PEPPER` (≥16, use ≥32) | `dev-insecure-pii-pepper-change-me` | **Yes** | keyed-HMAC of phone/IP; `assertPiiCryptoConfig` | Dev default **rejected** outside development/test. Distinct KDF from `PIN_PEPPER`. |
| `PII_ENCRYPTION_KEY` | required | Yes | `CHANGE_ME_PII_ENCRYPTION_KEY` (base64 of **exactly 32 bytes**, AES-256-GCM) | base64 of 32 zero bytes | **Yes** | encrypts `phone_e164` at rest; `assertPiiCryptoConfig` | Two checks: schema `.refine` (non-32-byte base64 fails parse, every env) **and** assert rejects the named dev default / any all-zero key outside dev/test. The v1/legacy key when the keyring is active. |
| `PII_ENCRYPTION_KEYS` | conditional | Yes | `{"k1":"<base64-32B>"}` JSON map (kid 1–32 `[A-Za-z0-9_-]`, dot-free) | (unset) | **Yes (every env)** | `getPiiKeyring`; `assertPiiCryptoConfig` (TD22-1) | **Opt-in** staged rotation, **both-or-neither** with `PII_ENCRYPTION_ACTIVE_KID`. Empty string = ERROR. Fails boot on half-set / invalid JSON / 0 keys / duplicate kid / bad charset / non-32-byte / all-zero. |
| `PII_ENCRYPTION_ACTIVE_KID` | conditional | No | `k1` (kid present in `PII_ENCRYPTION_KEYS`) | (unset) | **Yes (every env)** | `getPiiKeyring`; `assertPiiCryptoConfig` | The kid new v2 tokens write under. Requires `PII_ENCRYPTION_KEYS`; both-or-neither. Identifier, not secret. |

### D. Auth & session (worker + payer)

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `JWT_SECRET` | required | Yes | `CHANGE_ME_JWT_SECRET` (≥16, use ≥32) | `dev-insecure-jwt-secret-change-me` | **Yes** | signs **both** worker + payer sessions; `assertAuthConfig` + `assertPayerAuthConfig` + `assertAdminAuthConfig` | Dev default rejected outside dev/test by two guards. **Must differ from `ADMIN_JWT_SECRET`.** A leaked/default value = forgeable worker + payer sessions. |
| `SESSION_TTL_DAYS` | optional | No | `30` | `30` | No | worker/payer session + Redis key TTL | — |
| `AUTH_ROLLING_TIERS_ENABLED` | optional | No | `false` / `true` | `false` | No | tiered-session behavior (ADR-0026) | OFF → flat `SESSION_TTL_DAYS`, no absolute cap. ON → tiered idle TTL + absolute-max enforced. |
| `AUTH_SESSION_ABSOLUTE_MAX_DAYS` | optional | No | `90` | `90` | No | absolute session cap (when tiers on) | Cross-field: `AUTH_REFRESH_TTL_DAYS` must be ≥ this (every env). |
| `AUTH_TIER_WINDOW_DAYS` | optional | No | `60` | `60` | No | engagement-tier active-day window | — |
| `AUTH_REFRESH_TTL_DAYS` | optional | No | `90` | `90` | **Yes** | rotating refresh-token TTL; `assertAuthConfig` | **Fails boot (every env) if `< AUTH_SESSION_ABSOLUTE_MAX_DAYS`** — regardless of whether tiers are on. |
| `PIN_PEPPER` | required | Yes | `CHANGE_ME_PIN_PEPPER` (≥16, use ≥32) | `dev-insecure-pin-pepper-change-me` | **Yes** | scrypt device-unlock PIN KDF; `assertAuthConfig` | Distinct from `PII_HASH_PEPPER`. Dev default rejected outside dev/test — leak of `worker_credentials` + public pepper makes the 10⁴ PIN space brute-forceable. |
| `PIN_LENGTH` | optional | No | `4` (int 4–8) | `4` | No | PIN shape + weak-PIN denylist | — |
| `PIN_MAX_ATTEMPTS` | optional | No | `5` | `5` | No | PIN durable throttle | — |
| `PIN_LOCKOUT_BASE_SECONDS` | optional | No | `60` | `60` | No | PIN exponential backoff base | — |
| `PIN_MAX_LOCKOUT_CYCLES` | optional | No | `5` | `5` | No | PIN → forced OTP reset (R25a) | — |
| `PIN_CHALLENGE_TTL_SECONDS` | optional | No | `600` | `600` | No | pin-challenge token TTL (SIM-swap gate) | — |
| `TEST_LOGIN_ENABLED` | optional | No | `false` | `false` | **Yes (if true)** | `POST /auth/test-login`; `assertAuthConfig` | **MUST stay OFF in prod.** Arming it with `NODE_ENV` not explicitly development/test/staging = **boot failure**. OFF → route is neutral 404. Mints a real session with no OTP. |
| `TEST_LOGIN_TOKEN` | conditional | Yes | `CHANGE_ME_TEST_LOGIN_TOKEN` (≥32) | (unset) | **Yes** | `POST /auth/test-login` bearer; `assertAuthConfig` | Schema `.min(32)` → a set short/empty value fails parse every env. Required (≥32) when `TEST_LOGIN_ENABLED`. **Leave unset in prod.** |
| `TEST_LOGIN_MAX_PER_DAY` | optional | No | `200` (int ≥0) | `200` | No | daily test-login mint ceiling | `0` = paused (kill-switch). |

### E. Worker OTP / SMS — Fast2SMS, **real-only** (no console/mock, §1)

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `SMS_PROVIDER` | optional | No | `fast2sms` (literal — only allowed value) | `fast2sms` | **Yes** | Fast2Sms provider selection; `assertAuthConfig` | `z.literal('fast2sms')` — any other value fails parse. No mock path exists. |
| `FAST2SMS_API_KEY` | required | Yes | `CHANGE_ME_FAST2SMS_API_KEY` | (unset) | **Yes** | Fast2Sms send; `assertAuthConfig` | **Required in EVERY env** — assert fails boot without it (real-only worker OTP). |
| `FAST2SMS_SENDER_ID` | required | No | `BADBHI` (DLT sender id) | (unset) | **Yes** | Fast2Sms; `assertAuthConfig` | Required every env. Identifier, not a secret. |
| `FAST2SMS_DLT_TEMPLATE_ID` | required | No | `1234567890` (approved DLT template id) | (unset) | **Yes** | Fast2Sms; `assertAuthConfig` | Required every env. Identifier. |
| `FAST2SMS_ENTITY_ID` | optional | No | `1701234567890` (DLT principal entity id) | (unset) | No | Fast2Sms | **NOT** in the assert required set (schema-optional), but real DLT delivery typically needs it. Runbook overstates it as required — see ⚠. |
| `FAST2SMS_ROUTE` | optional | No | `dlt` | `dlt` | No | Fast2Sms route selection | Runbook lists as required (drift); schema default is `dlt`. |
| `OTP_LENGTH` | optional | No | `6` (int 4–8) | `6` | No | OTP shape | — |
| `OTP_TTL_SECONDS` | optional | No | `300` | `300` | No | OTP lifetime | — |
| `OTP_MAX_ATTEMPTS` | optional | No | `5` | `5` | No | OTP verify cap | — |
| `OTP_RESEND_COOLDOWN_SECONDS` | optional | No | `30` | `30` | No | OTP resend cooldown | — |
| `OTP_MAX_SENDS_PER_HOUR` | optional | No | `5` | `5` | No | per-phone hourly cap | — |
| `OTP_MAX_SENDS_PER_DAY` | optional | No | `10` | `10` | No | per-phone daily backstop (TD60) | — |
| `OTP_GLOBAL_MAX_SENDS_PER_DAY` | optional | No | `2000` (int ≥0) | `2000` | No | global worker-SMS spend circuit-breaker | **`0` = PAUSED = worker-SMS KILL-SWITCH** (worker OTP is real-only). Redis error → reject (fail-closed). |

### F. Payer auth & email (ZeptoMail / SMTP, real-only)

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `PAYER_LOGIN_METHOD` | optional | No | `email_otp` (enum: email_otp / whatsapp / supabase) | `email_otp` | **Yes** | payer login channel; `assertPayerAuthConfig` | `email_otp` requires a real email provider at boot; `supabase` requires `SUPABASE_URL`+`SUPABASE_SERVICE_ROLE_KEY`; `whatsapp` rides the ADR-0020 mock. Half-config = boot fail. |
| `EMAIL_PROVIDER` | conditional | No | `zeptomail` (enum: zeptomail / smtp / auto) | `zeptomail` | **Yes (when relevant)** | payer email-OTP + member-invite email; `emailProviderBlockedReason` | Real-only (no mock). Relevant when `PAYER_LOGIN_METHOD=email_otp` OR `MEMBER_INVITES_ENABLE_REAL=true` — then the selected provider's creds are required or boot fails. `auto` needs at least one full set. |
| `ZEPTOMAIL_API_URL` | optional | No | `https://api.zeptomail.in/` | (unset) | No | ZeptoMail HTTPS send | Non-secret endpoint; **not** in the required set even for zeptomail. |
| `ZEPTOMAIL_API_TOKEN` | conditional | Yes | `CHANGE_ME_ZEPTOMAIL_API_TOKEN` | (unset) | **Yes** | ZeptoMail send; `assertPayerAuthConfig`/`assertMemberInvitesConfig` | Required when `EMAIL_PROVIDER=zeptomail` (or `auto` with no SMTP) and the email channel is in use. |
| `ZEPTOMAIL_MAIL_AGENT` | conditional | Yes | `CHANGE_ME_ZEPTOMAIL_MAIL_AGENT` | (unset) | **Yes** | ZeptoMail send | Pairs with `ZEPTOMAIL_API_TOKEN`. |
| `ZEPTOMAIL_SANDBOX_MODE` | optional | No | `false` | `false` | No | ZeptoMail sandbox toggle | — |
| `SMTP_HOST` | conditional | Yes | `CHANGE_ME_SMTP_HOST` | (unset) | **Yes** | SMTP transport | Required (with USER/PASS/`EMAIL_FROM_ADDRESS`) when `EMAIL_PROVIDER=smtp` (or `auto` choosing SMTP). |
| `SMTP_PORT` | optional | No | `587` (port 1–65535) | (unset) | No | SMTP transport | — |
| `SMTP_USER` | conditional | Yes | `CHANGE_ME_SMTP_USER` | (unset) | **Yes** | SMTP auth | Required with SMTP set. |
| `SMTP_PASS` | conditional | Yes | `CHANGE_ME_SMTP_PASS` | (unset) | **Yes** | SMTP auth | The SMTP secret. |
| `SMTP_FROM` | optional | No | `otp@badabhai.in` | (unset) | No | SMTP envelope sender | — |
| `EMAIL_FROM_NAME` | optional | No | `BadaBhai` | (unset) | No | rendered From name | Presentation only. |
| `EMAIL_FROM_ADDRESS` | conditional | No | `otp@badabhai.in` (email) | (unset) | **Yes** | both email providers; `emailProviderBlockedReason` | Required by **both** zeptomail and smtp guards when the email channel is relevant. |
| `EMAIL_REPLY_TO` | optional | No | `support@badabhai.in` (email) | (unset) | No | rendered Reply-To | Presentation only. |
| `PAYER_DISCLOSURE_MAX_PER_HOUR` | optional | No | `30` | `30` | No | per-payer disclosure/unlock cap | — |
| `PAYER_AUTH_MAX_PER_IP_PER_HOUR` | optional | No | `20` | `20` | No | unauth payer-auth per-IP cap | — |
| `PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY` | optional | No | `2000` (int ≥0) | `2000` | No | global payer-email spend breaker | **`0` = PAUSED = payer-email KILL-SWITCH.** Payer email is real-only. |
| `PAYER_REACH_MAX_PER_HOUR` | optional | No | `60` | `60` | No | per-payer reach read cap | — |
| `AGENCY_INVITE_MINT_MAX_PER_HOUR` | optional | No | `60` | `60` | No | agency invite-mint cap | — |

### G. Member invites (org)

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `MEMBER_INVITES_ENABLE_REAL` | optional | No | `false` | `false` | **Yes (if true)** | org-invite email gate; `assertMemberInvitesConfig` | OFF → mock mailer (raw token never leaves process). When true, requires the `EMAIL_PROVIDER` creds **and** `MEMBER_INVITE_ACCEPT_URL` or boot fails. |
| `MEMBER_INVITE_ACCEPT_URL` | conditional | No | `https://app.badabhai.in/invite/accept` | (unset) | **Yes** | accept-link builder | Required when `MEMBER_INVITES_ENABLE_REAL`. Raw token appended as `?token=` into the email body only — never logged/evented. |
| `MEMBER_INVITE_MAX_PER_ORG` | optional | No | `25` | `25` | No | per-org non-removed member cap | — |

### H. Admin portal (ADR-0025)

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `ADMIN_JWT_SECRET` | required | Yes | `CHANGE_ME_ADMIN_JWT_SECRET` (≥16, **≠ `JWT_SECRET`**) | `dev-insecure-admin-jwt-secret-change-me` | **Yes** | signs admin session (`typ:admin`); `assertAdminAuthConfig` | Outside dev/test: dev default rejected **and** must **not equal `JWT_SECRET`** (both fail boot). Most-privileged token in the system. |
| `ADMIN_MFA_REQUIRED` | optional | No | `true` (custom coercion: `false/0/no/off/""` = false, else true) | `true` | **Yes (if true w/o issuer)** | admin session-mint MFA gate; `assertAdminAuthConfig` | Defaults **true**. When true, every admin role needs TOTP enrolment **and** `ADMIN_TOTP_ISSUER` non-empty or boot fails (even in dev). Do not disable in prod. |
| `ADMIN_TOTP_ISSUER` | conditional | No | `BadaBhai Admin` | `BadaBhai Admin` | **Yes** | TOTP issuer label; `assertAdminAuthConfig` | Required non-empty when `ADMIN_MFA_REQUIRED`. Has a default, so normally satisfied — explicitly emptying it fails boot. |
| `ADMIN_AUTH_MAX_PER_IP_PER_HOUR` | optional | No | `20` | `20` | No | unauth admin-auth per-IP cap | — |
| `ADMIN_PII_REVEAL_ENABLED` | optional | No | `false` | `false` | No | reason-gated worker-PII reveal master switch (ADMIN-3b) | OFF → neutral 404 (no oracle). Flip only after the ADMIN-3b security review. |
| `ADMIN_PII_REVEAL_MAX_PER_HOUR` | optional | No | `10` | `10` | No | per-admin reveal hourly cap | Checked before decrypt; Redis fail-closed. |
| `ADMIN_PII_REVEAL_MAX_PER_DAY` | optional | No | `30` | `30` | No | per-admin reveal daily cap | — |

### I. Internal service tokens (**three distinct tokens — do not conflate**)

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | required | Yes | `CHANGE_ME_INTERNAL_SERVICE_TOKEN` | (unset; base compose dev literal) | No (runtime deny) | `InternalServiceGuard` (ops resume-PII + signed-URL + ops-unlocks + pricing-write + agency-kyc routes) | **Runtime fail-closed:** unset → those routes deny ALL callers (401). **Must byte-match `apps/web`** (ops console sends `x-internal-service-token`). Service-to-service, not per-worker identity. |
| `SKILLS_INTERNAL_TOKEN` | conditional | Yes | `CHANGE_ME_SKILLS_INTERNAL_TOKEN` | (unset) | No (runtime deny) | `SkillsInternalGuard` (`POST /internal/skills/nearest-aliases` + `/unresolved`) | Least-privilege, **distinct** from `INTERNAL_SERVICE_TOKEN`. **Must match `apps/ai-service`** (ai→api direction). Unset → skills routes deny all. Required only if skill canonicalization is armed. |
| `AI_INTERNAL_TOKEN` | conditional | Yes | `CHANGE_ME_AI_INTERNAL_TOKEN` (**≥16**) | (unset) | **Yes (if present-but-short)** | `AiService.forward` adds `x-ai-internal-token`; enforced by ai-service on every route but `/health` | api→ai direction. Schema `.min(16)` → a **set** short/empty value fails parse. Unset keeps today's open internal posture. **Both-or-neither** across api + ai-service; a half-flip 401s every api→ai call and silently degrades to mock. Never write an empty `AI_INTERNAL_TOKEN=`. |

### J. AI routing & cost — **declarative on the Node side** (real consumption is in ai-service)

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `GEMINI_FLASH_API_KEY` | conditional | Yes | `CHANGE_ME_GEMINI_FLASH_API_KEY` | (unset) | No (falls back to mock) | `realAiCallsBlockedReason` master gate (Node); the actual caller is ai-service | Declarative here; **does not fail boot** — absence with `AI_ENABLE_REAL_CALLS=true` falls back to MOCK. Must also be present in `apps/ai-service`. |
| `ANTHROPIC_API_KEY` | optional | Yes | `CHANGE_ME_ANTHROPIC_API_KEY` | (unset) | No | AI fallback chain (Claude Haiku) | Never a master gate — presence only **adds** the fallback provider. |
| `LITELLM_API_KEY` | optional | Yes | (same as `GEMINI_FLASH_API_KEY`) | (unset) | No | `realAiCallsBlockedReason` (deprecated alias) | **DEPRECATED (TD28)** back-compat alias for `GEMINI_FLASH_API_KEY` for one release. Prefer the new name — do not treat as a distinct secret. |
| `GEMINI_API_KEY` | optional | Yes | (unused) | (unset) | No | legacy declaration, **unused** by the Node API | Third name in the Gemini naming drift — ai-service uses `GEMINI_FLASH_API_KEY`. Leave unset. |
| `AI_ENABLE_REAL_CALLS` | optional | No | `false` | `false` | No | `realAiCallsBlockedReason` (invariant #5) | Default OFF. Real calls need this flag **and** a key; otherwise MOCK. No boot assert. **Must match `apps/ai-service`.** §2/§5: staging-first. |
| `DEFAULT_CHEAP_MODEL` | optional | No | `gemini-2.5-flash-lite` (bare id, no prefix) | `gemini-2.5-flash-lite` | No | model routing (declarative) | — |
| `DEFAULT_CAPABLE_MODEL` | optional | No | `gemini-2.5-flash` | `gemini-2.5-flash` | No | model routing (declarative) | — |
| `AI_COST_ALERT_PROFILE_INR` | optional | No | `6` | `6` | No | cost-alert guardrail | — |
| `AI_TARGET_PROFILE_COST_INR` | optional | No | `4` | `4` | No | target cost guardrail | — |
| `AI_MAX_CALL_COST_INR` | optional | No | `10` | `10` | No | hard per-call spend ceiling | Worst-case > this → refuse, fall back to mock. |
| `GOOGLE_CLOUD_PROJECT` | optional | No | (legacy) | (unset) | No | legacy GCP declaration, unused by Node | — |
| `GOOGLE_CLOUD_LOCATION` | optional | No | (legacy) | (unset) | No | legacy GCP declaration, unused by Node | — |
| `SARVAM_API_KEY` | optional | Yes | `CHANGE_ME_SARVAM_API_KEY` | (unset) | No | STT (Sarvam) placeholder | Real STT is §7-deferred; declarative here. **Real consumer is ai-service.** |
| `LANGFUSE_PUBLIC_KEY` | optional | No | `pk-lf-...` | (unset) | No | Langfuse observability (placeholder) | Pairs with the secret key. |
| `LANGFUSE_SECRET_KEY` | optional | Yes | `CHANGE_ME_LANGFUSE_SECRET_KEY` | (unset) | No | Langfuse observability (placeholder) | — |
| `LANGFUSE_BASE_URL` | optional | No | `https://cloud.langfuse.com` | `https://cloud.langfuse.com` | No | Langfuse endpoint | — |

### K. Payments (Razorpay) — launch-gated

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `PAYMENTS_ENABLE_REAL` | optional | No | `false` | `false` | **Yes (if true)** | `assertPaymentsConfig`; gateway/webhook | OFF → mock credits. When true, **all three** Razorpay secrets required or boot fails. **Must match `apps/payer-web`.** Human-gated, staging-first (§7). |
| `PAYMENTS_PROVIDER_KEY` | conditional | No (**public by design**) | `rzp_live_CHANGE_ME` | (unset) | **Yes (if payments real)** | `getRazorpayCredentials`; browser checkout | The rzp_ key **id**, handed to the browser on the order response (not via a `NEXT_PUBLIC_` var). `.min(1)` → blank counts as missing. |
| `PAYMENTS_PROVIDER_SECRET` | conditional | Yes | `CHANGE_ME_PAYMENTS_PROVIDER_SECRET` | (unset) | **Yes (if payments real)** | order signing + checkout-signature HMAC | **Server-only** — never in a body/log/event/`NEXT_PUBLIC`. |
| `RAZORPAY_WEBHOOK_SECRET` | conditional | Yes | `CHANGE_ME_RAZORPAY_WEBHOOK_SECRET` | (unset) | **Yes (if payments real)** | webhook HMAC (capture source of truth) | **Separate** from the key secret. Without it, captures only land via browser fallback (dropped connection = paid-but-not-credited). |

### L. Push (FCM, ADR-0034) — launch-gated

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `PUSH_ENABLE_REAL` | optional | No | `false` | `false` | **Yes (if true)** | `assertPushConfig` | OFF → mock provider. When true, FCM creds required or boot fails. |
| `FCM_SERVICE_ACCOUNT_B64` | conditional | Yes | `CHANGE_ME_FCM_SERVICE_ACCOUNT_B64` (base64 of Firebase SA JSON w/ `client_email`+`private_key`) | (unset) | **Yes — validated whenever supplied, even with push off** | `getFcmServiceAccount`; `assertPushConfig` | Base64 keeps the PEM a single token through CI. **Malformed → boot throw even with `PUSH_ENABLE_REAL` off** (TD67 "half-armed secret must be loud"). Required when push real. |
| `FCM_PROJECT_ID` | conditional | No | `badabhai-prod` | (unset) | **Yes (if push real)** | `assertPushConfig` | Identifier. |
| `PUSH_GLOBAL_MAX_SENDS_PER_DAY` | optional | No | `5000` (int ≥0) | `5000` | No | push global daily ceiling + kill-switch | **`0` = PAUSED = halt every push.** Security-type pushes are **exempt** from the numeric ceiling. |
| `PUSH_TOKEN_UPDATES_PER_IP_PER_HOUR` | optional | No | `30` | `30` | No | `PATCH /auth/devices/me/push-token` per-IP cap | Fail-closed. |

### M. Messaging (WhatsApp, ADR-0020) — launch-gated

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `MESSAGING_ENABLE_REAL` | optional | No | `false` | `false` | **Yes (if true)** | `assertMessagingConfig` | OFF → WhatsApp MOCK (phone never leaves to Meta). When true, WhatsApp creds required or boot fails. |
| `WHATSAPP_API_KEY` | conditional | Yes | `CHANGE_ME_WHATSAPP_API_KEY` | (unset) | **Yes (if messaging real)** | `MetaWhatsAppProvider`; `assertMessagingConfig` | Unused in alpha (mock). Root-env loader skips blank values. |
| `WHATSAPP_PHONE_NUMBER_ID` | conditional | No | `1234567890` | (unset) | **Yes (if messaging real)** | `MetaWhatsAppProvider`; `assertMessagingConfig` | Opaque Meta identifier. |

### N. Contact unlock & payer capacity

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY` | optional | No | `5` | `5` | No | contact-unlock chokepoint (ADR-0010) | — |
| `UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK` | optional | No | `10` | `10` | No | contact-unlock chokepoint | — |
| `UNLOCK_MAX_ATTEMPTS_PER_UNLOCK` | optional | No | `3` | `3` | No | contact-unlock chokepoint | — |
| `UNLOCK_LATENCY_TARGET_MS` | optional | No | `1000` (int ≥0) | `1000` | No | neutral-deny latency normalisation | `0` disables padding. |
| `CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES` | optional | No | `1` (int ≥0) | `1` | No | payer-capacity chokepoint default (ADR-0016) | `0` = a new payer holds zero active plans until they buy capacity. |
| `CAPACITY_ENFORCEMENT_ENABLED` | optional | No | `false` | `false` | No | `isCapacityEnforcementEnabled` | OFF → SHADOW/inert (computes would-pause, never pauses). |

### O. Agency payouts (ADR-0022 Amdt 2) — launch-gated

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `AGENCY_PAYOUTS_ENABLED` | optional | No | `false` | `false` | No | agency payout/earnings routes | OFF → neutral 404, no accrual. MOCK throughout — real money stays behind `PAYMENTS_ENABLE_REAL` + §7 legal/DPDP. |
| `AGENCY_PAYOUT_UNLOCK_BASIS_INR` | optional | No | `40` | `40` | No | commission accrual (stamped per row) | — |
| `AGENCY_PAYOUT_RATE_BPS` | optional | No | `2500` (≤10000) | `2500` | No | commission rate (25%) | — |
| `AGENCY_PAYOUT_WINDOW_DAYS` | optional | No | `90` | `90` | No | first-touch attribution window | — |
| `AGENCY_PAYOUT_MIN_THRESHOLD_INR` | optional | No | `500` | `500` | No | minimum requestable payout | — |

### P. PACE supply-widening (ADR-0021) — launch-gated

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `PACE_ENABLED` | optional | No | `false` | `false` | No | `isPaceEnabled` | Master switch, OFF = inert. Widen decision is pure config (no LLM, invariant #4). |
| `PACE_THIN_SUPPLY_MIN` | optional | No | `3` | `3` | No | thin-supply threshold | — |
| `PACE_AREA_STEP_KM` | optional | No | `15` | `15` | No | per-wave travel-band step | — |
| `PACE_MAX_AREA_KM` | optional | No | `75` | `75` | No | travel-band ceiling | — |
| `PACE_WAVE_INTERVAL_HOURS` | optional | No | `6` | `6` | No | widen-wave cadence | — |
| `PACE_OPS_ALERT_AFTER_HOURS` | optional | No | `24` | `24` | No | thin-supply ops-alert threshold | — |
| `PACE_ADJACENCY_ENABLED` | optional | No | `false` | `false` | No | `isPaceAdjacencyEnabled` | No-op until a ratified `ADJACENT_ROLES` map exists. |

### Q. Matching V1 & chat

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `MATCH_V1_ENABLED` | optional | No | `false` | `false` | No | `isMatchV1Enabled` (ADR-0036) | **Deploy switch** selecting legacy `jobs` vs `job_reach` source. OFF is the only safe default until the 0052–0058 migration train + D1–D6 data steps run (else the feed is empty). All tunables live in the `match_config` DB row, not env. |
| `CHAT_ONE_SHOT_OPENER_ENABLED` | optional | No | `false` | `false` | No | `POST /chat/session` opener seam | OFF → byte-identical to today (no outbound call on chat mount). |

### R. Resume / interview-kit / photo / referral caps & retention

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `RESUME_DAILY_CAP` | optional | No | `5` | `5` | No | resume abuse cap (per worker/UTC day) | — |
| `RESUME_GLOBAL_DAILY_CAP` | optional | No | `5000` | `5000` | No | resume global daily backstop | — |
| `RESUME_SIGNED_URL_TTL_SECONDS` | optional | No | `900` | `900` | No | signed download-URL mint | — |
| `RESUME_RATE_LIMIT_PER_IP_PER_HOUR` | optional | No | `20` | `20` | No | resume download per-IP cap | HMAC-hashed IP; Redis outage → 429 fail-closed. |
| `INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR` | optional | No | `20` | `20` | No | interview-kit download per-IP cap | — |
| `PHOTO_RATE_LIMIT_PER_IP_PER_HOUR` | optional | No | `20` | `20` | No | photo upload-url mint cap (ADR-0032) | — |
| `REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR` | optional | No | `20` | `20` | No | `POST /referrals/attribute` per-IP cap | — |
| `REFERRAL_CLICK_MAX_PER_IP_PER_HOUR` | optional | No | `600` | `600` | No | public `POST /invites/:code/click` cap | Deliberately high (shares payer-web egress IP). Over-cap sheds with a neutral body. |
| `INTERVIEW_KIT_CONTENT_VERSION` | optional | No | `1` | `1` | No | interview-kit render-once identity | **Bump on any kit copy change**; never reuse an old value. |
| `ACCOUNT_DELETION_COOLDOWN_SECONDS` | optional | No | `604800` (int ≥0) | `604800` | No | re-registration cool-down (Redis, phone_hash) | `0` disables. **Fail-open by design** (anti-abuse, never auth). |
| `ACCOUNT_DELETION_GRACE_DAYS` | optional | No | `7` | `7` | No | pre-erasure grace window (ADR-0031) | `positive()` — `0` would break the "7 din" promise, so it must be a code change, not an env value. |
| `ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS` | optional | No | `1` (fractional ok) | `1` | No | deletion sweep cadence | DB marker is authoritative. |
| `AI_JOBS_RETENTION_DAYS` | optional | No | `90` | `90` | No | `ai_jobs` retention prune predicate (PERF-3) | Terminal rows only; never touches queued/running or profile-referenced rows. |
| `AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS` | optional | No | `24` (fractional ok) | `24` | No | retention sweep tick cadence | — |
| `AI_JOBS_RETENTION_DELETE_ENABLED` | optional | No | `false` | `false` | No | retention sweep dry-run gate | OFF → sweep logs candidates, deletes nothing. Flip to arm real deletion. |

---

## `apps/ai-service` — FastAPI (Pydantic `Settings`, its **own** env)

Case-insensitive: each lower-snake field maps to the UPPER_SNAKE env var. `env_file` is anchored to `apps/ai-service/.env` (AI-ENV-1), never CWD. `extra="ignore"` — foreign vars (e.g. the API's `REDIS_URL`) can never reach these Settings. **Only two vars refuse to boot** (`AI_INTERNAL_TOKEN`, `AI_SPEND_REDIS_URL`); everything else boots on its default, so a mock-only service with **zero** env is a valid, deliberate state.

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `AI_ENABLE_REAL_CALLS` | optional | No | `false` | `false` | No (runtime → mock) | `real_calls_blocked_reason()` | Master real-call gate. Needs **both** this true **and** `GEMINI_FLASH_API_KEY`. **Must match `apps/api`.** |
| `AI_REAL_CALL_TASKS` | optional | No | `profile_extraction,skill_embedding` (comma-sep TaskTypes) | `""` (empty) | No | `real_call_enabled_for(task_type)` | ⚠ **EMPTY = ALL TASKS** (most permissive, back-compat). A non-empty value is an **allowlist** restricting real calls to the listed tasks. Master flag + key still required regardless. |
| `AI_REAL_CALLS_KILL_SWITCH` | optional | No | `false` | `false` | No | `real_calls_blocked_reason()` (checked **first**) | Independent HARD kill (TD27). Checked before the flag/key → disables real calls regardless of `AI_ENABLE_REAL_CALLS`. The single-flag emergency abort. |
| `AI_PROFILING_REPHRASE_ENABLED` | optional | No | `false` | `false` | No | profiling-chat rephrase path (COST-4) | OFF → deterministic question-bank question, **zero** output tokens. Known MEDIUM: dormant rephrase phrases the ADVANCED question, not the confusing one — fix before flipping ON. |
| `GEMINI_FLASH_API_KEY` | conditional | Yes | `CHANGE_ME_GEMINI_FLASH_API_KEY` | (None) | No (runtime → mock) | `router.py`/`llm.py` (Gemini); `real_calls_blocked_reason()` | **Primary real-call credential + master key-gate.** Optional so mock mode boots. **Must match `apps/api`'s copy.** |
| `ANTHROPIC_API_KEY` | optional | Yes | `CHANGE_ME_ANTHROPIC_API_KEY` | (None) | No | router fallback chain | Fallback (Claude Haiku) only, **not** a master gate. Adds Claude only if the `anthropic` SDK is importable. |
| `DEFAULT_CHEAP_MODEL` | optional | No | `gemini-2.5-flash-lite` | `gemini-2.5-flash-lite` | No | chat-turn model | Real Gemini id so a no-.env service resolves a valid model. |
| `DEFAULT_CAPABLE_MODEL` | optional | No | `gemini-2.5-flash` | `gemini-2.5-flash` | No | strict-JSON extraction model | **Pinned prod extraction model** (ADR-0008 "capable"); default == gold-set validation model. |
| `DEFAULT_FALLBACK_MODEL` | optional | No | `claude-haiku-4-5` (bare, no date) | `claude-haiku-4-5` | No | cross-provider fallback | Only after Gemini fails AND `ANTHROPIC_API_KEY` set AND provider differs. |
| `EMBEDDING_MODEL` | optional | No | `gemini-embedding-001` | `gemini-embedding-001` | No | skill-embedding path (TAX-3) | Must output 768-dim (L2-normalized). `text-embedding-004` is retired. |
| `SKILL_CANONICALIZE_ENABLED` | optional | No | `false` | `false` | No | extraction canonicalization (TAX-4) | Wiring flag. Also needs `BACKEND_API_URL` + `SKILLS_INTERNAL_TOKEN` (else `NullSkillStore`, inert) — TD65 store+flag. |
| `SKILL_CANONICALIZE_FLOOR` | optional | No | `0.75` (cosine 0–1) | `0.75` | No | canonicalization matcher | Calibrated on real `gemini-embedding-001@768`. Re-sweep on any corpus/model change; never hand-tune. |
| `SKILL_CANONICALIZE_TOP_K` | optional | No | `5` | `5` | No | nearest-alias fetch | — |
| `SKILL_CANONICALIZE_DEFAULT_DOMAIN` | optional | No | `cnc-machining` | `cnc-machining` | No | anchor-domain path | — |
| `SKILL_GROWTH_MIN_CLUSTER_SIZE` | optional | No | `2` | `2` | No | `/growth/cluster` (report-only) | Tunes what is *proposed* to a human, never what activates. |
| `SKILL_GROWTH_MIN_TOTAL_COUNT` | optional | No | `3` | `3` | No | `/growth/cluster` | — |
| `SKILL_GROWTH_CLUSTER_THRESHOLD` | optional | No | `0.80` (cosine 0–1) | `0.80` | No | leader clustering | — |
| `SKILL_GROWTH_BAND_LOW` | optional | No | `0.60` (cosine 0–1) | `0.60` | No | proposal banding | band_low..floor = near-skill; below = provisional-skill. |
| `BACKEND_API_URL` | conditional | No | `https://api.internal.badabhai.in` | (None) | No | `HttpSkillStore` | Required **with** `SKILLS_INTERNAL_TOKEN` to arm canonicalization; both unset → `NullSkillStore`. ai-service stays DB-free. |
| `SKILLS_INTERNAL_TOKEN` | conditional | Yes | `CHANGE_ME_SKILLS_INTERNAL_TOKEN` | (None) | No | `HttpSkillStore` (ai→api skills routes) | Scoped, least-privilege — **not** the api's broad token. **Must match `apps/api`.** Distinct from `AI_INTERNAL_TOKEN` (reverse direction). |
| `AI_INTERNAL_TOKEN` | optional | Yes | `CHANGE_ME_AI_INTERNAL_TOKEN` (**min 16**) | (None) | **Yes** | route guard — every route but `/health` requires exact match in `x-ai-internal-token` (timing-safe) | `Field(min_length=16)` → an **empty** (`AI_INTERNAL_TOKEN=`) or short value **fails `Settings()` at startup** (never arms the gate vacuously). None (unset) keeps the open internal posture. **Must match `apps/api`; set both or neither.** |
| `AI_COST_ALERT_PROFILE_INR` | optional | No | `6.0` | `6.0` | No | `cost_tracker.py` | Alerting only. |
| `AI_TARGET_PROFILE_COST_INR` | optional | No | `4.0` | `4.0` | No | `cost_tracker.py` | Informational target. |
| `AI_MAX_CALL_COST_INR` | optional | No | `10.0` | `10.0` | No | hard per-call ceiling | Worst-case > this → refuse (fall back to mock). Also bounds each STT chunk. |
| `AI_MAX_DAILY_COST_INR` | optional | No | `200.0` | `200.0` | No | `SpendLedger` rolling per-UTC-day cap | Per-process when `AI_SPEND_REDIS_URL` unset; global (by UTC day) when set. |
| `AI_MAX_TOTAL_COST_INR` | optional | No | `1000.0` | `1000.0` | No | `SpendLedger` lifetime cumulative cap | — |
| `AI_MAX_USER_DAILY_COST_INR` | optional | No | `6.0` | `6.0` | No | `SpendLedger` per-user per-UTC-day cap (opaque `worker_ref`) | Bounds all real AI spend for one worker/day. PII-free key. |
| `AI_RETRY_BUDGET_PER_WINDOW` | optional | No | `20` | `20` | No | retry budget | Max retry attempts across all requests in the window. Stays per-process even with the Redis ledger. |
| `AI_RETRY_BUDGET_WINDOW_SECONDS` | optional | No | `60` | `60` | No | retry budget window | — |
| `AI_SPEND_REDIS_URL` | optional | Yes | `rediss://:CHANGE_ME@HOST:6379` (redis:// / rediss:// / unix://) | (None) | **Yes (if present-but-wrong-scheme)** | `SpendLedger` backend | ⚠ **Renamed from `REDIS_URL` (AI-ENV-1 hard cut, no alias)** — the api's `REDIS_URL` is incompatible and can't reach here. Unset/`""` → in-process (per-replica) caps. Malformed non-empty value raises `ConfigError` at `Settings()` (not `ValueError`, so no credential echo). Set for a shared, globally-enforced, fail-closed ledger before adding uvicorn workers. |
| `SARVAM_API_KEY` | conditional | Yes | `CHANGE_ME_SARVAM_API_KEY` | (None) | No | `stt.py` / `translate.py` | Needed for real STT/translate; §7-deferred, off by default. Absence → mock/fallback. |
| `SARVAM_STT_MODEL` | optional | No | `saarika:v2.5` | `saarika:v2.5` | No | `stt.py` | — |
| `SARVAM_STT_COST_INR_PER_CHUNK` | optional | No | `0.25` (per ≤30s chunk) | `0.25` | No | STT reserve→reconcile | Estimate (~₹30/hr). Calibrate against the invoice at the §7 real-Sarvam flip. |
| `SARVAM_TRANSLATE_MODEL` | optional | No | `mayura:v1` | `mayura:v1` | No | `translate.py` | Required for auto-detect + code-mixed Hinglish. |
| `SUPABASE_URL` | conditional | No | `https://<ref>.supabase.co` | (None) | No (real STT fails closed to empty) | `stt.py` Storage GET; `storage_configured` | Required (**with** the key) for real STT to fetch voice audio. **Same value as `apps/api`.** |
| `SUPABASE_SERVICE_ROLE_KEY` | conditional | Yes | `CHANGE_ME_SUPABASE_SERVICE_ROLE_KEY` | (None) | No | `stt.py` Storage GET; `storage_configured` | Bypasses RLS; never logged. **Same value as `apps/api`.** |
| `VOICE_NOTES_BUCKET` | optional | No | `worker-voice-notes` | `worker-voice-notes` | No | `stt.py` Storage fetch | ⚠ **Different default from `apps/api`** (which defaults empty/dormant). Must exist **private** out-of-band. |
| `LANGFUSE_PUBLIC_KEY` | optional | No | `pk-lf-...` | (None) | No | tracing; `langfuse_enabled` | Tracing off unless **both** keys present. |
| `LANGFUSE_SECRET_KEY` | optional | Yes | `CHANGE_ME_LANGFUSE_SECRET_KEY` | (None) | No | tracing; `langfuse_enabled` | — |
| `LANGFUSE_BASE_URL` | optional | No | `https://cloud.langfuse.com` | `https://cloud.langfuse.com` | No | tracing endpoint | — |
| `AI_SERVICE_PORT` | optional | No | `8000` | `8000` | No | uvicorn/service bind | — |

> `AI_EVAL_BASE_URL` is **not** an app-runtime var — it exists only in the test/eval harness (`tests/`), not `app/`. Excluded here by design.

---

## `apps/web` — Next.js ops console (read-only, server-rendered)

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | required | Yes | `CHANGE_ME_INTERNAL_SERVICE_TOKEN` (same value as the API's) | `""` | No (**silent-at-boot, total-at-runtime** if wrong) | `opsHeaders()` — attaches `x-internal-service-token` on every ops call | **Server-only**, read raw from `process.env` (not in any Zod schema, never inlined into the client bundle). **Must byte-match `apps/api`'s `InternalServiceGuard`** or **every ops route 401s** (whole console shows its error state). Single point of total-ops-outage. |
| `NEXT_PUBLIC_API_URL` | optional | No | `https://api.badabhai.in` | `http://localhost:3001` | No (invalid URL throws at import; missing OK) | `publicEnvSchema` → fetch base URL + footer | Browser-exposed, non-secret. Forgotten value silently falls back to localhost. |
| `NEXT_PUBLIC_ENVIRONMENT` | optional | No | `production` (enum) | `development` | No (out-of-enum throws at import) | footer label | Display only. |
| `NODE_ENV` | optional | No | `production` (enum) | `development` (fail-open) | No | `nodeEnvSchema` in `publicEnvSchema`; standard Next var | Part of the public schema; out-of-enum throws at import. Never gate a security shortcut on the parsed value. |

---

## `apps/payer-web` — Next.js payer/agency portal (external)

Only the three `publicEnvSchema` vars (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ENVIRONMENT`, `NODE_ENV`) fail-closed **at import** on an *invalid* value; all have safe defaults so *missing* is fine. Every server-side var is a plain guarded read with a default (no boot refusal). **No secret is exposed via any `NEXT_PUBLIC_` var** — the Razorpay key id reaches the browser only on the order response, never a build value.

| Variable | Required | Secret? | Format / example | Default | Fail-closed at boot? | Consumed by | Notes |
|---|---|---|---|---|---|---|---|
| `PAYER_API_URL` | required (staging/prod) | No | `https://api.internal.badabhai.in` | `http://localhost:3001` | No (localhost default) | `payerServerConfig().apiBaseUrl` (server-only) | **The server-side API base** the portal's route handlers/actions call. Deliberately **not** `NEXT_PUBLIC_` so the browser never learns the internal origin. Missing prod value silently points at localhost. |
| `NEXT_PUBLIC_API_URL` | optional | No | `https://api.badabhai.in` | `http://localhost:3001` | Yes (invalid URL throws at import) | public bundle fetch base; invite-landing fallback | Browser base URL. Distinct from `PAYER_API_URL` (invite-landing prefers `PAYER_API_URL`, falls back to this). |
| `NEXT_PUBLIC_ENVIRONMENT` | optional | No | `production` (enum) | `development` | Yes (out-of-enum throws) | footer; secure-cookie signal | `staging`/`production` forces the payer session cookie to `Secure`. |
| `NODE_ENV` | optional | No | `production` (enum) | `development` | No | secure cookie; `isDevEnv()`; assert-no-agency-pii; public schema | `production` → Secure cookie + `isDevEnv()` false (dev org-role override dead). |
| `PAYMENTS_ENABLE_REAL` | conditional | No | `false` / `true` | `false` | No (**read flag, no longer a boot assert**) | `payerServerConfig().paymentsEnableReal` | Now a read flag (it previously threw, making the shared-env gate un-flippable). Unset/garbage → mock top-up. **Must match `apps/api`'s flag** (shared env). Real Razorpay secrets live only in `apps/api`. |
| `NEXT_PUBLIC_SITE_URL` | optional | No | `https://app.badabhai.in` | (unset → `window.location.origin`) | No | agency QR-invite poster origin; secure-cookie signal | Only `new URL(...).origin` (http/https) is taken. |
| `NEXT_PUBLIC_WORKER_APP_ID` | optional | No | `in.badabhai.worker` (Android package id) | `in.badabhai.worker` | No | Play Store install URL on `/i/<code>` landing | A wrong id 404s referred workers on the Play Store. Differs between internal-test and prod tracks. |
| `NEXT_PUBLIC_PAYER_THEME` | optional | No | `paper` / `ink` (else `system`) | (unset) | No | `envThemeDefault()`; SSR baseline | Back-compat mirror of server `PAYER_THEME` (server wins). Cookie `bb_theme` overrides both. |
| `PAYER_THEME` | optional | No | `paper` / `ink` | (unset) | No | `envThemeDefault()` | Server-side theme default; precedence over `NEXT_PUBLIC_PAYER_THEME`. |
| `NEXT_PUBLIC_ENABLE_AGENCY_PORTAL` | optional | No | `true` / `false` (only literal `true` enables) | `true` | No | `agencyFlags()` | The **only** agency flag defaulting ON — gates the agency demand shell; off → `notFound()`. |
| `NEXT_PUBLIC_ENABLE_AGENCY_SUPPLY` | optional | No | `true` / `false` | `false` | No | `agencyFlags()` | Label-only, PARKED Phase-2 (CEO-gated). Public mirror of server `AGENCY_SUPPLY_ENABLED`. |
| `AGENCY_SUPPLY_ENABLED` | optional | No | `true` / `false` | `false` | No | `payerServerConfig().agencySupplyEnabled` (server-only) | Server twin of the above; label-only. |
| `NEXT_PUBLIC_ENABLE_AGENCY_KYC` | optional | No | `true` / `false` | `false` | No | `agencyFlags()` | Label-only, PARKED (legal/DPDP-gated). |
| `NEXT_PUBLIC_ENABLE_AGENCY_PAYOUTS` | optional | No | `true` / `false` | `false` | No | `agencyFlags()` | Label-only, PARKED (real money out, TD34). |
| `NEXT_PUBLIC_ENABLE_AGENCY_BULK_UPLOAD` | optional | No | `true` / `false` | `false` | No | `agencyFlags()` | Marked **DEAD** (bulk raw-phone/CSV = consent violation). Keep off. |
| `NEXT_PUBLIC_ENABLE_AGENCY_OUTCOME_TRACKING` | optional | No | `true` / `false` | `false` | No | `agencyFlags()` | Label-only, DEFERRED. |
| `PAYER_POSTING_FREE_THROUGH_LAUNCH` | optional | No | `true` / `false` (only literal `false` disables) | `true` | No | `postingIsFreeThroughLaunch()` | **Inverse polarity** — default true (free); only `false` switches to paid-tier display copy. Backend still resolves price server-side. |
| `PAYER_LOW_BALANCE_THRESHOLD` | optional | No | `5` (non-negative int) | `5` | No | `lowBalanceThreshold()` | Display-only nudge. |
| `PAYER_CREDIT_VALIDITY_MONTHS` | optional | No | `12` (positive int) | `12` | No | `creditValidityMonths()` | Display-only. |
| `PAYER_DEV_ORG_ROLE` | optional | No | `owner` / `recruiter` | (unset → recruiter) | No | `getOrgRole()` | **DEV-ONLY** preview override; honored only when `isDevEnv()`, **ignored in staging/production** (fails closed to recruiter). Do not set in prod. |
| `VERCEL_URL` | optional | No | (platform-injected host, no scheme) | (unset) | No | `shouldUseSecureCookie()` | Vercel-injected; https deploy host = Secure-cookie signal. Absent on non-Vercel deploys. |

---

## Flutter apps (`apps/worker-app`, `apps/payer-app`) — no `.env`

The Flutter clients are **compile-time configured**, not `.env`-driven. There is no runtime environment file for an operator to set: build-time constants (e.g. `kPersistentAuth`, the API base URL, the Android package/application id) are baked into the build via Dart defines / Gradle config at CI time. Nothing in this manifest applies to them. The one operator-relevant coupling is `NEXT_PUBLIC_WORKER_APP_ID` on `apps/payer-web`, which must equal the worker app's published Play Store application id (`in.badabhai.worker` on the prod track) so referral install links resolve.

---

## 🚫 Boot-blocking (fail-closed) — set these **first**, wrong = the process crashes on startup

**Unconditional (crash boot in prod every time if missing/dev-default/malformed):**

- `apps/api`: `PII_HASH_PEPPER`, `PII_ENCRYPTION_KEY`, `JWT_SECRET`, `PIN_PEPPER`, `ADMIN_JWT_SECRET` (must also **≠ `JWT_SECRET`**), `SMS_PROVIDER` (must be literal `fast2sms`), `FAST2SMS_API_KEY`, `FAST2SMS_SENDER_ID`, `FAST2SMS_DLT_TEMPLATE_ID`, `AUTH_REFRESH_TTL_DAYS` (must be `≥ AUTH_SESSION_ABSOLUTE_MAX_DAYS`).
- `apps/api` MFA (defaults are set, but emptying them under the default `ADMIN_MFA_REQUIRED=true` crashes boot): `ADMIN_MFA_REQUIRED`, `ADMIN_TOTP_ISSUER`.

**Conditional (crash boot only when the named flag/method is active):**

- `PAYER_LOGIN_METHOD=supabase` → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- `PAYER_LOGIN_METHOD=email_otp` **or** `MEMBER_INVITES_ENABLE_REAL=true` → `EMAIL_PROVIDER` creds: (`ZEPTOMAIL_API_TOKEN` + `ZEPTOMAIL_MAIL_AGENT`) **or** (`SMTP_HOST` + `SMTP_USER` + `SMTP_PASS`), plus `EMAIL_FROM_ADDRESS`.
- `MEMBER_INVITES_ENABLE_REAL=true` → also `MEMBER_INVITE_ACCEPT_URL`.
- `PAYMENTS_ENABLE_REAL=true` → `PAYMENTS_PROVIDER_KEY` + `PAYMENTS_PROVIDER_SECRET` + `RAZORPAY_WEBHOOK_SECRET`.
- `PUSH_ENABLE_REAL=true` → `FCM_SERVICE_ACCOUNT_B64` + `FCM_PROJECT_ID`. **`FCM_SERVICE_ACCOUNT_B64` is validated whenever supplied even with push OFF** — a mangled value crashes boot.
- `MESSAGING_ENABLE_REAL=true` → `WHATSAPP_API_KEY` + `WHATSAPP_PHONE_NUMBER_ID`.
- `TEST_LOGIN_ENABLED=true` → crashes boot unless `NODE_ENV` is explicitly development/test/staging **and** `TEST_LOGIN_TOKEN` ≥32. **Keep it off in prod.**
- Keyring (opt-in): `PII_ENCRYPTION_KEYS` + `PII_ENCRYPTION_ACTIVE_KID` — validated fail-closed in **every** env when either is set.
- Schema parse (any env, when set): `AI_INTERNAL_TOKEN` (<16 fails), `TEST_LOGIN_TOKEN` (<32 fails), `PII_ENCRYPTION_KEY` (non-32-byte base64 fails), `API_PORT`/`SMTP_PORT` (out-of-range fails).

**`apps/ai-service` (only two):** `AI_INTERNAL_TOKEN` (present-but-`<16` fails `Settings()`), `AI_SPEND_REDIS_URL` (present-but-not `redis://`/`rediss://`/`unix://` raises `ConfigError`).

**Compose/CD interpolation guards (crash the deploy command, not the app):** `API_IMAGE`, `AI_SERVICE_IMAGE` (`${VAR:?}`, fail the whole overlay before profile filter).

> Vars that **boot fine on a dev default but are still must-set for a correct prod deploy** (no boot guard): `DATABASE_URL`, `REDIS_URL`, `AI_SERVICE_URL`, `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY_HOP_COUNT`, `PAYER_API_URL`. Set these deliberately — a forgotten value silently uses localhost / denies all CORS / collapses per-IP throttling.

---

## 🔗 Must match across services (same value on both sides, or the call 401s / silently mocks)

1. **`INTERNAL_SERVICE_TOKEN`** — `apps/api` (`InternalServiceGuard` enforces) **=** `apps/web` ops console (sends `x-internal-service-token`). Mismatch → every ops route 401s.
2. **`SKILLS_INTERNAL_TOKEN`** — `apps/ai-service` (sends `x-skills-internal-token`) **=** `apps/api` (`SkillsInternalGuard` enforces). Direction ai→api; scoped least-privilege.
3. **`AI_INTERNAL_TOKEN`** — `apps/api` (sends) **=** `apps/ai-service` (enforces on every route but `/health`). Direction api→ai. **Both-or-neither, ≥16 chars**; a half-flip 401s every api→ai call and silently degrades AI to mock (TD81 failure class). Never write it as an empty string on either side (crash-loops both).
4. **`GEMINI_FLASH_API_KEY`** — `apps/api` (declarative master-gate check) **=** `apps/ai-service` (the actual Gemini caller). The Node API forwards to ai-service; ai-service needs its own copy of the same key.
5. **`SUPABASE_URL`** — `apps/api` (Storage) **=** `apps/ai-service` (STT Storage GET). Same project.
6. **`SUPABASE_SERVICE_ROLE_KEY`** — `apps/api` **=** `apps/ai-service`. Same project.
7. **`AI_ENABLE_REAL_CALLS`** — `apps/api` **=** `apps/ai-service`. The Node side gates declaratively; ai-service enforces the real path — keep them consistent.
8. **`PAYMENTS_ENABLE_REAL`** — `apps/api` (enforces + asserts boot) **=** `apps/payer-web` (reads to choose mock vs real checkout). Shared env; keep in lockstep.
9. **`DATABASE_URL`** — `apps/api` **=** the migration/`db:migrate` runner env. Same connection string.
10. **`NODE_ENV`** — set to `production` consistently across `apps/api`, `apps/ai-service` behavior expectations, `apps/web`, `apps/payer-web`.

**Cross-name landmines — these are NOT the same var (never copy one value into the other):**

- `REDIS_URL` (api: mandatory infra — sessions/OTP/BullMQ) **≠** `AI_SPEND_REDIS_URL` (ai-service: optional spend ledger). AI-ENV-1 hard cut, no alias; ai-service ignores `REDIS_URL` entirely.
- `INTERNAL_SERVICE_TOKEN` **≠** `SKILLS_INTERNAL_TOKEN` **≠** `AI_INTERNAL_TOKEN` — three different tokens.
- `GEMINI_FLASH_API_KEY` (authoritative) **≠** `LITELLM_API_KEY` (deprecated alias) **≠** `GEMINI_API_KEY` (legacy unused).
- `JWT_SECRET` signs **both** worker and payer sessions inside `apps/api` (one value, two principals) and **must differ from** `ADMIN_JWT_SECRET`.

---

## 🎚 Launch-gate flags & semantics (verified)

**Real-provider gates that REFUSE BOOT when `true` without their creds** (`apps/api`):

- `PAYMENTS_ENABLE_REAL` → needs `PAYMENTS_PROVIDER_KEY` + `PAYMENTS_PROVIDER_SECRET` + `RAZORPAY_WEBHOOK_SECRET` (`assertPaymentsConfig`).
- `PUSH_ENABLE_REAL` → needs `FCM_SERVICE_ACCOUNT_B64` + `FCM_PROJECT_ID` (`assertPushConfig`; the FCM blob's *shape* is validated even when the gate is OFF).
- `MESSAGING_ENABLE_REAL` → needs `WHATSAPP_API_KEY` + `WHATSAPP_PHONE_NUMBER_ID` (`assertMessagingConfig`).
- `MEMBER_INVITES_ENABLE_REAL` → needs the `EMAIL_PROVIDER` creds + `MEMBER_INVITE_ACCEPT_URL` (`assertMemberInvitesConfig`).

**Gates that are INERT / behavior-only when off (no boot guard — flipping just activates):**

- `AI_ENABLE_REAL_CALLS` (fails to **mock**, not boot), `CAPACITY_ENFORCEMENT_ENABLED` (shadow/inert), `AGENCY_PAYOUTS_ENABLED` (neutral 404, mock), `PACE_ENABLED` / `PACE_ADJACENCY_ENABLED` (inert / no-op until a ratified map), `MATCH_V1_ENABLED` (deploy switch — OFF is the only safe default until the 0052–0058 train + D1–D6 data steps run), `CHAT_ONE_SHOT_OPENER_ENABLED` (byte-identical when off), `AUTH_ROLLING_TIERS_ENABLED` (flat TTL when off — but the `AUTH_REFRESH_TTL_DAYS ≥ AUTH_SESSION_ABSOLUTE_MAX_DAYS` cross-field invariant applies regardless), `AI_JOBS_RETENTION_DELETE_ENABLED` (dry-run when off), `ADMIN_PII_REVEAL_ENABLED` (neutral 404 when off), `RESUME_RENDER_ENABLED` (renderer → null when off), `ZEPTOMAIL_SANDBOX_MODE`.
- **`TEST_LOGIN_ENABLED` is the exception** — it *refuses boot* when `true` outside an explicit development/test/staging `NODE_ENV`.

**`apps/ai-service` gate flags:** `AI_ENABLE_REAL_CALLS`, `AI_REAL_CALLS_KILL_SWITCH`, `AI_PROFILING_REPHRASE_ENABLED`, `SKILL_CANONICALIZE_ENABLED` (all default OFF; none refuse boot — they gate behavior at runtime).

**AI real-calls — the exact staging recipe (fail-closed chain, evaluated in this order):**

1. `AI_REAL_CALLS_KILL_SWITCH=true` is the **abort lever, checked FIRST** — it blocks real calls regardless of the enable flag. Keep it `false` to allow real calls; set `true` to instantly kill them (env-only, no redeploy).
2. `AI_ENABLE_REAL_CALLS=true` **and** `GEMINI_FLASH_API_KEY` set — both required, on **both** `apps/api` and `apps/ai-service`. Any one missing → MOCK.
3. **`AI_REAL_CALL_TASKS` empty = ALL tasks go real** (`profile_extraction`, `resume_generation`, `skill_embedding`, `stt_transcription`, `profiling_chat_turn`). To stage AI safely, set an explicit allowlist, e.g. `AI_REAL_CALL_TASKS=profile_extraction` — every other task stays mock even with the master flag + key on.
4. **STT real calls are additionally a legal gate** (Sarvam DPA) — beyond the flag/key/allowlist, real `stt_transcription` needs `SARVAM_API_KEY` **and** the storage pair, and stays §7-deferred until the DPA is signed.
5. **`AI_SPEND_REDIS_URL` unset → per-replica spend caps** (each uvicorn worker holds its own counters). Set it (redis://…) for a single **shared, globally-enforced, fail-closed** ledger before scaling workers or flipping real calls. Set-but-unreachable fails closed to mock (`spend_store_unavailable`).

---

## ⛔ Must NOT be set (or must stay off) in production

- **`TEST_LOGIN_ENABLED=true`** — arming it in prod is a **boot failure** by design; it mints a session with no OTP. Leave it `false`/unset and leave `TEST_LOGIN_TOKEN` unset.
- **Any dev-default secret** (`dev-insecure-*` for `JWT_SECRET` / `ADMIN_JWT_SECRET` / `PII_HASH_PEPPER` / `PIN_PEPPER`, all-zero `PII_ENCRYPTION_KEY`) — rejected at boot outside development/test. Replace all with real values.
- **`ADMIN_MFA_REQUIRED=false`** — do not disable admin MFA in prod (defaults on for a reason; the second factor is the admin principal's protection).
- **`ADMIN_JWT_SECRET` equal to `JWT_SECRET`** — boot failure; they must be cryptographically distinct.
- **Any secret behind a `NEXT_PUBLIC_` name** — the browser split is deliberate. The Razorpay key **secret** and webhook secret are `apps/api`-only; only the rzp_ key **id** may reach the browser, and it arrives on the order response, never a `NEXT_PUBLIC_` build value.
- **`PAYER_DEV_ORG_ROLE`** (payer-web) — dev-only Owner/Recruiter override; ignored in prod but should not be present.
- **Compose-internal `DATABASE_URL=...@postgres:` / `REDIS_URL=...@redis:`** — the guard workflows reject these; they would write real PII to a disposable volume while `/health` returns 200.
- **`AI_INTERNAL_TOKEN=`** (empty string) on either service — a *present* empty string fails the `min(16)` / `min_length=16` check and crash-loops both. Either set a real ≥16-char value on both sides, or leave the var fully unset on both.
- **`AI_REAL_CALL_TASKS` left empty while `AI_ENABLE_REAL_CALLS=true`** — that sends **all** task types to the real LLM. Always pin an explicit allowlist when staging real AI.
- **Any mock/console SMS override** — there is no console/mock provider; `SMS_PROVIDER` must be the literal `fast2sms`. Any other value fails boot.

---

## 📦 Paste-ready templates (secrets = `CHANGE_ME_*`; non-secret defaults pre-filled)

> Never commit these with real values — inject secrets as host/CI environment variables. Placeholders must all be replaced before a prod boot.

### `apps/api/.env`

```dotenv
# ── REQUIRED: core ──────────────────────────────────────────────
NODE_ENV=production
DATABASE_URL=postgresql://USER:CHANGE_ME_DB_PASSWORD@HOST:5432/badabhai?sslmode=require   # BYPASSRLS pooler role
REDIS_URL=redis://:CHANGE_ME_REDIS_PASSWORD@HOST:6379
AI_SERVICE_URL=https://ai.internal.badabhai.in
CORS_ALLOWED_ORIGINS=https://ops.badabhai.in,https://app.badabhai.in
TRUST_PROXY_HOP_COUNT=1          # real edge hop count; NEVER a blanket true

# ── REQUIRED: PII crypto (boot-gated) ───────────────────────────
PII_HASH_PEPPER=CHANGE_ME_PII_HASH_PEPPER                 # >=32 chars
PII_ENCRYPTION_KEY=CHANGE_ME_PII_ENCRYPTION_KEY_BASE64_32B # base64 of EXACTLY 32 bytes

# ── REQUIRED: auth / session (boot-gated) ───────────────────────
JWT_SECRET=CHANGE_ME_JWT_SECRET                          # >=32 chars
PIN_PEPPER=CHANGE_ME_PIN_PEPPER                          # >=32 chars, distinct from PII_HASH_PEPPER
ADMIN_JWT_SECRET=CHANGE_ME_ADMIN_JWT_SECRET              # >=32 chars, MUST differ from JWT_SECRET

# ── REQUIRED: worker OTP (Fast2SMS, real-only) ──────────────────
SMS_PROVIDER=fast2sms
FAST2SMS_API_KEY=CHANGE_ME_FAST2SMS_API_KEY
FAST2SMS_SENDER_ID=CHANGE_ME_FAST2SMS_SENDER_ID
FAST2SMS_DLT_TEMPLATE_ID=CHANGE_ME_FAST2SMS_DLT_TEMPLATE_ID
FAST2SMS_ENTITY_ID=CHANGE_ME_FAST2SMS_ENTITY_ID          # optional in schema, needed for real DLT delivery
FAST2SMS_ROUTE=dlt

# ── REQUIRED: payer auth + email (email_otp default → email creds required) ──
PAYER_LOGIN_METHOD=email_otp
EMAIL_PROVIDER=zeptomail
EMAIL_FROM_ADDRESS=otp@badabhai.in
ZEPTOMAIL_API_TOKEN=CHANGE_ME_ZEPTOMAIL_API_TOKEN
ZEPTOMAIL_MAIL_AGENT=CHANGE_ME_ZEPTOMAIL_MAIL_AGENT
# --- OR switch EMAIL_PROVIDER=smtp and use:
# SMTP_HOST=CHANGE_ME_SMTP_HOST
# SMTP_PORT=587
# SMTP_USER=CHANGE_ME_SMTP_USER
# SMTP_PASS=CHANGE_ME_SMTP_PASS

# ── REQUIRED: admin MFA (defaults satisfy; leave issuer non-empty) ──
ADMIN_MFA_REQUIRED=true
ADMIN_TOTP_ISSUER=BadaBhai Admin

# ── REQUIRED: internal service tokens (must match peers) ────────
INTERNAL_SERVICE_TOKEN=CHANGE_ME_INTERNAL_SERVICE_TOKEN   # == apps/web
# AI_INTERNAL_TOKEN=CHANGE_ME_AI_INTERNAL_TOKEN           # >=16; set on BOTH api + ai-service or NEITHER
# SKILLS_INTERNAL_TOKEN=CHANGE_ME_SKILLS_INTERNAL_TOKEN   # only if skill canonicalization is armed

# ── AI (declarative on Node side; real caller is ai-service) ────
AI_ENABLE_REAL_CALLS=false                               # staging-first; keep false at launch
# GEMINI_FLASH_API_KEY=CHANGE_ME_GEMINI_FLASH_API_KEY     # required only to make real calls effective
# ANTHROPIC_API_KEY=CHANGE_ME_ANTHROPIC_API_KEY           # optional, adds Claude Haiku fallback

# ── Storage (required only when render/STT/photo/voice is armed) ──
# SUPABASE_URL=https://<ref>.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=CHANGE_ME_SUPABASE_SERVICE_ROLE_KEY
CONVERSATIONS_BUCKET=worker-conversations
RESUMES_BUCKET=worker-resumes
INTERVIEW_KIT_BUCKET=interview-kits
VOICE_NOTES_BUCKET=                                       # empty = voice/DSAR-audio dormant; set worker-voice-notes to arm
WORKER_PHOTOS_BUCKET=                                     # empty = photo endpoints 503; set to arm
RESUME_RENDER_ENABLED=false                              # ON requires SUPABASE_URL + key

# ── LAUNCH-GATE flags (all default OFF; keep OFF at launch) ─────
PAYMENTS_ENABLE_REAL=false     # true needs PAYMENTS_PROVIDER_KEY + _SECRET + RAZORPAY_WEBHOOK_SECRET
PUSH_ENABLE_REAL=false         # true needs FCM_SERVICE_ACCOUNT_B64 + FCM_PROJECT_ID
MESSAGING_ENABLE_REAL=false    # true needs WHATSAPP_API_KEY + WHATSAPP_PHONE_NUMBER_ID
MEMBER_INVITES_ENABLE_REAL=false  # true needs email creds + MEMBER_INVITE_ACCEPT_URL
CAPACITY_ENFORCEMENT_ENABLED=false
AGENCY_PAYOUTS_ENABLED=false
PACE_ENABLED=false
PACE_ADJACENCY_ENABLED=false
MATCH_V1_ENABLED=false
CHAT_ONE_SHOT_OPENER_ENABLED=false
AUTH_ROLLING_TIERS_ENABLED=false
AI_JOBS_RETENTION_DELETE_ENABLED=false
ADMIN_PII_REVEAL_ENABLED=false
TEST_LOGIN_ENABLED=false       # MUST stay off in prod (arming it = boot failure)

# ── OPTIONAL: tunable numeric knobs (safe defaults shown) ───────
API_PORT=3001
SESSION_TTL_DAYS=30
AUTH_SESSION_ABSOLUTE_MAX_DAYS=90
AUTH_TIER_WINDOW_DAYS=60
AUTH_REFRESH_TTL_DAYS=90        # MUST be >= AUTH_SESSION_ABSOLUTE_MAX_DAYS (boot-checked)
PIN_LENGTH=4
PIN_MAX_ATTEMPTS=5
PIN_LOCKOUT_BASE_SECONDS=60
PIN_MAX_LOCKOUT_CYCLES=5
PIN_CHALLENGE_TTL_SECONDS=600
TEST_LOGIN_MAX_PER_DAY=200
OTP_LENGTH=6
OTP_TTL_SECONDS=300
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SECONDS=30
OTP_MAX_SENDS_PER_HOUR=5
OTP_MAX_SENDS_PER_DAY=10
OTP_GLOBAL_MAX_SENDS_PER_DAY=2000       # 0 = worker-SMS kill-switch
PAYER_DISCLOSURE_MAX_PER_HOUR=30
PAYER_AUTH_MAX_PER_IP_PER_HOUR=20
PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY=2000 # 0 = payer-email kill-switch
PAYER_REACH_MAX_PER_HOUR=60
AGENCY_INVITE_MINT_MAX_PER_HOUR=60
ADMIN_AUTH_MAX_PER_IP_PER_HOUR=20
ADMIN_PII_REVEAL_MAX_PER_HOUR=10
ADMIN_PII_REVEAL_MAX_PER_DAY=30
MEMBER_INVITE_MAX_PER_ORG=25
PUSH_GLOBAL_MAX_SENDS_PER_DAY=5000      # 0 = halt every push (security pushes exempt)
PUSH_TOKEN_UPDATES_PER_IP_PER_HOUR=30
UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY=5
UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK=10
UNLOCK_MAX_ATTEMPTS_PER_UNLOCK=3
UNLOCK_LATENCY_TARGET_MS=1000
CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES=1
AGENCY_PAYOUT_UNLOCK_BASIS_INR=40
AGENCY_PAYOUT_RATE_BPS=2500
AGENCY_PAYOUT_WINDOW_DAYS=90
AGENCY_PAYOUT_MIN_THRESHOLD_INR=500
PACE_THIN_SUPPLY_MIN=3
PACE_AREA_STEP_KM=15
PACE_MAX_AREA_KM=75
PACE_WAVE_INTERVAL_HOURS=6
PACE_OPS_ALERT_AFTER_HOURS=24
RESUME_DAILY_CAP=5
RESUME_GLOBAL_DAILY_CAP=5000
RESUME_SIGNED_URL_TTL_SECONDS=900
RESUME_RATE_LIMIT_PER_IP_PER_HOUR=20
INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR=20
PHOTO_RATE_LIMIT_PER_IP_PER_HOUR=20
REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR=20
REFERRAL_CLICK_MAX_PER_IP_PER_HOUR=600
INTERVIEW_KIT_CONTENT_VERSION=1
ACCOUNT_DELETION_COOLDOWN_SECONDS=604800
ACCOUNT_DELETION_GRACE_DAYS=7
ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS=1
AI_JOBS_RETENTION_DAYS=90
AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS=24
DEFAULT_CHEAP_MODEL=gemini-2.5-flash-lite
DEFAULT_CAPABLE_MODEL=gemini-2.5-flash
AI_COST_ALERT_PROFILE_INR=6
AI_TARGET_PROFILE_COST_INR=4
AI_MAX_CALL_COST_INR=10
ZEPTOMAIL_SANDBOX_MODE=false
# LANGFUSE_PUBLIC_KEY=  LANGFUSE_SECRET_KEY=CHANGE_ME  LANGFUSE_BASE_URL=https://cloud.langfuse.com
# EMAIL_FROM_NAME=BadaBhai   EMAIL_REPLY_TO=support@badabhai.in
# Keyring (opt-in, TD22-1): PII_ENCRYPTION_KEYS={"k1":"<base64-32B>"}  PII_ENCRYPTION_ACTIVE_KID=k1
```

### `apps/ai-service/.env`

```dotenv
# ── Real-call gates (default = mock-only; safe to boot with nothing set) ──
AI_REAL_CALLS_KILL_SWITCH=false        # abort lever, checked FIRST
AI_ENABLE_REAL_CALLS=false             # must match apps/api
AI_REAL_CALL_TASKS=                    # EMPTY = ALL tasks real when enabled; pin an allowlist to stage
# GEMINI_FLASH_API_KEY=CHANGE_ME_GEMINI_FLASH_API_KEY   # same value as apps/api
# ANTHROPIC_API_KEY=CHANGE_ME_ANTHROPIC_API_KEY         # optional fallback (Claude Haiku)
AI_PROFILING_REPHRASE_ENABLED=false

# ── Service auth (must match apps/api; both-or-neither, >=16) ────
# AI_INTERNAL_TOKEN=CHANGE_ME_AI_INTERNAL_TOKEN
# SKILLS_INTERNAL_TOKEN=CHANGE_ME_SKILLS_INTERNAL_TOKEN
# BACKEND_API_URL=https://api.internal.badabhai.in       # required WITH SKILLS_INTERNAL_TOKEN to arm canonicalization

# ── Models (real Gemini/Anthropic ids; defaults ship valid) ─────
DEFAULT_CHEAP_MODEL=gemini-2.5-flash-lite
DEFAULT_CAPABLE_MODEL=gemini-2.5-flash
DEFAULT_FALLBACK_MODEL=claude-haiku-4-5
EMBEDDING_MODEL=gemini-embedding-001

# ── Skill canonicalization + growth (default OFF / calibrated) ──
SKILL_CANONICALIZE_ENABLED=false
SKILL_CANONICALIZE_FLOOR=0.75
SKILL_CANONICALIZE_TOP_K=5
SKILL_CANONICALIZE_DEFAULT_DOMAIN=cnc-machining
SKILL_GROWTH_MIN_CLUSTER_SIZE=2
SKILL_GROWTH_MIN_TOTAL_COUNT=3
SKILL_GROWTH_CLUSTER_THRESHOLD=0.80
SKILL_GROWTH_BAND_LOW=0.60

# ── Cost & retry caps ───────────────────────────────────────────
AI_COST_ALERT_PROFILE_INR=6.0
AI_TARGET_PROFILE_COST_INR=4.0
AI_MAX_CALL_COST_INR=10.0
AI_MAX_DAILY_COST_INR=200.0
AI_MAX_TOTAL_COST_INR=1000.0
AI_MAX_USER_DAILY_COST_INR=6.0
AI_RETRY_BUDGET_PER_WINDOW=20
AI_RETRY_BUDGET_WINDOW_SECONDS=60
# AI_SPEND_REDIS_URL=rediss://:CHANGE_ME@HOST:6379   # unset = per-replica caps; set for shared, fail-closed ledger

# ── STT / translate (Sarvam, §7-deferred; DPA-gated) ────────────
# SARVAM_API_KEY=CHANGE_ME_SARVAM_API_KEY
SARVAM_STT_MODEL=saarika:v2.5
SARVAM_STT_COST_INR_PER_CHUNK=0.25
SARVAM_TRANSLATE_MODEL=mayura:v1

# ── Storage (required only for real STT; same values as apps/api) ──
# SUPABASE_URL=https://<ref>.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=CHANGE_ME_SUPABASE_SERVICE_ROLE_KEY
VOICE_NOTES_BUCKET=worker-voice-notes    # NOTE: ai-service default differs from apps/api (empty)

# ── Observability + port ────────────────────────────────────────
# LANGFUSE_PUBLIC_KEY=   LANGFUSE_SECRET_KEY=CHANGE_ME
LANGFUSE_BASE_URL=https://cloud.langfuse.com
AI_SERVICE_PORT=8000
```

### `apps/web/.env` (ops console)

```dotenv
INTERNAL_SERVICE_TOKEN=CHANGE_ME_INTERNAL_SERVICE_TOKEN   # MUST byte-match apps/api
NEXT_PUBLIC_API_URL=https://api.badabhai.in
NEXT_PUBLIC_ENVIRONMENT=production
NODE_ENV=production
```

### `apps/payer-web/.env` (payer/agency portal)

```dotenv
# ── Server-side (internal origin; NOT exposed to the browser) ───
PAYER_API_URL=https://api.internal.badabhai.in
PAYMENTS_ENABLE_REAL=false                 # must match apps/api's flag; false = mock top-up
AGENCY_SUPPLY_ENABLED=false

# ── Public (browser bundle) ─────────────────────────────────────
NEXT_PUBLIC_API_URL=https://api.badabhai.in
NEXT_PUBLIC_ENVIRONMENT=production
NODE_ENV=production
NEXT_PUBLIC_SITE_URL=https://app.badabhai.in
NEXT_PUBLIC_WORKER_APP_ID=in.badabhai.worker   # must equal the worker app's Play Store id

# ── Agency feature flags (only PORTAL defaults ON) ──────────────
NEXT_PUBLIC_ENABLE_AGENCY_PORTAL=true
NEXT_PUBLIC_ENABLE_AGENCY_SUPPLY=false
NEXT_PUBLIC_ENABLE_AGENCY_KYC=false
NEXT_PUBLIC_ENABLE_AGENCY_PAYOUTS=false
NEXT_PUBLIC_ENABLE_AGENCY_BULK_UPLOAD=false     # DEAD — keep off
NEXT_PUBLIC_ENABLE_AGENCY_OUTCOME_TRACKING=false

# ── Display / pricing copy (backend still resolves price) ───────
PAYER_POSTING_FREE_THROUGH_LAUNCH=true          # inverse polarity: only 'false' switches to paid
PAYER_LOW_BALANCE_THRESHOLD=5
PAYER_CREDIT_VALIDITY_MONTHS=12
# PAYER_THEME=paper     NEXT_PUBLIC_PAYER_THEME=paper
# PAYER_DEV_ORG_ROLE=   <-- DEV ONLY; never set in prod
```

### Deployment / CI-CD infrastructure (not app `.env` — set as CI secrets / deploy env)

```dotenv
# Image pins — fail the whole compose overlay if unset (${VAR:?}); export BOTH for any compose cmd incl rollback
API_IMAGE=ghcr.io/<owner>/badabhai-platform/badabhai-api:sha-<short7>
AI_SERVICE_IMAGE=ghcr.io/<owner>/badabhai-platform/badabhai-ai-service:sha-<short7>

# Persistent-API (staging-cd) smoke + optional deploy hook
STAGING_API_BASE_URL=https://api.staging.badabhai.in     # /health poll target
# STAGING_DEPLOY_HOOK_URL=CHANGE_ME                       # optional; empty = skip host-deploy POST

# Lightsail/box SSH path (ci.yml deploy-lightsail)
LIGHTSAIL_HOST=CHANGE_ME_LIGHTSAIL_HOST
LIGHTSAIL_USER=CHANGE_ME_LIGHTSAIL_USER
LIGHTSAIL_SSH_KEY=CHANGE_ME_LIGHTSAIL_SSH_KEY_PEM         # never add allenvs:true to the ssh action
```

---

## ⚠ Conflicts / ambiguities to resolve

1. **Two divergent staging deploy paths with different required-secret sets — neither is a superset of the other.**
   - **(A) Lightsail/box path** (`docker-compose.staging.yml` `${VAR:?}` + `ci.yml deploy-lightsail` bridge): 12 secrets — `JWT_SECRET, PII_ENCRYPTION_KEY, PII_HASH_PEPPER, PIN_PEPPER, ADMIN_JWT_SECRET, DATABASE_URL, REDIS_URL, INTERNAL_SERVICE_TOKEN, FAST2SMS_API_KEY, FAST2SMS_SENDER_ID, FAST2SMS_DLT_TEMPLATE_ID, CORS_ALLOWED_ORIGINS` + 2 image vars.
   - **(B) Persistent-API path** (`staging-cd.yml` guard): 13 secrets — adds the ZeptoMail trio (`ZEPTOMAIL_API_TOKEN, ZEPTOMAIL_MAIL_AGENT, EMAIL_FROM_ADDRESS`) + `STAGING_API_BASE_URL`, but **drops `PIN_PEPPER, ADMIN_JWT_SECRET, CORS_ALLOWED_ORIGINS`**.
   - **Risk:** `staging-cd` runs `NODE_ENV=staging`, where `assertAuthConfig` (`PIN_PEPPER`), `assertAdminAuthConfig` (`ADMIN_JWT_SECRET`), and CORS all apply — so the `staging-cd` guard **under-enumerates the deployed host's true boot requirements** (its env block governs the ephemeral runner, not the persistent host, which is provisioned out-of-band). **Reconcile:** the deployed host must carry the *union* — this manifest lists the full runtime requirement.

2. **`VOICE_NOTES_BUCKET` has two different defaults for the same name.** `apps/api` defaults to `""` (dormant DSAR-audio seam); `apps/ai-service` defaults to `worker-voice-notes`. In a shared-env deploy, set `VOICE_NOTES_BUCKET=worker-voice-notes` explicitly to arm both consistently (this also arms the api's DSAR audio-erase leg — intended, §2).

3. **One Gemini key, three names.** `GEMINI_FLASH_API_KEY` is authoritative; `LITELLM_API_KEY` is a deprecated one-release back-compat alias (TD28); `GEMINI_API_KEY` is a legacy unused declaration on the Node side. Use only `GEMINI_FLASH_API_KEY` (on both `apps/api` and `apps/ai-service`). Do not treat the aliases as distinct secrets.

4. **`REDIS_URL` vs `AI_SPEND_REDIS_URL` (AI-ENV-1 hard cut, no alias).** A single shared `REDIS_URL` across all services is **wrong** — the ai-service reads *only* `AI_SPEND_REDIS_URL` (optional spend ledger) and ignores `REDIS_URL`. `apps/api`'s `REDIS_URL` is mandatory infra. Keep them separate.

5. **Three similarly-named service tokens.** `INTERNAL_SERVICE_TOKEN` (api↔web ops routes), `SKILLS_INTERNAL_TOKEN` (ai→api skills routes, scoped), `AI_INTERNAL_TOKEN` (api→ai, ≥16, both-or-neither). Easily conflated; each is a distinct value.

6. **`FAST2SMS_ENTITY_ID` / `FAST2SMS_ROUTE` — runbook vs schema drift.** The staging-service-deploy-runbook lists both as boot-required for fast2sms; the schema (`docs/environment-variables.md`) and `staging-cd.yml` guard class both **optional** (`FAST2SMS_ROUTE` defaults `dlt`), and `assertAuthConfig` does **not** require them. The runbook overstates. Real DLT delivery typically still needs `FAST2SMS_ENTITY_ID` — set it in practice, but it is not boot-enforced.

7. **`PAYMENTS_ENABLE_REAL` polarity/behavior differs by app.** In `apps/api` it is a boot assertion (true without the 3 Razorpay secrets crashes boot). In `apps/payer-web` it was **intentionally changed from a boot assertion to a plain read** (the old assertion made the shared-env gate un-flippable). Both read the same shared env value — keep them in lockstep; only `apps/api` enforces the secret set.

8. **`MEMBER_INVITES_ENABLE_REAL` fail-closed classification.** The Zod-schema surface reports `failClosedAtBoot=false` for the boolean itself; the operator/runtime surface reports `true` because setting it `true` fires `assertMemberInvitesConfig`, which refuses boot without email creds + `MEMBER_INVITE_ACCEPT_URL`. Resolved here as **"boot-fails when true without creds"** (same pattern as the other `*_ENABLE_REAL` gates).

9. **`ZEPTOMAIL_API_URL` is optional even for zeptomail** — it is a non-secret endpoint **not** in `emailProviderBlockedReason`'s required set, despite being a ZeptoMail field. Do not treat it as a required credential.

10. **Surfaces fully read; none blocked.** All five code surfaces were enumerated from committed code, compose/workflow YAML, and `*.example` templates — no `.env`/secret file was read (a guard hook blocked one env-pattern grep; the value never mattered). No secret **values** appear anywhere in this manifest. The only var that is *silent at boot but total at runtime* is `INTERNAL_SERVICE_TOKEN` on `apps/web` (mismatch → every ops route 401s with no boot signal) — verify it against `apps/api` out-of-band.
