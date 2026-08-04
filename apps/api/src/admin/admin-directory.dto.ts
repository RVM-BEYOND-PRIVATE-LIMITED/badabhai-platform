import { z } from "zod";
import type { AdminRole, AdminStatus } from "@badabhai/db";
import type { AdminCapability } from "./admin-capabilities";

/**
 * DTOs for the ADMINISTRATION reads (BP-3): the admin directory and the capability matrix.
 *
 * ── THE DIRECTORY IS FACELESS, AND THAT IS AN OWNER RULING ──────────────────────────────
 * `admin_users.email_enc` and `name_enc` are AES-256-GCM ciphertext at rest (ADR-0004), and
 * no shipped route has ever decrypted ANOTHER admin's identity — `GET /admin/me` returns the
 * caller's id, role and capabilities, never an address. Serving names or emails here would
 * be a NEW cross-actor PII path and would turn one screen into the complete admin address
 * book, so it was escalated rather than assumed. Owner ruling 2026-08-04: **faceless now**.
 *
 * That is not a crippled screen. The questions this section actually has to answer are
 * security-audit questions, and every one of them is answerable without a name:
 *   - who holds `super_admin`, and how many of them are there
 *   - who has never enrolled a second factor
 *   - who has not logged in for months, or ever
 *   - who is still `pending` long after being invited
 *
 * The admin id is the join to everything else: it is the `actor_id` on every
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
 * One admin account, faceless.
 *
 * NEVER: `email_enc`, `email_hash`, `name_enc`, `mfa_secret_enc`. The last of those is the
 * most important — it is the TOTP seed, and returning it would let any reader mint valid
 * second factors for that admin forever.
 */
export interface AdminDirectoryRow {
  id: string;
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
