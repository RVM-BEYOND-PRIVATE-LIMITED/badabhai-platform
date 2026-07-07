import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, ne, sql } from "drizzle-orm";
import {
  type Database,
  payers,
  payerOrgs,
  payerMembers,
  type OrgRole,
  type PayerMember,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** A payer's resolved org membership — the org they act within + their role in it. */
export interface ResolvedOrg {
  orgId: string;
  orgRole: OrgRole;
}

/** Input to invite a teammate — the email is already-validated + normalized by the DTO. */
export interface InviteMemberInput {
  orgId: string;
  emailEnc: string;
  emailHash: string;
  orgRole: OrgRole;
  invitedBy: string;
  inviteTokenHash: string;
  inviteExpiresAt: Date;
}

/**
 * The result of {@link PayerOrgsRepository.inviteMemberAtomic}. A discriminated union so the
 * caller (the service) keeps the HTTP-response + event mapping while the repo owns the atomic
 * seat-cap decision. `already_active` / `capped` short-circuit with no write; `invited` carries
 * the upserted row.
 */
export type InviteMemberOutcome =
  | { outcome: "already_active" }
  | { outcome: "capped" }
  | { outcome: "invited"; member: PayerMember };

/**
 * Data access for the payer org tenant model (ADR-0027 / B5). Keeps the invariant that
 * EVERY payer has exactly one solo org (root_payer_id = the payer) with themselves as the
 * single already-accepted OWNER member — the same shape B5.1's migration backfilled for
 * pre-existing payers. This repo re-asserts it for payers created AFTER the backfill (at
 * signup + defensively at login), so the org model is never sparse. All writes are
 * IDEMPOTENT (ON CONFLICT DO NOTHING on the unique keys), so calling ensure repeatedly is
 * a no-op and never mutates an existing org/member. PII: member email mirrors the payer's
 * encrypted login email (email_enc + email_hash, TD21) — never plaintext.
 */
@Injectable()
export class PayerOrgsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Ensure the payer's solo org + owner membership exist; return the resolved org. Idempotent:
   * both inserts ON CONFLICT DO NOTHING on the unique keys (`payer_orgs_root_payer_id_uq`,
   * `payer_members_org_email_uq`), so a payer that already has an org (backfilled or a prior
   * ensure) is untouched. Returns null only if the payer row itself is missing (never expected
   * on the authenticated paths). The org name + member email are copied from the payer row
   * (ciphertext), so no plaintext PII passes through here.
   */
  async ensureSoloOrg(payerId: string): Promise<ResolvedOrg | null> {
    const [payer] = await this.db.select().from(payers).where(eq(payers.id, payerId)).limit(1);
    if (!payer) return null;

    // 1) The solo org (idempotent on root_payer_id). name_enc copied from the payer's org name.
    await this.db
      .insert(payerOrgs)
      .values({ rootPayerId: payerId, nameEnc: payer.orgNameEnc, status: "active" })
      .onConflictDoNothing({ target: payerOrgs.rootPayerId });

    const [org] = await this.db
      .select({ id: payerOrgs.id })
      .from(payerOrgs)
      .where(eq(payerOrgs.rootPayerId, payerId))
      .limit(1);
    if (!org) return null; // unreachable (just inserted-or-existing), but fail-safe

    // 2) The founding owner member (idempotent on (org_id, email_hash)). Email mirrors the
    //    payer's own encrypted login email; already 'accepted' (they founded the org).
    await this.db
      .insert(payerMembers)
      .values({
        orgId: org.id,
        memberPayerId: payerId,
        emailEnc: payer.emailEnc,
        emailHash: payer.emailHash,
        orgRole: "owner",
        status: "active",
        acceptedAt: new Date(),
      })
      .onConflictDoNothing({ target: [payerMembers.orgId, payerMembers.emailHash] });

    return { orgId: org.id, orgRole: "owner" };
  }

  /**
   * Resolve the org a payer acts within + their role — their single ACTIVE membership (B5:
   * one org per member; most-recently-accepted wins if that ever changes). Returns null when
   * the payer has no active membership yet (the caller then falls back to {@link ensureSoloOrg}
   * or treats it fail-closed). PII-free (opaque ids + the org_role enum).
   */
  async resolveOrgForPayer(payerId: string): Promise<ResolvedOrg | null> {
    const [row] = await this.db
      .select({ orgId: payerMembers.orgId, orgRole: payerMembers.orgRole })
      .from(payerMembers)
      .where(and(eq(payerMembers.memberPayerId, payerId), eq(payerMembers.status, "active")))
      .orderBy(desc(payerMembers.acceptedAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * All NON-removed members of an org (invited + active), oldest-invited first — for the
   * owner/member team list. Returns the raw rows (ciphertext email); the SERVICE decrypts +
   * MASKS the email before it leaves the boundary (no plaintext in the response).
   */
  async listMembers(orgId: string): Promise<PayerMember[]> {
    return this.db
      .select()
      .from(payerMembers)
      .where(and(eq(payerMembers.orgId, orgId), ne(payerMembers.status, "removed")))
      .orderBy(asc(payerMembers.invitedAt));
  }

  /** One member row scoped to its org (no-oracle: a foreign/absent id → undefined). */
  async findMember(orgId: string, memberId: string): Promise<PayerMember | undefined> {
    const [row] = await this.db
      .select()
      .from(payerMembers)
      .where(and(eq(payerMembers.id, memberId), eq(payerMembers.orgId, orgId)))
      .limit(1);
    return row;
  }

  /**
   * Invite (or re-invite) a teammate by email, ATOMICALLY against the per-org seat cap.
   *
   * The seat-cap count and the insert run in ONE transaction under a per-ORG advisory lock
   * (`pg_advisory_xact_lock` on the org — lock key == seat-count key == org, mirroring the
   * capacity chokepoint idiom). So N concurrent invites for DIFFERENT new emails can never each
   * read "under cap" and all insert — the TOCTOU a split count-then-insert allowed. The same lock
   * serializes an invite against a concurrent accept of the SAME email, so a re-invite cannot
   * silently downgrade a just-activated member back to `invited`. Org is already resolved by the
   * caller (`@CurrentOrg`), so nothing is resolved inside the tx (no pool-vs-lock deadlock).
   *
   * Outcomes (the caller maps each to its HTTP response + event): `already_active` — the email is
   * a current ACTIVE member (reject, no write); `capped` — a NEW seat would exceed `maxSeats`
   * (reject, no write); `invited` — the row was upserted (a re-invite of an invited/removed email
   * reuses the row with a fresh token + status='invited'; only a NEW email consumes a seat).
   * PII: the email is written ONLY as ciphertext + keyed hash; the invite token ONLY as its hash;
   * `member_payer_id` stays NULL until accept.
   */
  async inviteMemberAtomic(
    input: InviteMemberInput,
    maxSeats: number,
  ): Promise<InviteMemberOutcome> {
    return this.db.transaction(async (tx) => {
      // Serialize all invites for this org on the org advisory lock (== the seat-count key).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.orgId}, 0))`);

      const [existing] = await tx
        .select()
        .from(payerMembers)
        .where(
          and(
            eq(payerMembers.orgId, input.orgId),
            eq(payerMembers.emailHash, input.emailHash),
            ne(payerMembers.status, "removed"),
          ),
        )
        .limit(1);
      if (existing?.status === "active") return { outcome: "already_active" };

      // Only a NEW seat (no existing non-removed row for this email) counts against the cap;
      // a re-invite of an invited/removed email reuses its row and consumes no new seat. The
      // count is under the lock, so it reflects committed state against concurrent invites.
      if (!existing) {
        const [seatRow] = await tx
          .select({ n: count() })
          .from(payerMembers)
          .where(and(eq(payerMembers.orgId, input.orgId), ne(payerMembers.status, "removed")));
        if ((seatRow?.n ?? 0) >= maxSeats) return { outcome: "capped" };
      }

      const now = new Date();
      const [member] = await tx
        .insert(payerMembers)
        .values({
          orgId: input.orgId,
          emailEnc: input.emailEnc,
          emailHash: input.emailHash,
          orgRole: input.orgRole,
          status: "invited",
          invitedBy: input.invitedBy,
          inviteTokenHash: input.inviteTokenHash,
          inviteExpiresAt: input.inviteExpiresAt,
          invitedAt: now,
        })
        .onConflictDoUpdate({
          target: [payerMembers.orgId, payerMembers.emailHash],
          set: {
            orgRole: input.orgRole,
            status: "invited",
            invitedBy: input.invitedBy,
            inviteTokenHash: input.inviteTokenHash,
            inviteExpiresAt: input.inviteExpiresAt,
            invitedAt: now,
            removedAt: null,
            updatedAt: now,
          },
        })
        .returning();
      if (!member) throw new Error("failed to invite payer member");
      return { outcome: "invited", member };
    });
  }

  /**
   * Look up a still-pending invite by its token HASH (never the raw token) — used by the
   * accept flow to resolve which invited member a bearer token belongs to. Matches ONLY a row
   * that is still `invited` AND not past `invite_expires_at` (a consumed/expired/removed token
   * resolves to undefined → the service returns a no-oracle rejection). The caller additionally
   * binds the accept to the authenticated payer's email (defense-in-depth on a leaked token).
   */
  async findByInviteTokenHash(tokenHash: string, now: Date): Promise<PayerMember | undefined> {
    const [row] = await this.db
      .select()
      .from(payerMembers)
      .where(
        and(
          eq(payerMembers.inviteTokenHash, tokenHash),
          eq(payerMembers.status, "invited"),
          gt(payerMembers.inviteExpiresAt, now),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * ACCEPT an invite in ONE guarded write (no TOCTOU): flip an `invited` row to `active`, bind
   * it to the accepting payer, and CONSUME the token (inviteTokenHash → null so it is strictly
   * single-use). The WHERE re-checks id + the token hash + status='invited' + not-expired, so a
   * concurrent double-accept / expired / already-consumed token is a no-op → undefined (the
   * service 409/404s without leaking which). member_payer_id is stamped here (the invite carried
   * only the email until now). Returns the activated row.
   */
  async acceptInvite(input: {
    memberId: string;
    tokenHash: string;
    memberPayerId: string;
    now: Date;
  }): Promise<PayerMember | undefined> {
    const [row] = await this.db
      .update(payerMembers)
      .set({
        status: "active",
        memberPayerId: input.memberPayerId,
        acceptedAt: input.now,
        inviteTokenHash: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(payerMembers.id, input.memberId),
          eq(payerMembers.inviteTokenHash, input.tokenHash),
          eq(payerMembers.status, "invited"),
          gt(payerMembers.inviteExpiresAt, input.now),
        ),
      )
      .returning();
    return row;
  }

  /**
   * SOFT-remove a member (status='removed' + removed_at) — scoped to its org, and NEVER an
   * owner (owner removal / transfer is out of scope for B5.3). One guarded UPDATE (id + org_id
   * + org_role='recruiter' + not-already-removed in the WHERE), so a foreign/owner/gone row is a
   * no-op → returns undefined (the service 404/409s without leaking which). The row is kept
   * (soft-delete) for audit; member_payer_id is preserved.
   */
  async softRemoveMember(orgId: string, memberId: string): Promise<PayerMember | undefined> {
    const [row] = await this.db
      .update(payerMembers)
      .set({ status: "removed", removedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(payerMembers.id, memberId),
          eq(payerMembers.orgId, orgId),
          eq(payerMembers.orgRole, "recruiter"),
          ne(payerMembers.status, "removed"),
        ),
      )
      .returning();
    return row;
  }
}
