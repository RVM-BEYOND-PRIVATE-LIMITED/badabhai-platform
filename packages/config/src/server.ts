import { z } from "zod";
import { booleanFromString, portSchema, nodeEnvSchema, isDevEnv, formatEnvError } from "./shared";

/**
 * Server-side (secret-bearing) configuration.
 *
 * SECURITY: this schema includes the Supabase service-role key and LLM/STT
 * secrets. It must ONLY be loaded in backend services (NestJS API, FastAPI is
 * separate). NEVER import this from the web/worker frontends — use
 * `@badabhai/config/public` there.
 *
 * Most fields are optional with safe local defaults so the API can boot in dev
 * without every secret. Real AI calls are gated separately (see
 * `assertRealAiConfig`) so the system fails closed rather than half-configured.
 */
/**
 * Dev-only PII secrets. They keep local boot + tests working without real
 * secrets; production MUST override both (enforced by assertPiiCryptoConfig).
 */
export const DEV_PII_HASH_PEPPER = "dev-insecure-pii-pepper-change-me";
export const DEV_PII_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64"); // 32 zero bytes

/**
 * Dev-only JWT signing secret. Keeps local boot + tests working without a real
 * secret; production MUST override it (enforced by assertAuthConfig).
 */
export const DEV_JWT_SECRET = "dev-insecure-jwt-secret-change-me";

/**
 * Dev-only PIN pepper (ADR-0026 Phase 3). DISTINCT from DEV_PII_HASH_PEPPER: the device-
 * unlock PIN is hashed (scrypt) with its OWN server pepper so the PIN KDF is cryptographically
 * independent of the phone/IP HMAC pepper. Keeps local boot + tests working; production MUST
 * override it (enforced by assertAuthConfig — fail-closed), exactly like PII_HASH_PEPPER.
 */
export const DEV_PIN_PEPPER = "dev-insecure-pin-pepper-change-me";

/**
 * Dev-only ADMIN session signing secret (ADR-0025 ADMIN-1). DISTINCT from DEV_JWT_SECRET:
 * the admin session is signed with its OWN secret so an admin token is cryptographically
 * unrelated to a worker/payer token (defense-in-depth behind the `typ:"admin"` audience
 * pin + the separate Redis namespace). Keeps local boot + tests working; production MUST
 * override it (enforced by assertAdminAuthConfig — fail-closed).
 */
export const DEV_ADMIN_JWT_SECRET = "dev-insecure-admin-jwt-secret-change-me";

