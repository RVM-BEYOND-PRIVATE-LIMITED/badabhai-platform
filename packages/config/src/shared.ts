import { z } from "zod";

/** Coerce common string representations of booleans into a real boolean. */
export const booleanFromString = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", ""])])
  .transform((v) => v === true || v === "true" || v === "1")
  .default(false);

/** Coerce a string/number into a positive integer port. */
export const portSchema = z.coerce.number().int().min(1).max(65535);

export const NODE_ENVS = ["development", "test", "staging", "production"] as const;
/**
 * FOOTGUN WARNING: this defaults to "development" when NODE_ENV is unset, so the
 * PARSED `config.NODE_ENV` is FAIL-OPEN — an unset env reads as "development".
 * That default is only safe for non-security behaviour (log tags, dev warnings).
 * NEVER gate a dev shortcut (insecure keys, console OTP, auth bypass) on the
 * parsed value: use {@link isDevEnv} (which reads RAW `process.env.NODE_ENV` and
 * fails closed) so a forgotten NODE_ENV in staging/prod cannot unlock shortcuts.
 */
export const nodeEnvSchema = z.enum(NODE_ENVS).default("development");
export type NodeEnv = (typeof NODE_ENVS)[number];

/**
 * THE canonical, fail-closed answer to "are dev shortcuts allowed here?".
 *
 * Reads the RAW environment value (NOT the Zod-parsed `config.NODE_ENV`, which
 * defaults to "development" and is therefore fail-open on an unset env). Returns
 * true ONLY when NODE_ENV is EXPLICITLY "development" or "test"; every other
 * value — unset/undefined, "", "staging", "production", or a typo like "dev" /
 * "Development" — returns false, so the caller enforces real secrets.
 *
 * Every boot gate that decides whether an insecure dev shortcut may run (the dev
 * JWT secret, the console OTP provider, dev PII secrets) MUST route through this
 * one helper — single source of truth so the fail-closed rule can't drift.
 */
export function isDevEnv(rawNodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return rawNodeEnv === "development" || rawNodeEnv === "test";
}

/** Format a Zod error into a readable, multi-line message for boot-time failures. */
export function formatEnvError(error: z.ZodError): string {
  const lines = error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `Invalid environment configuration:\n${lines.join("\n")}`;
}
