import "server-only";

/**
 * DEV-ONLY quick-login gate (additive to the ADR-0019 login; NOT a real auth path).
 *
 * The SINGLE predicate both the login page (to render the dev panel) and the
 * quick-login server action (a defense-in-depth re-assert) read — so the render gate
 * and the execution gate can never drift apart. Default FALSE: a one-click login that
 * skips manual OTP must NEVER be enabled in staging/production.
 *
 * It does NOT touch the real `PAYER_AUTH_MODE` seam — the real login form, the http
 * provider, and `payerServerConfig()` are unchanged. This flag only decides whether the
 * separate, isolated dev shortcut is available locally.
 */
export function devQuickLoginEnabled(): boolean {
  return (process.env.DEV_QUICK_LOGIN ?? "").trim().toLowerCase() === "true";
}
