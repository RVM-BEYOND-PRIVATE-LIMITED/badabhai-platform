import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  ACCOUNT_PASSWORD_STATES,
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  type AccountPasswordState,
  type AccountRole,
  type AccountStatus,
} from "./account-labels";

/**
 * Payer login accounts (#2578) — reads for the User accounts tab.
 *
 * `GET /admin/accounts` is keyset-paged (`cursor` + `limit`) and filtered by closed enums
 * (`AdminPayerLoginsController`, #2563). There is deliberately NO free-text search: the stored
 * login identifier is ciphertext, and a searchable hash would be a new identity index. The
 * screen therefore offers the filters the API actually has, never a search box it cannot serve.
 *
 * The login identifier and organisation name are ADDITIVE and independently gated by
 * `read_identity` on the server: both are ABSENT (`undefined`) for a role that may not see
 * them, and `null` when the account has no value on record. The screen keeps those two states
 * distinct — "Hidden for your role" vs a dash.
 */

/** One row of `GET /admin/accounts`. Dates arrive as ISO strings over JSON. */
export const accountListItemSchema = z.object({
  id: z.string(),
  login_id: z.string().nullable().optional(),
  type: z.enum(ACCOUNT_TYPES),
  organisation: z.string().nullable().optional(),
  org_id: z.string().nullable(),
  role: z.enum(ACCOUNT_ROLES),
  status: z.enum(ACCOUNT_STATUSES),
  last_login_at: z.string().nullable(),
  password_state: z.enum(ACCOUNT_PASSWORD_STATES),
  password_set_at: z.string().nullable(),
  /** `null` when the Redis lock-state read failed — not the same fact as "not locked". */
  locked: z.boolean().nullable(),
});
export type AccountListItem = z.infer<typeof accountListItemSchema>;

const accountsPageSchema = z.object({
  items: z.array(accountListItemSchema),
  nextCursor: z.string().nullable(),
});
export type AccountsPage = z.infer<typeof accountsPageSchema>;

export interface ListAccountsInput {
  cursor?: string;
  limit?: number;
  role?: AccountRole;
  status?: AccountStatus;
  passwordState?: AccountPasswordState;
  orgId?: string;
}

/** One keyset page of payer logins, newest first (`GET /admin/accounts`). */
export async function listAccounts(input: ListAccountsInput = {}): Promise<AccountsPage> {
  const q = new URLSearchParams();
  if (input.cursor) q.set("cursor", input.cursor);
  if (input.limit) q.set("limit", String(input.limit));
  if (input.role) q.set("role", input.role);
  if (input.status) q.set("status", input.status);
  if (input.passwordState) q.set("password_state", input.passwordState);
  if (input.orgId) q.set("org_id", input.orgId);
  const qs = q.toString();
  return adminFetch(`/admin/accounts${qs ? `?${qs}` : ""}`, { schema: accountsPageSchema });
}
