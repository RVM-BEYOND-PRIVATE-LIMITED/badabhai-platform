import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import {
  type Database,
  agencyInvites,
  type AgencyInvite,
  type AgencyInviteStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** Funnel counts by stage for one agency's OWN invites (aggregate-only, k-anon floored). */
export interface AgencyInviteStageCounts {
  created: number;
  clicked: number;
  accepted: number;
}

/**
 * Data access for `agency_invites` (ADR-0022). FACELESS: opaque code + payer/worker ids +
 * enums + an optional non-PII campaign tag only. Owner-scoped reads pass the SESSION
 * `inviterPayerId`; the click/accept lookups go by the opaque `code`. NO phone/name/email
 * column exists. The referrals summary returns ONLY aggregate stage counts — never rows.
 */
@Injectable()
export class AgencyInvitesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Mint an owned invite. `inviterPayerId` is the SESSION payer (stamped server-side). */
  async create(input: {
    code: string;
    inviterPayerId: string;
    campaign?: string;
  }): Promise<AgencyInvite> {
    const [row] = await this.db
      .insert(agencyInvites)
      .values({
        code: input.code,
        inviterPayerId: input.inviterPayerId,
        campaign: input.campaign ?? null,
      })
      .returning();
    if (!row) throw new Error("failed to create agency invite");
    return row;
  }

  /** Resolve an invite by its opaque code (used by click + the internal accept seam). */
  async findByCode(code: string): Promise<AgencyInvite | undefined> {
    const [row] = await this.db
      .select()
      .from(agencyInvites)
      .where(eq(agencyInvites.code, code))
      .limit(1);
    return row;
  }

  /** Advance an invite's status (created -> clicked). Idempotent at the caller. */
  async setStatus(id: string, status: AgencyInviteStatus): Promise<void> {
    await this.db
      .update(agencyInvites)
      .set({ status, updatedAt: new Date() })
      .where(eq(agencyInvites.id, id));
  }

  /**
   * Attribute a worker to an invite (the consent-gated accept). Sets the worker handle +
   * status='accepted'. Guarded on the invite still being unattributed so a re-run is a
   * no-op (returns false). Caller has already verified ACTIVE consent (invariant #6).
   */
  async markAccepted(id: string, invitedWorkerId: string): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .update(agencyInvites)
      // `attributed_at` is stamped ONCE here (alongside the worker handle) — it is the
      // 90-day payout-attribution window anchor (ADR-0022 Amendment 2). Set together with
      // status/invited_worker_id so the anchor exists for every newly-attributed invite.
      .set({ status: "accepted", invitedWorkerId, attributedAt: now, updatedAt: now })
      .where(and(eq(agencyInvites.id, id), isNull(agencyInvites.invitedWorkerId)))
      .returning({ id: agencyInvites.id });
    return rows.length > 0;
  }

  /**
   * Aggregate funnel counts for ONE agency's OWN invites, scoped by `inviterPayerId`. A
   * GROUP BY status over the owner's rows — returns COUNTS ONLY (never invite/worker rows),
   * so it can never resolve a single named invitee. The k-anon floor is applied by the
   * service on top of these raw counts.
   */
  async stageCountsForOwner(inviterPayerId: string): Promise<AgencyInviteStageCounts> {
    const rows = await this.db
      .select({ status: agencyInvites.status, n: count() })
      .from(agencyInvites)
      .where(eq(agencyInvites.inviterPayerId, inviterPayerId))
      .groupBy(agencyInvites.status);

    const counts: AgencyInviteStageCounts = { created: 0, clicked: 0, accepted: 0 };
    for (const r of rows) {
      if (r.status === "created") counts.created = Number(r.n);
      else if (r.status === "clicked") counts.clicked = Number(r.n);
      else if (r.status === "accepted") counts.accepted = Number(r.n);
    }
    return counts;
  }
}
