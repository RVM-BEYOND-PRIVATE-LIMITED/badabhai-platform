import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, ne } from "drizzle-orm";
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

  /** The current NON-removed member for an email in an org (dup-invite / already-member guard). */
  async findActiveOrInvitedByEmail(orgId: string, emailHash: string): Promise<PayerMember | undefined> {
    const [row] = await this.db
      .select()
      .from(payerMembers)
      .where(
        and(
          eq(payerMembers.orgId, orgId),
          eq(payerMembers.emailHash, emailHash),
          ne(payerMembers.status, "removed"),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Invite (or re-invite) a teammate by email — upsert on the unique (org_id, email_hash) so a
   * re-invite (of an invited OR previously-removed email) reuses the row with a fresh token +
   * status='invited'. The caller ({@link import("../payer-portal/payer-org-members.service").PayerOrgMembersService})
   * rejects re-inviting an ACTIVE member first. member_payer_id stays NULL until accept. PII:
   * the email is written ONLY as ciphertext + keyed hash (never plaintext); the invite token is
   * stored ONLY as its hash (bearer secret). Returns the invited row.
   */
  async inviteMember(input: InviteMemberInput): Promise<PayerMember> {
    const [row] = await this.db
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
        invitedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [payerMembers.orgId, payerMembers.emailHash],
        set: {
          orgRole: input.orgRole,
          status: "invited",
          invitedBy: input.invitedBy,
          inviteTokenHash: input.inviteTokenHash,
          inviteExpiresAt: input.inviteExpiresAt,
          invitedAt: new Date(),
          removedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("failed to invite payer member");
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
