import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import type { OrgRole, PayerMember, PayerMemberStatus } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { PayersRepository } from "../payers/payers.repository";
import { PayerOrgsRepository, type ResolvedOrg } from "../payers/payer-orgs.repository";
import type { InviteMemberDto, AcceptInviteDto } from "./payer-org-members.dto";
import { MEMBER_INVITE_MAILER, type MemberInviteMailer } from "./member-invite.mailer";

/** Days an org invite token stays valid before it must be re-issued. */
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
 * a keyed hash.
 *
 * B5.4 adds: the invite ACCEPT flow (single-use token verify → member activation, always live,
 * no provider), a per-org seat cap (MEMBER_INVITE_MAX_PER_ORG), and REAL accept-link email
 * delivery behind the {@link MEMBER_INVITE_MAILER} seam. Delivery is MOCK (no send) by default;
 * the real ZeptoMail/SMTP mailer is chosen only behind MEMBER_INVITES_ENABLE_REAL (§7, staging-
 * first). The raw token appears ONLY in the mailer input (accept link) — never logged/evented.
 */
@Injectable()
export class PayerOrgMembersService {
  constructor(
    private readonly orgs: PayerOrgsRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    private readonly payers: PayersRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(MEMBER_INVITE_MAILER) private readonly mailer: MemberInviteMailer,
  ) {}

  /** The caller's org members (masked), faceless — any member of the org may read. */
  async list(org: ResolvedOrg, callerPayerId: string): Promise<OrgMemberView[]> {
    const rows = await this.orgs.listMembers(org.orgId);
    return rows.map((r) => this.toView(r, callerPayerId));
  }

  /**
   * Invite a teammate by email (owner-only, enforced by the guard). Rejects re-inviting an
   * already-ACTIVE member (409); enforces the per-org seat cap for a NEW seat only (a re-invite
   * of an existing invited/removed email reuses its row, so it does not consume a seat).
   * Encrypts the email, mints a single-use token (stored as a keyed HASH only), records the
   * invited member, emits payer_member.invited (PII-free), then delivers the accept link via the
   * {@link MEMBER_INVITE_MAILER} seam (MOCK no-op by default; real send only behind the gate).
   * Returns the masked view. The raw token/link go ONLY to the mailer — never logged/evented.
   */
  async invite(
    org: ResolvedOrg,
    invitedBy: string,
    dto: InviteMemberDto,
    ctx: RequestContext,
  ): Promise<OrgMemberView> {
    // Bearer token — the RAW value goes ONLY into the accept-link email (the mailer input);
    // only its keyed hash is persisted (single-use, consumed on accept). Minted before the
    // atomic write; on a rejected outcome it is simply discarded (never persisted / mailed).
    const rawToken = `${randomUUID()}${randomUUID()}`;

    // Seat cap + dup-active guard are enforced ATOMICALLY in the repo (per-org advisory lock +
    // count + insert in one tx), so concurrent invites can't overshoot the cap (TOCTOU).
    const result = await this.orgs.inviteMemberAtomic(
      {
        orgId: org.orgId,
        emailEnc: this.pii.encrypt(dto.email),
        emailHash: this.pii.hmac(dto.email),
        orgRole: dto.org_role,
        invitedBy,
        inviteTokenHash: this.pii.hmac(rawToken),
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_DAYS * MS_PER_DAY),
      },
      this.config.MEMBER_INVITE_MAX_PER_ORG,
    );
    if (result.outcome === "already_active") {
      throw new ConflictException("That email is already an active member of this org");
    }
    if (result.outcome === "capped") {
      throw new ConflictException("This organization has reached its member limit");
    }
    const member = result.member;

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

    // Deliver the accept link (MOCK no-op by default; real ZeptoMail/SMTP only behind the gate).
    // The invite is already recorded + evented, so a real-delivery failure surfaces as a 503 and
    // the owner re-invites (upsert refreshes the token + re-sends) — the audit event still holds.
    try {
      await this.mailer.send({ email: dto.email, acceptUrl: this.buildAcceptUrl(rawToken) });
    } catch {
      throw new ServiceUnavailableException("Could not send the invite email; please retry");
    }

    return this.toView(member, invitedBy);
  }

  /**
   * ACCEPT an invite (ADR-0027 / B5.4) — ALWAYS live, no provider. The accepting principal is
   * the authenticated payer (PayerAuthGuard). Resolves the invite by the single-use token HASH
   * (never the raw token); a missing/expired/consumed token is a no-oracle 404. Binds the accept
   * to the caller's OWN verified email (defense-in-depth on a leaked link) — an email mismatch is
   * 403. Activates the member in one guarded write (consumes the token), then emits
   * payer_member.accepted (PII-free). Returns the masked view of the now-active membership.
   */
  async accept(
    payerId: string,
    dto: AcceptInviteDto,
    ctx: RequestContext,
  ): Promise<OrgMemberView> {
    const now = new Date();
    const tokenHash = this.pii.hmac(dto.token);

    const member = await this.orgs.findByInviteTokenHash(tokenHash, now);
    if (!member) throw new NotFoundException("Invalid or expired invite");

    // The accept must be completed by the SAME identity the invite was addressed to — compare
    // the caller's verified email hash to the invite's (both keyed HMACs; no plaintext).
    const payer = await this.payers.findById(payerId);
    if (!payer || payer.emailHash !== member.emailHash) {
      throw new ForbiddenException("This invite is for a different account");
    }

    const accepted = await this.orgs.acceptInvite({
      memberId: member.id,
      tokenHash,
      memberPayerId: payerId,
      now,
    });
    if (!accepted) throw new ConflictException("Invite has already been used or has expired");

    await this.events.emit({
      event_name: "payer_member.accepted",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "payer", subject_id: accepted.id },
      payload: { member_id: accepted.id, org_id: accepted.orgId, member_payer_id: payerId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return this.toView(accepted, payerId);
  }

  /**
   * Build the accept link the invitee follows. When MEMBER_INVITE_ACCEPT_URL is set (required
   * for real sends), the single-use raw token is appended as a query param; otherwise (mock,
   * no base configured) a `mock://` link is returned — the mock mailer never transmits it, so
   * the raw token still never leaves the process.
   */
  private buildAcceptUrl(rawToken: string): string {
    const base = this.config.MEMBER_INVITE_ACCEPT_URL;
    const q = `token=${encodeURIComponent(rawToken)}`;
    if (!base) return `mock://invite/accept?${q}`;
    return `${base}${base.includes("?") ? "&" : "?"}${q}`;
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
