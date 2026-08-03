import type { AdminRole } from "@badabhai/db";

/**
 * The admin RBAC capability model (ADR-0025 Decision 3) — the SINGLE SOURCE OF TRUTH for
 * "which role may do what". Deny-by-default: a capability is allowed ONLY if this matrix
 * explicitly lists the role under it; an unlisted capability, or a null/unknown role, is
 * DENIED (never defaulted to a privileged role).
 *
 * This constant is pinned against the ADR Decision-3 table by a drift test (must-fix #5) so
 * a silent over-grant fails CI. It is the ONLY place a capability→role mapping lives — guards
 * and (future ADMIN-2/3) routes consult {@link can}, never an inline check.
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

/**
 * The capability→role matrix (ADR-0025 Decision 3.1). Each capability maps to the EXACT set
 * of roles allowed it. `read_events` is the read floor (all four roles); every mutation /
 * export / PII capability is least-privilege. DO NOT widen a row without updating the ADR
 * Decision-3 table (the drift test pins these together).
 *
 * Notes that encode the ADR's deliberate separations:
 *   - `export` excludes `support` (the PII-reveal role must NOT also bulk-export) and `analyst`.
 *   - `toggle_kill_switch` + `manage_admins` are `super_admin`-only (break-glass).
 *   - `reveal_pii` is `support` + `super_admin` ONLY (ops_admin/analyst denied).
 */
export const ADMIN_CAPABILITY_MATRIX: Record<AdminCapability, readonly AdminRole[]> = {
  read_events: ["super_admin", "ops_admin", "support", "analyst"],
  export: ["super_admin", "ops_admin"],
  suspend_payer: ["super_admin", "ops_admin"],
  grant_credits: ["super_admin", "ops_admin"],
  force_close_posting: ["super_admin", "ops_admin"],
  flag_worker: ["super_admin", "ops_admin"],
  toggle_kill_switch: ["super_admin"],
  reveal_pii: ["super_admin", "support"],
  manage_admins: ["super_admin"],
} as const;

/**
 * Deny-by-default capability check. Returns true ONLY when `role` is a known role explicitly
 * listed under `capability` in the matrix. A null/undefined/unknown role → false (fail-closed).
 * An unknown capability → false (the lookup yields no allow-list).
 */
export function can(role: AdminRole | null | undefined, capability: AdminCapability): boolean {
  if (role === null || role === undefined) return false;
  const allowed = ADMIN_CAPABILITY_MATRIX[capability];
  return allowed !== undefined && allowed.includes(role);
}

/**
 * Every capability `role` holds — the server-resolved answer that `GET /admin/me` returns.
 *
 * WHY THIS EXISTS. The Admin Portal (ADMIN-4..8) has to render role-aware UI: hide the
 * suspend button from an analyst, hide reveal-contact from an ops_admin. The matrix lives
 * HERE, inside `apps/api` — a sibling app cannot import it. Without this the portal's only
 * options were to hardcode the role lists in the frontend or to guess, and a second copy of
 * an authorization table drifts the first time a row changes. So the server answers instead.
 *
 * DERIVED VIA {@link can}, deliberately — not by reading the matrix a second way. The guard
 * decides with `can`; this list is the same function over the same capability set, so what
 * the UI shows and what the server permits CANNOT disagree. Reimplementing the lookup here
 * would reintroduce exactly the drift this is meant to remove.
 *
 * This is a CONVENIENCE, never the enforcement. The server checks every request against
 * `@RequireAdminRole` regardless of what the client believes it may do; a client that forges
 * a longer list gets 403s, not access. Hiding a control the user cannot use is a UX act.
 */
export function capabilitiesFor(role: AdminRole | null | undefined): AdminCapability[] {
  return ADMIN_CAPABILITIES.filter((capability) => can(role, capability));
}
