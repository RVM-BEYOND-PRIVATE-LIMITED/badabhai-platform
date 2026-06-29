# Env & Secrets Tracker

**Never print secret values here.** Names + status only. Source: [.env.example](../../.env.example),
[docs/environment-variables.md](../environment-variables.md), `packages/config/src/{server,public}.ts`.

Legend — Required: ✅ yes / — no / ⚙️ has safe default. Secret: 🔒 secret / 🌐 public (browser).
Status: `OK` (set & validated) / `MISSING` / `DEFAULT` (dev default) / `STAGING-PENDING`.

## Crypto / auth (fail-closed at boot outside dev)
| Var | Secret | Local | Staging | Prod | Owner | Status |
| --- | ------ | ----- | ------- | ---- | ----- | ------ |
| `JWT_SECRET` | 🔒 | ⚙️ | ✅ | ✅ | DevOps | DEFAULT local / STAGING-PENDING |
| `PII_ENCRYPTION_KEY` | 🔒 | ⚙️ | ✅ | ✅ | DevOps | DEFAULT local / STAGING-PENDING |
| `PII_HASH_PEPPER` | 🔒 | ⚙️ | ✅ | ✅ | DevOps | DEFAULT local / STAGING-PENDING |
| `INTERNAL_SERVICE_TOKEN` | 🔒 | ✅ | ✅ | ✅ | DevOps | STAGING-PENDING |
| `SESSION_TTL_DAYS` | 🌐 | ⚙️ | ⚙️ | ⚙️ | backend | OK |

## Database / cache
| Var | Secret | Local | Staging | Prod | Status |
| --- | ------ | ----- | ------- | ---- | ------ |
| `DATABASE_URL` | 🔒 | ✅ | ✅ | ✅ | OK local (cloud Supabase reconciled) / STAGING-PENDING |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | 🔒 | ✅ | ✅ | ✅ | STAGING-PENDING |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | 🌐 | ⚙️ | ✅ | ✅ | OK |
| `REDIS_URL` | 🔒 | ✅ | ✅ | ✅ | OK local / STAGING-PENDING |

## OTP — SMS (Fast2SMS, worker) — REAL-ONLY
| Var | Secret | Local | Staging | Prod | Status |
| --- | ------ | ----- | ------- | ---- | ------ |
| `SMS_PROVIDER` | 🌐 | ⚙️ | ✅(fast2sms) | ✅ | DEFAULT |
| `FAST2SMS_API_KEY` | 🔒 | — | ✅ | ✅ | MISSING until OTP-7 (D2) |
| `FAST2SMS_SENDER_ID` / `_DLT_TEMPLATE_ID` / `_ENTITY_ID` / `_ROUTE` | 🔒/🌐 | — | ✅ | ✅ | MISSING until OTP-7 |
| `OTP_TTL_SECONDS` / `_LENGTH` / `_MAX_ATTEMPTS` / `_MAX_SENDS_PER_HOUR` / `_RESEND_COOLDOWN_SECONDS` / `_GLOBAL_MAX_SENDS_PER_DAY` | 🌐 | ⚙️ | ⚙️ (cap low) | ⚙️ | OK |

## OTP — Email (ZeptoMail/SMTP, payer) — REAL-ONLY
| Var | Secret | Local | Staging | Prod | Status |
| --- | ------ | ----- | ------- | ---- | ------ |
| `EMAIL_PROVIDER` | 🌐 | ⚙️ | ✅ | ✅ | DEFAULT |
| `ZEPTOMAIL_API_TOKEN` / `_MAIL_AGENT` / `_API_URL` / `_SANDBOX_MODE` | 🔒/🌐 | — | ✅ | ✅ | MISSING until OTP-7 |
| `SMTP_HOST`/`_PORT`/`_USER`/`_PASS`/`_FROM` | 🔒 | — | ⚙️(alt) | ⚙️ | optional fallback |
| `EMAIL_FROM_ADDRESS` / `_FROM_NAME` / `_REPLY_TO` | 🌐 | ⚙️ | ✅ | ✅ | DEFAULT |
| `PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY` | 🌐 | ⚙️ | ⚙️ | ⚙️ | OK |

## Real-provider gates (DEFAULT OFF — keep off through alpha)
| Var | Secret | Default | Status |
| --- | ------ | ------- | ------ |
| `AI_ENABLE_REAL_CALLS` | 🌐 | false | OK (off) |
| `PAYMENTS_ENABLE_REAL` | 🌐 | false | OK (off) |
| `MESSAGING_ENABLE_REAL` | 🌐 | false | OK (off) |
| `RESUME_RENDER_ENABLED` | 🌐 | false | OK (off — D5) |
| `AI_REAL_CALL_TASKS` / `AI_MAX_CALL_COST_INR` / `AI_TARGET_PROFILE_COST_INR` / `AI_COST_ALERT_PROFILE_INR` | 🌐 | ⚙️ | OK |

## AI / STT / observability (gated; not needed for alpha mock path)
| Var | Secret | Needed for | Status |
| --- | ------ | ---------- | ------ |
| `GEMINI_API_KEY` / `GEMINI_FLASH_API_KEY` / `ANTHROPIC_API_KEY` | 🔒 | real LLM (gated) | MISSING (intended) |
| `GOOGLE_CLOUD_PROJECT` / `_LOCATION` / `DEFAULT_*_MODEL` | 🌐 | LLM routing | DEFAULT |
| `SARVAM_API_KEY` / `SARVAM_STT_MODEL` / `_TRANSLATE_MODEL` | 🔒/🌐 | voice (PARKED) | MISSING (intended) |
| `LANGFUSE_*` | 🔒 | AI tracing (placeholder) | MISSING (intended) |
| `WHATSAPP_API_KEY` / `_PHONE_NUMBER_ID` | 🔒 | real WhatsApp (mock now) | MISSING (intended) |

## App / ports / buckets
| Var | Secret | Status |
| --- | ------ | ------ |
| `API_PORT` / `WEB_PORT` / `AI_SERVICE_PORT` / `AI_SERVICE_URL` | 🌐 | OK |
| `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_ENVIRONMENT` | 🌐 | OK |
| `NODE_ENV` | 🌐 | OK |
| `*_BUCKET` (CONVERSATIONS/RESUMES/INTERVIEW_KIT/VOICE_NOTES) | 🌐 | OK (private ACL out-of-band) |
| `RESUME_*` / `INTERVIEW_KIT_*` caps | 🌐 | OK |

## GitHub Actions / staging environment (D1)
- **CI** (`ci.yml`): uses CI-dummy provider placeholders + service-container PG/Redis. **No real secrets.** Status: OK.
- **`staging` Environment secrets needed (D1):** `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PII_ENCRYPTION_KEY`, `PII_HASH_PEPPER`, `INTERNAL_SERVICE_TOKEN`, `STAGING_API_BASE_URL`, `STAGING_DEPLOY_HOOK_URL` (optional), + Fast2SMS + ZeptoMail set (D2). **Status: ALL MISSING (staging-cd inert until created).**

## Findings
- ✅ **No `NEXT_PUBLIC_` secret misuse** — all secrets are backend-only.
- ✅ Fail-closed boot guards (`assertAuthConfig` / `assertPiiCryptoConfig` / `assertPaymentsConfig`).
- ✅ `.env` access blocked by the harness guard hook; `.env.example` is the template.
- ⚠️ Staging secret set not created → **staging CD cannot run** (the P0 alpha blocker, D1).

---
_Do not paste values. To mark a row OK, confirm it loads + the boot guard passes on that environment._
