import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, type SQL } from "drizzle-orm";
import { adminUsers, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AdminDirectoryRow } from "./admin-directory.dto";

/**
 * SELECT-ONLY data access for the admin directory (BP-3).
 *
 * ── EXPLICIT PROJECTION, AND WHY IT MATTERS MORE HERE THAN ANYWHERE ─────────────────────
 * `admin_users` holds `mfa_secret_enc` — the TOTP seed. A bare `select()` would return it,
 * and a seed in an HTTP response is a permanent second-factor bypass for that account: the
 * reader could mint valid codes forever, and the admin would never know. `email_enc` and
 * `name_enc` are the same class of mistake, one degree less severe.
 *
 * So every column is named, and a build-blocker scans this file for the four forbidden
 * identifiers.
 *
 * ── WHY THIS LIST IS NOT PAGINATED ──────────────────────────────────────────────────────
 * Deliberate, and the one place in the admin API where keyset paging would be ceremony:
 * `admin_users` is the internal staff table. It holds single digits today and will not
 * plausibly exceed a few dozen — the whole point of the role model is that admin access is
 * scarce. A cursor, a next-page control and an index migration would all be machinery for a
 * page that will never have a second one, and an operator auditing "who has access" wants
 * the WHOLE list on one screen anyway; paging it would actively hide the answer.
 *
 * The hard cap below is the backstop that makes "unpaginated" safe rather than unbounded.
 */

/**
 * Upper bound on the directory. Not a page size — a sanity cap. Reaching it means something
 * has gone wrong with admin provisioning, which is itself worth seeing.
 */
export const ADMIN_DIRECTORY_MAX = 500;

@Injectable()
export class AdminDirectoryRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(
    filter: { role?: string; status?: string },
    selfId: string,
  ): Promise<AdminDirectoryRow[]> {
    const clauses: SQL[] = [];
    if (filter.role) clauses.push(eq(adminUsers.role, filter.role as never));
    if (filter.status) clauses.push(eq(adminUsers.status, filter.status as never));

    const rows = await this.db
      .select({
        id: adminUsers.id,
        role: adminUsers.role,
        status: adminUsers.status,
        mfaEnrolled: adminUsers.mfaEnrolled,
        lastLoginAt: adminUsers.lastLoginAt,
        createdAt: adminUsers.createdAt,
        updatedAt: adminUsers.updatedAt,
      })
      .from(adminUsers)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      // Oldest first: the founding accounts are the ones an audit cares about most, and a
      // stable order beats recency on a list nobody scrolls.
      .orderBy(asc(adminUsers.createdAt), asc(adminUsers.id))
      .limit(ADMIN_DIRECTORY_MAX);

    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      status: r.status,
      mfa_enrolled: r.mfaEnrolled,
      last_login_at: r.lastLoginAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      is_self: r.id === selfId,
    }));
  }

  /**
   * Active `super_admin` count.
   *
   * Reuses no existing helper deliberately: `AdminRepository.countActiveSuperAdmins` exists
   * and is load-bearing for the last-super-admin guard on role change. Calling it from here
   * would couple a display read to a safety invariant's implementation, so that if the guard
   * ever narrowed its definition the directory would silently start reporting that narrower
   * number as "how many admins hold the keys".
   */
  async countActiveSuperAdmins(): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(adminUsers)
      .where(and(eq(adminUsers.role, "super_admin"), eq(adminUsers.status, "active")));
    return rows[0]?.n ?? 0;
  }
}
