/**
 * Payer-login vocabulary shared by the server read (`lib/accounts.ts`) and the client
 * dialogs (#2578). NO `server-only` here: the User accounts screen needs the same closed
 * enums and labels on both sides of the boundary.
 */

export const ACCOUNT_ROLES = ["employer", "agent"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const ACCOUNT_STATUSES = ["pending", "active", "suspended"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_PASSWORD_STATES = [
  "none",
  "set",
  "temporary_pending",
  "temporary_expired",
  "revoked",
] as const;
export type AccountPasswordState = (typeof ACCOUNT_PASSWORD_STATES)[number];

export const ACCOUNT_TYPES = ["company_owner", "agency_owner", "team_member"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** The User accounts "Type" column's label. */
export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  company_owner: "Company owner",
  agency_owner: "Agency owner",
  team_member: "Team member",
};

/** The password-state label an operator reads, in sentence case. */
export const PASSWORD_STATE_LABELS: Record<AccountPasswordState, string> = {
  none: "No password",
  set: "Set",
  temporary_pending: "Temporary — must change",
  temporary_expired: "Temporary expired",
  revoked: "Revoked",
};
