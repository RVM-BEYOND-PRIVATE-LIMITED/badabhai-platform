import { z } from "zod";
import { nodeEnvSchema, formatEnvError } from "./shared";

/**
 * Public (browser-safe) configuration.
 *
 * SECURITY: this schema MUST contain only non-secret, `NEXT_PUBLIC_*`-style
 * values that are safe to ship to the browser. The frontend imports this via
 * `@badabhai/config/public` and therefore never depends on backend secrets —
 * so a missing service-role key can never crash the web app.
 */
export const publicEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3001"),
  NEXT_PUBLIC_ENVIRONMENT: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
});

export type PublicConfig = z.infer<typeof publicEnvSchema>;

/**
 * Parse public config. Unknown/extra keys (including any leaked server secrets)
 * are ignored — only the whitelisted public keys are read.
 */
export function loadPublicConfig(
  env: Record<string, string | undefined> = process.env,
): PublicConfig {
  const result = publicEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(formatEnvError(result.error));
  }
  return result.data;
}