export const serverEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,

  // Core datastores
  DATABASE_URL: z.string().url().default("postgresql://badabhai:badabhai@localhost:5432/badabhai"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // Supabase (backend only)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  // Private Storage bucket holding the full worker-conversation JSON artifact
  // (transcript + final state snapshot). Backend/service-role access ONLY — never
  // reachable by web/Flutter. Object keys carry opaque UUIDs only (no PII). See
  // ADR-0003. Reuses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Storage Mode A).
  CONVERSATIONS_BUCKET: z.string().min(1).default("worker-conversations"),
  // Private Storage bucket holding rendered resume PDFs (TD5). Backend/service-role
  // access ONLY — same Storage Mode A as CONVERSATIONS_BUCKET. Object keys are opaque
  // UUIDs (worker_id/resume_id) only; the worker's name lives INSIDE the PDF bytes,
  // never in the path. MUST be created PRIVATE out-of-band (anon denied); RLS only
  // covers Postgres tables, not Storage object ACLs.
  RESUMES_BUCKET: z.string().min(1).default("worker-resumes"),
  // ADR-0026 Phase 5 (security Finding 1) — private Storage bucket for raw worker AUDIO
  // (voice-note blobs). EMPTY DEFAULT is deliberate: voice upload is a Phase-1 placeholder —
  // the client supplies a `voice_notes.storage_path` (e.g. "worker/sess/v1.ogg") but there is
  // NO backend audio bucket today, so DSAR audio erasure is a WIRED-BUT-DORMANT seam. When a
  // real audio bucket lands, set this (or store audio under conversationWorkerPrefix) so
  // AccountDeletionService erases the audio blobs that hold raw PII (the transcript lives on
  // the row, erased by the cascade; the blob at storage_path must be erased here). Unset → skip.
  VOICE_NOTES_BUCKET: z.string().default(""),
  // ADR-0032 — private Storage bucket for worker profile PHOTOS (a face photo is a
  // high-sensitivity PII class). Same Storage Mode A (service-role, backend-only);
  // object keys are opaque `photos/{workerId}/{uuid}.jpg` (server-chosen, never
  // client-supplied). EMPTY DEFAULT is deliberate (voice pattern): while unset the
  // photo endpoints 503 fail-closed and the feature is inert. Setting it (the bucket
  // `worker-profile-photos` exists PRIVATE, provisioned out-of-band) simultaneously
  // arms the account-deletion erase leg — no gap where photos exist but erasure is
  // dormant. The photo is for the worker's OWN app + OWN resume PDF only — it must
  // NEVER reach the payer surface, the disclosure PDF, events, ai_jobs, or logs.
  WORKER_PHOTOS_BUCKET: z.string().default(""),
  // Private Storage bucket holding rendered per-trade interview-kit PDFs (TD24, Task 4).
  // Same Storage Mode A (service-role, backend-only). Object keys are
  // `interview-kits/{tradeKey}/{contentVersion}/interview-kit.pdf` — fully deterministic,
  // PII-FREE (no worker identity in the path or the kit; kits are per-TRADE, not per-worker).
  // MUST be created PRIVATE out-of-band (anon denied).
  INTERVIEW_KIT_BUCKET: z.string().min(1).default("interview-kits"),

  // Resume render worker (TD5).
  // Master kill-switch for the WeasyPrint render step (the requested WEASYPRINT_ENABLED
  // maps onto this — one switch governs BOTH resume and interview-kit rendering, since
  // they share the WeasyPrint core). When false the renderer degrades to null (no PDF),
  // so the system runs without the binary in local dev. Default OFF: enable via env in
  // staging/prod once the binary is present (Dockerfile installs it).
  RESUME_RENDER_ENABLED: booleanFromString,
  // Per-worker generations allowed per UTC day (paid-path abuse cap).
  RESUME_DAILY_CAP: z.coerce.number().int().positive().default(5),
  // Global generations allowed per UTC day — interim backstop until TD4 binds a
  // request to an authenticated worker (today a caller could rotate worker_id).
  RESUME_GLOBAL_DAILY_CAP: z.coerce.number().int().positive().default(5000),
  // TTL (seconds) for a freshly minted signed download URL.
  RESUME_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Per-IP download caps per ROLLING UTC hour (TD24 abuse backstop, complements the
  // per-worker/global day caps). The IP is HMAC-hashed before it touches Redis/logs.
  // Fail-closed: a Redis outage rejects (429) rather than uncapping.
  RESUME_RATE_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),
  INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),
  // ADR-0032 photo upload-url mint cap (bb-security-review M-1): an unthrottled mint
  // would let a hostile worker fabricate unlimited ≤2MiB orphan objects (upload-but-
  // never-confirm) — a storage-cost + erasure-surface abuse. Same fail-closed idiom.
  PHOTO_RATE_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),
  // Referral-attribution hook (ADR-0022 Amendment 1) per-IP cap / rolling UTC hour. The
  // worker-authed POST /referrals/attribute is a low-frequency onboarding side-signal; an
  // uncapped one lets an authed worker spam attribution reads (DB-load + a timing probe) —
  // bb-security-review LOW-MED. Same fail-closed idiom (Redis outage → 429, never uncapped).
  REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),
  // Interview-kit content version. Part of the render-once identity (tradeKey +
  // contentVersion). BUMP this whenever any kit copy changes so a fresh PDF is
  // rendered instead of serving the stale cached file. Never reuse an old value.
  INTERVIEW_KIT_CONTENT_VERSION: z.coerce.number().int().positive().default(1),
  // Internal SERVICE-to-service secret (NOT user auth) gating the ops/backend-only
  // resume routes that return PII or mint signed URLs (GET /resume/:id, /:id/download,
  // /:id/share, /:id/regenerate). Unset => those routes deny ALL callers (fail closed).
  // It does NOT establish a per-worker identity — that needs TD4/R1. Treat as a secret
  // (R8/TD10). The ops console reads resumes via /workers/:id/profile and is unaffected.
  INTERNAL_SERVICE_TOKEN: z.string().min(1).optional(),

  // SCOPED service secret for the FORK-B-1 skill-canonicalization seam ONLY
  // (POST /internal/skills/nearest-aliases + /unresolved — SkillsInternalGuard).
  // DELIBERATELY distinct from INTERNAL_SERVICE_TOKEN (least privilege): the
  // ai-service holds THIS token and can reach nothing but the two skills routes —
  // never the resume-PII or money routes. Unset => the skills routes deny ALL
  // callers (fail closed). Treat as a secret.
  SKILLS_INTERNAL_TOKEN: z.string().min(1).optional(),

  // PII protection (BACKEND ONLY). Pepper for the keyed HMAC of phone/IP; AES-256
  // key (base64 of 32 bytes) for encrypting phone_e164 at rest. The key NEVER
  // touches the database. Dev defaults keep local boot/tests working; production
  // MUST override both (assertPiiCryptoConfig fails closed otherwise).
  PII_HASH_PEPPER: z.string().min(16).default(DEV_PII_HASH_PEPPER),
  PII_ENCRYPTION_KEY: z
    .string()
    .default(DEV_PII_ENCRYPTION_KEY)
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    }, "PII_ENCRYPTION_KEY must be base64 of exactly 32 bytes"),

  // TD22-1 — staged PII key rotation (phase 1: token v2 + keyring + read-both;
  // NO data touched). OPT-IN pair — BOTH must be set together (both-or-neither,
  // enforced fail-closed at BOOT by assertPiiCryptoConfig, never at first decrypt):
  //   PII_ENCRYPTION_KEYS       — a JSON object mapping a key id ("kid") to a
  //                               base64-encoded 32-byte AES-256 key, e.g.
  //                               '{"k2026a":"<base64 of 32 bytes>"}'. A kid is
  //                               1-32 chars of [A-Za-z0-9_-] — DOT-FREE ("." is
  //                               the token delimiter).
  //   PII_ENCRYPTION_ACTIVE_KID — the kid new v2 tokens are WRITTEN under; must
  //                               be a key of the map.
  // When configured, encrypt emits `v2.<kid>.<iv>.<tag>.<ct>` under the active key
  // and decrypt reads BOTH v2 (kid lookup) and legacy v1 (PII_ENCRYPTION_KEY above,
  // retained as the v1 key). Unset (the default) → exactly today's single-key v1
  // behavior. An EMPTY STRING is a config ERROR, never "silently off" (TD67
  // lesson). Key material NEVER touches the database, logs, events, or errors.
  PII_ENCRYPTION_KEYS: z
    .string()
    .optional()
    .describe(
      'TD22-1 keyring: JSON object map of key id ("kid", 1-32 chars of [A-Za-z0-9_-], dot-free) -> base64-encoded 32-byte AES-256 key. Requires PII_ENCRYPTION_ACTIVE_KID; validated fail-closed at boot.',
    ),
  PII_ENCRYPTION_ACTIVE_KID: z
    .string()
    .optional()
    .describe(
      "TD22-1 keyring: the kid new v2 PII tokens are written under. Must be a key of PII_ENCRYPTION_KEYS; requires PII_ENCRYPTION_KEYS; validated fail-closed at boot.",
    ),

  // Worker auth: OTP login + rolling JWT session (BACKEND ONLY).
  // JWT_SECRET signs the worker session token. Dev default keeps local boot/tests
  // working; production MUST override it (assertAuthConfig fails closed otherwise).
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  // Session lifetime (days). The token + Redis session key share this TTL; an
  // active client gets it refreshed (rolling/sliding) past the half-life.
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // ADR-0026 Phase 1 — engagement-tiered rolling session + opaque rotating refresh
  // token. ALL Phase-1 keys are SERVER-ONLY. The refresh-token endpoints are ALWAYS
  // live (additive); only the tiered idle-TTL / 90d absolute-cap BEHAVIOR is gated.
  //
  // Master gate for the tiered-session BEHAVIOR change (ADR-0026 §Rollout 1). Default
  // OFF (booleanFromString → a falsey string stays OFF, fail-safe to no-behavior-change):
  //   false → the session idle TTL stays today's flat SESSION_TTL_DAYS and NO absolute
  //           cap is enforced (byte-identical to the pre-ADR-0026 rolling behavior).
  //   true  → the idle TTL becomes tier-based (session-tiers.ts) and the absolute cap
  //           (AUTH_SESSION_ABSOLUTE_MAX_DAYS) is enforced — past the cap only a fresh
  //           OTP resets the clock. Flip true in staging-first to activate tiers.
  AUTH_ROLLING_TIERS_ENABLED: booleanFromString,
  // Hard absolute lifetime (days) of a session from the OTP that minted it — only an
  // OTP resets this clock. Enforced ONLY when AUTH_ROLLING_TIERS_ENABLED (else inert).
  AUTH_SESSION_ABSOLUTE_MAX_DAYS: z.coerce.number().int().positive().default(90),
  // Trailing window (days) over which distinct active IST dates are counted to pick the
  // engagement tier. Active days older than this are pruned on every refresh.
  AUTH_TIER_WINDOW_DAYS: z.coerce.number().int().positive().default(60),
  // Opaque rotating-refresh-token lifetime (days). MUST be >= AUTH_SESSION_ABSOLUTE_MAX_DAYS
  // so the refresh record never expires out from under a session that is still inside its
  // absolute cap (else a worker inside the 90d window would lose silent refresh early).
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(90),

  // ADR-0026 Phase 3 — device-unlock PIN (BACKEND ONLY). The PIN is hashed with scrypt +
  // a per-PIN salt + this dedicated server pepper; the hash lives in worker_credentials and
  // NEVER enters events/ai_jobs/audit_logs/logs (§2). Dev default keeps local boot/tests
  // working; production MUST override PIN_PEPPER (assertAuthConfig fails closed otherwise).
  PIN_PEPPER: z.string().min(16).default(DEV_PIN_PEPPER),
  // PIN shape: exactly N digits (4 by default). A weak-PIN denylist is enforced in code.
  PIN_LENGTH: z.coerce.number().int().min(4).max(8).default(4),
  // Server-side throttle (durable in worker_credentials — survives a Redis flush): after
  // PIN_MAX_ATTEMPTS consecutive wrong PINs the account is locked for an EXPONENTIAL backoff
  // (PIN_LOCKOUT_BASE_SECONDS * 2^cycle); after PIN_MAX_LOCKOUT_CYCLES the PIN is invalidated
  // and a fresh OTP + PIN reset is forced (SIM-swap / brute-force defense, R25a).
  PIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PIN_LOCKOUT_BASE_SECONDS: z.coerce.number().int().positive().default(60),
  PIN_MAX_LOCKOUT_CYCLES: z.coerce.number().int().positive().default(5),
  // Lifetime (seconds) of the short-lived pin-challenge token minted by OTP verify when the
  // SIM-swap gate trips (existing account + new device + a PIN is set) — the client must
  // complete /auth/pin/verify within this window or re-OTP.
  PIN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  // ADR-0026 Phase 5 — DPDP account-deletion re-registration cool-down (seconds). After a
  // worker hard-deletes their account, a Redis key keyed on the PII-free phone_hash blocks
  // immediate re-registration / OTP-spend churn for this window (default 7d). Fail-OPEN: a
  // Redis flush losing the key only re-opens normal registration (acceptable for an anti-abuse
  // cool-down — never for auth). nonnegative() so 0 disables the cool-down (no key set).
  ACCOUNT_DELETION_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(604800),

  // D-3 — GATED test-login (worker session-mint) seam for staging smoke / e2e ONLY.
  // Worker login is REAL-ONLY (Fast2SMS), so no automated test can complete an OTP
  // round-trip; this pair arms POST /auth/test-login, which mints a REAL worker
  // session through the SAME AuthService seam the OTP verify path uses (no fork,
  // consent gates unchanged). Posture (all enforced by assertAuthConfig, fail-closed):
  //   - DEFAULT OFF. booleanFromString so a falsey string stays OFF (fail-safe to
  //     inert, like AI_ENABLE_REAL_CALLS). While OFF the route is a NEUTRAL 404.
  //   - Enabled REQUIRES a >=32-char TEST_LOGIN_TOKEN — enabled without one FAILS
  //     BOOT (TD67 lesson: a half-armed secret gate must be loud, never vacuous).
  //     The schema min(32) additionally makes an EMPTY/short token a PARSE error
  //     in every environment (an empty string is a config ERROR, never "off").
  //   - STRUCTURALLY IMPOSSIBLE in production: enabled with NODE_ENV=production —
  //     or any env that is not EXPLICITLY development/test/staging — fails boot.
  //   - Token set but not enabled → inert (fine; the route still 404s).
  // NOTE: this is NOT a resurrection of DEV_QUICK_LOGIN (dead by design) — there is
  // no client-side/dev-mode bypass; the seam is a server secret + env gate.
  TEST_LOGIN_ENABLED: booleanFromString,
  TEST_LOGIN_TOKEN: z.string().min(32).optional(),
  // GLOBAL daily mint ceiling for the test-login seam (security review L1). The
  // per-IP hour cap alone leaves a token holder able to rotate IPs for unlimited
  // mints; this is the IP-INDEPENDENT backstop (the OTP-5 breaker's role for the
  // SMS path). Generous enough for smoke + e2e; far below "unbounded".
  //   min(0) is DELIBERATE: 0 = PAUSED = the test-login kill-switch — the next mint
  //   is refused instantly (env-only, NO redeploy), without disarming the flag.
  TEST_LOGIN_MAX_PER_DAY: z.coerce.number().int().min(0).default(200),
  // ADR-0031 — the PRE-erasure grace window (days). Confirm schedules the hard-delete at
  // now() + this many days (workers.deletion_scheduled_at); the worker may cancel anytime
  // until the sweep erases. positive(): 0 would silently restore ADR-0026's immediate
  // erasure and break the app's disclosed "7 din" promise — an instant-delete regression
  // must be an explicit code change, not an env value. NOT the same knob as the
  // POST-erasure re-registration cool-down above.
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().positive().default(7),
  // Cadence (hours) of the deletion sweep that erases overdue rows. The DB marker is
  // authoritative — a missed run only delays erasure until the next sweep. Fractional
  // hours allowed for tests/staging (cadence precedent: PACE_WAVE_INTERVAL_HOURS).
  ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS: z.coerce.number().positive().default(1),

  // PERF-3 — ai_jobs retention window (days). OWNER DECISION (2026-07-21): TERMINAL
  // (completed/failed) rows older than 90 days are pruned. DPDP rationale is DATA
  // MINIMISATION of operational metadata: ai_jobs rows are PII-free by construction
  // (§2 invariant 2 — refs, hashes and typed cost scalars only), so this is
  // retention/cost hygiene, NOT erasure. Age counts from `updated_at` (the terminal
  // transition — never earlier than created_at, so the conservative reading of
  // "older than 90 days"). The sweep NEVER touches queued/running rows and NEVER
  // prunes a row referenced by `worker_profiles.ai_job_id` (the TD14 tie): deleting
  // one would blind the #420 extraction dedupe and re-open real AI spend on every
  // profile-preview mount. positive(): 0 would mean "prune everything terminal
  // immediately" — that must be an explicit code change, not an env value.
  AI_JOBS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  // Cadence (hours) of the retention sweep tick. The prune predicate over ai_jobs is
  // authoritative — a missed/duplicated tick only delays pruning until the next one
  // (cadence precedent: ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS). Fractional hours
  // allowed for tests/staging catch-up.
  AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  // DRY-RUN gate (launch-gate pattern — INERT by default). While false the sweep only
  // LOGS the candidate count + age distribution and deletes NOTHING; flipping this to
  // true is the explicit act that arms real deletion. booleanFromString so a falsey
  // string stays OFF — fail-safe to dry-run, consistent with AI_ENABLE_REAL_CALLS /
  // CAPACITY_ENFORCEMENT_ENABLED.
  AI_JOBS_RETENTION_DELETE_ENABLED: booleanFromString,

  // OTP shape + lifecycle. The code is generated with crypto.randomInt per digit,
  // stored ONLY as a keyed HMAC, single-use, and rate-limited per phone + per IP.
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(30),
  OTP_MAX_SENDS_PER_HOUR: z.coerce.number().int().positive().default(5),
  // Per-phone DAILY send ceiling backstopping the hourly cap: an abuser pacing just
  // under OTP_MAX_SENDS_PER_HOUR could still burn paid SMS all day against one number.
  // Generous default — a legit worker re-logging in stays far below it. Trips the SAME
  // neutral 429 as the hourly cap (no new oracle); fail-closed like every OTP throttle.
  OTP_MAX_SENDS_PER_DAY: z.coerce.number().int().positive().default(10),
  // GLOBAL daily send circuit-breaker for the worker SMS path (OTP-5 — the SPEND
  // ceiling). A backstop ABOVE the per-phone cooldown/cap + the per-IP cap: it bounds
  // the TOTAL number of REAL Fast2SMS sends platform-wide per UTC day, so a distributed
  // abuser rotating phones/IPs still cannot run up the bill. Counts REAL sends ONLY
  // (no-op in mock/console mode → no spend, no effect). Fail-closed: a Redis error on
  // the global counter rejects rather than uncapping.
  //   min(0) is DELIBERATE: 0 = PAUSED = the worker-SMS KILL-SWITCH. Setting this to 0
  //   trips the breaker on the very next real send → instant halt of all real spend
  //   (and a PII-free worker.otp_send_cap_exceeded breach event), env-only, NO redeploy.
  //   This is the worker-SMS off-switch: worker OTP is REAL-ONLY (Fast2SMS), so there is
  //   no provider toggle to disable real sends — setting the cap to 0 is the lever.
  OTP_GLOBAL_MAX_SENDS_PER_DAY: z.coerce.number().int().min(0).default(2000),
  // SMS delivery is REAL-ONLY: "fast2sms" sends via the Fast2SMS DLT route (all Fast2SMS
  // specifics live in Fast2SmsProvider). There is NO console/dev provider — assertAuthConfig
  // requires the Fast2SMS credentials in EVERY environment, so the app fails CLOSED without
  // them. The literal keeps the env var for back-compat with one allowed value.
  SMS_PROVIDER: z.literal("fast2sms").default("fast2sms"),
  FAST2SMS_API_KEY: z.string().min(1).optional(),
  FAST2SMS_SENDER_ID: z.string().min(1).optional(),
  FAST2SMS_DLT_TEMPLATE_ID: z.string().min(1).optional(),
  FAST2SMS_ENTITY_ID: z.string().min(1).optional(),
  FAST2SMS_ROUTE: z.string().min(1).default("dlt"),

  // Self-serve PAYER auth (ADR-0019 Decision B — closes R16/LC-1/TD33). The payer is
  // the THIRD principal (worker/payer/ops). The session mechanism reuses JWT_SECRET +
  // SESSION_TTL_DAYS (PayerSessionService) and the login OTP reuses the OTP_* knobs
  // above (one set of OTP shape/lifecycle for both principals).
  //
  // PAYER_LOGIN_METHOD selects the login channel (ADR-0019 B-R1):
  //   "email_otp" — DEFAULT: a one-time code is emailed via the REAL provider
  //                 (EMAIL_PROVIDER below — ZeptoMail/SMTP; credentials required at boot).
  //   "whatsapp"  — rides the ADR-0020 WhatsApp MOCK provider (no real send in alpha);
  //                 the payer's phone is required on the account.
  //   "supabase"  — config-gated adapter (locked stack). INERT WITHOUT KEYS: selecting it
  //                 without SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY fails CLOSED at boot
  //                 (assertPayerAuthConfig). No real provider is enabled by default.
  PAYER_LOGIN_METHOD: z.enum(["email_otp", "whatsapp", "supabase"]).default("email_otp"),
  // XB-G (ADR-0019 external-disclosure addendum): a per-PAYER cap on the disclosure
  // (unlock) endpoint over a rolling UTC hour, enforced against the real PayerAuthGuard
  // identity. Complements the per-WORKER shared cap (XB-B, the payer-independent
  // backstop) and the per-IP cap. Fail-closed (a Redis outage rejects, never uncaps).
  PAYER_DISCLOSURE_MAX_PER_HOUR: z.coerce.number().int().positive().default(30),
  // Per-IP hourly cap on the UNAUTHENTICATED payer auth endpoints (signup / login
  // request / verify) — an account-farming + credential-stuffing backstop (XB-H / XT2).
  PAYER_AUTH_MAX_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),
  // GLOBAL daily send circuit-breaker for the payer EMAIL-OTP path (OTP-5 — the SPEND
  // ceiling; the payer analogue of OTP_GLOBAL_MAX_SENDS_PER_DAY). Bounds the TOTAL number
  // of REAL payer email sends platform-wide per UTC day, ABOVE the per-account cooldown/
  // cap + per-IP cap, so a distributed abuser cannot run up the email bill. Counts REAL
  // sends. The payer email channel is REAL-ONLY (ZeptoMail/SMTP), so this always enforces.
  // Fail-closed: a Redis error on the global counter rejects rather than uncapping. On
  // breach the response stays BYTE-IDENTICAL for a known vs unknown account (no enumeration
  // oracle, XB-H) — the breaker is checked on the existence-INDEPENDENT reserve path and
  // degrades to the same neutral "code_sent"-shaped response.
  //   min(0) is DELIBERATE: 0 = PAUSED = the payer-email KILL-SWITCH. Setting this to 0
  //   trips the breaker on the next real send → instant halt + a PII-free
  //   payer.otp_send_cap_exceeded breach event, env-only, NO redeploy.
  PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: z.coerce.number().int().min(0).default(2000),
  // Per-PAYER hourly cap on the self-serve REACH read (ADR-0019 R22 / PR2). The reach
  // view returns the full faceless ranked pool for a payer's OWNED job, so repeated
  // loads are the scrape / worker-de-anonymization surface (the reach analogue of XB-G).
  // Fail-closed (a Redis outage rejects). Higher than the disclosure cap — reach is an
  // information-only refreshable read, not a billable disclosure.
  PAYER_REACH_MAX_PER_HOUR: z.coerce.number().int().positive().default(60),
  // Per-PAYER hourly cap on the Agency Supply Portal INVITE-MINT endpoint (ADR-0022
  // security condition — the invite analogue of XB-G). Minting an invite creates an
  // opaque attribution code; an uncapped account could mint unboundedly to spam/seed
  // the funnel, so this throttles a single agency's mint velocity. Reuses
  // PayerDisclosureRateLimit with scope "agency_invite_mint". Fail-closed (a Redis
  // outage rejects, never uncaps).
  AGENCY_INVITE_MINT_MAX_PER_HOUR: z.coerce.number().int().positive().default(60),

  // Admin Ops Portal auth (ADR-0025 ADMIN-1) — the 4th privileged principal (worker /
  // payer / ops-secret / admin). The admin session reuses the payer rolling/revocable
  // httpOnly-JWT mechanism, but with its OWN signing secret + Redis namespace + `typ:"admin"`
  // audience pin, so a worker/payer token can NEVER satisfy AdminAuthGuard and vice-versa.
  //
  // ADMIN_JWT_SECRET signs the admin session token. Dev default keeps local boot/tests
  // working; OUTSIDE an explicit development/test env it MUST be overridden AND must NOT
  // equal the worker/payer JWT_SECRET (a shared secret would defeat the principal
  // separation) — both enforced fail-closed by assertAdminAuthConfig.
  ADMIN_JWT_SECRET: z.string().min(16).default(DEV_ADMIN_JWT_SECRET),
  // MFA scope (ADR-0025 OQ-1 — owner: MFA for ALL roles, incl. analyst). Default ON. When
  // true, EVERY admin role must have mfa_enrolled=true AND pass a TOTP step before a session
  // is minted (enforced server-side at session-mint, must-fix #1). booleanFromString +
  // a true default would coerce wrong, so this is its own coerced boolean defaulting true.
  ADMIN_MFA_REQUIRED: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "boolean" ? v : !["false", "0", "no", "off", ""].includes(v.toLowerCase())))
    .default(true),
  // TOTP issuer label shown in the authenticator app (the `issuer` in the otpauth URI).
  // Non-secret, but REQUIRED when ADMIN_MFA_REQUIRED is true (a half-set MFA config —
  // MFA required but no issuer — fails closed at boot via assertAdminAuthConfig).
  ADMIN_TOTP_ISSUER: z.string().min(1).default("BadaBhai Admin"),
  // Per-IP hourly cap on the UNAUTHENTICATED admin auth endpoints (login request / verify /
  // MFA) — the admin analogue of PAYER_AUTH_MAX_PER_IP_PER_HOUR (credential-stuffing /
  // account-farming backstop). Fail-closed (a Redis outage rejects).
  ADMIN_AUTH_MAX_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),

  // Reason-gated worker-PII reveal (ADR-0025 ADMIN-3b, Decision 4) — the single most
  // sensitive route in the system (it decrypts a worker's phone). Master switch: DEFAULT
  // OFF so the route is INERT until its security review passes. booleanFromString so a
  // falsey string stays OFF (fail-safe to inert, like AI_ENABLE_REAL_CALLS). When OFF the
  // route returns a NEUTRAL 404 — indistinguishable from a non-existent route (no oracle
  // that the feature exists). Flip true ONLY after the ADMIN-3b security review (Control 1).
  ADMIN_PII_REVEAL_ENABLED: booleanFromString,
  // Per-ADMIN reveal caps (ADR-0025 ADMIN-3b must-fix #8) over a rolling UTC hour + UTC day.
  // A backstop on a single admin's reveal velocity (a reason-gated route must still be
  // RATE-bounded so a compromised/abusive admin cannot bulk-deanonymize). Counted per-admin
  // in Redis (namespace `admin_pii_reveal:*`); checked BEFORE the decrypt. Fail-closed: a
  // Redis error DENIES (never uncaps). An over-cap denial emits a PII-free breach event.
  ADMIN_PII_REVEAL_MAX_PER_HOUR: z.coerce.number().int().positive().default(10),
  ADMIN_PII_REVEAL_MAX_PER_DAY: z.coerce.number().int().positive().default(30),

  // Payer email-OTP delivery channel (ADR-0019; the email analogue of SMS_PROVIDER).
  // REAL-ONLY and RELEVANT when PAYER_LOGIN_METHOD="email_otp". There is NO "none"/mock
  // option — a real provider's credentials are REQUIRED at boot (assertPayerAuthConfig →
  // emailProviderBlockedReason fails CLOSED without them, never silently degrading). All
  // keys are SERVER-ONLY secrets — never NEXT_PUBLIC_*, never the public config.
  //   "zeptomail" — ZeptoMail HTTPS send API (requires the ZEPTOMAIL_* set below) [default].
  //   "smtp"      — generic SMTP relay (requires the SMTP_* set below).
  //   "auto"      — pick whichever set is fully configured (ZeptoMail preferred); a
  //                 reason is raised only when NEITHER set is satisfiable.
  EMAIL_PROVIDER: z.enum(["zeptomail", "smtp", "auto"]).default("zeptomail"),
  // ZeptoMail (HTTPS send API). The API_URL is a non-secret endpoint; the TOKEN +
  // MAIL_AGENT are secrets supplied only in staging-first. SANDBOX_MODE uses
  // booleanFromString (NOT z.coerce.boolean) so a falsey string stays OFF.
  ZEPTOMAIL_API_URL: z.string().url().optional(),
  ZEPTOMAIL_API_TOKEN: z.string().min(1).optional(),
  ZEPTOMAIL_MAIL_AGENT: z.string().min(1).optional(),
  ZEPTOMAIL_SANDBOX_MODE: booleanFromString,
  // Generic SMTP relay (alternative to ZeptoMail). HOST/USER/PASS are secrets; PORT
  // reuses the shared portSchema. FROM is the envelope sender for the SMTP transport.
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: portSchema.optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).optional(),
  // Shared From identity for the rendered email (both providers). EMAIL_FROM_ADDRESS is
  // a required cred for every REAL provider (the guard enforces it); NAME + REPLY_TO are
  // presentation-only.
  EMAIL_FROM_NAME: z.string().min(1).optional(),
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  EMAIL_REPLY_TO: z.string().email().optional(),

  // Payer org teammate INVITES — real accept-link email (ADR-0027 / B5.4). The invite
  // ACCEPT flow (single-use token verify → member activation) is ALWAYS live; only the
  // outbound real-email DELIVERY of the accept link is gated. MEMBER_INVITES_ENABLE_REAL
  // is the master gate (mirrors AI_ENABLE_REAL_CALLS / PAYMENTS_ENABLE_REAL /
  // MESSAGING_ENABLE_REAL) and DEFAULTS FALSE: the MOCK mailer (no send — the raw token /
  // accept link never leaves the process) is the alpha default. Flipping it true reuses the
  // REAL email provider (EMAIL_PROVIDER + its creds — ZeptoMail/SMTP, the SAME set the payer
  // OTP channel requires) AND requires MEMBER_INVITE_ACCEPT_URL; it is human-gated +
  // staging-first (CLAUDE.md §7). A real-enabled flag missing the email creds / accept URL
  // fails CLOSED at boot via assertMemberInvitesConfig. booleanFromString so a falsey string
  // stays OFF (fail-safe to mock), consistent with the other real-provider gates above.
  MEMBER_INVITES_ENABLE_REAL: booleanFromString,
  // Base URL of the payer-web invite-accept page (e.g. https://app.badabhai.in/team/accept).
  // The single-use raw token is appended as `?token=…` to build the accept link that goes
  // ONLY into the invite email body — never logged/evented (the bearer secret is stored only
  // as a keyed hash). REQUIRED when MEMBER_INVITES_ENABLE_REAL is true (the guard fails closed
  // without it); unused by the mock mailer. Server-only.
  MEMBER_INVITE_ACCEPT_URL: z.string().url().optional(),
  // Per-org cap on concurrently NON-removed members (active + invited). A backstop so a
  // single org cannot mint unbounded invites (the spam / email-enumeration surface).
  // Reaching it rejects further invites (409) until a seat frees up. Config-driven, tunable
  // without a migration.
  MEMBER_INVITE_MAX_PER_ORG: z.coerce.number().int().positive().default(25),

  // AI routing (direct providers — Gemini primary + Claude Haiku fallback; ADR-0008).
  // The AI service (Python) calls providers DIRECTLY over their own SDKs/REST; the
  // Node API does NOT make LLM calls (it forwards to the AI service), so these are
  // declarative/gating only. GEMINI_FLASH_API_KEY is the master gate for real calls
  // and mirrors the AI service's own credential name.
  GEMINI_FLASH_API_KEY: z.string().min(1).optional(),
  // OPTIONAL fallback-provider key — its presence only ADDS Claude Haiku to the AI
  // service's fallback chain; it is NEVER a master gate.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // DEPRECATED (TD28): the pre-ADR-0008 name for the real-call key. Still accepted as
  // a back-compat ALIAS for GEMINI_FLASH_API_KEY for one release — prefer the new name.
  LITELLM_API_KEY: z.string().min(1).optional(),
  AI_ENABLE_REAL_CALLS: booleanFromString,

  // Contact Unlock + Reveal payments (ADR-0010 §D5 / Phase-0 F-6). MOCK CREDITS in
  // alpha — there is NO real money movement. PAYMENTS_ENABLE_REAL is the master gate
  // (mirrors AI_ENABLE_REAL_CALLS) and DEFAULTS FALSE; flipping it true requires a
  // real gateway key AND is human-gated + staging-first (CLAUDE.md §7). A real-enabled
  // flag without the key fails CLOSED at boot via assertPaymentsConfig.
  PAYMENTS_ENABLE_REAL: booleanFromString,
  // OPAQUE real-gateway key (e.g. Razorpay). NEVER committed; only ever supplied in
  // staging-first behind PAYMENTS_ENABLE_REAL. Unused in alpha (mock ledger).
  PAYMENTS_PROVIDER_KEY: z.string().min(1).optional(),

  // Worker push notifications (ADR-0034 — FCM). SECURITY ALERTS ONLY in this phase
  // (new-device login + logged-out-everywhere); resume/profile/voice pushes are
  // deferred. PUSH_ENABLE_REAL is the master gate and DEFAULTS FALSE: with it off the
  // MOCK provider is bound and nothing leaves the process. Flipping it true requires
  // the service-account credential AND is human-gated + staging-first (CLAUDE.md §7);
  // a real-enabled flag without the credential fails CLOSED at boot via
  // assertPushConfig. booleanFromString so a falsey string stays OFF.
  //
  // DELIBERATELY SEPARATE from MESSAGING_ENABLE_REAL / WHATSAPP_* above: that is the
  // ADR-0020 WhatsApp invite funnel — a different provider, a different spend profile,
  // and a different kill-switch. One switch must never govern both channels.
  PUSH_ENABLE_REAL: booleanFromString,
  // Firebase service-account key, BASE64-ENCODED. Base64 is not decoration: the raw
  // key is multi-line JSON containing a PEM private key, and the CI deploy bridges
  // secrets to the box as shell env vars (ci.yml `envs:`), which mangles embedded
  // newlines/quotes. Encoding it keeps the secret a single opaque token end-to-end.
  // NEVER committed; supplied only in staging-first. The decoded credential and every
  // provider response body stay OUT of logs (a response body echoes the push token).
  FCM_SERVICE_ACCOUNT_B64: z.string().min(1).optional(),
  FCM_PROJECT_ID: z.string().min(1).optional(),
  // Global daily ceiling on REAL pushes AND the kill-switch.
  //   min(0) is DELIBERATE: 0 = PAUSED = halt every push (including security), env-only,
  //   NO redeploy — the OTP_GLOBAL_MAX_SENDS_PER_DAY lever, same semantics.
  // NOTE: `security`-type pushes are EXEMPT from the numeric ceiling (see PushService).
  // The OTP caps bound real MONEY (paid SMS); FCM is free, and under the ruled scope
  // every push is a security alert — so a numeric cap would silently drop the one
  // message class that must always arrive. A breach is emitted, never silently dropped.
  PUSH_GLOBAL_MAX_SENDS_PER_DAY: z.coerce.number().int().min(0).default(5000),
  // Per-IP hourly cap on PATCH /auth/devices/me/push-token. The client re-sends on every
  // FCM token rotation and on app start, so an unthrottled route is a cheap
  // write-amplification surface. Generous — a legit device sends this rarely.
  // Fail-closed (a Redis outage rejects) like every other IP cap.
  PUSH_TOKEN_UPDATES_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(30),

  // WhatsApp invite funnel + re-engagement (ADR-0020). MOCK provider in alpha — no
  // real message is sent and the worker's phone never leaves to Meta. MESSAGING_ENABLE_REAL
  // is the master gate (mirrors AI_ENABLE_REAL_CALLS / PAYMENTS_ENABLE_REAL) and DEFAULTS
  // FALSE; flipping it true requires the WhatsApp keys AND is human-gated + staging-first
  // (CLAUDE.md §7). A real-enabled flag without the keys fails CLOSED at boot via
  // assertMessagingConfig. booleanFromString so a falsey string stays OFF.
  MESSAGING_ENABLE_REAL: booleanFromString,
  // OPAQUE Meta WhatsApp Cloud API credentials. NEVER committed; supplied only in
  // staging-first behind MESSAGING_ENABLE_REAL. Unused in alpha (mock provider).
  WHATSAPP_API_KEY: z.string().min(1).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),

  // Contact Unlock worker-protection caps (ADR-0010 §D4 — CONFIG-DRIVEN, not
  // hard-coded; tunable without a migration). The chokepoint reads these. Numbers are
  // the ADR's recommended alpha starting caps (OQ-F: a trust-and-safety call to tune).
  UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY: z.coerce.number().int().positive().default(5),
  UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK: z.coerce.number().int().positive().default(10),
  UNLOCK_MAX_ATTEMPTS_PER_UNLOCK: z.coerce.number().int().positive().default(3),

  // Per-payer hiring capacity (ADR-0016 D4 — CONFIG-DRIVEN, fail-closed). The default
  // concurrent-active-vacancy allowance for a payer with NO payer_capacity row. The
  // chokepoint reads this; NO number is hard-coded in the service logic. min(0) is
  // intentional (0 = a brand-new payer can hold ZERO active plans until they buy
  // capacity); the small default keeps alpha conservative without a migration to tune.
  CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES: z.coerce.number().int().min(0).default(1),
  // Master switch for capacity ENFORCEMENT (ADR-0016, posture B). Default OFF =
  // inert/shadow: the chokepoint still counts and computes the decision but never
  // pauses a plan — it records a PII-free "would-pause" log line + a wouldPause flag.
  // The cap is ADVISORY until PayerAuthGuard/LC-1 lands; flip true to enforce.
  // Uses booleanFromString (NOT z.coerce.boolean, whose "false"/"0" coerce to true)
  // so a falsey string stays OFF — fail-safe to inert, consistent with the other
  // boolean flags above (AI_ENABLE_REAL_CALLS / PAYMENTS_ENABLE_REAL).
  CAPACITY_ENFORCEMENT_ENABLED: booleanFromString,

  // One-shot composite opener (owner-approved 2026-07-22). OFF = today's behaviour,
  // byte-identical: `POST /chat/session` makes no outbound call, its response body
  // keeps exactly {session_id, status, started_at}, and the client renders its own
  // `kChatOpeningText`. ON, the session response carries `opening_text` — an
  // invitation to answer every topic in one message. Measured: a fluent worker then
  // answers 11 of 12 topics up front and wraps on turn 2 instead of 13.
  //
  // The flag lives HERE, not in the ai-service, because this is the seam that decides
  // what the worker sees. The ai-service `/profiling/opening` route is unconditional
  // and pure, so it has no dead branch; and only a flag on this side can make OFF
  // mean "no network hop on the chat-mount path" at all.
  //
  // booleanFromString (NOT z.coerce.boolean, whose "false"/"0" coerce to TRUE) so a
  // falsey string stays OFF — fail-safe to today's behaviour.
  CHAT_ONE_SHOT_OPENER_ENABLED: booleanFromString,

  // PACE supply-widening (ADR-0021 — CONFIG-DRIVEN, deterministic, no LLM). The widen
  // DECISION is a pure function of these rules; nothing is hard-coded in the service.
  // Master switch — default OFF (inert/additive): PACE only runs when explicitly
  // enabled. booleanFromString so a falsey string stays OFF (fail-safe to inert),
  // consistent with the other boolean gates above.
  PACE_ENABLED: booleanFromString,
  // A job with FEWER than this many above-floor (on-trade) good-fit candidates is
  // "thin supply" → PACE widens. The count uses the SAME floor the boost-integrity
  // guard locks; never hides/drops anyone.
  PACE_THIN_SUPPLY_MIN: z.coerce.number().int().positive().default(3),
  // Each AREA-widen wave raises the travel band by this many km, up to the ceiling.
  PACE_AREA_STEP_KM: z.coerce.number().positive().default(15),
  PACE_MAX_AREA_KM: z.coerce.number().positive().default(75),
  // Wave cadence within the 6–24h window: hours between successive widen waves, and
  // the elapsed-hours threshold after which thin supply raises an OPS ALERT.
  PACE_WAVE_INTERVAL_HOURS: z.coerce.number().positive().default(6),
  PACE_OPS_ALERT_AFTER_HOURS: z.coerce.number().positive().default(24),
  // ADJACENT-TRADE leg gate — default OFF and BLOCKED until a RATIFIED adjacency map
  // exists (ADR-0021; no ratified ADJACENT_ROLES map today). MUST stay false until a
  // ratified map is wired — flipping it true without one is a no-op (the map is empty).
  PACE_ADJACENCY_ENABLED: booleanFromString,

  // Model routing. Bare provider model ids (no provider prefix); the AI service
  // selects cheap vs capable per task. Cost guardrails are in INR per worker profile.
  DEFAULT_CHEAP_MODEL: z.string().min(1).default("gemini-2.5-flash-lite"),
  DEFAULT_CAPABLE_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  AI_COST_ALERT_PROFILE_INR: z.coerce.number().nonnegative().default(6),
  AI_TARGET_PROFILE_COST_INR: z.coerce.number().nonnegative().default(4),
  // Hard per-call spend ceiling (INR): a real call whose worst-case cost exceeds
  // this is refused (falls back to mock).
  AI_MAX_CALL_COST_INR: z.coerce.number().positive().default(10),

  // Google Cloud / Gemini — Node-side declarations only (legacy). The AI service
  // calls Gemini directly via GEMINI_FLASH_API_KEY above; these are unused by the
  // Node API and kept optional for back-compat. (ADR-0008)
  GOOGLE_CLOUD_PROJECT: z.string().min(1).optional(),
  GOOGLE_CLOUD_LOCATION: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),

  // STT (Sarvam placeholder)
  SARVAM_API_KEY: z.string().min(1).optional(),

  // Observability (Langfuse placeholders)
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  LANGFUSE_BASE_URL: z.string().url().default("https://cloud.langfuse.com"),

  // Service URLs / ports
  API_PORT: portSchema.default(3001),
  // TD25 — number of reverse-proxy hops in front of the API whose X-Forwarded-For is
  // trusted when deriving req.ip (feeds every per-IP rate cap). 0 (default) = disabled:
  // Express keeps the socket peer — the fail-safe posture when the edge topology is
  // unknown. Set to the REAL hop count at deploy; NEVER a blanket `true` (a spoofable
  // XFF header would let an abuser rotate their rate-limit identity at will) — see
  // docs/post-alpha-hardening-plan.md (Wave 1).
  TRUST_PROXY_HOP_COUNT: z.coerce.number().int().nonnegative().default(0),
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),
  // TD67: the ONE service-level bearer for ai-service routes. When the ai-service
  // sets AI_INTERNAL_TOKEN, every route except /health requires this exact value in
  // `x-ai-internal-token`; unset (default) keeps today's internal-only open posture.
  // Scoped to the NestJS→ai-service direction — NOT the api's INTERNAL_SERVICE_TOKEN
  // and NOT SKILLS_INTERNAL_TOKEN (which guards the REVERSE direction). Set BOTH
  // sides together (staging service env, never a committed file).
  AI_INTERNAL_TOKEN: z.string().min(16).optional(),

  // Browser CORS allow-list for the API — comma-separated EXACT origins
  // (e.g. "https://ops.badabhai.in,https://app.badabhai.in"). Mirrors the
  // fail-closed/dev-default philosophy of the assert* guards (see
  // `resolveCorsOrigins`): IGNORED in an explicit development/test env (CORS
  // reflects the request origin so local ops-console/payer-web dev keeps
  // working); OUTSIDE dev only these origins are allowed and an EMPTY list denies
  // all cross-origin — never a "*" wildcard. Set it in staging/prod.
  CORS_ALLOWED_ORIGINS: z.string().default(""),
});

