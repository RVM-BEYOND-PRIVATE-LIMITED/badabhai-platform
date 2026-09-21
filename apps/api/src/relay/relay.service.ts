import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RelayMessage } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { UnlockService, type RelayResolution } from "../unlocks/unlocks.service";
import { neutralUnavailable, type NeutralUnavailableResponse } from "../unlocks/unlock-response";
import { RelayRepository } from "./relay.repository";
import {
  RELAY_TEMPLATE_WIRE,
  renderOpeningTemplate,
  type PayerRelaySendDto,
  type RelayMessageWire,
  type RelayTemplateWire,
  type RelayThreadWire,
  type WorkerRelayReplyDto,
} from "./relay.dto";

/**
 * The in-app relay's business logic (E0 items 3–5, `docs/agent/phases/E0_BUILD.md`).
 *
 * ── ONE LADDER, BOTH SIDES ────────────────────────────────────────────────────────────────
 *
 * Every method that reads or writes a thread first calls `UnlockService.resolveRelayForPayer`
 * or `resolveRelayForWorker`. That is the fail-closed ladder (live grant, ownership, worker
 * not pending deletion, BOTH employer-contact purposes on the latest consent row) and it is
 * re-run AT USE TIME — the invariant the whole phase exists to make non-vacuous. A resolution
 * failure serves the ONE neutral body (`neutralUnavailable()`), never a reason: the payer
 * learns nothing about the worker's state.
 *
 * ── WHAT THIS SERVICE DOES NOT DO ─────────────────────────────────────────────────────────
 *
 * It never touches a phone (there is no decrypt on this path), never writes `unlocks` /
 * `unlock_routing` (single-writer stays structural), never charges a credit, and never
 * exposes a counterparty identity. The message BODY never rides the event spine — events
 * carry opaque ids + enums + counts only.
 *
 * ── THE ONE PLACE A DISTINCT ERROR IS HONEST ──────────────────────────────────────────────
 *
 * Free text before the worker's first reply is a 400, not the neutral body. It is not a fact
 * about the WORKER (the payer owns this unlock and the thread is theirs); it is a fact about
 * the shape the §B ruling allows at this point in the thread. A neutral body here would make
 * the UI unable to tell "the worker has not replied yet" from "your access is gone".
 */
@Injectable()
export class RelayService {
  private readonly logger = new Logger(RelayService.name);

  constructor(
    private readonly relay: RelayRepository,
    private readonly unlocks: UnlockService,
    private readonly events: EventsService,
  ) {}

  /** The closed opening-template catalogue, for the payer's composer (one source of truth). */
  listTemplates(): { templates: readonly RelayTemplateWire[] } {
    return { templates: RELAY_TEMPLATE_WIRE };
  }

