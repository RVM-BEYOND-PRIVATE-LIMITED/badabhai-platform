import { z } from "zod";

/** Coerce common string representations of booleans into a real boolean. */
export const booleanFromString = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", ""])])
  .transform((v) => v === true || v === "true" || v === "1")
  .default(false);

/** Coerce a string/number into a positive integer port. */
export const portSchema = z.coerce.number().int().min(1).max(65535);

export const NODE_ENVS = ["development", "test", "staging", "production"] as const;
export const nodeEnvSchema = z.enum(NODE_ENVS).default("development");
export type NodeEnv = (typeof NODE_ENVS)[number];

/** Format a Zod error into a readable, multi-line message for boot-time failures. */
export function formatEnvError(error: z.ZodError): string {
  const lines = error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `Invalid environment configuration:\n${lines.join("\n")}`;
}