export type ServerConfig = z.infer<typeof serverEnvSchema>;

/**
 * Parse and validate server config. Throws with a readable message on failure
 * (intended to crash the process at boot rather than run mis-configured).
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = serverEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(formatEnvError(result.error));
  }
  return result.data;
}

/**
 * Guard for the "real LLM calls" path. The system fails CLOSED: real calls are
 * only permitted when explicitly enabled AND the required credentials exist.
 * Returns the reason it is disabled, or null when real calls are allowed.
 */
export function realAiCallsBlockedReason(config: ServerConfig): string | null {
  if (!config.AI_ENABLE_REAL_CALLS) return "AI_ENABLE_REAL_CALLS is false";
  // GEMINI_FLASH_API_KEY is the master gate (mirrors the AI service). Accept the
  // deprecated LITELLM_API_KEY as a back-compat alias for one release (TD28, ADR-0008).
  if (!config.GEMINI_FLASH_API_KEY && !config.LITELLM_API_KEY) {
    return "GEMINI_FLASH_API_KEY is not set";
  }
  return null;
}

export function areRealAiCallsEnabled(config: ServerConfig): boolean {
  return realAiCallsBlockedReason(config) === null;
}

/**
 * Resolve the NestJS CorsOptions `origin` for the API from config — replaces a
 * bare `app.enableCors()` (which sets `Access-Control-Allow-Origin: *`). Mirrors
 * the fail-closed, dev-default philosophy of the assert* guards:
 *   - dev/test → `true` (reflect the request origin; local ops-console/payer-web
 *                dev keeps working without configuring origins).
 *   - non-dev  → the explicit CORS_ALLOWED_ORIGINS allow-list (exact origins). An
 *                EMPTY list returns `false` (deny ALL cross-origin) — fail closed.
 * Never returns the literal "*" wildcard.
 */