  /**
   * The payer sends a message into their unlock's thread.
   *
   * OPENING vs FREE TEXT is the §B rule: while the worker has not replied, only the closed
   * template shape is accepted; once the worker has replied (an affirmative act by the party
   * the property protects), free text both ways.
   */
  async sendFromPayer(
    payerId: string,
    handle: string,
    dto: PayerRelaySendDto,
    ctx: RequestContext,
  ): Promise<
    { message_id: string; created_at: string } | NeutralUnavailableResponse
  > {
    const resolved = await this.unlocks.resolveRelayForPayer(handle, payerId);
    if (resolved === null) return neutralUnavailable();

    if (dto.kind === "text" && !(await this.relay.hasWorkerReply(resolved.unlockId))) {
      throw new BadRequestException(
        "free text opens after the worker replies; send a template message first",
      );
    }

    const row = await this.relay.insert(
      dto.kind === "template"
        ? {
            unlockId: resolved.unlockId,
            direction: "payer_to_worker",
            kind: "template",
            templateId: dto.template_id,
            body: { template_id: dto.template_id, params: dto.params },
          }
        : {
            unlockId: resolved.unlockId,
            direction: "payer_to_worker",
            kind: "text",
            templateId: null,
            body: { text: dto.text },
          },
    );

    await this.emitSent(row, resolved, payerId, ctx);
    // The worker-facing signal (E0 item 5). Emitted ONLY for the inbound leg — see the
    // payload's docblock: a single event for both directions would tell the worker
    // "someone messaged you" about their own reply.
    const receivedPayload: PayloadInputOf<"relay.message_received"> = {
      worker_id: resolved.workerId,
      unlock_id: resolved.unlockId,
      message_id: row.id,
    };
    await this.events.emit({
      event_name: "relay.message_received",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "worker", subject_id: resolved.workerId },
      payload: receivedPayload,
      idempotencyKey: `relay.message_received:${row.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { message_id: row.id, created_at: row.createdAt.toISOString() };
  }

  /** The caller's own threads. Listing is own-data read; opening one re-runs the ladder. */
  async listThreads(workerId: string): Promise<{ threads: RelayThreadWire[] }> {
    const rows = await this.relay.listThreadsForWorker(workerId);
    return {
      threads: rows.map((row) => ({
        unlock_id: row.unlock_id,
        last_message_at: row.last_message_at.toISOString(),
        unread_count: row.unread_count,
      })),
    };
  }

  /** One thread's messages, oldest-first, rendered. Resolution-gated (neutral on failure). */
  async readThread(
    workerId: string,
    unlockId: string,
  ): Promise<{ messages: RelayMessageWire[] } | NeutralUnavailableResponse> {
    const resolved = await this.unlocks.resolveRelayForWorker(unlockId, workerId);
    if (resolved === null) return neutralUnavailable();
    const rows = await this.relay.listByUnlock(resolved.unlockId);
    return { messages: rows.map((row) => this.toWire(row)) };
  }

  /** The worker replies — free text by design (§B). Resolution-gated, same ladder. */
  async replyFromWorker(
    workerId: string,
    unlockId: string,
    dto: WorkerRelayReplyDto,
    ctx: RequestContext,
  ): Promise<
    { message_id: string; created_at: string } | NeutralUnavailableResponse
  > {
    const resolved = await this.unlocks.resolveRelayForWorker(unlockId, workerId);
    if (resolved === null) return neutralUnavailable();

    const row = await this.relay.insert({
      unlockId: resolved.unlockId,
      direction: "worker_to_payer",
      kind: "text",
      templateId: null,
      body: { text: dto.text },
    });

    await this.emitSent(row, resolved, workerId, ctx);
    return { message_id: row.id, created_at: row.createdAt.toISOString() };
  }

  /**
   * The PAYER half of the thread read (#1636) — the payer's own unlock, resolved from the
   * handle they hold and nothing else.
   *
   * WHY IT EXISTS. Without it a payer can send a template but cannot read the thread or learn
   * whether the worker replied, so the FE would have to invent thread state the E0 contract
   * keeps server-owned (and `POST .../messages` gates free text on exactly that fact).
   *
   * SAME LADDER, SAME NEUTRAL BODY: `resolveRelayForPayer` re-runs the full use-time checks and
   * any failure returns the ONE neutral body — the payer must not learn expiry, ownership or
   * consent state. The wire mirrors the worker route (`RelayMessageWire`), rendered
   * server-side, so one renderer serves both surfaces and the raw body column is never exposed.
   * NO COUNTERPARTY IDENTITY: the payer learns what was said, never who the worker is beyond the
   * handle they already had.
   */
  async readThreadForPayer(
    payerId: string,
    handle: string,
  ): Promise<{ messages: RelayMessageWire[] } | NeutralUnavailableResponse> {
    const resolved = await this.unlocks.resolveRelayForPayer(handle, payerId);
    if (resolved === null) return neutralUnavailable();
    const rows = await this.relay.listByUnlock(resolved.unlockId);
    return { messages: rows.map((row) => this.toWire(row)) };
  }

  /** Mark the thread's inbound messages read. AUDIT event only (no payer-visible receipt). */
  async markThreadRead(
    workerId: string,
    unlockId: string,
    ctx: RequestContext,
  ): Promise<{ marked: number } | NeutralUnavailableResponse> {
    const resolved = await this.unlocks.resolveRelayForWorker(unlockId, workerId);
    if (resolved === null) return neutralUnavailable();

    const marked = await this.relay.markInboundRead(resolved.unlockId);
    if (marked > 0) {
      const payload: PayloadInputOf<"relay.message_read"> = {
        unlock_id: resolved.unlockId,
        reader: "worker",
        count: marked,
      };
      await this.events.emit({
        event_name: "relay.message_read",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "unlock", subject_id: resolved.unlockId },
        payload,
        // NO idempotency key, deliberately — the same treatment `unlock.requested` gets. A
        // retry of the same read action finds zero unread rows and emits nothing, so there
        // is no duplicate to converge on; a stable key would instead swallow a LATER, real
        // read action whose count happened to match.
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }
    return { marked };
  }

  // ---- internals -------------------------------------------------------------------------

  /** One emit for every accepted message, in either direction. Never the body. */
  private async emitSent(
    row: RelayMessage,
    resolved: RelayResolution,
    actorId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"relay.message_sent"> = {
      unlock_id: resolved.unlockId,
      message_id: row.id,
      direction: row.direction,
    };
    await this.events.emit({
      event_name: "relay.message_sent",
      actor:
        row.direction === "payer_to_worker"
          ? { actor_type: "payer", actor_id: actorId }
          : { actor_type: "worker", actor_id: actorId },
      subject: { subject_type: "unlock", subject_id: resolved.unlockId },
      payload,
      idempotencyKey: `relay.message_sent:${row.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * A stored row as the wire shape. The BODY COLUMN IS NEVER EXPOSED — a template row is
   * RENDERED from the closed catalogue (so copy changes ship server-side, not in two
   * clients), and a text row carries its text. An unknown template id is a data-integrity
   * fault (the write path validates); it renders as an empty line rather than leaking the id.
   */
  private toWire(row: RelayMessage): RelayMessageWire {
    let text = "";
    if (row.kind === "template" && row.templateId !== null) {
      const body = row.body as { params?: Record<string, string> };
      const rendered = renderOpeningTemplate(row.templateId, body.params ?? {});
      if (rendered === null) {
        this.logger.warn(
          `relay message ${row.id} carries an unknown template id; rendering an empty line`,
        );
      }
      text = rendered ?? "";
    } else {
      const body = row.body as { text?: string };
      text = body.text ?? "";
    }
    return {
      message_id: row.id,
      direction: row.direction,
      text,
      created_at: row.createdAt.toISOString(),
      read_at: row.readAt ? row.readAt.toISOString() : null,
    };
  }
}
