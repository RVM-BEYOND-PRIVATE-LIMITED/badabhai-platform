import { z } from "zod";
import { booleanFromString, portSchema, nodeEnvSchema, formatEnvError } from "./shared";

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

  // Resume render worker (TD5).
  // Master kill-switch for the WeasyPrint render step. When false the renderer
  // degrades to null (no PDF), so the system runs without the binary in local dev.
  RESUME_RENDER_ENABLED: booleanFromString,
  // Per-worker generations allowed per UTC day (paid-path abuse cap).
  RESUME_DAILY_CAP: z.coerce.number().int().positive().default(5),
  // Global generations allowed per UTC day — interim backstop until TD4 binds a
  // request to an authenticated worker (today a caller could rotate worker_id).
  RESUME_GLOBAL_DAILY_CAP: z.coerce.number().int().positive().default(5000),
  // TTL (seconds) for a freshly minted signed download URL.
  RESUME_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

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

  // AI routing (LiteLLM)
  LITELLM_BASE_URL: z.string().url().default("http://localhost:4000"),
  LITELLM_API_KEY: z.string().min(1).optional(),
  AI_ENABLE_REAL_CALLS: booleanFromString,

  // Model routing. Names are LiteLLM model ids; the AI service selects cheap vs
  // capable per task. Cost guardrails are in INR per worker profile.
  DEFAULT_CHEAP_MODEL: z.string().min(1).default("gemini-flash-lite"),
  DEFAULT_CAPABLE_MODEL: z.string().min(1).default("claude-haiku-or-gemini-flash"),
  AI_COST_ALERT_PROFILE_INR: z.coerce.number().nonnegative().default(6),
  AI_TARGET_PROFILE_COST_INR: z.coerce.number().nonnegative().default(4),
  // Hard per-call spend ceiling (INR): a real call whose worst-case cost exceeds
  // this is refused (falls back to mock).
  AI_MAX_CALL_COST_INR: z.coerce.number().positive().default(10),

  // Google Cloud / Gemini (consumed by LiteLLM in real mode only; backend-only).
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
  if (!config.LITELLM_API_KEY) return "LITELLM_API_KEY is not set";
  if (!config.LITELLM_BASE_URL) return "LITELLM_BASE_URL is not set";
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
  if (rawNodeEnv === "development" || rawNodeEnv === "test") return;
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
