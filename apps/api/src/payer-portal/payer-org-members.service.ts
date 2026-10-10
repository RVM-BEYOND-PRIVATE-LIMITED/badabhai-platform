import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import type { OrgRole, PayerMember, PayerMemberStatus, PayerRole } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { PayersRepository } from "../payers/payers.repository";
import {
  PayerOrgsRepository,
  type PayerOrgsTx,
  type ResolvedOrg,
} from "../payers/payer-orgs.repository";
import { isTeamMembership } from "../payers/payer-tenant-scope";
import type { InviteMemberDto, AcceptInviteDto } from "./payer-org-members.dto";
import { MEMBER_INVITE_MAILER, type MemberInviteMailer } from "./member-invite.mailer";

/** Days an org invite token stays valid before it must be re-issued. */
const INVITE_TTL_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/**
 * The ONE body for every ADR-0053 §3.5 accept refusal (A1, A2, A3). It names no rule and no
 * org, so the response says nothing beyond "not with this account"; the rule is in the log.
 */
export const INVITE_NOT_ACCEPTABLE_MESSAGE = "This invite can't be accepted with this account";

/** ADR-0053 §3.5 — the membership invariant an accept would break. */
export type AcceptRefusalRule =
  | "A1_already_in_a_team" // already an active member of another org's team
  | "A2_anchors_a_team" // anchors their own team (another non-removed member)
  | "A3_role_mismatch"; // vertical role differs from the inviting org's anchor (O-9)

/**
 * The ONE body for an invite the org's anchor may no longer send (risk R65, the invite side of
 * A2): the anchor has joined another org's team, so their own org must not become a team. Names
 * no rule and no org; the rule is in the log. Reachable only through a race with that accept —
 * once the accept commits, the guard keys the anchor to the other team, where they are not owner.
 */
export const INVITE_NOT_SENDABLE_MESSAGE = "This organization can't invite members right now";

/** Why the invite path refuses under the membership lock (logged; the response is neutral). */
type InviteRefusalRule =
  | "A2_anchor_joined_a_team" // the anchor is an active member of another org's team
  | "org_missing"; // the org named by the session's membership no longer resolves

/** What the invite transaction decided; the service turns it into the response after commit. */
type InviteOutcome =
  | { readonly kind: "invited"; readonly member: PayerMember }
  | { readonly kind: "already_active" }
  | { readonly kind: "seat_cap" }
  | { readonly kind: "refused"; readonly rule: InviteRefusalRule };

