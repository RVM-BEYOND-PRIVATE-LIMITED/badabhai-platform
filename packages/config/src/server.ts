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
export const serverEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,

  // Core datastores
  DATABASE_URL: z.string().url().default("postgresql://badabhai:badabhai@localhost:5432/badabhai"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // Supabase (backend only)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // AI routing (LiteLLM)
  LITELLM_BASE_URL: z.string().url().default("http://localhost:4000"),
  LITELLM_API_KEY: z.string().min(1).optional(),
  AI_ENABLE_REAL_CALLS: booleanFromString,

  // STT (Sarvam placeholder)
  SARVAM_API_KEY: z.string().min(1).optional(),

  // Observability (Langfuse placeholders)
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),

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
