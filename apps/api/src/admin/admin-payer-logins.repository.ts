import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  auditLogs,
  payers,
  payerMembers,
  payerOrgs,
  type Database,
  type OrgRole,
  type PayerRole,
  type PayerStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import type { AdminAccountPasswordState } from "./admin-payer-logins.dto";

/** One payer row as the accounts list reads it — NO contact ciphertext, NO password hash. */
export interface AdminAccountRow {
  id: string;
  role: PayerRole;
  status: PayerStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
  passwordSetAt: Date | null;
  passwordRevokedAt: Date | null;
  mustChangePassword: boolean;
  /** `password_hash IS NOT NULL`, computed in SQL so the hash itself never leaves the row. */
  hasPassword: boolean;
}

export interface AdminAccountMembership {
  memberPayerId: string | null;
  orgId: string;
  orgRole: OrgRole;
}

export interface AdminAccountOrg {
  id: string;
  rootPayerId: string;
}

export interface AdminAccountListInput {
  cursor?: string;
  limit: number;
  role?: PayerRole;
  status?: PayerStatus;
  passwordState?: AdminAccountPasswordState;
  orgId?: string;
}

export interface AdminAccountListResult {
  rows: AdminAccountRow[];
  nextCursor: string | null;
}

/**
 * Data access for #2563 — payer login management.
 *
 * ── THE PROJECTION IS DELIBERATELY FACELESS ──────────────────────────────────────────────
 * The accounts list reads ids, enums, timestamps and one SQL-computed boolean. It never reads
 * `email_enc`, `phone_enc`, `email_hash`, `phone_hash`, `org_name_enc` or `password_hash`; the
 * login identifier and organisation name are resolved through `AdminIdentityService`, the one
 * boundary that can decrypt and the one place that charges the identity budget and writes the
 * audit row. `password_hash IS NOT NULL` is the only password-derived fact here, and it is a
 * boolean, not the credential.
 *
 * ── WRITES ARE TRANSACTIONAL ────────────────────────────────────────────────────────────
 * The credential change, the `audit_logs` reason row and the `admin.action_performed` event
 * share the caller's transaction ({@link withTransaction}); the Redis session revocation runs
 * after commit, because Redis is not transactional with Postgres.
 */
@Injectable()
export class AdminPayerLoginsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * One keyset page of payer accounts, newest first. `org_id` filters to the org's root payer
   * and its active team members, which is the screen's useful scope; the other filters are
   * exact closed enums. Password-state filtering happens in SQL so a filtered page is a full
   * page (not "filter the first 25, then drop rows").
   */
  async listAccounts(input: AdminAccountListInput): Promise<AdminAccountListResult> {
    const cursor = decodeEntityCursor(input.cursor);
    const conditions = [];
    if (input.role) conditions.push(eq(payers.role, input.role));
    if (input.status) conditions.push(eq(payers.status, input.status));

    if (input.passwordState === "temporary_pending") {
      conditions.push(eq(payers.mustChangePassword, true));
    } else if (input.passwordState === "revoked") {
      conditions.push(
        and(
          sql`${payers.passwordRevokedAt} is not null`,
          or(
            sql`${payers.passwordSetAt} is null`,
            sql`${payers.passwordRevokedAt} >= ${payers.passwordSetAt}`,
          )!,
        )!,
      );
    } else if (input.passwordState === "set") {
      conditions.push(
        and(
          eq(payers.mustChangePassword, false),
          sql`${payers.passwordSetAt} is not null`,
          or(
            sql`${payers.passwordRevokedAt} is null`,
            sql`${payers.passwordSetAt} > ${payers.passwordRevokedAt}`,
          )!,
        )!,
      );
    } else if (input.passwordState === "none") {
      conditions.push(
        and(
          eq(payers.mustChangePassword, false),
          sql`${payers.passwordSetAt} is null`,
          sql`${payers.passwordRevokedAt} is null`,
        )!,
      );
    }

    // The org scope is an id set: the org's root plus its active members. A subquery would be
    // one statement; two indexed reads are simpler and the id set is bounded by the page the
    // screen can request.
    if (input.orgId) {
      const [org] = await this.db
        .select({ rootPayerId: payerOrgs.rootPayerId })
        .from(payerOrgs)
        .where(eq(payerOrgs.id, input.orgId))
        .limit(1);
      if (!org) return { rows: [], nextCursor: null };
      const members = await this.db
        .select({ memberPayerId: payerMembers.memberPayerId })
        .from(payerMembers)
        .where(and(eq(payerMembers.orgId, input.orgId), eq(payerMembers.status, "active")));
      const ids = [
        org.rootPayerId,
        ...members.map((m) => m.memberPayerId).filter((id): id is string => id !== null),
      ];
      conditions.push(inArray(payers.id, ids));
    }

    if (cursor) {
      const at = new Date(cursor.createdAt);
      conditions.push(
        or(lt(payers.createdAt, at), and(eq(payers.createdAt, at), lt(payers.id, cursor.id)))!,
      );
    }

    const rows = await this.db
      .select({
        id: payers.id,
        role: payers.role,
        status: payers.status,
        createdAt: payers.createdAt,
        lastLoginAt: payers.lastLoginAt,
        passwordSetAt: payers.passwordSetAt,
        passwordRevokedAt: payers.passwordRevokedAt,
        mustChangePassword: payers.mustChangePassword,
        hasPassword: sql<boolean>`${payers.passwordHash} is not null`,
      })
      .from(payers)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(payers.createdAt), desc(payers.id))
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor:
        rows.length > input.limit && last
          ? encodeEntityCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  /** Active team memberships for a payer id set (one per payer in the current single-org model). */
  async activeMemberships(payerIds: string[]): Promise<AdminAccountMembership[]> {
    if (payerIds.length === 0) return [];
    return this.db
      .select({
        memberPayerId: payerMembers.memberPayerId,
        orgId: payerMembers.orgId,
        orgRole: payerMembers.orgRole,
      })
      .from(payerMembers)
      .where(and(inArray(payerMembers.memberPayerId, payerIds), eq(payerMembers.status, "active")));
  }

  /** The solo org of each payer in the id set (root_payer_id). */
  async orgsByRootPayer(payerIds: string[]): Promise<AdminAccountOrg[]> {
    if (payerIds.length === 0) return [];
    return this.db
      .select({ id: payerOrgs.id, rootPayerId: payerOrgs.rootPayerId })
      .from(payerOrgs)
      .where(inArray(payerOrgs.rootPayerId, payerIds));
  }

  /** Orgs by id — the parent org of a team-member account on the list. */
  async orgsByIds(orgIds: string[]): Promise<AdminAccountOrg[]> {
    if (orgIds.length === 0) return [];
    return this.db
      .select({ id: payerOrgs.id, rootPayerId: payerOrgs.rootPayerId })
      .from(payerOrgs)
      .where(inArray(payerOrgs.id, orgIds));
  }

  /**
   * The written reason for one login write. `audit_logs` is the platform's write-only audit
   * table; the reason code and text live here, NOT on `admin.action_performed` (whose payload
   * is `.strict()` and value-free). `reason_text` is admin-authored and never evented or logged.
   */
  async writeAuditReason(
    tx: Database,
    input: {
      adminId: string;
      payerId: string;
      action: string;
      reasonCode: string;
      reasonText: string;
    },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: input.adminId,
      action: input.action,
      entityType: "payer",
      entityId: input.payerId,
      metadata: {
        reason_code: input.reasonCode,
        reason_text: input.reasonText,
      },
    });
  }
}