export function resolveCorsOrigins(
  config: ServerConfig,
  rawNodeEnv: string | undefined = process.env.NODE_ENV,
): true | false | string[] {
  if (isDevEnv(rawNodeEnv)) return true;
  const origins = config.CORS_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length > 0 ? origins : false;
}

/** True if either PII secret is still the insecure dev default (for a boot warning). */
export function isUsingDevPiiDefaults(config: ServerConfig): boolean {
  return (
    config.PII_HASH_PEPPER === DEV_PII_HASH_PEPPER ||
    config.PII_ENCRYPTION_KEY === DEV_PII_ENCRYPTION_KEY
  );
}

/**
 * TD22-1 — kid charset for the PII keyring. MUST stay in sync with
 * `PII_KID_PATTERN` in `packages/db/src/crypto.ts` (the token-format source of
 * truth; this package cannot depend on `@badabhai/db`, so the pattern is
 * deliberately duplicated). 1-32 chars of [A-Za-z0-9_-], dot-free — "." is the
 * token delimiter, so a dotted kid would silently corrupt token parsing.
 */
const PII_KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** TD22-1 — the parsed PII keyring (shape mirrors `PiiKeyring` in @badabhai/db). */
export interface PiiKeyringConfig {
  /** The kid new v2 tokens are written under. Guaranteed to be a key of `keys`. */
  activeKid: string;
  /** kid → base64-encoded 32-byte AES-256 key. */
  keys: Record<string, string>;
}

