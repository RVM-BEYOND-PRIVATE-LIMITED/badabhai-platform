# Environment Variables

> **Authoritative reference for every env var BadaBhai reads.** Grounded in the
> Zod/Pydantic schemas that actually parse them — not a hand-maintained list:
>
> - Node backend (secret-bearing): [`packages/config/src/server.ts`](../packages/config/src/server.ts) (`serverEnvSchema`)
> - Web public split: [`packages/config/src/public.ts`](../packages/config/src/public.ts) (`publicEnvSchema`)
> - AI service (Python): [`apps/ai-service/app/config.py`](../apps/ai-service/app/config.py) (`Settings`)
> - Copy-me template: [`.env.example`](../.env.example) (placeholders only)
>
> **No secret VALUES live in this repo.** This doc lists var NAMES + purpose only.
> The no-secrets rule is an invariant — see [`CLAUDE.md` §6](../CLAUDE.md) (_"No secrets /
> `.env` committed"_) and the harness guard [`.claude/hooks/guard-secrets.mjs`](../.claude/hooks/guard-secrets.mjs).
> To set up locally: `cp .env.example .env` and fill placeholders for **local dev only**.

---

## How to read this doc

- **SECRET** = backend-only, never shipped to a client bundle, never logged. Lives in
  `serverEnvSchema` or the AI-service `Settings`. A SECRET that leaks into the browser is
  a security incident.
- **public** = `NEXT_PUBLIC_*`, safe to ship to the browser. Lives in `publicEnvSchema`.
- **Default** = the schema default (the var is optional). **(required)** = no default;
  the listed boot guard fails closed if it is missing/insecure outside dev/test.
- **Consumed by** = which service process actually reads it.

The Node `config.NODE_ENV` parse is **fail-open** (defaults to `development` on an unset
env) — security gates therefore route through `isDevEnv()`, which reads the **raw**
`process.env.NODE_ENV` and fails closed. See [`packages/config/src/shared.ts`](../packages/config/src/shared.ts).

---

## Fail-closed boot guards (read this first)

The Node API calls these once at boot ([`apps/api/src/main.ts`](../apps/api/src/main.ts));
each throws and refuses to boot rather than run mis-configured. They are the reason a
forgotten secret in staging/prod is a loud crash, not a silent downgrade.

| Guard (in `server.ts`)  | Throws at boot when (outside explicit `development`/`test`)                                           | Vars enforced                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `assertPiiCryptoConfig` | `PII_HASH_PEPPER` / `PII_ENCRYPTION_KEY` still the dev default, or an all-zero AES key                | `PII_HASH_PEPPER`, `PII_ENCRYPTION_KEY`         |
| `assertAuthConfig`      | `JWT_SECRET` is the dev default, `SMS_PROVIDER=console`, or `fast2sms` chosen without its credentials | `JWT_SECRET`, `SMS_PROVIDER`, `FAST2SMS_*`      |
| `assertPaymentsConfig`  | `PAYMENTS_ENABLE_REAL=true` but no `PAYMENTS_PROVIDER_KEY` (ADR-0010 F-6) — applies in **any** env    | `PAYMENTS_ENABLE_REAL`, `PAYMENTS_PROVIDER_KEY` |

**Default-FALSE gates** (real external traffic stays off until _explicitly_ enabled —
[`CLAUDE.md` §2 invariant 5](../CLAUDE.md)):

| Gate                                     | Master credential it also requires             | "Blocked reason" helper                                                          |
| ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `AI_ENABLE_REAL_CALLS`                   | `GEMINI_FLASH_API_KEY`                         | `realAiCallsBlockedReason` (server.ts) / `real_calls_blocked_reason` (config.py) |
| `PAYMENTS_ENABLE_REAL`                   | `PAYMENTS_PROVIDER_KEY`                        | `realPaymentsBlockedReason` (server.ts)                                          |
| `RESUME_RENDER_ENABLED`                  | WeasyPrint binary present in the image         | — (degrades to "no PDF" when off)                                                |
| `AI_REAL_CALLS_KILL_SWITCH` (AI service) | n/a — independent HARD kill, checked **first** | `real_calls_blocked_reason` (config.py)                                          |

Enabling real LLM/payment/SMS providers in a shared env is **human-gated + staging-first**
([`CLAUDE.md` §7](../CLAUDE.md)). Real-LLM rollout runbook:
[`docs/ai/enable-real-llm-extraction.md`](ai/enable-real-llm-extraction.md). Staging
resume-render enablement template: [`apps/api/.env.staging.example`](../apps/api/.env.staging.example).

---

## Node API — `serverEnvSchema` (all SECRET-bearing; backend only)

### Runtime

| Name       | Purpose                                                                                                               | Default       | Class  |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------- | ------ |
| `NODE_ENV` | Runtime mode. **Footgun:** parsed value is fail-open; security gates use raw `process.env.NODE_ENV` via `isDevEnv()`. | `development` | config |

### Core datastores

| Name           | Purpose                                                | Default                                                  | Class            |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------- | ---------------- |
| `DATABASE_URL` | Postgres connection (Drizzle + API).                   | `postgresql://badabhai:badabhai@localhost:5432/badabhai` | SECRET (in prod) |
| `REDIS_URL`    | Redis — sessions, OTP HMAC store, rate-limit counters. | `redis://localhost:6379`                                 | SECRET (in prod) |

### Supabase + Storage buckets (backend / service-role only)

| Name                        | Purpose                                                                                                            | Default                | Class                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------- |
| `SUPABASE_URL`              | Supabase project URL (Storage REST).                                                                               | _(optional)_           | config (URL is non-secret) |
| `SUPABASE_SERVICE_ROLE_KEY` | God-key; bypasses RLS by design. **Never** in a client bundle or log.                                              | _(optional)_           | **SECRET**                 |
| `CONVERSATIONS_BUCKET`      | Private bucket: worker-conversation JSON (ADR-0003). Object keys are opaque UUIDs — no PII in the path.            | `worker-conversations` | config                     |
| `RESUMES_BUCKET`            | Private bucket: rendered resume PDFs (TD5). Must be created PRIVATE out-of-band — RLS does not cover Storage ACLs. | `worker-resumes`       | config                     |
| `INTERVIEW_KIT_BUCKET`      | Private bucket: per-trade interview-kit PDFs (TD24). PII-free (per-trade), still PRIVATE.                          | `interview-kits`       | config                     |

Bucket provisioning is out-of-band (not a Drizzle migration):
[`infra/supabase/storage-buckets.sql`](../infra/supabase/storage-buckets.sql) /
[`infra/supabase/storage-buckets.md`](../infra/supabase/storage-buckets.md).

### Resume / interview-kit render worker (TD5 / TD24)

| Name                                       | Purpose                                                                                                                                                                                                                                 | Default      | Class      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- |
| `RESUME_RENDER_ENABLED`                    | Master kill-switch for the WeasyPrint render step (governs **both** resume + interview-kit). Off ⇒ renderer degrades to null PDF.                                                                                                       | `false`      | gate       |
| `RESUME_DAILY_CAP`                         | Per-worker generations per UTC day.                                                                                                                                                                                                     | `5`          | config     |
| `RESUME_GLOBAL_DAILY_CAP`                  | Global generations per UTC day (interim backstop until TD4 binds an authenticated worker).                                                                                                                                              | `5000`       | config     |
| `RESUME_SIGNED_URL_TTL_SECONDS`            | TTL of a freshly minted signed download URL.                                                                                                                                                                                            | `900`        | config     |
| `RESUME_RATE_LIMIT_PER_IP_PER_HOUR`        | Per-IP download cap / rolling UTC hour (IP is HMAC-hashed; fail-closed on Redis outage).                                                                                                                                                | `20`         | config     |
| `INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR` | Same, for interview-kit downloads.                                                                                                                                                                                                      | `20`         | config     |
| `INTERVIEW_KIT_CONTENT_VERSION`            | Render-once identity part — bump when kit copy changes so a fresh PDF renders. Never reuse an old value.                                                                                                                                | `1`          | config     |
| `INTERNAL_SERVICE_TOKEN`                   | Service-to-service secret gating ops/backend resume routes (`GET /resume/:id`, `/:id/download`, `/:id/share`, `/:id/regenerate`). **Unset ⇒ those routes deny all callers (fail closed).** Also read by the ops console server process. | _(optional)_ | **SECRET** |

### PII protection (backend only — invariant: no raw PII past the `workers` table)

| Name                 | Purpose                                                                                                                     | Default                              | Class      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------- |
| `PII_HASH_PEPPER`    | Pepper for the keyed HMAC of phone/IP. **(required in prod — `assertPiiCryptoConfig`.)**                                    | dev default (insecure)               | **SECRET** |
| `PII_ENCRYPTION_KEY` | AES-256 key (base64 of exactly 32 bytes) encrypting `phone_e164` at rest. Key never touches the DB. **(required in prod.)** | dev default (all-zero key, insecure) | **SECRET** |

### Worker auth — OTP login + rolling JWT session (backend only)

| Name                          | Purpose                                                                                                                  | Default                | Class       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------- |
| `JWT_SECRET`                  | Signs the worker session token. **(required in prod — `assertAuthConfig`.)**                                             | dev default (insecure) | **SECRET**  |
| `SESSION_TTL_DAYS`            | Session lifetime; token + Redis session share this TTL (rolling/sliding).                                                | `30`                   | config      |
| `OTP_LENGTH`                  | OTP digit count (4–8).                                                                                                   | `6`                    | config      |
| `OTP_TTL_SECONDS`             | OTP validity window.                                                                                                     | `300`                  | config      |
| `OTP_MAX_ATTEMPTS`            | Max verify attempts per OTP.                                                                                             | `5`                    | config      |
| `OTP_RESEND_COOLDOWN_SECONDS` | Min gap between resends.                                                                                                 | `30`                   | config      |
| `OTP_MAX_SENDS_PER_HOUR`      | Per-phone send cap / hour.                                                                                               | `5`                    | config      |
| `SMS_PROVIDER`                | `console` (prints OTP to log — **dev/test ONLY**, blocked by `assertAuthConfig` elsewhere) or `fast2sms` (real DLT SMS). | `console`              | gate/config |
| `FAST2SMS_API_KEY`            | Fast2SMS credential — required when `SMS_PROVIDER=fast2sms`.                                                             | _(optional)_           | **SECRET**  |
| `FAST2SMS_SENDER_ID`          | Fast2SMS DLT sender id — required for `fast2sms`.                                                                        | _(optional)_           | SECRET      |
| `FAST2SMS_DLT_TEMPLATE_ID`    | Approved DLT template id — required for `fast2sms`.                                                                      | _(optional)_           | SECRET      |
| `FAST2SMS_ENTITY_ID`          | DLT entity id.                                                                                                           | _(optional)_           | SECRET      |
| `FAST2SMS_ROUTE`              | Fast2SMS route.                                                                                                          | `dlt`                  | config      |

### AI routing + real-call gates (Node side — declarative; the AI service makes the actual calls)

The Node API does **not** call LLMs; it forwards to the FastAPI AI service. These vars are
gating/declarative on the Node side and mirror the AI-service credential names (ADR-0008,
direct providers — no LiteLLM).

| Name                         | Purpose                                                                                                            | Default                 | Class      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------- | ---------- |
| `AI_ENABLE_REAL_CALLS`       | Master gate for real LLM traffic. **Off by default** (invariant 5). Pseudonymization always runs first regardless. | `false`                 | gate       |
| `GEMINI_FLASH_API_KEY`       | Master real-call credential (Google AI Studio / Gemini). Without it, real calls stay blocked.                      | _(optional)_            | **SECRET** |
| `ANTHROPIC_API_KEY`          | Optional fallback-provider key — only **adds** Claude Haiku to the fallback chain; never a master gate.            | _(optional)_            | **SECRET** |
| `LITELLM_API_KEY`            | **DEPRECATED (TD28)** — back-compat alias for `GEMINI_FLASH_API_KEY` for one release. Prefer the new name.         | _(optional)_            | **SECRET** |
| `DEFAULT_CHEAP_MODEL`        | Cheap-tier model id (high-volume chat turns).                                                                      | `gemini-2.5-flash-lite` | config     |
| `DEFAULT_CAPABLE_MODEL`      | Capable-tier model id (strict-JSON extraction).                                                                    | `gemini-2.5-flash`      | config     |
| `AI_COST_ALERT_PROFILE_INR`  | Per-profile cost alert threshold (INR).                                                                            | `6`                     | config     |
| `AI_TARGET_PROFILE_COST_INR` | Per-profile cost target (INR).                                                                                     | `4`                     | config     |
| `AI_MAX_CALL_COST_INR`       | Hard per-call ceiling (INR) — worst-case over this ⇒ refused, falls back to mock.                                  | `10`                    | config     |
| `GOOGLE_CLOUD_PROJECT`       | Legacy GCP declaration; unused by the Node API (kept optional for back-compat).                                    | _(optional)_            | config     |
| `GOOGLE_CLOUD_LOCATION`      | Legacy GCP declaration; unused.                                                                                    | _(optional)_            | config     |
| `GEMINI_API_KEY`             | Legacy Gemini key declaration; unused by the Node API (AI service uses `GEMINI_FLASH_API_KEY`).                    | _(optional)_            | **SECRET** |

### Payments — Contact Unlock + Reveal (mock credits in alpha; ADR-0010)

| Name                                    | Purpose                                                                                                                           | Default      | Class      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- |
| `PAYMENTS_ENABLE_REAL`                  | Master gate for real money movement. **Off by default**; flipping true requires a gateway key AND is human-gated + staging-first. | `false`      | gate       |
| `PAYMENTS_PROVIDER_KEY`                 | Opaque real-gateway key (e.g. Razorpay). Unused in alpha (mock ledger).                                                           | _(optional)_ | **SECRET** |
| `UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY` | Worker-protection cap (config-driven, no migration to tune).                                                                      | `5`          | config     |
| `UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK` | Worker-protection cap.                                                                                                            | `10`         | config     |
| `UNLOCK_MAX_ATTEMPTS_PER_UNLOCK`        | Worker-protection cap.                                                                                                            | `3`          | config     |

### STT (Sarvam — placeholder)

| Name             | Purpose                                                                                                                 | Default      | Class      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- |
| `SARVAM_API_KEY` | Sarvam STT credential. Real STT also requires `AI_ENABLE_REAL_CALLS=true` (fails closed to empty transcript otherwise). | _(optional)_ | **SECRET** |

### Observability — Langfuse (placeholders; tracing disabled unless both keys set)

| Name                  | Purpose              | Default                      | Class      |
| --------------------- | -------------------- | ---------------------------- | ---------- |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key. | _(optional)_                 | SECRET     |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key. | _(optional)_                 | **SECRET** |
| `LANGFUSE_BASE_URL`   | Langfuse endpoint.   | `https://cloud.langfuse.com` | config     |

### Service URLs / ports

| Name             | Purpose                                            | Default                 | Class  |
| ---------------- | -------------------------------------------------- | ----------------------- | ------ |
| `API_PORT`       | NestJS API listen port.                            | `3001`                  | config |
| `AI_SERVICE_URL` | Where the Node API reaches the FastAPI AI service. | `http://localhost:8000` | config |

---

## AI service — `Settings` (Python / pydantic-settings; backend only)

Reads `apps/ai-service/.env` (or the process env). pydantic-settings is case-insensitive,
so field `gemini_flash_api_key` ⇄ env `GEMINI_FLASH_API_KEY`. Real LLM calls fail closed —
`real_calls_blocked_reason` requires the master flag **and** the Gemini key, with the kill
switch checked first.

### Real-call gating

| Env name                    | Purpose                                                                                                                                                                                                 | Default      | Class      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- |
| `AI_ENABLE_REAL_CALLS`      | Master flag for real calls (mirrors the Node side).                                                                                                                                                     | `false`      | gate       |
| `AI_REAL_CALLS_KILL_SWITCH` | Independent HARD kill (TD27) — blocks real calls **before** the flag/key checks.                                                                                                                        | `false`      | gate       |
| `AI_REAL_CALL_TASKS`        | Per-task allowlist (comma-separated `TaskType`s). **Empty = all tasks.** Lets one task go real while others stay mock. See [`docs/ai/enable-real-llm-extraction.md`](ai/enable-real-llm-extraction.md). | `""`         | gate       |
| `GEMINI_FLASH_API_KEY`      | Primary real-call credential + master gate.                                                                                                                                                             | _(optional)_ | **SECRET** |
| `ANTHROPIC_API_KEY`         | Fallback-provider credential — adds Claude Haiku to the chain; not a master gate.                                                                                                                       | _(optional)_ | **SECRET** |

### Model routing + cost / spend caps (INR)

| Env name                         | Purpose                                                                                              | Default                 | Class  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------- | ------ |
| `DEFAULT_CHEAP_MODEL`            | Cheap-tier model id.                                                                                 | `gemini-2.5-flash-lite` | config |
| `DEFAULT_CAPABLE_MODEL`          | Capable-tier model id.                                                                               | `gemini-2.5-flash-lite` | config |
| `DEFAULT_FALLBACK_MODEL`         | Cross-provider fallback model (used only after the primary fails and when the Anthropic key is set). | `claude-haiku-4-5`      | config |
| `AI_COST_ALERT_PROFILE_INR`      | Per-profile cost alert.                                                                              | `6.0`                   | config |
| `AI_TARGET_PROFILE_COST_INR`     | Per-profile cost target.                                                                             | `4.0`                   | config |
| `AI_MAX_CALL_COST_INR`           | Hard per-call ceiling — over ⇒ falls back to mock.                                                   | `10.0`                  | config |
| `AI_MAX_DAILY_COST_INR`          | Rolling per-UTC-day spend cap (TD27).                                                                | `200.0`                 | config |
| `AI_MAX_TOTAL_COST_INR`          | Process-lifetime cumulative spend cap (TD27).                                                        | `1000.0`                | config |
| `AI_MAX_USER_DAILY_COST_INR`     | Per-user (opaque `worker_ref`, PII-free) per-UTC-day spend cap.                                      | `6.0`                   | config |
| `AI_RETRY_BUDGET_PER_WINDOW`     | Max retry attempts across all requests within the window.                                            | `20`                    | config |
| `AI_RETRY_BUDGET_WINDOW_SECONDS` | Retry-budget window.                                                                                 | `60`                    | config |

### STT (Sarvam)

| Env name                 | Purpose                                                    | Default        | Class      |
| ------------------------ | ---------------------------------------------------------- | -------------- | ---------- |
| `SARVAM_API_KEY`         | Sarvam STT credential.                                     | _(optional)_   | **SECRET** |
| `SARVAM_STT_MODEL`       | STT model id (config so the `saaras:v3` swap is one line). | `saarika:v2.5` | config     |
| `SARVAM_TRANSLATE_MODEL` | Translation model (auto-detect + code-mixed Hinglish).     | `mayura:v1`    | config     |

### Storage (Mode A — read-only voice audio for real STT)

| Env name                    | Purpose                                                                                                   | Default              | Class                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------- |
| `SUPABASE_URL`              | Supabase project URL (Storage object GET only).                                                           | _(optional)_         | config (URL is non-secret) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key; backend-only; never logged. Real STT fails closed to empty if storage isn't configured. | _(optional)_         | **SECRET**                 |
| `VOICE_NOTES_BUCKET`        | Private bucket of uploaded voice notes; object key = request `storage_path`. Must be PRIVATE out-of-band. | `worker-voice-notes` | config                     |

### Observability + port

| Env name              | Purpose                                                        | Default                      | Class      |
| --------------------- | -------------------------------------------------------------- | ---------------------------- | ---------- |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key (tracing enabled only when both keys set). | _(optional)_                 | SECRET     |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key.                                           | _(optional)_                 | **SECRET** |
| `LANGFUSE_BASE_URL`   | Langfuse endpoint.                                             | `https://cloud.langfuse.com` | config     |
| `AI_SERVICE_PORT`     | FastAPI listen port.                                           | `8000`                       | config     |

---

## Web (Next.js ops console) — public split

Frontends import [`@badabhai/config/public`](../packages/config/src/public.ts) — they
**never** import `serverEnvSchema`, so a missing backend secret can never crash the web app.
`publicEnvSchema` whitelists only the keys below; any leaked server key in the env is ignored.

| Name                      | Purpose                                                                                                        | Default                 | Class  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------- | ------ |
| `NODE_ENV`                | Runtime mode (parsed, fail-open).                                                                              | `development`           | public |
| `NEXT_PUBLIC_API_URL`     | Base URL the browser uses for the API ([`apps/web/src/lib/api.ts`](../apps/web/src/lib/api.ts), `layout.tsx`). | `http://localhost:3001` | public |
| `NEXT_PUBLIC_ENVIRONMENT` | Environment tag shown in the ops UI.                                                                           | `development`           | public |

**Server-only var read by the web process** (NOT `NEXT_PUBLIC_*`, never inlined into the
client bundle — read via `process.env` in Server Components only):

| Name                     | Purpose                                                                                                                                                                                                                            | Class      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `INTERNAL_SERVICE_TOKEN` | Same shared secret as the API. The ops applicants/pricing pages (ADR-0009) call API routes behind `InternalServiceGuard`; `apiPostInternal`/`apiGetInternal` attach it as `x-internal-service-token`. Unset ⇒ those reads get 401. | **SECRET** |

> TODO(verify): `.env.example` also lists `NEXT_PUBLIC_SUPABASE_URL`,
> `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `WEB_PORT`, and `AI_SERVICE_PORT` (Node side), but none
> of these are declared in `publicEnvSchema`/`serverEnvSchema` nor referenced in `apps/web`
> source at the time of writing — they appear template-only / forward-looking. If you add
> Supabase-browser auth to the ops console, declare them in `publicEnvSchema` first.

---

## Related

- Template to copy: [`.env.example`](../.env.example)
- Staging resume-render enablement: [`apps/api/.env.staging.example`](../apps/api/.env.staging.example)
- Real-LLM rollout runbook: [`docs/ai/enable-real-llm-extraction.md`](ai/enable-real-llm-extraction.md)
- Storage bucket provisioning: [`infra/supabase/storage-buckets.md`](../infra/supabase/storage-buckets.md)
- No-secrets invariant + quality gate: [`CLAUDE.md` §6](../CLAUDE.md)
- AI direct-provider decision: [`docs/decisions/0008-litellm-to-direct-providers.md`](decisions/0008-litellm-to-direct-providers.md)
- Payments gate decision: [`docs/decisions/0010`](decisions/) (ADR-0010 — Contact Unlock)
