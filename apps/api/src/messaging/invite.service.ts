import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EventsService } from "../events/events.service";
import { InviteRepository } from "./invite.repository";

export interface CreatedInvite {
  invite_id: string;
  code: string;
  link: string;
}

export type AcceptResult =
  | { ok: true }
  | { ok: false; reason: "unknown_code" | "self_invite" | "already_attributed" };

/**
 * Invite funnel + PII-free attribution (ADR-0020 Decision 3). An invite is an opaque
 * deep-link token; attribution links inviter→invited by worker id only — no phone,
 * name, or message body ever touches this path. Upstream signal for the deferred
 * agency-referral payout attribution.
 */
@Injectable()
export class InviteService {
  constructor(
    private readonly repo: InviteRepository,
    private readonly events: EventsService,
  ) {}

  /** A worker creates a shareable referral link. */
  async createInvite(inviterWorkerId: string, campaign?: string): Promise<CreatedInvite> {
    const code = randomUUID().replace(/-/g, "").slice(0, 12);
    const invite = await this.repo.create({ code, inviterWorkerId, campaign });
    await this.events.emit({
      event_name: "invite.created",
      actor: { actor_type: "worker", actor_id: inviterWorkerId },
      subject: { subject_type: "invite", subject_id: invite.id },
      payload: { invite_id: invite.id, inviter_worker_id: inviterWorkerId, channel: "whatsapp", campaign },
      idempotencyKey: `invite.created:${invite.id}`,
    });
    return { invite_id: invite.id, code, link: `/i/${code}` };
  }

  /** Record a click on a referral link (attribution). Neutral on an unknown code. */
  async recordClick(code: string): Promise<{ ok: boolean }> {
    const invite = await this.repo.findByCode(code);
    if (!invite) return { ok: false };
    if (invite.status === "created") await this.repo.markClicked(invite.id);
    await this.events.emit({
      event_name: "invite.clicked",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "invite", subject_id: invite.id },
      payload: { invite_id: invite.id, channel: "whatsapp" },
    });
    return { ok: true };
  }

  /**
   * Attribute a new worker to an invite (called from the signup flow). Anti-abuse:
   * rejects self-invite and a duplicate attribution; idempotent on the invite.
   */
  async recordAccept(code: string, invitedWorkerId: string): Promise<AcceptResult> {
    const invite = await this.repo.findByCode(code);
    if (!invite) return { ok: false, reason: "unknown_code" };
    if (invite.inviterWorkerId === invitedWorkerId) return { ok: false, reason: "self_invite" };
    if (invite.invitedWorkerId) return { ok: false, reason: "already_attributed" };
    await this.repo.markAccepted(invite.id, invitedWorkerId);
    await this.events.emit({
      event_name: "invite.accepted",
      actor: { actor_type: "worker", actor_id: invitedWorkerId },
      subject: { subject_type: "invite", subject_id: invite.id },
      payload: {
        invite_id: invite.id,
        inviter_worker_id: invite.inviterWorkerId,
        invited_worker_id: invitedWorkerId,
      },
      idempotencyKey: `invite.accepted:${invite.id}`,
    });
    return { ok: true };
  }
}
