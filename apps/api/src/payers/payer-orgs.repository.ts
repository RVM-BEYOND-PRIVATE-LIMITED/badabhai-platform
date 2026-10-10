import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  type Database,
  payers,
  payerOrgs,
  payerMembers,
  type OrgRole,
  type PayerMember,
  type PayerRole,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { ActiveMembershipFacts } from "./payer-tenant-scope";

/** A payer's resolved org membership — the org they act within + their role in it. */
export interface ResolvedOrg {
  orgId: string;
  orgRole: OrgRole;
}

/**
 * A Drizzle transaction handle: the first argument of a `db.transaction` callback. The invite
 * and accept paths run their membership reads and their write inside ONE transaction that first
 * takes the membership lock ({@link PayerOrgsRepository.lockPayerForMembership}; risk R65).
 */
export type PayerOrgsTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Where a statement runs: inside the caller's transaction, or on the pool. */
type Executor = Database | PayerOrgsTx;

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

  /** Run `work` inside ONE transaction (the invite and accept paths' atomic boundary, R65). */
  async withTransaction<T>(work: (tx: PayerOrgsTx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * THE MEMBERSHIP LOCK (risk R65, ADR-0053 §3.5): the payer's own `payers` row, held until `tx`
   * ends. Invite rules A1/A2 are check-then-write; every path that can break one of them takes
   * this lock FIRST, then reads and writes inside the same `tx`:
   *  - an invite ACCEPT locks the accepter (two accepts by one payer queue, so the second sees
   *    the first's active membership — A1);
   *  - an INVITE locks the inviting org's ANCHOR ({@link lockOrgAnchorForMembership}), the same
   *    row an accept by that anchor locks — so "the anchor joins another team" and "the anchor's
   *    org gains a member" can never both pass their check (A2).
   * `FOR NO KEY UPDATE`: it excludes every other membership lock on the row and plain updates of
   * it, but not the `FOR KEY SHARE` a foreign-key check takes, so an unrelated insert that
   * references this payer never waits on an accept. In READ COMMITTED each statement after the
   * lock reads a fresh snapshot, so a waiter sees whatever the holder committed. Returns false
   * when there is no such payer (the caller fails closed).
   */
  async lockPayerForMembership(tx: PayerOrgsTx, payerId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: payers.id })
      .from(payers)
      .where(eq(payers.id, payerId))
      .for("no key update");
    return rows.length > 0;
  }

  /**
   * {@link lockPayerForMembership} on the ANCHOR of `orgId` (`payer_orgs.root_payer_id`), in one
   * statement. The invite path's lock: invites are owner-only and the only owner is the anchor,
   * but the row locked is derived from the org, never from the caller. Returns the anchor's id,
   * or null when the org does not exist.
   */
  async lockOrgAnchorForMembership(tx: PayerOrgsTx, orgId: string): Promise<string | null> {
    const [row] = await tx
      .select({ anchor: payers.id })
      .from(payers)
      .innerJoin(payerOrgs, eq(payerOrgs.rootPayerId, payers.id))
      .where(eq(payerOrgs.id, orgId))
      .for("no key update", { of: payers });
    return row?.anchor ?? null;
  }

  /**
   * Every ACTIVE membership of a payer, joined to its org and to the org's anchor payer
   * (ADR-0053 rule R1). DB access only: WHICH membership the payer acts in is decided by
   * `chooseActingOrg` (payer-tenant-scope.ts), called through `PayerTenantScopeService` — the
   * one choice the Team page, the session org claim, `GET /payer/me` and the tenant predicates
   * share. Do not pick a row here.
   *
   * One round trip: `payer_members_member_payer_id_idx`, then primary-key joins. Every join
   * follows a NOT NULL foreign key (org_id → payer_orgs, root_payer_id → payers) or the
   * payer's own row, so it keeps exactly the rows the WHERE selects. Ordered newest-accepted
   * first, the order the pre-ADR single-row read used. PII-free: ids and enums only. Pass `tx`
   * to read under the membership lock (the invite and accept rules, R65).
   */
  async listActiveMembershipsWithAnchor(
    payerId: string,
    tx?: PayerOrgsTx,
  ): Promise<ActiveMembershipFacts[]> {
    const exec: Executor = tx ?? this.db;
    const anchor = alias(payers, "anchor");
    const member = alias(payers, "member");
    return exec
      .select({
        orgId: payerMembers.orgId,
        orgRole: payerMembers.orgRole,
        acceptedAt: payerMembers.acceptedAt,
        orgStatus: payerOrgs.status,
        anchorPayerId: payerOrgs.rootPayerId,
        anchorRole: anchor.role,
        anchorStatus: anchor.status,
        memberRole: member.role,
      })
      .from(payerMembers)
      .innerJoin(payerOrgs, eq(payerOrgs.id, payerMembers.orgId))
      .innerJoin(anchor, eq(anchor.id, payerOrgs.rootPayerId))
      .innerJoin(member, eq(member.id, payerMembers.memberPayerId))
      .where(and(eq(payerMembers.memberPayerId, payerId), eq(payerMembers.status, "active")))
      .orderBy(desc(payerMembers.acceptedAt));
  }

  /**
   * Does this payer anchor a TEAM org — their own org has at least one non-removed member
   * (invited or active) other than themselves? Invite rule A2 (ADR-0053 §3.5). An invited row
   * has no member_payer_id yet, so NULL counts as "someone else" (IS DISTINCT FROM, spelled
   * out because a bare `<>` drops the NULL). Pass `tx` to read under the membership lock (R65).
   */
  async anchorsTeamOrg(payerId: string, tx?: PayerOrgsTx): Promise<boolean> {
    const exec: Executor = tx ?? this.db;
    const [row] = await exec
      .select({ id: payerMembers.id })
      .from(payerMembers)
      .innerJoin(payerOrgs, eq(payerOrgs.id, payerMembers.orgId))
      .where(
        and(
          eq(payerOrgs.rootPayerId, payerId),
          ne(payerMembers.status, "removed"),
          or(isNull(payerMembers.memberPayerId), ne(payerMembers.memberPayerId, payerId)),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** The vertical role of an org's anchor payer — invite rule A3 (ADR-0053 §3.5, O-9). */
  async findAnchorRole(orgId: string, tx?: PayerOrgsTx): Promise<PayerRole | null> {
    const exec: Executor = tx ?? this.db;
    const [row] = await exec
      .select({ role: payers.role })
      .from(payerOrgs)
      .innerJoin(payers, eq(payers.id, payerOrgs.rootPayerId))
      .where(eq(payerOrgs.id, orgId))
      .limit(1);
    return row?.role ?? null;
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
   * Count the NON-removed members of an org (active + invited) — the per-org seat cap the
   * invite path enforces (a backstop against unbounded invite minting). Removed rows are
   * excluded so freeing a seat re-opens the cap. Under the invite path's membership lock
   * (`tx`), concurrent invites into one org also count one at a time.
   */
  async countActiveOrInvited(orgId: string, tx?: PayerOrgsTx): Promise<number> {
    const exec: Executor = tx ?? this.db;
    const [row] = await exec
      .select({ n: count() })
      .from(payerMembers)
      .where(and(eq(payerMembers.orgId, orgId), ne(payerMembers.status, "removed")));
    return row?.n ?? 0;
  }

  /** The current NON-removed member for an email in an org (dup-invite / already-member guard). */
  async findActiveOrInvitedByEmail(
    orgId: string,
    emailHash: string,
    tx?: PayerOrgsTx,
  ): Promise<PayerMember | undefined> {
    const exec: Executor = tx ?? this.db;
    const [row] = await exec
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
   * stored ONLY as its hash (bearer secret). Returns the invited row. `tx`: the invite path's
   * transaction, under the anchor's membership lock (R65).
   */
  async inviteMember(input: InviteMemberInput, tx?: PayerOrgsTx): Promise<PayerMember> {
    const exec: Executor = tx ?? this.db;
    const [row] = await exec
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
   * only the email until now). Returns the activated row. `tx`: the accept path's transaction,
   * under the accepter's membership lock, so the A1–A3 reads and this write are one unit (R65).
   */
  async acceptInvite(
    input: {
      memberId: string;
      tokenHash: string;
      memberPayerId: string;
      now: Date;
    },
    tx?: PayerOrgsTx,
  ): Promise<PayerMember | undefined> {
    const exec: Executor = tx ?? this.db;
    const [row] = await exec
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