/** Parse PII_ENCRYPTION_KEYS as a JSON string→string object map (null on any shape error). */
function parsePiiKeysJson(raw: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const value of Object.values(parsed)) {
      if (typeof value !== "string") return null;
    }
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * TD22-1 LOW-2 — count the TOP-LEVEL members of a raw JSON object string
 * (colons at nesting depth 1, outside strings; escape-aware). JSON.parse
 * silently keeps only the LAST value for a duplicated key, so a raw
 * `{"k1":"<keyA>","k1":"<keyB>"}` would boot clean and then fail only at READ
 * time (GCM auth failure on every row written under the shadowed keyA) —
 * violating the fail-at-boot contract. Comparing this raw count against
 * `Object.keys(parsed).length` exposes the duplicate at boot. Only called after
 * the raw string has parsed successfully as an object, so the scan is over
 * known-valid JSON.
 */
function countTopLevelJsonMembers(raw: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let count = 0;
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === ":" && depth === 1) count += 1;
  }
  return count;
}

/**
 * TD22-1 — every problem with the PII keyring env pair, or [] when the keyring is
 * either fully valid or entirely unset. Rules (all fail STARTUP, never first
 * decrypt): both-or-neither; an EMPTY STRING is a config ERROR, never treated as
 * unset (TD67 lesson — a half-armed secret gate must be loud); the map must be a
 * JSON object with at least one entry and NO duplicated kid in the raw JSON
 * (JSON.parse last-wins would otherwise defer the failure to read time); every
 * kid must match the charset; every key must be base64 of exactly 32 bytes and
 * not all-zero (the keyring is opt-in, so there is no dev-default excuse in ANY
 * environment); the active kid must be a key of the map. §2 guardrail: no kid
 * value and no key material EVER appears in a problem string — messages name
 * only the env vars and the rule violated.
 */
