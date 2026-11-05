import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import type { OrgRole, PayerRole, PayerStatus } from "@badabhai/db";
import type { AdminPage } from "./admin-entities.dto";

/**
 * DTOs for #2563 — payer login management on the Admin Portal.
 *
 * Every body is `.strict()`: no extra (PII-shaped) key can ride in, and the actor is always the
 * session admin (`@CurrentAdmin().id`), never a body field. Login identifiers are the SAME
 * validated shapes the payer door accepts (lower-cased email / E.164 phone), so an admin cannot
 * create an account the payer could never sign in with.
 *
 * EVERY write carries a closed `reason_code` and a written `reason_text` (15–500 characters).
 * The reason is stored on the `audit_logs` row written in the same transaction as the credential
 * change and `admin.action_performed`; it is NEVER put on the value-free event itself.
 */

/** The payer's vertical role — mirrors `db.PayerRole` (`employer` = company, `agent` = agency). */
export const AdminPayerRoleSchema = z.enum(["employer", "agent"]);
export type AdminPayerRole = z.infer<typeof AdminPayerRoleSchema>;

/** The org role a team member holds — the founder stays the sole owner (existing tenancy rule). */
export const AdminOrgRoleSchema = z.enum(["recruiter"]);
export type AdminOrgRole = z.infer<typeof AdminOrgRoleSchema>;

/**
 * The closed reason CODES for the three login writes. A code, never free text: the code names
 * the ACTION for the audit index, while `reason_text` carries the operator's explanation.
 */
export const ADMIN_PAYER_LOGIN_REASON_CODES = [
  "login_created",
  "password_issued",
  "password_revoked",
] as const;
export const AdminPayerLoginReasonCode = z.enum(ADMIN_PAYER_LOGIN_REASON_CODES);
export type AdminPayerLoginReasonCode = z.infer<typeof AdminPayerLoginReasonCode>;

/**
 * The written reason. 15 characters is the platform's admin-write floor (a code alone cannot
 * explain WHY), and 500 keeps an operator from pasting a document into an audit row. Trimmed
 * before length checking so trailing whitespace cannot satisfy the minimum.
 */
export const AdminPayerReasonTextSchema = z
  .string()
  .trim()
  .min(15, "Reason must be at least 15 characters")
  .max(500, "Reason must be at most 500 characters");

/**
 * POST /admin/payers — create a company/agency owner login, or a team member under an existing
 * org.
 *
 *   owner       → `org_name` + `role`; the server creates the payer, its solo org, the owner
 *                 membership and the free-tier grant, exactly like self-serve signup.
 *   team member → `member_of_org_id` (and optional `org_role`); the server attaches an ACTIVE
 *                 `payer_members` row with NO invite token. `role` is derived from the org's
 *                 founding payer, because a login cannot be an employer in an agency's org.
 */
export const AdminCreatePayerLoginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: e164PhoneSchema.optional(),
    role: AdminPayerRoleSchema.optional(),
    org_name: z.string().trim().min(1).max(200).optional(),
    member_of_org_id: z.string().uuid().optional(),
    org_role: AdminOrgRoleSchema.optional(),
    reason_code: z.literal("login_created"),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict()
  .refine((v) => v.email !== undefined || v.phone !== undefined, {
    message: "At least one of email/phone is required",
  })
  .refine((v) => (v.org_name === undefined) !== (v.member_of_org_id === undefined), {
    message: "Provide exactly one of org_name or member_of_org_id",
  })
  .refine((v) => (v.member_of_org_id !== undefined ? v.role === undefined : v.role !== undefined), {
    message: "role is required for an owner and must be omitted for a team member",
  })
  .refine((v) => v.member_of_org_id !== undefined || v.org_role === undefined, {
    message: "org_role applies only to a team member",
  });
export type AdminCreatePayerLoginDto = z.infer<typeof AdminCreatePayerLoginSchema>;

const reasonShape = {
  reason_code: z.literal("password_issued"),
  reason_text: AdminPayerReasonTextSchema,
} as const;

/** POST /admin/payers/:id/password/temporary — issue a one-time password for an existing login. */
export const AdminIssueTemporaryPasswordSchema = z.object(reasonShape).strict();
export type AdminIssueTemporaryPasswordDto = z.infer<typeof AdminIssueTemporaryPasswordSchema>;

/** POST /admin/payers/:id/password/revoke — turn password sign-in off (email code still works). */
export const AdminRevokePayerPasswordSchema = z
  .object({
    reason_code: z.literal("password_revoked"),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type AdminRevokePayerPasswordDto = z.infer<typeof AdminRevokePayerPasswordSchema>;

/**
 * GET /admin/accounts — keyset page (the admin-list convention: `cursor` + `limit`, NOT a page
 * number). Filters are closed enums/ids; there is deliberately NO free-text search of a login
 * ID, because the stored identifier is ciphertext and a searchable hash would be a new identity
 * index nobody asked for.
 */
export const AdminAccountsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().positive().max(50).optional().default(25),
    role: AdminPayerRoleSchema.optional(),
    status: z.enum(["pending", "active", "suspended"]).optional(),
    password_state: z
      .enum(["none", "set", "temporary_pending", "temporary_expired", "revoked"])
      .optional(),
    org_id: z.string().uuid().optional(),
  })
  .strict();
export type AdminAccountsQueryDto = z.infer<typeof AdminAccountsQuerySchema>;

/** How the account came to exist — the User accounts screen's "Type" column. */
export type AdminAccountType = "company_owner" | "agency_owner" | "team_member";

/** Password state, in the order the list resolves it. */
export type AdminAccountPasswordState =
  | "none"
  | "set"
  | "temporary_pending"
  | "temporary_expired"
  | "revoked";

export interface AdminAccountListItem {
  id: string;
  /**
   * The login identifier (email, else phone), decrypted for this response only. ABSENT when no
   * identity was disclosed to this admin (`read_identity` missing or the name budget exhausted);
   * `null` when disclosed and the account has no login identifier at all (should not occur —
   * every payer has one).
   */
  login_id?: string | null;
  type: AdminAccountType;
  /** The organisation display name. ABSENT under the same identity rules as `login_id`. */
  organisation?: string | null;
  org_id: string | null;
  role: PayerRole;
  status: PayerStatus;
  last_login_at: Date | null;
  password_state: AdminAccountPasswordState;
  password_set_at: Date | null;
  /** `true` when the password-attempt counter has reached the limit; `null` when Redis failed. */
  locked: boolean | null;
}

export type AdminAccountsPage = AdminPage<AdminAccountListItem>;

/** POST /admin/payers response — the temporary password exists ONLY here, once. */
export interface AdminCreatePayerLoginResponse {
  payer_id: string;
  login_id: string;
  temporary_password: string;
  must_change_password: true;
}

/** POST /admin/payers/:id/password/temporary response — the new password exists ONLY here. */
export interface AdminIssueTemporaryPasswordResponse {
  payer_id: string;
  temporary_password: string;
  must_change_password: true;
}

/** POST /admin/payers/:id/password/revoke response. */
export interface AdminRevokePayerPasswordResponse {
  payer_id: string;
  changed: boolean;
}

/** Compile-time pin: the DTO enums cannot drift from the database unions. */
const _rolePin = AdminPayerRoleSchema.options satisfies readonly PayerRole[];
const _orgRolePin = AdminOrgRoleSchema.options satisfies readonly OrgRole[];
void _rolePin;
void _orgRolePin;
