import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { type Database, workers } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { MessagingConsentService } from "./messaging-consent.service";
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from "./whatsapp.provider";

export interface ReengagementResult {
  sent: boolean;
  reason?: "no_consent" | "unknown_worker" | "provider_error";
  message_id?: string;
}

/**
 * Worker re-engagement send flow (ADR-0020) — the consent-gated orchestration.
 * Ordering (fail-closed): consent → resolve phone → requested → provider send → sent
 * (or failed). The raw phone is read ONLY to hand to the provider and is NEVER logged
 * or put in an event; every event carries ids + the template id + enums only.
 */
@Injectable()
export class ReengagementService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly consent: MessagingConsentService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  async sendReengagement(workerId: string, template: string): Promise<ReengagementResult> {
    // [1] CONSENT GATE — fail-closed. No whatsapp_messaging consent → never send.
    if (!(await this.consent.hasWhatsAppConsent(workerId))) {
      await this.events.emit({
        event_name: "messaging.suppressed",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId, template, reason: "no_consent" },
      });
      return { sent: false, reason: "no_consent" };
    }

    // [2] Resolve the worker's phone (raw — used ONLY for the provider call below).
    const [row] = await this.db.select().from(workers).where(eq(workers.id, workerId)).limit(1);
    if (!row) {
      await this.events.emit({
        event_name: "messaging.suppressed",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId, template, reason: "unknown_worker" },
      });
      return { sent: false, reason: "unknown_worker" };
    }
    const phoneE164 = this.pii.decrypt(row.phoneE164);

    // [3] requested
    const messageId = randomUUID();
    await this.events.emit({
      event_name: "messaging.requested",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { message_id: messageId, worker_id: workerId, template, channel: "whatsapp", real_call: false },
      idempotencyKey: `messaging.requested:${messageId}`,
    });

    // [4] send via the provider (mock default). Phone used HERE only; never logged/evented.
    try {
      const result = await this.provider.send({ phoneE164, template, workerId });
      await this.events.emit({
        event_name: "messaging.sent",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          message_id: messageId,
          worker_id: workerId,
          template,
          channel: "whatsapp",
          real_call: result.realCall,
        },
        idempotencyKey: `messaging.sent:${messageId}`,
      });
      return { sent: true, message_id: messageId };
    } catch {
      await this.events.emit({
        event_name: "messaging.failed",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          message_id: messageId,
          worker_id: workerId,
          template,
          channel: "whatsapp",
          reason: "provider_error",
          real_call: false,
        },
        idempotencyKey: `messaging.failed:${messageId}`,
      });
      return { sent: false, reason: "provider_error", message_id: messageId };
    }
  }
}