export function piiKeyringConfigProblems(config: ServerConfig): string[] {
  const rawKeys = config.PII_ENCRYPTION_KEYS;
  const rawKid = config.PII_ENCRYPTION_ACTIVE_KID;
  if (rawKeys === undefined && rawKid === undefined) return [];

  const problems: string[] = [];
  if (rawKeys === "") {
    problems.push("PII_ENCRYPTION_KEYS must not be an empty string (unset it to disable the keyring)");
  }
  if (rawKid === "") {
    problems.push("PII_ENCRYPTION_ACTIVE_KID must not be an empty string (unset it to disable the keyring)");
  }
  if (rawKeys === undefined) {
    problems.push("PII_ENCRYPTION_ACTIVE_KID is set but PII_ENCRYPTION_KEYS is not set");
  }
  if (rawKid === undefined) {
    problems.push("PII_ENCRYPTION_KEYS is set but PII_ENCRYPTION_ACTIVE_KID is not set");
  }
  if (problems.length > 0) return problems;

  const keys = parsePiiKeysJson(rawKeys!);
  if (keys === null) {
    return ["PII_ENCRYPTION_KEYS must be a JSON object mapping key id -> base64 32-byte key"];
  }
  const kids = Object.keys(keys);
  if (kids.length === 0) {
    problems.push("PII_ENCRYPTION_KEYS must contain at least one key");
  }
  // LOW-2: JSON.parse keeps the LAST value for a repeated key — a duplicated kid
  // would boot clean and fail only at READ time on rows written under the
  // shadowed key. Compare the raw top-level member count to the parsed key
  // count so the duplicate fails at BOOT. Never echoes the kid (§2).
  if (countTopLevelJsonMembers(rawKeys!) !== kids.length) {
    problems.push("PII_ENCRYPTION_KEYS contains a duplicate key id");
  }
  if (kids.some((kid) => !PII_KID_PATTERN.test(kid))) {
    problems.push(
      "PII_ENCRYPTION_KEYS contains an invalid key id (must be 1-32 chars of A-Za-z0-9_-)",
    );
  }
  let sawWrongLengthKey = false;
  let sawAllZeroKey = false;
  for (const value of Object.values(keys)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== 32) sawWrongLengthKey = true;
    else if (decoded.every((b) => b === 0)) sawAllZeroKey = true;
  }
  if (sawWrongLengthKey) {
    problems.push("PII_ENCRYPTION_KEYS contains a key that is not base64 of exactly 32 bytes");
  }
  if (sawAllZeroKey) {
    problems.push("PII_ENCRYPTION_KEYS contains an all-zero key");
  }
  if (!PII_KID_PATTERN.test(rawKid!)) {
    problems.push(
      "PII_ENCRYPTION_ACTIVE_KID is not a valid key id (must be 1-32 chars of A-Za-z0-9_-)",
    );
  } else if (!Object.prototype.hasOwnProperty.call(keys, rawKid!)) {
    problems.push("PII_ENCRYPTION_ACTIVE_KID is not a key id in PII_ENCRYPTION_KEYS");
  }
  return problems;
}

/**
 * TD22-1 — the parsed, validated PII keyring, or null when the operator has not
 * opted in (both env vars unset → exactly today's single-key v1 behavior).
 * THROWS on any half-set/invalid keyring (same problems assertPiiCryptoConfig
 * fails boot on) — defense-in-depth so a consumer constructed with a bad keyring
 * can never silently fall back to the legacy key.
 */
export function getPiiKeyring(config: ServerConfig): PiiKeyringConfig | null {
  if (config.PII_ENCRYPTION_KEYS === undefined && config.PII_ENCRYPTION_ACTIVE_KID === undefined) {
    return null;
  }
  const problems = piiKeyringConfigProblems(config);
  if (problems.length > 0) {
    throw new Error(`Invalid PII keyring config (TD22-1, fail closed): ${problems.join("; ")}`);
  }
  return {
    activeKid: config.PII_ENCRYPTION_ACTIVE_KID!,
    keys: parsePiiKeysJson(config.PII_ENCRYPTION_KEYS!)!,
  };
}

/**
 * Fail-closed guard for PII crypto. The dev defaults (a public pepper + an
 * all-zero AES key) are acceptable ONLY when NODE_ENV is EXPLICITLY "development"
 * or "test". Any other value — including UNSET, "staging", or "production" — must
 * supply real secrets, so a forgotten NODE_ENV in prod fails closed instead of
 * silently encrypting under a known-zero key. Call once at boot (main.ts).
 *
 * TD22-1: also validates the optional PII keyring pair (PII_ENCRYPTION_KEYS +
 * PII_ENCRYPTION_ACTIVE_KID) in EVERY environment — the keyring is opt-in with no
 * dev default, so if either var is set it must be fully valid (a structural
 * misconfiguration, like a half-set MFA config, fails boot even in dev).
 */
export function assertPiiCryptoConfig(
  config: ServerConfig,
  rawNodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  const keyringProblems = piiKeyringConfigProblems(config);
  if (keyringProblems.length > 0) {
    throw new Error(
      `Invalid PII keyring config (TD22-1, fail closed): ${keyringProblems.join("; ")}`,
    );
  }
  if (isDevEnv(rawNodeEnv)) return;
  const insecure: string[] = [];
  if (config.PII_HASH_PEPPER === DEV_PII_HASH_PEPPER) insecure.push("PII_HASH_PEPPER");
  if (config.PII_ENCRYPTION_KEY === DEV_PII_ENCRYPTION_KEY) insecure.push("PII_ENCRYPTION_KEY");
  // Reject an all-zero AES key however it was supplied (not only the named default).
  try {
    const key = Buffer.from(config.PII_ENCRYPTION_KEY, "base64");
    if (key.length === 32 && key.every((b) => b === 0))
      insecure.push("PII_ENCRYPTION_KEY(all-zero)");
  } catch {
    /* length/format already validated by the schema .refine */
  }
  if (insecure.length > 0) {
    throw new Error(
      `Insecure PII secret(s) outside an explicit development/test environment: ${[
        ...new Set(insecure),
      ].join(", ")} must be overridden`,
    );
  }
}

/** True if JWT_SECRET is still the insecure dev default (for a boot warning). */
export function isUsingDevJwtDefault(config: ServerConfig): boolean {
  return config.JWT_SECRET === DEV_JWT_SECRET;
}

/**
 * Guard for the "real payments" path (ADR-0010 §D5 / Phase-0 F-6) — the direct
 * analogue of `realAiCallsBlockedReason`. The system fails CLOSED: real charges are
 * only permitted when explicitly enabled AND a provider key exists. Returns the
 * reason real payments are disabled, or null when they are allowed. In alpha this
 * always returns a reason (mock credits only).
 */
export function realPaymentsBlockedReason(config: ServerConfig): string | null {
  if (!config.PAYMENTS_ENABLE_REAL) return "PAYMENTS_ENABLE_REAL is false";
  if (!config.PAYMENTS_PROVIDER_KEY) return "PAYMENTS_PROVIDER_KEY is not set";
  return null;
}

export function areRealPaymentsEnabled(config: ServerConfig): boolean {
  return realPaymentsBlockedReason(config) === null;
}

/**
 * Guard for the "real WhatsApp send" path (ADR-0020 Decision 1) — the direct
 * analogue of `realPaymentsBlockedReason`. Fails CLOSED: a real message is only
 * permitted when explicitly enabled AND the Meta WhatsApp credentials exist.
 * Returns the reason real sends are disabled, or null when allowed. In alpha this
 * always returns a reason (mock provider — the phone never leaves to a third party).
 */
export function realMessagingBlockedReason(config: ServerConfig): string | null {
  if (!config.MESSAGING_ENABLE_REAL) return "MESSAGING_ENABLE_REAL is false";
  if (!config.WHATSAPP_API_KEY) return "WHATSAPP_API_KEY is not set";
  if (!config.WHATSAPP_PHONE_NUMBER_ID) return "WHATSAPP_PHONE_NUMBER_ID is not set";
  return null;
}

export function areRealMessagesEnabled(config: ServerConfig): boolean {
  return realMessagingBlockedReason(config) === null;
}

/**
 * Guard for the "real org-invite email" path (ADR-0027 / B5.4) — the direct analogue of
 * `realMessagingBlockedReason`. Fails CLOSED: a real accept-link email is sent only when
 * explicitly enabled AND the email provider is fully configured (reuses EMAIL_PROVIDER +
 * its creds — the SAME set the payer OTP channel requires) AND a MEMBER_INVITE_ACCEPT_URL
 * base is set (so the link can be built). Returns the reason real sends are disabled, or
 * null when allowed. In alpha this always returns a reason (mock mailer — the raw token /
 * accept link never leaves the process).
 */
export function realMemberInvitesBlockedReason(config: ServerConfig): string | null {
  if (!config.MEMBER_INVITES_ENABLE_REAL) return "MEMBER_INVITES_ENABLE_REAL is false";
  const emailBlocked = emailProviderBlockedReason(config);
  if (emailBlocked) return emailBlocked;
  if (!config.MEMBER_INVITE_ACCEPT_URL) return "MEMBER_INVITE_ACCEPT_URL is not set";
  return null;
}

export function areRealMemberInvitesEnabled(config: ServerConfig): boolean {
  return realMemberInvitesBlockedReason(config) === null;
}

/**
 * True when the WORKER OTP path uses the REAL (spend-incurring) SMS provider (OTP-5).
 * Worker OTP is REAL-ONLY (Fast2SMS), so this is always true — the global daily send
 * circuit-breaker (OTP_GLOBAL_MAX_SENDS_PER_DAY) therefore always enforces. Retained as
 * the explicit spend-signal seam the OTP service gates on.
 */
export function isRealOtpSmsActive(_config: ServerConfig): boolean {
  return true;
}

