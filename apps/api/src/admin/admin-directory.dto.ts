import { z } from "zod";
import type { AdminRole, AdminStatus } from "@badabhai/db";
import type { AdminCapability } from "./admin-capabilities";

/**
 * DTOs for the ADMINISTRATION reads (BP-3): the admin directory and the capability matrix.
 *
 * ── NAMES YES, EMAILS NO — AND BOTH HALVES ARE OWNER RULINGS ────────────────────────────
 * `admin_users.email_enc` and `name_enc` are AES-256-GCM ciphertext at rest (ADR-0004). The
 * 2026-08-04 ruling made this screen entirely faceless; the CTO REVERSED the name half on
 * 2026-08-18, because a directory of uuids cannot answer the question people actually open it
 * with ("who is this account?"). So:
 *
 *   `name`  — SERVED, behind `read_identity` and the per-admin name-egress cap. Optional, and
 *             its presence is the answer: absent = not disclosed to you, null = disclosed and
 *             no name on record, string = the name. (This route is `manage_admins`, so in
 *             practice only a super_admin reaches it, and a super_admin holds `read_identity`.)
 *   EMAIL   — still NEVER. Nothing has reversed that half, and it is the one that would turn
 *             this screen into the complete admin ADDRESS BOOK — a phishing target list for
 *             precisely the accounts with the most reach. Nor `mfa_secret_enc`, ever.
 *
 * The screen's real job is still security audit, and every one of those questions was always
 * answerable without a name — who holds `super_admin` and how many, who has never enrolled a
 * second factor, who has not logged in for months, who is still `pending`. A name makes the
 * answers actionable; it does not change what is asked.
 *
 * The admin id remains the join to everything else: it is the `actor_id` on every
 * `admin.action_performed` event, so "what has this account done" is one click away.
 */

/** GET /admin/admins query. Deliberately unpaginated — see the repository. */
export const AdminDirectoryQuerySchema = z
  .object({
    role: z.enum(["super_admin", "ops_admin", "support", "analyst"]).optional(),
    status: z.enum(["pending", "active", "suspended"]).optional(),
  })
  .strict();
export type AdminDirectoryQueryDto = z.infer<typeof AdminDirectoryQuerySchema>;

/**
 * One admin account.
 *
 * NEVER: `email_enc`, `email_hash`, `mfa_secret_enc`. The last of those is the most important —
 * it is the TOTP seed, and returning it would let any reader mint valid second factors for that
 * admin forever. `name_enc` is the ONE identity column now served, and only via
 * `AdminIdentityService` (capability + egress cap + audit-before-decrypt); the directory's own
 * repository still projects none of the four.
 */
export interface AdminDirectoryRow {
  id: string;
  /**
   * The admin's display name, decrypted for this response only. ABSENT when no name was
   * disclosed to this caller; `null` when disclosed and none is on record (the invite flow does
   * not collect one, so this is common).
   */
  name?: string | null;
  role: AdminRole;
  status: AdminStatus;
  mfa_enrolled: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** True when this row is the calling admin — the UI marks "you" rather than guessing. */
  is_self: boolean;
}

export interface AdminDirectoryResponse {
  admins: AdminDirectoryRow[];
  /**
   * How many ACTIVE super_admins exist. Surfaced because both failure modes are real and
   * neither is visible from a row: exactly one is a lockout risk (lose that device and
   * nobody can grant `manage_admins` again), and many is an over-privilege smell.
   */
  active_super_admins: number;
}

/** One row of the capability matrix. */
export interface AdminCapabilityRow {
  capability: AdminCapability;
  roles: AdminRole[];
}

/**
 * The authorization model, served rather than duplicated.
 *
 * The portal deliberately carries NO role→capability mapping (CLAUDE.md invariant #9: never
 * re-implement a server authority as a second copy). Without this route the Roles screen
 * would have to hardcode the matrix and drift the first time a row changed — so the server
 * answers instead, from the SAME constant the guards enforce.
 */
export interface AdminCapabilityMatrixResponse {
  roles: AdminRole[];
  matrix: AdminCapabilityRow[];
}
