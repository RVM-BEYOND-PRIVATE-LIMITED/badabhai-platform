# 10 — Environment & Configuration Audit

**Method.** Read in full: `packages/config/src/server.ts` (884 lines of schema + ~850 lines of boot-guard functions), `packages/config/src/public.ts`, `packages/config/src/shared.ts`, and every `.env*.example` file in the repository — `.env.example` (root), `apps/ai-service/.env.example`, `apps/ai-service/.env.staging.example`, `apps/api/.env.staging.example`, `apps/payer-web/.env.example` (5 files; the two `.env.staging.example` files are a distinct naming convention from `.env.example`, easy to miss on a naive glob). Cross-checked variable-name sets programmatically (schema vs. template) and by grep for consumption. Read `docker-compose.yml`/`docker-compose.staging.yml` in full for the `api`/`ai-service` service `environment:` blocks, because a variable's presence in a schema or template does not establish it's reachable in a deployed container — compose only forwards names a service's `environment:` block explicitly names. No secret **value** appears anywhere below.

Batch 1's [`15_SECURITY_AUDIT.md`](15_SECURITY_AUDIT.md) already covers the fail-closed behavior of `AI_INTERNAL_TOKEN`, `ZEPTOMAIL_API_URL/TOKEN/MAIL_AGENT`+`EMAIL_FROM_ADDRESS`, `SUPABASE_URL/SERVICE_ROLE_KEY`, and the `PAYMENTS_ENABLE_REAL` family — referenced, not re-derived, below.

## 1. Summary