/**
 * True when the PAYER email-OTP path uses a REAL (spend-incurring) email provider (OTP-5).
 * The payer email channel is REAL-ONLY (ZeptoMail/SMTP — no "none"/mock), so this is always
 * true and the payer global daily send circuit-breaker (PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY)
 * always enforces. NOTE: relevant only when PAYER_LOGIN_METHOD="email_otp" (the email
 * channel is unused for whatsapp/supabase); the OTP service gates on this spend signal.
 */
export function isRealPayerEmailActive(_config: ServerConfig): boolean {
  return true;
}

/**
 * Guard for the per-payer capacity ENFORCEMENT path (ADR-0016, posture B) — the
 * direct analogue of `areRealPaymentsEnabled`. Default OFF (fail-safe = inert):
 * when false the chokepoint runs in SHADOW — it computes the over-cap decision but
 * never pauses, recording a PII-free would-pause log line instead. Flip true to
 * enforce. The cap is advisory until PayerAuthGuard/LC-1 (CLAUDE.md §8).
 */
export function isCapacityEnforcementEnabled(config: ServerConfig): boolean {
  return config.CAPACITY_ENFORCEMENT_ENABLED;
}

/**
 * Master gate for PACE supply-widening (ADR-0021). Default OFF (additive/inert): PACE
 * waves + ops alerts only run when explicitly enabled. The widen DECISION itself is a
 * pure config-driven rule (no LLM, invariant 4).
 */
export function isPaceEnabled(config: ServerConfig): boolean {
  return config.PACE_ENABLED;
}

/**
 * Gate for the PACE ADJACENT-TRADE widen leg (ADR-0021). Default OFF and BLOCKED on a
 * ratified adjacency map — there is NO ratified ADJACENT_ROLES map today, so the area
 * leg ships first and this stays false. Enabling it without a ratified map is a no-op
 * (the adjacency lookup returns no related roles).
 */
export function isPaceAdjacencyEnabled(config: ServerConfig): boolean {
  return config.PACE_ADJACENCY_ENABLED;
}

/**
 * Fail-closed boot guard for the payments config (ADR-0010 Phase-0 F-6; mirrors
 * `assertPiiCryptoConfig`). If real payments are ENABLED but no provider key is set,
 * a half-configured gateway must NOT run silently as mock — throw at boot so the
 * mis-configuration is loud. (Alpha default: PAYMENTS_ENABLE_REAL=false → no-op.)
 * Real payments are additionally a HUMAN-GATED, staging-first escalation (CLAUDE.md
 * §7) — this guard only enforces the config invariant, not the human approval.
 */
export function assertPaymentsConfig(config: ServerConfig): void {
  if (config.PAYMENTS_ENABLE_REAL && !config.PAYMENTS_PROVIDER_KEY) {
    throw new Error(
      "PAYMENTS_ENABLE_REAL is true but PAYMENTS_PROVIDER_KEY is not set — refusing to boot a half-configured real payments gateway (ADR-0010 F-6, fail closed)",
    );
  }
}

/**
 * Fail-closed boot guard for the WhatsApp messaging config (ADR-0020; mirrors
 * `assertPaymentsConfig`). If real messaging is ENABLED but the Meta credentials
 * are not fully set, a half-configured provider must NOT run silently as mock —
 * throw at boot so the mis-configuration is loud. (Alpha default:
 * MESSAGING_ENABLE_REAL=false → no-op.) Real sends are additionally a HUMAN-GATED,
 * staging-first escalation (CLAUDE.md §7); this guard only enforces the config
 * invariant, not the human approval.
 */
/**
 * Reason REAL push sends cannot run, or null when they are allowed (ADR-0034 — the
 * direct analogue of `realMessagingBlockedReason`). Fails CLOSED: a real send needs the
 * flag AND a decodable service-account credential AND a project id.
 */
export function realPushBlockedReason(config: ServerConfig): string | null {
  if (!config.PUSH_ENABLE_REAL) return "PUSH_ENABLE_REAL is false";
  if (!config.FCM_SERVICE_ACCOUNT_B64) return "FCM_SERVICE_ACCOUNT_B64 is not set";
  if (!config.FCM_PROJECT_ID) return "FCM_PROJECT_ID is not set";
  return null;
}

export function areRealPushesEnabled(config: ServerConfig): boolean {
  return realPushBlockedReason(config) === null;
}

/**
 * Decode + validate the base64 Firebase service-account credential (ADR-0034), or null
 * when it is unset. THROWS on a malformed value so a mangled paste fails at BOOT rather
 * than at the first send — the whole reason the key is transported base64-encoded.
 *
 * §2: the returned material is a SECRET. It must never be logged, evented, or echoed in
 * an error — the messages below name only the env var and the rule violated.
 */