/** What the accept transaction decided; the service turns it into the response after commit. */
type AcceptOutcome =
  | { readonly kind: "accepted"; readonly member: PayerMember }
  | { readonly kind: "refused"; readonly rule: AcceptRefusalRule }
  | { readonly kind: "consumed" } // the token was used, expired or re-issued since the read
  | { readonly kind: "no_payer" }; // the accepter's payers row is gone (fail closed)

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
  private readonly logger = new Logger(PayerOrgMembersService.name);

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
   *
   * Risk R65 (ADR-0053 §3.5, A2 from the invite side): the checks and the write run in ONE
   * transaction holding the org ANCHOR's membership lock — the same row lock an accept by that
   * anchor takes — so an anchor accepting another org's invite and their own org gaining a member
   * can never both land. Under the lock it refuses (neutral 409, logged, no event, no mail) when
   * the anchor is already an active member of another org's team. The seat cap is counted under
   * the same lock. The event and the email follow the commit.
   */
  async invite(
    org: ResolvedOrg,
    invitedBy: string,
    dto: InviteMemberDto,
    ctx: RequestContext,
  ): Promise<OrgMemberView> {
    const emailHash = this.pii.hmac(dto.email);

    // Bearer token — the RAW value goes ONLY into the accept-link email (the mailer input);
    // only its keyed hash is persisted (single-use, consumed on accept).
    const rawToken = `${randomUUID()}${randomUUID()}`;
    const inviteTokenHash = this.pii.hmac(rawToken);

    const outcome = await this.orgs.withTransaction(async (tx): Promise<InviteOutcome> => {
      const anchor = await this.orgs.lockOrgAnchorForMembership(tx, org.orgId);
      if (!anchor) return { kind: "refused", rule: "org_missing" };
      const anchorMemberships = await this.orgs.listActiveMembershipsWithAnchor(anchor, tx);
      if (anchorMemberships.some((m) => isTeamMembership(m, anchor))) {
        return { kind: "refused", rule: "A2_anchor_joined_a_team" };
      }

      const existing = await this.orgs.findActiveOrInvitedByEmail(org.orgId, emailHash, tx);
      if (existing && existing.status === "active") return { kind: "already_active" };
      // Seat cap: only a NEW seat (no existing non-removed row for this email) counts against it.
      if (!existing) {
        const seats = await this.orgs.countActiveOrInvited(org.orgId, tx);
        if (seats >= this.config.MEMBER_INVITE_MAX_PER_ORG) return { kind: "seat_cap" };
      }

      const member = await this.orgs.inviteMember(
        {
          orgId: org.orgId,
          emailEnc: this.pii.encrypt(dto.email),
          emailHash,
          orgRole: dto.org_role,
          invitedBy,
          inviteTokenHash,
          inviteExpiresAt: new Date(Date.now() + INVITE_TTL_DAYS * MS_PER_DAY),
        },
        tx,
      );
      return { kind: "invited", member };
    });

    if (outcome.kind === "already_active") {
      throw new ConflictException("That email is already an active member of this org");
    }
    if (outcome.kind === "seat_cap") {
      throw new ConflictException("This organization has reached its member limit");
    }
    if (outcome.kind === "refused") {
      this.logger.warn(
        `payer invite refused: rule=${outcome.rule} org=${org.orgId} inviter=${invitedBy}`,
      );
      throw new ConflictException(INVITE_NOT_SENDABLE_MESSAGE);
    }
    const { member } = outcome;

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
   *
   * ADR-0053 §3.5 — then refuses (one neutral 409, logged, no event) an accept that would break
   * a membership invariant the tenant resolver relies on: A1 one team per payer, A2 a team's
   * anchor cannot join another org, A3 the vertical role must match the anchor's (O-9). Checked
   * only AFTER the caller has proved the invite is theirs, and BEFORE the write, so a refusal
   * consumes no token. Only NEW accepts are refused; an existing membership is never touched.
   *
   * Risk R65: the A1–A3 reads and the accept write run in ONE transaction that FIRST takes the
   * accepter's membership lock (their `payers` row), so two accepts by one payer — or an accept
   * racing an invite into the org the accepter anchors, which takes the same lock — run one at a
   * time and the second sees what the first committed. The event follows the commit.
   */
  async accept(payerId: string, dto: AcceptInviteDto, ctx: RequestContext): Promise<OrgMemberView> {
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

    const outcome = await this.orgs.withTransaction(async (tx): Promise<AcceptOutcome> => {
      if (!(await this.orgs.lockPayerForMembership(tx, payerId))) return { kind: "no_payer" };
      const rule = await this.acceptRefusal(tx, payerId, payer.role, member.orgId);
      if (rule) return { kind: "refused", rule };
      const accepted = await this.orgs.acceptInvite(
        { memberId: member.id, tokenHash, memberPayerId: payerId, now },
        tx,
      );
      return accepted ? { kind: "accepted", member: accepted } : { kind: "consumed" };
    });

    if (outcome.kind === "no_payer") {
      throw new ForbiddenException("This invite is for a different account");
    }
    if (outcome.kind === "refused") {
      this.logger.warn(
        `payer invite accept refused: rule=${outcome.rule} payer=${payerId} member=${member.id}`,
      );
      throw new ConflictException(INVITE_NOT_ACCEPTABLE_MESSAGE);
    }
    if (outcome.kind === "consumed") {
      throw new ConflictException("Invite has already been used or has expired");
    }
    const accepted = outcome.member;

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
   * The ADR-0053 §3.5 rule this accept would break, or null. Reads only, inside the accept's
   * transaction under the accepter's membership lock (R65); decides in order A1, A2, A3 so the
   * log names the first breach. A missing anchor role fails CLOSED as A3.
   */
  private async acceptRefusal(
    tx: PayerOrgsTx,
    payerId: string,
    payerRole: PayerRole,
    orgId: string,
  ): Promise<AcceptRefusalRule | null> {
    const memberships = await this.orgs.listActiveMembershipsWithAnchor(payerId, tx);
    if (memberships.some((m) => isTeamMembership(m, payerId))) return "A1_already_in_a_team";
    if (await this.orgs.anchorsTeamOrg(payerId, tx)) return "A2_anchors_a_team";
    if ((await this.orgs.findAnchorRole(orgId, tx)) !== payerRole) return "A3_role_mismatch";
    return null;
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