| Source | Variable count | Consumed by |
|---|---|---|
| `packages/config/src/server.ts` (`serverEnvSchema`) | **154** fields | `apps/api` only ("NEVER import this from the web/worker frontends") |
| `packages/config/src/public.ts` (`publicEnvSchema`) | **3** fields (`NODE_ENV`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ENVIRONMENT`) | `apps/api` (rarely), `apps/web`, `apps/payer-web` — the only whitelisted browser-safe surface |
| `.env.example` (root) | ~112 declared lines | `apps/api`'s full server schema + a handful of `apps/web`'s reads |
| `apps/ai-service/.env.example` | ~70 declared lines | `apps/ai-service` (Python/Pydantic `Settings`, **not** `packages/config`) |
| `apps/ai-service/.env.staging.example` | overlay of ~35 of the above | `apps/ai-service` |
| `apps/api/.env.staging.example` | 10 declared lines | `apps/api` |
| `apps/payer-web/.env.example` | 16 declared lines | `apps/payer-web` only — own local schema, does **not** import `@badabhai/config/server` |

Confirmed importers of `@badabhai/config`: 168 files under `apps/api/src` (the schema owner), plus exactly 4 frontend files — `apps/web/src/lib/config.ts`, `apps/payer-web/src/lib/config.ts`, `apps/payer-web/src/lib/auth/org-roles.ts` (+test) — all four using **only** `@badabhai/config/public`. `apps/admin-web` imports `@badabhai/config` **nowhere** (§6).

## 2. `packages/config/src/server.ts` — server-only (`apps/api`)

Grouped by concern. "Secret" = credential/key material that must never leave the server. "optionalSecret" = the `z.preprocess((v) => v === "" ? undefined : v, …)` wrapper — the fix Batch 1 verified for `SUPABASE_*`/`ZEPTOMAIL_*`/`EMAIL_FROM_ADDRESS`.

**Core datastores & private Storage buckets**: `DATABASE_URL`, `REDIS_URL`, `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (optionalSecret, latter is secret), `CONVERSATIONS_BUCKET`/`RESUMES_BUCKET`/`VOICE_NOTES_BUCKET` (empty=dormant)/`WORKER_PHOTOS_BUCKET` (empty=503 fail-closed)/`INTERVIEW_KIT_BUCKET`.

**Resume/interview-kit render + internal auth**: `RESUME_RENDER_ENABLED`, `RESUME_DAILY_CAP`/`RESUME_GLOBAL_DAILY_CAP`, `RESUME_SIGNED_URL_TTL_SECONDS`, per-IP rate caps for resume/interview-kit/photo, `WORKER_ACTIONS_PER_HOUR`, `INTERVIEW_KIT_CONTENT_VERSION`, **`INTERNAL_SERVICE_TOKEN`** (no default, unset denies all — secret), **`SKILLS_INTERNAL_TOKEN`** (distinct least-privilege secret from the above, no default — secret).

**PII cryptography**: `PII_HASH_PEPPER`/`PII_ENCRYPTION_KEY` (insecure dev defaults, **MUST override in prod**, fail-closed via `assertPiiCryptoConfig` — both secret), `PII_ENCRYPTION_KEYS`/`PII_ENCRYPTION_ACTIVE_KID` (TD22-1 rotation keyring, both-or-neither fail-closed).

**Worker auth (session/PIN/deletion/test-login/OTP)**: `JWT_SECRET` (dev default, MUST override — secret), session TTL/rolling-tier config, `PIN_PEPPER` (dev default, MUST override, cryptographically distinct from `PII_HASH_PEPPER` — secret) + PIN lockout/challenge tuning, `ACCOUNT_DELETION_*` (grace/cooldown/sweep), `TEST_LOGIN_ENABLED`/`TEST_LOGIN_TOKEN` (min 32, structurally impossible outside dev/test/staging — secret), OTP length/TTL/attempt/resend/send-cap config, `SMS_PROVIDER` (`z.literal("fast2sms")`, no mock path), `FAST2SMS_API_KEY`/`SENDER_ID`/`DLT_TEMPLATE_ID` (all three required at boot — key is secret) / `FAST2SMS_ENTITY_ID` (**not** enforced by `assertAuthConfig`, the odd one out) / `FAST2SMS_ROUTE`.

**Payer auth (email OTP), org invites**: `PAYER_LOGIN_METHOD`, `PAYER_TEST_LOGIN_ENABLED`/`TOKEN` (secret), payer rate caps, `EMAIL_PROVIDER` (`zeptomail`/`smtp`/`auto`), `ZEPTOMAIL_API_URL`/`API_TOKEN`/`MAIL_AGENT` (optionalSecret, #819 fix — token/agent are secret), `SMTP_*` (bare `.optional()`, **no** `optionalSecret` wrap — `SMTP_PASS`/`SMTP_USER` secret), `EMAIL_FROM_ADDRESS` (optionalSecret, #819 fix, non-secret address), `MEMBER_INVITES_ENABLE_REAL`/`MEMBER_INVITE_ACCEPT_URL`/`MAX_PER_ORG`.

**Admin ops portal (ADR-0025)**: **`ADMIN_JWT_SECRET`** (dev default, **MUST override AND differ from `JWT_SECRET`** via `assertAdminAuthConfig` — secret), `ADMIN_MFA_REQUIRED` (default true), `ADMIN_TOTP_ISSUER`, admin auth/PII-reveal rate caps, `ADMIN_PII_REVEAL_ENABLED` (default false, 404 while off — the single most sensitive route's master switch).

**AI routing/cost + chat/profiling (api-side declarations)**: the Node API never calls an LLM directly (ADR-0008) — these are gating/declarative only, mirrored by ai-service's own separately-configured copy (§4); see §10 for whether the api-side copies are even wired in staging. `GEMINI_FLASH_API_KEY`/`ANTHROPIC_API_KEY`/`LITELLM_API_KEY` (deprecated alias, TD28) — all secret; `AI_ENABLE_REAL_CALLS` (feeds only `GET /health`'s `ai_posture` observability field — see §10); model routing/cost-alert/spend-ceiling knobs; `SARVAM_API_KEY` (secret, api-side placeholder, ai-service holds the real one); `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY` (secret key only, dormant unless both set); `AI_SERVICE_URL`; `AI_INTERNAL_TOKEN` (min 16 — secret, covered by Batch 1); chat/profiling turn-cap/history-window/locale/LLM-interview-toggle config; `AI_JOBS_RETENTION_*`.

**Payments, push, WhatsApp messaging**: `PAYMENTS_ENABLE_REAL` (covered by Batch 1), `PAYMENTS_PROVIDER_KEY` (**explicitly public by design** — handed to browser checkout) / `PAYMENTS_PROVIDER_SECRET` (secret), `RAZORPAY_WEBHOOK_SECRET` (secret, distinct from key secret), `PUSH_ENABLE_REAL`, `FCM_SERVICE_ACCOUNT_B64` (secret)/`FCM_PROJECT_ID`, push caps, `MESSAGING_ENABLE_REAL`, `WHATSAPP_API_KEY` (secret)/`PHONE_NUMBER_ID`.

**Contact-unlock, capacity, referrals, agency payouts, PACE, matching**: unlock worker-protection caps + latency-normalization pad, capacity defaults/enforcement toggle, referral attribution/click caps + windows + short-link base, agency invite-mint cap, `AGENCY_PAYOUTS_ENABLED` (covered by Batch 1) + owner-ratified commission economics, `PACE_*` tuning (adjacency leg blocked until a ratified map exists), `MATCH_V1_ENABLED` (the only env var Matching V1 added).

**Deployment/infra**: `NODE_ENV` (fail-**open** default — never gate a security shortcut on the parsed value, use `isDevEnv()` instead), `API_PORT`, `TRUST_PROXY_HOP_COUNT` (fail-safe default 0 = socket peer), `CORS_ALLOWED_ORIGINS` (empty = deny all cross-origin outside dev).

## 3. `packages/config/src/public.ts` — browser-safe

`NODE_ENV`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ENVIRONMENT` (also drives cookie `Secure` flag in payer-web). `loadPublicConfig()` explicitly ignores unknown/extra keys, "including any leaked server secrets" — a whitelist parse, not a passthrough, by design.

This schema is **deliberately minimal**. Every frontend app needing additional `NEXT_PUBLIC_*` values reads `process.env` directly in its **own** `lib/config.ts`/`server-config.ts` rather than extending this shared schema (§5, §6) — a consistent, intentional pattern across the three Next.js apps, not drift.

## 4. `apps/ai-service/.env.example` + `.env.staging.example` — separate Pydantic schema

~70 vars consumed by `apps/ai-service/app/config.py` (`pydantic-settings`), a **completely separate schema** from `packages/config/src/server.ts`. Grouped: real-call gate (`AI_ENABLE_REAL_CALLS`, `AI_REAL_CALL_TASKS`, `AI_REAL_CALLS_KILL_SWITCH` — ai-service's **own** copies, the ones actually enforced against the LLM call, unlike the much weaker api-side copy — see §10); provider credentials (secret); model routing (`DEFAULT_FALLBACK_MODEL` has **no** counterpart in `server.ts`); profiling engine tuning (independent of api-side `CHAT_MAX_TURNS`/`CHAT_HISTORY_WINDOW_TURNS` — api-side is authoritative, ai-service's copy is a mirror); domain-match RAG (off by default); token caps/temperature; Gemini transport tuning; cost guardrails (TD27, shares names with but is **numerically independent of** the api-side declarations); `AI_SPEND_REDIS_URL` (**deliberately not named `REDIS_URL`** — AI-ENV-1 fix, sharing the name previously caused a silent ~21s stall); skill-canonicalization/growth tuning; internal seams (`BACKEND_API_URL`, `SKILLS_INTERNAL_TOKEN` ai→api, `AI_INTERNAL_TOKEN` api→ai — an empty value fails Pydantic's `min_length=16` at startup, "not a valid off"); Sarvam STT/TTS tuning; Storage (**must match the api-side value exactly** — the file's own comment flags the two sides' defaults used to disagree, causing silent total transcription failure with a green `/health`); Langfuse observability.

## 5. `apps/payer-web/.env.example` — own local schema

payer-web imports `@badabhai/config/public` for exactly `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_ENVIRONMENT`, then layers its **own** vars via `process.env` in `src/lib/config.ts`/`server-config.ts`: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SHORT_LINK_BASE`, `NEXT_PUBLIC_WORKER_APP_ID`, `NEXT_PUBLIC_ENABLE_AGENCY_PORTAL` (fail-closed boolean, default ON) + 5 sibling agency feature labels (fail-closed, default OFF — flipping any one ships **no code**, label-only), `PAYER_AUTH_MODE` (api/mock), `PAYER_API_URL`, `DEV_QUICK_LOGIN`, `PAYER_SESSION_SECRET` (secret in mock mode only, template `change-me-in-staging`), `PAYMENTS_ENABLE_REAL` (must stay false — "the portal ships MOCK-only and refuses to boot if this is true"), `PAYER_POSTING_FREE_THROUGH_LAUNCH`, `AGENCY_SUPPLY_ENABLED`.

`NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` appear in the root template under a "Web (Next.js)" heading but are **not used by payer-web** — confirmed zero references (§9).

## 6. `apps/admin-web` — no `.env.example` at all

**Zero** `.env.example` file, imports `@badabhai/config` **nowhere**. Only reads: `ADMIN_API_BASE_URL` (server-side API base, no default fallback documented anywhere) and `NEXT_PUBLIC_ENVIRONMENT` (fallback `NODE_ENV`). **Genuine documentation gap**: an operator provisioning `admin-web` for staging/prod has no template file to consult for `ADMIN_API_BASE_URL` at all.

## 7. `apps/web` — reads `@badabhai/config/public` + one direct secret

`apps/web/src/lib/config.ts` uses only `loadPublicConfig()`. Separately, `apps/web/src/lib/api.ts` reads `process.env.INTERNAL_SERVICE_TOKEN` **directly** (not through `@badabhai/config`, not `NEXT_PUBLIC_*`) to attach `x-internal-service-token` on every ops-console call behind `InternalServiceGuard`. A correct, working cross-app secret-sharing pattern (the root `.env.example`'s trailing comment describes it), but entirely undocumented in `apps/web`'s own template (it has none) — explained only in a comment at the *bottom* of the root `.env.example`, four lines after that file's stated scope ("Environment Template" for `apps/api`).

## 8. Cross-check A — `server.ts` schema fields absent from the root `.env.example`

**123 of 154** server-schema fields have no line in `.env.example`. The overwhelming majority are safe (every one carries a schema `.default(...)` — rate caps, TTLs, feature-flag booleans defaulting `false`). A smaller subset is a **real documentation gap** — production-required secrets carrying an explicit "MUST override in production"/"fail closed if unset" comment, with **no line at all** in any template:

| Var | Why this matters |
|---|---|
| `ADMIN_JWT_SECRET` | Must differ from `JWT_SECRET`, override outside dev/test — `JWT_SECRET`/`PII_HASH_PEPPER`/`PII_ENCRYPTION_KEY` all get a template line with a `node -e` generation snippet; this sibling secret gets none |
| `PIN_PEPPER` | Same "MUST override in production" class as `PII_HASH_PEPPER`, no template line |
| `SKILLS_INTERNAL_TOKEN` | A distinct least-privilege secret from `INTERNAL_SERVICE_TOKEN` (which does get a commented-out line) — zero mention on the api side (ai-service's own template mentions it, from the *consumer* side only) |
| `AI_INTERNAL_TOKEN` (api-side) | Documented for the ai-service side (commented out) but the api-side half of the same shared secret has no root-template line |
| `PAYER_LOGIN_METHOD` | Selects the entire payer login channel — no template line anywhere despite gating which credential set is required |

## 9. Cross-check B — `.env.example` (root) vars absent from `server.ts`/`public.ts`

`AI_REAL_CALL_TASKS`, `SARVAM_STT_MODEL`, `SARVAM_TRANSLATE_MODEL`, `SARVAM_TTS_*`, `DEFAULT_FALLBACK_MODEL`, `LANGFUSE_TRACING_ENVIRONMENT`, `AI_SERVICE_PORT` → **legitimate**, documenting the ai-service side of the local dev stack (`docker compose --profile api` runs both), not orphaned. `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` → **dead template entry**, zero references in any `apps/*/src`. `WEB_PORT` → **dead template entry**, zero references outside the template file.

## 10. Compose-wiring reachability — a supplement to Batch 1 §8, not a restatement

Batch 1 stated the 5 real-provider master flags "can only be armed by a direct box-env action, never by a deploy." A full read of `docker-compose.staging.yml`'s `api:` `environment:` block (lines 42–286) refines this: **Docker Compose forwards into a container only the variable names a service's own `environment:` block references** — a name absent from that block is never populated, regardless of the box's shell export. This repo has hit and fixed this exact failure mode reactively, **at least four separate times**: `AI_ENABLE_REAL_CALLS`/`CHAT_LLM_INTERVIEW_ENABLED` (#798), `WORKER_PHOTOS_BUCKET` (#794), `ZEPTOMAIL_API_URL` (#813), `RESUME_RENDER_ENABLED` (#793) — each now pinned by a dedicated compose-guard test reading the YAML directly.

**Finding.** Cross-checking the full `api:` block against the schema: **none** of `PAYMENTS_ENABLE_REAL`, `PAYMENTS_PROVIDER_KEY`, `PAYMENTS_PROVIDER_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `MESSAGING_ENABLE_REAL`, `WHATSAPP_API_KEY`, `WHATSAPP_PHONE_NUMBER_ID`, `PUSH_ENABLE_REAL`, `FCM_SERVICE_ACCOUNT_B64`, `FCM_PROJECT_ID`, `AGENCY_PAYOUTS_ENABLED`, `MEMBER_INVITES_ENABLE_REAL`, `MEMBER_INVITE_ACCEPT_URL`, `MATCH_V1_ENABLED`, `CAPACITY_ENFORCEMENT_ENABLED`, `PACE_ENABLED`, `TEST_LOGIN_ENABLED`/`TOKEN`, `PAYER_TEST_LOGIN_ENABLED`/`TOKEN`, `SKILLS_INTERNAL_TOKEN`, `AUTH_ROLLING_TIERS_ENABLED`, `AI_JOBS_RETENTION_DELETE_ENABLED`, or the api-side `AI_ENABLE_REAL_CALLS`/`GEMINI_FLASH_API_KEY`/`ANTHROPIC_API_KEY`/`LITELLM_API_KEY` appears — as a `:?` requirement, a `:-` pass-through, or a literal — anywhere in that block, and none is covered by a compose-guard test. **Per the mechanism above, a direct box-env action alone would not arm any of these on this box today**: an operator exporting `PAYMENTS_ENABLE_REAL=true` on the box's shell and re-running `docker compose up -d` would see no change at all, silently — precisely the failure class this repo has now fixed four times without generalizing the fix. Not a live incident (all five flags correctly read `false` today, matching Batch 1), and for these five an unreachable arming path is arguably a *harder* fail-closed posture than Batch 1's framing implied. Raised as a forward risk: the next person following this repo's own documented arming pattern (mirroring `AI_ENABLE_REAL_CALLS`'s runbook) for any of these 25 variables will hit the same silent no-op, unless the compose line is added first.

The api-side `AI_ENABLE_REAL_CALLS`/`GEMINI_FLASH_API_KEY` pair is a partial exception worth naming precisely: `health.service.ts` confirms these two feed **only** the `GET /health` `ai_posture` observability field (config-presence, zero-network-I/O, explicitly caveated as not proof of a working key) — they do not themselves gate an LLM call (the api never calls a provider directly). Their absence from staging compose is therefore inert-by-design, though it does mean `ai_posture` can never read anything but its "mock" default on this box regardless of ai-service's own (correctly wired) posture.

## 11. What Batch 1 already established (referenced, not re-derived)

`optionalSecret()` fail-closed-on-`""` behavior and its application to `SUPABASE_*`/`ZEPTOMAIL_*`; `AI_INTERNAL_TOKEN`'s TD67 fail-closed-at-boot fix and the residual "ai-service has zero auth by default, contained only by loopback-only port bind" (F3); `PAYMENTS_ENABLE_REAL` and siblings' default-false posture (refined in §10, not contradicted); every `InternalServiceGuard`/`SkillsInternalGuard`/`AdminAuthGuard` route's fail-closed-on-unconfigured-secret behavior.

---

**Files/evidence referenced**: `packages/config/src/{server,public,shared}.ts`, `.env.example`, `apps/ai-service/.env{,.staging}.example`, `apps/api/.env.staging.example`, `apps/payer-web/.env.example`, `apps/payer-web/src/lib/{config,server-config}.ts`, `apps/admin-web/src/lib/server-config.ts`, `apps/web/src/lib/{config,api}.ts`, `apps/api/src/config/config.module.ts`, `apps/api/src/health/health.service.ts`, `docker-compose.yml`, `docker-compose.staging.yml`, the four `*-compose.guard.test.ts` files, `apps/ai-service/app/config.py`.
