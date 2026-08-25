import { z } from "zod";

/** Coerce common string representations of booleans into a real boolean. */
export const booleanFromString = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", ""])])
  .transform((v) => v === true || v === "true" || v === "1")
  .default(false);

/** Coerce a string/number into a positive integer port. */
export const portSchema = z.coerce.number().int().min(1).max(65535);

/**
 * A positive-integer knob read from the environment, where an EMPTY VALUE MEANS ABSENT.
 *
 * ── THE OUTAGE THIS EXISTS FOR ──────────────────────────────────────────────────────────
 * `z.coerce.number().int().positive().default(N)` looks like it has a safe default and does
 * not: `.default()` fires only for `undefined`, and an empty string is PRESENT. So `""` is
 * coerced — `Number("")` is `0` — and `.positive()` rejects it. The whole config parse throws
 * and the API never boots.
 *
 * An empty string is not a hypothetical input, it is the ORDINARY one. Compose's own
 * pass-through idiom, used on nearly every variable in docker-compose.staging.yml, is
 * `${VAR:-}` — which expands to the empty string and passes `VAR=""` INTO the container. A
 * `.env` line with nothing after the `=` does the same, and so does a CI secret that resolved
 * to nothing. On 2026-08-25 that took the staging API down in a crash loop: two new numeric
 * knobs were given the standard `${VAR:-}` pass-through, both had schema defaults, and the
 * container refused to boot on `Number must be greater than 0` for values nobody had set.
 *
 * {@link booleanFromString} has accepted `""` since it was written — its `z.enum` lists the
 * empty string explicitly. This is the same accommodation for the other kind of knob, and it
 * belongs HERE rather than in each compose entry: a substitution default (`${VAR:-20}`) fixes
 * one file while leaving `.env` and the secret bridge to produce the same empty string, and it
 * puts a second copy of the number somewhere that cannot import the first.
 *
 * WHITESPACE COUNTS AS EMPTY for the same reason — `VAR=" "` from a hand-edited `.env` is a
 * value nobody chose, and `Number(" ")` is also 0.
 *
 * ⚠ THIS IS FOR KNOBS WITH A DEFAULT, NOT FOR REQUIRED VALUES. It only makes an empty value
 * behave the way an ABSENT one already does; a variable with no default still fails closed on
 * both. Nothing here can turn a missing required setting into a silent zero.
 */
export const positiveIntFromString = (defaultValue: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    // ⚠ THE `.default()` GOES ON THE INNER SCHEMA, NOT ON THE `preprocess`. Written the other
    // way round — `z.preprocess(fn, inner).default(d)` — the default sits OUTSIDE the effect and
    // only fires for an input that was already `undefined`: an empty string reaches the effect,
    // becomes `undefined`, and is then coerced by the inner schema to `NaN`. That reproduces the
    // original crash with a different message, which is worse than not fixing it.
    z.coerce.number().int().positive().default(defaultValue),
  );

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

/**
 * Should a web-portal session cookie be marked `Secure` (HTTPS-only)?
 *
 * True in production AND on any https/staging deployment. Local http dev stays
 * non-secure so the cookie is still set at all -- a browser silently drops a
 * `Secure` cookie set over plain http. Shared by every principal's
 * session-cookie module (payer, admin, ...) so each stops reimplementing the
 * identical three signals (BL-9).
 *
 * Signals (any ⇒ secure): `NODE_ENV=production`; a staging/production
 * `NEXT_PUBLIC_ENVIRONMENT` label; or the deployment's OWN site URL being
 * https. The backend API URL is deliberately NOT a signal -- it is a different
 * host and could be https even during local http dev, a false positive that
 * would silently drop the cookie and make login appear broken.
 */
export function shouldUseSecureCookie(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NODE_ENV === "production") return true;

  const environment = (env.NEXT_PUBLIC_ENVIRONMENT ?? "").trim().toLowerCase();
  if (environment === "staging" || environment === "production") return true;

  const siteUrls = [env.NEXT_PUBLIC_SITE_URL, env.VERCEL_URL && `https://${env.VERCEL_URL}`];
  return siteUrls.some(
    (u) => typeof u === "string" && u.trim().toLowerCase().startsWith("https://"),
  );
}

/** Format a Zod error into a readable, multi-line message for boot-time failures. */
export function formatEnvError(error: z.ZodError): string {
  const lines = error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `Invalid environment configuration:\n${lines.join("\n")}`;
}
