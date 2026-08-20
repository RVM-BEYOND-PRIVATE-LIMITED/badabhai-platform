import { Inject, Injectable } from "@nestjs/common";
import { inArray } from "drizzle-orm";
import { adminUsers, payers, workers, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * One entity's stored name, still ENCRYPTED. `nameCipher` is an `encryptPii` token or null
 * (nobody has recorded a name for this row yet — a legitimate, common state).
 */
export interface AdminIdentityRow {
  id: string;
  nameCipher: string | null;
}

/**
 * SELECT-ONLY data access for the admin NAME reads (owner ruling 2026-08-18, reversing
 * ADR-0025 Decision 4).
 *
 * ── WHY THIS IS A SEPARATE REPOSITORY AND NOT THREE EXTRA COLUMNS ───────────────────────
 * `admin-entities.repository.ts` and `admin-directory.repository.ts` both make an absolute
 * promise in their headers — every column named, no PII in the select list — and both are held
 * to it by source-scanning build-blockers in `admin-static-guards.test.ts`. Adding
 * `fullName` / `orgNameEnc` / `nameEnc` to their projections would delete those promises for
 * every OTHER column at the same time: the scan would have to be weakened, and the next
 * accidental `phone_hash` would sail through.
 *
 * Keeping the identity read here means the faceless projections stay faceless and provably so,
 * and the ONE place that touches a name column is a 60-line file whose entire contents a
 * reviewer can hold in their head. It is the same call `#997` made for worker feedback and
 * ADMIN-3b made for the reveal — the exception lives in its own file, so the rule stays a rule.
 *
 * ── THE PROJECTION IS `(id, one name column)` AND NOTHING ELSE ──────────────────────────
 * Not `select()`, not a join, not "while we're here". `workers` carries `phone_e164` and
 * `phone_hash`; `payers` carries four ciphertext columns and two keyed hashes; `admin_users`
 * carries `mfa_secret_enc`, the TOTP seed whose disclosure is a permanent second-factor bypass.
 * A whole-row read here would put every one of them one `return row` away from an HTTP response.
 *
 * ── CIPHERTEXT OUT, ALWAYS ──────────────────────────────────────────────────────────────
 * Nothing in this file decrypts. The caller counts the non-null tokens, commits the audit row,
 * and only then decrypts — an ordering that is only possible because the ciphertext crosses
 * this boundary, and one this repository cannot accidentally break.
 *
 * ── NO WRITES, EVER, AND NO SEARCH ──────────────────────────────────────────────────────
 * Every method is a LOOKUP by a caller-held id set. There is deliberately no name predicate of
 * any kind: `WHERE full_name ILIKE ...` would turn an ops screen into "find me every worker
 * called X", which is a person-discovery tool rather than a console. (It is also impossible by
 * construction — the column is non-deterministic AES ciphertext — and that is exactly why it
 * must not be given a plaintext or hashed sibling later.)
 */
@Injectable()
export class AdminIdentityRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** `workers.full_name` (AES token) for a caller-held id set. */
  async workerNames(ids: string[]): Promise<AdminIdentityRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: workers.id, nameCipher: workers.fullName })
      .from(workers)
      .where(inArray(workers.id, ids));
    return rows;
  }

  /**
   * `payers.org_name_enc` (AES token) for a caller-held id set — the portal's Companies AND
   * Agencies tabs, which are one table split by `role`.
   *
   * This is the BUSINESS display name, not a contact person: no such column exists anywhere in
   * the codebase, and neither `payers.email_enc` nor `agency_kyc.account_holder_name_enc` is a
   * stand-in for one (the latter sits behind the ADR-0022 money/legal gate).
   */
  async payerOrgNames(ids: string[]): Promise<AdminIdentityRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: payers.id, nameCipher: payers.orgNameEnc })
      .from(payers)
      .where(inArray(payers.id, ids));
    return rows;
  }

  /** `admin_users.name_enc` (AES token) for a caller-held id set. NEVER the email or the seed. */
  async adminNames(ids: string[]): Promise<AdminIdentityRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: adminUsers.id, nameCipher: adminUsers.nameEnc })
      .from(adminUsers)
      .where(inArray(adminUsers.id, ids));
    return rows;
  }
}
