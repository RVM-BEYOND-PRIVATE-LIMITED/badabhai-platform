/**
 * Login email-shape check — LINEAR (#1946).
 *
 * The loose full-string shape is fine as a yes/no screen, but the anchored
 * `^[^\s@]+@[^\s@]+\.[^\s@]+$` is quadratic on a long dotted domain followed by
 * whitespace: each `[^\s@]` redistribution re-scans the domain (~224 ms at 32k
 * characters), stalling the user's own tab. A real address is capped at 254
 * chars (RFC 5321; the server `emailSchema` enforces `.max(254)`), so reject
 * anything longer BEFORE the regex runs — the scan is then bounded and cannot
 * rescan an unbounded run.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_CHARS = 254;

/** True when [value] is a plausible email address (bounded, linear scan). */
export function looksLikeLoginEmail(value: string): boolean {
  return value.length <= EMAIL_MAX_CHARS && EMAIL_RE.test(value);
}
