/**
 * The admin capability vocabulary, as the SERVER reports it.
 *
 * ── WHY THIS FILE IS NOT A COPY OF THE MATRIX ───────────────────────────────────────
 * `ADMIN_CAPABILITY_MATRIX` (capability → allowed roles) lives in `apps/api` and is the
 * single source of truth. A sibling app cannot import it, and duplicating it here would
 * create a second authorization table that drifts the first time a row changes — exactly
 * what CLAUDE.md invariant #9 forbids ("never re-implement a server authority as a second
 * copy").
 *
 * So this file carries **no role→capability mapping at all**. It only names the closed
 * vocabulary so TypeScript can catch a typo'd capability string at compile time, and the
 * server tells us which of them the current admin actually holds, via
 * `GET /admin/me → capabilities`.
 *
 * ── AND IT IS NOT ENFORCEMENT ───────────────────────────────────────────────────────
 * Hiding a control the operator cannot use is a UX act, not a security boundary. Every
 * route re-checks `@RequireAdminRole` server-side on every request, so a client that
 * forged a longer list would earn 403s, not access. Never let a UI capability check be the
 * only thing standing between a user and an action.
 */

export const ADMIN_CAPABILITIES = [
  "read_events",
  "export",
  "suspend_payer",
  "grant_credits",
  "force_close_posting",
  "flag_worker",
  "toggle_kill_switch",
  "reveal_pii",
  "manage_admins",
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

/** The four admin roles (ADR-0025). Displayed; never used to derive permissions. */
export const ADMIN_ROLES = ["super_admin", "ops_admin", "support", "analyst"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Human labels. Roles are shown in the UI; capabilities appear in permission views. */
export const ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: "Super admin",
  ops_admin: "Ops admin",
  support: "Support",
  analyst: "Analyst",
};

export const CAPABILITY_LABELS: Record<AdminCapability, string> = {
  read_events: "Read events",
  export: "Export data",
  suspend_payer: "Suspend payers",
  grant_credits: "Grant credits",
  force_close_posting: "Force-close postings",
  flag_worker: "Flag workers",
  toggle_kill_switch: "Toggle kill switch",
  reveal_pii: "Reveal contact details",
  manage_admins: "Manage admins",
};

/** Narrow an unknown string to a known capability (anything else is dropped, not trusted). */
export function isAdminCapability(value: unknown): value is AdminCapability {
  return (
    typeof value === "string" && (ADMIN_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value);
}

/**
 * Does this session hold `capability`? Reads ONLY the server-supplied list.
 *
 * Fails closed: an absent or malformed list grants nothing, so a `/admin/me` that failed
 * to parse renders a portal with no privileged controls rather than all of them.
 */
export function can(
  granted: readonly AdminCapability[] | null | undefined,
  capability: AdminCapability,
): boolean {
  return Array.isArray(granted) && granted.includes(capability);
}

/** True when the session holds EVERY listed capability. Empty list ⇒ true (nothing asked). */
export function canAll(
  granted: readonly AdminCapability[] | null | undefined,
  capabilities: readonly AdminCapability[],
): boolean {
  return capabilities.every((c) => can(granted, c));
}

/** True when the session holds AT LEAST ONE. Empty list ⇒ false (nothing can satisfy it). */
export function canAny(
  granted: readonly AdminCapability[] | null | undefined,
  capabilities: readonly AdminCapability[],
): boolean {
  return capabilities.some((c) => can(granted, c));
}
