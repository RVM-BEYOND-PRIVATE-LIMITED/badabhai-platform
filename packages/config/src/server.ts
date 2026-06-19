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

  // Worker auth: OTP login + rolling JWT session (BACKEND ONLY).
  // JWT_SECRET signs the worker session token. Dev default keeps local boot/tests
  // working; production MUST override it (assertAuthConfig fails closed otherwise).
  JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  // Session lifetime (days). The token + Redis session key share this TTL; an
  // active client gets it refreshed (rolling/sliding) past the half-life.
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // OTP shape + lifecycle. The code is generated with crypto.randomInt per digit,
  // stored ONLY as a keyed HMAC, single-use, and rate-limited per phone + per IP.
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(30),
  OTP_MAX_SENDS_PER_HOUR: z.coerce.number().int().positive().default(5),
  // SMS delivery. "console" prints the code to the server log for LOCAL dev only
  // (assertAuthConfig forbids it outside development/test). "fast2sms" sends a real
  // SMS via the Fast2SMS DLT route; all Fast2SMS specifics live in Fast2SmsProvider.
  SMS_PROVIDER: z.enum(["console", "fast2sms"]).default("console"),
  FAST2SMS_API_KEY: z.string().min(1).optional(),
  FAST2SMS_SENDER_ID: z.string().min(1).optional(),
  FAST2SMS_DLT_TEMPLATE_ID: z.string().min(1).optional(),
  FAST2SMS_ENTITY_ID: z.string().min(1).optional(),
  FAST2SMS_ROUTE: z.string().min(1).default("dlt"),

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
  AI_SERVICE_URL: z.string().url().default("http://localhost:8000"),
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

/** True if either PII secret is still the insecure dev default (for a boot warning). */
export function isUsingDevPiiDefaults(config: ServerConfig): boolean {
  return (
    config.PII_HASH_PEPPER === DEV_PII_HASH_PEPPER ||
    config.PII_ENCRYPTION_KEY === DEV_PII_ENCRYPTION_KEY
  );
}

/**
 * Fail-closed guard for PII crypto. The dev defaults (a public pepper + an
 * all-zero AES key) are acceptable ONLY when NODE_ENV is EXPLICITLY "development"
 * or "test". Any other value — including UNSET, "staging", or "production" — must
 * supply real secrets, so a forgotten NODE_ENV in prod fails closed instead of
 * silently encrypting under a known-zero key. Call once at boot (main.ts).
 */
export function assertPiiCryptoConfig(
  config: ServerConfig,
  rawNodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  if (isDevEnv(rawNodeEnv)) return;
  const insecure: string[] = [];
  if (config.PII_HASH_PEPPER === DEV_PII_HASH_PEPPER) insecure.push("PII_HASH_PEPPER");
  if (config.PII_ENCRYPTION_KEY === DEV_PII_ENCRYPTION_KEY) insecure.push("PII_ENCRYPTION_KEY");
  // Reject an all-zero AES key however it was supplied (not only the named default).
  try {
    const key = Buffer.from(config.PII_ENCRYPTION_KEY, "base64");
    if (key.length === 32 && key.every((b) => b === 0)) insecure.push("PII_ENCRYPTION_KEY(all-zero)");
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
 * Fail-closed guard for worker-auth config. Like assertPiiCryptoConfig, the dev
 * shortcuts are acceptable ONLY when NODE_ENV is EXPLICITLY "development"/"test".
 * Any other value — including UNSET, "staging", or "production" — must:
 *   - override JWT_SECRET (the dev default would let anyone forge a session), AND
 *   - use a real SMS provider (the console provider PRINTS the code to logs, so it
 *     must never run outside dev), AND
 *   - when SMS_PROVIDER="fast2sms", supply the required Fast2SMS credentials, so a
 *     half-configured provider fails at boot rather than silently dropping OTPs.
 * Call once at boot (main.ts).
 */
export function assertAuthConfig(
  config: ServerConfig,
  rawNodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  if (isDevEnv(rawNodeEnv)) return;

  const problems: string[] = [];
  if (config.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push("JWT_SECRET must be overridden (the dev default is public)");
  }
  if (config.SMS_PROVIDER === "console") {
    problems.push("SMS_PROVIDER=console prints OTP codes to logs and must not run outside development");
  }
  if (config.SMS_PROVIDER === "fast2sms") {
    const missing: string[] = [];
    if (!config.FAST2SMS_API_KEY) missing.push("FAST2SMS_API_KEY");
    if (!config.FAST2SMS_SENDER_ID) missing.push("FAST2SMS_SENDER_ID");
    if (!config.FAST2SMS_DLT_TEMPLATE_ID) missing.push("FAST2SMS_DLT_TEMPLATE_ID");
    if (missing.length > 0) {
      problems.push(`SMS_PROVIDER=fast2sms requires: ${missing.join(", ")}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Insecure/incomplete auth config outside an explicit development/test environment: ${problems.join("; ")}`,
    );
  }
}