export function getFcmServiceAccount(
  config: ServerConfig,
): { clientEmail: string; privateKey: string } | null {
  const raw = config.FCM_SERVICE_ACCOUNT_B64;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error(
      "FCM_SERVICE_ACCOUNT_B64 must be base64 of the service-account JSON (decode/parse failed)",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("FCM_SERVICE_ACCOUNT_B64 must decode to a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const clientEmail = obj.client_email;
  const privateKey = obj.private_key;
  if (typeof clientEmail !== "string" || clientEmail.length === 0) {
    throw new Error("FCM_SERVICE_ACCOUNT_B64 is missing client_email");
  }
  if (typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("FCM_SERVICE_ACCOUNT_B64 is missing a usable private_key");
  }
  return { clientEmail, privateKey };
}

/**
 * Fail-closed boot guard for worker push (ADR-0034; mirrors `assertMessagingConfig`).
 * A half-configured real provider must NOT run silently as mock, and a mangled
 * base64 credential must not survive to the first send. Alpha default:
 * PUSH_ENABLE_REAL=false → no-op. Call once at boot (main.ts).
 */
export function assertPushConfig(config: ServerConfig): void {
  // Validate the credential shape whenever it is supplied, even with the gate OFF: a
  // half-armed secret must be loud (the TD67 lesson), not discovered when we flip on.
  const account = getFcmServiceAccount(config);
  if (!config.PUSH_ENABLE_REAL) return;
  const missing: string[] = [];
  if (!account) missing.push("FCM_SERVICE_ACCOUNT_B64");
  if (!config.FCM_PROJECT_ID) missing.push("FCM_PROJECT_ID");
  if (missing.length > 0) {
    throw new Error(
      `PUSH_ENABLE_REAL is true but ${missing.join(" + ")} ${
        missing.length > 1 ? "are" : "is"
      } not set — refusing to boot a half-configured real push provider (ADR-0034, fail closed)`,
    );
  }
}

export function assertMessagingConfig(config: ServerConfig): void {
  if (!config.MESSAGING_ENABLE_REAL) return;
  const missing: string[] = [];
  if (!config.WHATSAPP_API_KEY) missing.push("WHATSAPP_API_KEY");
  if (!config.WHATSAPP_PHONE_NUMBER_ID) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (missing.length > 0) {
    throw new Error(
      `MESSAGING_ENABLE_REAL is true but ${missing.join(" + ")} ${
        missing.length > 1 ? "are" : "is"
      } not set — refusing to boot a half-configured real WhatsApp provider (ADR-0020, fail closed)`,
    );
  }
}

/**
 * Fail-closed boot guard for the payer org-invite email config (ADR-0027 / B5.4; mirrors
 * `assertMessagingConfig` / `assertPaymentsConfig`). If real invite email is ENABLED but the
 * email provider is half-configured or MEMBER_INVITE_ACCEPT_URL is unset, the path must NOT
 * run silently as mock (or send a link-less email) — throw at boot so the mis-configuration is
 * loud. (Alpha default: MEMBER_INVITES_ENABLE_REAL=false → no-op.) Real sends are additionally
 * a HUMAN-GATED, staging-first escalation (CLAUDE.md §7); this guard only enforces the config
 * invariant, not the human approval. Call once at boot (main.ts), after assertPayerAuthConfig.
 */
export function assertMemberInvitesConfig(config: ServerConfig): void {
  if (!config.MEMBER_INVITES_ENABLE_REAL) return;
  const reason = realMemberInvitesBlockedReason(config);
  if (reason) {
    throw new Error(
      `MEMBER_INVITES_ENABLE_REAL is true but ${reason} — refusing to boot a half-configured real invite-email path (ADR-0027 B5.4, fail closed)`,
    );
  }
}

/**
 * Fail-closed guard for worker-auth config. Worker OTP is REAL-ONLY (Fast2SMS), so the
 * Fast2SMS credentials are REQUIRED in EVERY environment — there is no console/dev
 * provider to fall back to, so the app fails CLOSED (refuses to boot) without them. The
 * JWT dev-default shortcut is acceptable ONLY in an explicit development/test env; any
 * other value (UNSET, "staging", "production") must override JWT_SECRET, since the dev
 * default would let anyone forge a session. Call once at boot (main.ts).
 */
export function assertAuthConfig(
  config: ServerConfig,
  rawNodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  const problems: string[] = [];

  // Real SMS credentials are required in EVERY environment (real-only worker OTP — no
  // console fallback). A half-configured/absent provider fails at boot, never silently.
  const missing: string[] = [];
  if (!config.FAST2SMS_API_KEY) missing.push("FAST2SMS_API_KEY");
  if (!config.FAST2SMS_SENDER_ID) missing.push("FAST2SMS_SENDER_ID");
  if (!config.FAST2SMS_DLT_TEMPLATE_ID) missing.push("FAST2SMS_DLT_TEMPLATE_ID");
  if (missing.length > 0) {
    problems.push(`SMS_PROVIDER=fast2sms requires: ${missing.join(", ")}`);
  }

  // The dev JWT default is acceptable only in an explicit development/test environment.
  if (!isDevEnv(rawNodeEnv) && config.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push("JWT_SECRET must be overridden (the dev default is public)");
  }

  // ADR-0026 Phase 3 — the PIN pepper is a secret on par with PII_HASH_PEPPER: a leak of
  // worker_credentials + the dev-public pepper would make the 10^4 PIN space brute-forceable.
  // The dev default is acceptable only in an explicit development/test environment.
  if (!isDevEnv(rawNodeEnv) && config.PIN_PEPPER === DEV_PIN_PEPPER) {
    problems.push("PIN_PEPPER must be overridden (the dev default is public)");
  }

  // D-3 — the gated test-login mint seam. Two invariants, both fail-STARTUP:
  //
  //  1. HARD STRUCTURAL PRODUCTION BLOCK: the seam mints a real worker session
  //     without an OTP, so in production it would be a login bypass — the flag must
  //     be IMPOSSIBLE to arm there. We allow it ONLY when the RAW NODE_ENV is
  //     EXPLICITLY development/test/staging: "production", an UNSET env, an empty
  //     string, or any typo ("prod", "Staging") all REFUSE TO BOOT, so a forgotten
  //     or fat-fingered NODE_ENV on a production box can never leave the seam armed
  //     (the same raw-env fail-closed philosophy as isDevEnv — never trust the
  //     parsed default).
  //  2. TD67 lesson: enabled without a real (>=32-char) TEST_LOGIN_TOKEN must FAIL
  //     BOOT, never arm vacuously — a gate whose secret is missing/empty/short is a
  //     structural misconfiguration, not "off". (The schema's min(32) already makes
  //     an empty/short SET token a parse error; this covers enabled-with-unset.)
  if (config.TEST_LOGIN_ENABLED) {
    const testLoginAllowedEnvs = ["development", "test", "staging"];
    if (!testLoginAllowedEnvs.includes(rawNodeEnv ?? "")) {
      problems.push(
        "TEST_LOGIN_ENABLED must be false in production (D-3): it is only permitted when NODE_ENV is explicitly development, test, or staging",
      );
    }
    if (!config.TEST_LOGIN_TOKEN || config.TEST_LOGIN_TOKEN.length < 32) {
      problems.push(
        "TEST_LOGIN_ENABLED is true but TEST_LOGIN_TOKEN is not set to a >=32-char secret — refusing to arm a half-configured test-login gate (TD67, fail closed)",
      );
    }
  }

  // ADR-0026: the opaque refresh token's lifetime must be >= the session absolute cap, so
  // a refresh record never expires out from under a session still inside its 90d window
  // (which would force OTP early). Fail closed on a misconfiguration in EVERY environment.
  if (config.AUTH_REFRESH_TTL_DAYS < config.AUTH_SESSION_ABSOLUTE_MAX_DAYS) {
    problems.push(
      `AUTH_REFRESH_TTL_DAYS (${config.AUTH_REFRESH_TTL_DAYS}) must be >= AUTH_SESSION_ABSOLUTE_MAX_DAYS (${config.AUTH_SESSION_ABSOLUTE_MAX_DAYS})`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Insecure/incomplete auth config: ${problems.join("; ")}`);
  }
}

/**
 * Reason the SELECTED payer login method cannot run, or null when it is satisfiable
 * (ADR-0019 Decision B — the analogue of `realAiCallsBlockedReason`). The `supabase`
 * adapter is the locked-stack identity provider but is **inert without keys**:
 * selecting it without the Supabase service credentials returns a reason (so boot can
 * fail closed) rather than silently running a half-configured external IdP. The mock
 * channels (`email_otp` / `whatsapp`) are always satisfiable (no real provider/spend).
 */
export function payerLoginMethodBlockedReason(config: ServerConfig): string | null {
  if (config.PAYER_LOGIN_METHOD === "supabase") {
    const missing: string[] = [];
    if (!config.SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!config.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (missing.length > 0) {
      return `PAYER_LOGIN_METHOD=supabase requires: ${missing.join(", ")}`;
    }
  }
  return null;
}

/**
 * Reason the SELECTED email-OTP provider cannot run, or null when it is satisfiable
 * (ADR-0019; mirrors `assertAuthConfig`'s fast2sms branch + `payerLoginMethodBlockedReason`).
 * A REAL provider that is missing its required creds returns a reason so boot can fail
 * CLOSED rather than silently degrading to the mock channel. The mock provider ("none")
 * is always satisfiable (no real send/spend). This helper is provider-only — the CALLER
 * (assertPayerAuthConfig) decides whether it is RELEVANT (it gates only when
 * PAYER_LOGIN_METHOD="email_otp"; the email channel is irrelevant for whatsapp/supabase).
 *   - "zeptomail" requires ZEPTOMAIL_API_TOKEN + ZEPTOMAIL_MAIL_AGENT + EMAIL_FROM_ADDRESS.
 *   - "smtp"      requires SMTP_HOST + SMTP_USER + SMTP_PASS + EMAIL_FROM_ADDRESS.
 *   - "auto"      requires EITHER the full ZeptoMail set OR the full SMTP set (each
 *                 including EMAIL_FROM_ADDRESS); a reason only when NEITHER is satisfiable.
 */
export function emailProviderBlockedReason(config: ServerConfig): string | null {
  const zeptoMissing: string[] = [];
  if (!config.ZEPTOMAIL_API_TOKEN) zeptoMissing.push("ZEPTOMAIL_API_TOKEN");
  if (!config.ZEPTOMAIL_MAIL_AGENT) zeptoMissing.push("ZEPTOMAIL_MAIL_AGENT");
  if (!config.EMAIL_FROM_ADDRESS) zeptoMissing.push("EMAIL_FROM_ADDRESS");

  const smtpMissing: string[] = [];
  if (!config.SMTP_HOST) smtpMissing.push("SMTP_HOST");
  if (!config.SMTP_USER) smtpMissing.push("SMTP_USER");
  if (!config.SMTP_PASS) smtpMissing.push("SMTP_PASS");
  if (!config.EMAIL_FROM_ADDRESS) smtpMissing.push("EMAIL_FROM_ADDRESS");

  switch (config.EMAIL_PROVIDER) {
    case "zeptomail":
      return zeptoMissing.length > 0
        ? `EMAIL_PROVIDER=zeptomail requires: ${zeptoMissing.join(", ")}`
        : null;
    case "smtp":
      return smtpMissing.length > 0
        ? `EMAIL_PROVIDER=smtp requires: ${smtpMissing.join(", ")}`
        : null;
    case "auto":
      if (zeptoMissing.length === 0 || smtpMissing.length === 0) return null;
      return "EMAIL_PROVIDER=auto requires a fully-configured ZeptoMail set (ZEPTOMAIL_API_TOKEN + ZEPTOMAIL_MAIL_AGENT + EMAIL_FROM_ADDRESS) OR SMTP set (SMTP_HOST + SMTP_USER + SMTP_PASS + EMAIL_FROM_ADDRESS) — neither is satisfiable";
  }
}

/**
 * Fail-closed boot guard for the self-serve payer auth surface (ADR-0019 Decision B;
 * mirrors `assertAuthConfig` / `assertPaymentsConfig`). Invariants:
 *   - the chosen login method must be runnable — the `supabase` adapter must NOT boot
 *     half-configured (inert-without-keys → throw, never silently degrade), AND
 *   - when PAYER_LOGIN_METHOD="email_otp", the REAL email provider's credentials are
 *     REQUIRED (real-only — no mock channel); a half-configured provider throws via
 *     emailProviderBlockedReason. The email channel is irrelevant — and therefore NOT
 *     gated — for whatsapp/supabase, AND
 *   - outside an explicit development/test environment JWT_SECRET must be overridden
 *     (the payer session is signed with the SAME JWT_SECRET as the worker session; the
 *     dev default would let anyone forge a payer session — XB-H secure-session).
 * Call once at boot (main.ts), after `assertAuthConfig`.
 */
export function assertPayerAuthConfig(
  config: ServerConfig,
  rawNodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  const problems: string[] = [];

  const blocked = payerLoginMethodBlockedReason(config);
  if (blocked) problems.push(blocked);

  // The email-OTP channel is only relevant when it is the selected login method.
  if (config.PAYER_LOGIN_METHOD === "email_otp") {
    const emailBlocked = emailProviderBlockedReason(config);
    if (emailBlocked) problems.push(emailBlocked);
  }

  if (!isDevEnv(rawNodeEnv) && config.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push("JWT_SECRET must be overridden (the payer session is signed with it)");
  }

  if (problems.length > 0) {
    throw new Error(`Invalid payer-auth config (ADR-0019, fail closed): ${problems.join("; ")}`);
  }
}

/** True if ADMIN_JWT_SECRET is still the insecure dev default (for a boot warning). */
export function isUsingDevAdminJwtDefault(config: ServerConfig): boolean {
  return config.ADMIN_JWT_SECRET === DEV_ADMIN_JWT_SECRET;
}

/**
 * Fail-closed boot guard for the Admin Ops Portal auth surface (ADR-0025 ADMIN-1, must-fix
 * #2 — mirrors `assertPayerAuthConfig` with the SAME fail-closed test matrix). A
 * misconfigured env must NOT silently expose the 4th (highly-privileged) principal, so this
 * refuses to start when admin auth is half-configured. Invariants (all enforced OUTSIDE an
 * explicit development/test env; dev/test keeps the defaults for local boot):
 *   - ADMIN_JWT_SECRET must be overridden — the dev default is public, so it would let
 *     anyone forge an admin session (the most privileged token in the system).
 *   - ADMIN_JWT_SECRET must NOT equal the worker/payer JWT_SECRET — a shared secret would
 *     collapse the principal separation (an admin token must be cryptographically distinct).
 *   - when ADMIN_MFA_REQUIRED is true (the owner default — MFA for ALL roles), the TOTP
 *     config must be complete: a non-empty ADMIN_TOTP_ISSUER is required. MFA-required with
 *     no issuer is a HALF-SET MFA config → reject (never boot a half-configured second
 *     factor).
 * Call once at boot (main.ts), after `assertPayerAuthConfig`.
 */
export function assertAdminAuthConfig(
  config: ServerConfig,
  rawNodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  const problems: string[] = [];

  if (!isDevEnv(rawNodeEnv)) {
    if (config.ADMIN_JWT_SECRET === DEV_ADMIN_JWT_SECRET) {
      problems.push("ADMIN_JWT_SECRET must be overridden (the dev default is public)");
    }
    // The admin token MUST be cryptographically distinct from the worker/payer session token.
    if (config.ADMIN_JWT_SECRET === config.JWT_SECRET) {
      problems.push(
        "ADMIN_JWT_SECRET must differ from JWT_SECRET (a shared secret defeats principal separation)",
      );
    }
  }

  // A half-set MFA config (MFA required, but the TOTP issuer is missing) must fail closed —
  // even in development/test, since it is a structural mis-configuration, not a dev shortcut.
  if (config.ADMIN_MFA_REQUIRED && config.ADMIN_TOTP_ISSUER.trim().length === 0) {
    problems.push(
      "ADMIN_MFA_REQUIRED is true but ADMIN_TOTP_ISSUER is empty — refusing to boot a half-configured second factor",
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid admin-auth config (ADR-0025, fail closed): ${problems.join("; ")}`);
  }
}
