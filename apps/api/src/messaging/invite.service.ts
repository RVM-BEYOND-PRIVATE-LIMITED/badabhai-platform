import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { InviteInstallSource } from "@badabhai/event-schema";
import { EventsService } from "../events/events.service";
import { InviteRepository } from "./invite.repository";

export interface CreatedInvite {
  invite_id: string;
  code: string;
  link: string;
}

export type AcceptResult =
  | { ok: true }
  | {
      ok: false;
      // "inviter_unavailable": the inviter was hard-deleted (DSAR SET NULL) — should be
      // unreachable at accept time (the inviter is non-null by construction), kept as a
      // fail-closed branch so the PII-free event never gets a null uuid (ADR-0026 Phase 5).
      reason: "unknown_code" | "self_invite" | "already_attributed" | "inviter_unavailable";
    };

/** A click resolved against the worker→worker funnel. */
export type ClickResult =
  | { ok: true }
  /** The code is not a worker invite — the caller may try the agency code space. */
  | { ok: false; reason: "unknown_code" };

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

  /**
   * Record a click on a WORKER referral link (attribution). Reports `unknown_code` to its
   * CALLER so the public click path can fall through to the agency code space (TD113) —
   * the HTTP surface stays neutral regardless (see InviteClickService/MessagingController).
   */
  async recordClick(code: string): Promise<ClickResult> {
    const invite = await this.repo.findByCode(code);
    if (!invite) return { ok: false, reason: "unknown_code" };
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
   *
   * `source` (B4) records WHICH leg of the post-Dynamic-Links chain carried the code
   * across the Play Store round-trip. It is OPTIONAL and defaults to "unknown", so every
   * existing caller keeps compiling and every pre-B4 client keeps working unchanged.
   */
  async recordAccept(
    code: string,
    invitedWorkerId: string,
    source: InviteInstallSource = "unknown",
  ): Promise<AcceptResult> {
    const invite = await this.repo.findByCode(code);
    if (!invite) return { ok: false, reason: "unknown_code" };
    const inviterWorkerId = invite.inviterWorkerId;
    if (inviterWorkerId === null) return { ok: false, reason: "inviter_unavailable" };
    // SELF-REFERRAL GATE — the single implementation of that rule for the worker funnel.
    // The activation-bonus accrual (X.6) deliberately does NOT re-derive it; it inherits
    // this guarantee, because an invite that never accepted can never accrue.
    if (inviterWorkerId === invitedWorkerId) return { ok: false, reason: "self_invite" };
    if (invite.invitedWorkerId) return { ok: false, reason: "already_attributed" };
    const accepted = await this.repo.markAccepted(invite.id, invitedWorkerId);
    if (!accepted) return { ok: false, reason: "already_attributed" };
    await this.events.emit({
      event_name: "invite.accepted",
      actor: { actor_type: "worker", actor_id: invitedWorkerId },
      subject: { subject_type: "invite", subject_id: invite.id },
      payload: {
        invite_id: invite.id,
        inviter_worker_id: inviterWorkerId,
        invited_worker_id: invitedWorkerId,
      },
      idempotencyKey: `invite.accepted:${invite.id}`,
    });
    // B4 — the install ACTUALLY attributed + which leg delivered it. Emitted only on a
    // successful attribution (the `markAccepted` single-winner write above guarantees at
    // most one per invite), and keyed so an at-least-once retry writes one row.
    await this.events.emit({
      event_name: "invite.install",
      actor: { actor_type: "worker", actor_id: invitedWorkerId },
      subject: { subject_type: "invite", subject_id: invite.id },
      payload: { invite_id: invite.id, invite_kind: "worker", source },
      idempotencyKey: `invite.install:${invite.id}`,
    });
    return { ok: true };
  }
}
