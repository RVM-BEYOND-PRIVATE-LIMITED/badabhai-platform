import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { OrgRole, PayerMember, PayerMemberStatus } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { PayerOrgsRepository, type ResolvedOrg } from "../payers/payer-orgs.repository";
import type { InviteMemberDto } from "./payer-org-members.dto";

/** Days an org invite token stays valid (mock alpha; real delivery + accept lands in B5.4). */
const INVITE_TTL_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/**
 * A member as shown to the team list — FACELESS by default: opaque `member_id` + role +
 * status + a MASKED email label (never the raw email) + when they were invited. `is_self`
 * lets the UI mark the caller's own row. No PII, no invite token.
 */
export interface OrgMemberView {
  member_id: string;
  org_role: OrgRole;
  status: PayerMemberStatus;
  email_masked: string;
  invited_at: string;
  is_self: boolean;
}

/**
 * Payer org membership management (ADR-0027 / B5.3) — list / invite / remove teammates within
 * the caller's OWN org. The org is ALWAYS the caller's resolved org (`@CurrentOrg`, from the
 * verified session), never a body value (XB-A); writes are gated to `owner` by
 * {@link import("../payers/payer-org-role.guard").PayerOrgRoleGuard}. Every emitted event is
 * PII-free (ids + role enum). The invitee EMAIL is encrypted at rest (email_enc + email_hash,
 * TD21) and only ever MASKED in a response; the invite token is a bearer secret stored ONLY as
 * a keyed hash. MOCK invites in B5.3 (no real send / accept — that is B5.4 behind
 * MEMBER_INVITES_ENABLE_REAL).
 */
@Injectable()
export class PayerOrgMembersService {
  constructor(
    private readonly orgs: PayerOrgsRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /** The caller's org members (masked), faceless — any member of the org may read. */
  async list(org: ResolvedOrg, callerPayerId: string): Promise<OrgMemberView[]> {
    const rows = await this.orgs.listMembers(org.orgId);
    return rows.map((r) => this.toView(r, callerPayerId));
  }

  /**
   * Invite a teammate by email (owner-only, enforced by the guard). Rejects re-inviting an
   * already-ACTIVE member (409). Encrypts the email, mints a single-use token (stored as a keyed
   * HASH only), records the invited member, emits payer_member.invited (PII-free), and returns
   * the masked view. MOCK: no email is sent in B5.3.
   */
  async invite(
    org: ResolvedOrg,
    invitedBy: string,
    dto: InviteMemberDto,
    ctx: RequestContext,
  ): Promise<OrgMemberView> {
    const emailHash = this.pii.hmac(dto.email);

    const existing = await this.orgs.findActiveOrInvitedByEmail(org.orgId, emailHash);
    if (existing && existing.status === "active") {
      throw new ConflictException("That email is already an active member of this org");
    }

    // Bearer token — the RAW value never leaves the service in B5.3 (no delivery yet); only its
    // keyed hash is persisted. B5.4 delivers the raw token via the accept-link email.
    const rawToken = `${randomUUID()}${randomUUID()}`;
    const inviteTokenHash = this.pii.hmac(rawToken);

    const member = await this.orgs.inviteMember({
      orgId: org.orgId,
      emailEnc: this.pii.encrypt(dto.email),
      emailHash,
      orgRole: dto.org_role,
      invitedBy,
      inviteTokenHash,
      inviteExpiresAt: new Date(Date.now() + INVITE_TTL_DAYS * MS_PER_DAY),
    });

    await this.events.emit({
      event_name: "payer_member.invited",
      actor: { actor_type: "payer", actor_id: invitedBy },
      subject: { subject_type: "payer", subject_id: member.id },
      payload: {
        member_id: member.id,
        org_id: org.orgId,
        org_role: member.orgRole,
        invited_by: invitedBy,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return this.toView(member, invitedBy);
  }

  /**
   * Remove a teammate (owner-only, soft-delete). No-oracle 404 for an unknown OR another org's
   * member (the lookup is org-scoped); an owner cannot be removed (409 — ownership transfer is
   * out of B5.3 scope). Emits payer_member.removed (PII-free).
   */
  async remove(
    org: ResolvedOrg,
    removedBy: string,
    memberId: string,
    ctx: RequestContext,
  ): Promise<{ member_id: string; status: "removed" }> {
    const member = await this.orgs.findMember(org.orgId, memberId);
    if (!member) throw new NotFoundException("Member not found");
    if (member.orgRole === "owner") {
      throw new ConflictException("An owner cannot be removed");
    }
    if (member.status === "removed") {
      throw new ConflictException("Member is already removed");
    }

    const removed = await this.orgs.softRemoveMember(org.orgId, memberId);
    if (!removed) throw new NotFoundException("Member not found");

    await this.events.emit({
      event_name: "payer_member.removed",
      actor: { actor_type: "payer", actor_id: removedBy },
      subject: { subject_type: "payer", subject_id: removed.id },
      payload: { member_id: removed.id, org_id: org.orgId, removed_by: removedBy },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { member_id: removed.id, status: "removed" };
  }

  /** Map a member row to its faceless view — decrypts the email ONLY to MASK it (never leaks raw). */
  private toView(row: PayerMember, callerPayerId: string): OrgMemberView {
    return {
      member_id: row.id,
      org_role: row.orgRole,
      status: row.status,
      email_masked: PayerOrgMembersService.maskEmail(this.pii.decrypt(row.emailEnc)),
      invited_at: row.invitedAt.toISOString(),
      is_self: row.memberPayerId === callerPayerId,
    };
  }

  /** Mask an email to a low-PII label: first char + dots + the domain (e.g. `h•••@acme.example`). */
  private static maskEmail(email: string): string {
    const at = email.indexOf("@");
    if (at <= 0) return "•••";
    const first = email[0];
    const domain = email.slice(at + 1);
    return `${first}•••@${domain}`;
  }
}
