import { Injectable, Logger } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";

/**
 * Mock authentication for Phase 1.
 *
 * NO real OTP provider is integrated. `requestOtp` always "succeeds" and
 * `verifyOtp` accepts any well-formed 4-6 digit code. This exists to exercise
 * the worker-identity + event flow end to end. TODO: integrate a real SMS/OTP
 * provider behind this interface in a later phase.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly events: EventsService,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
  ) {}

  async requestOtp(phone: string, ctx: RequestContext): Promise<{ success: true; channel: string }> {
    const phoneHash = this.pii.hashPhone(phone);
    // NOTE: the raw phone is never logged or put into an event — only its hash.
    await this.events.emit({
      event_name: "worker.otp_requested",
      actor: { actor_type: "worker" },
      subject: { subject_type: "worker" },
      payload: { phone_hash: phoneHash, channel: "sms" },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    this.logger.log("otp requested (mock)");
    return { success: true, channel: "sms" };
  }

  async verifyOtp(
    phone: string,
    _otp: string,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; is_new_worker: boolean; status: string }> {
    const phoneHash = this.pii.hashPhone(phone);

    let worker = await this.workers.findByPhoneHash(phoneHash);
    let isNew = false;

    if (!worker) {
      // Read-miss → atomic insert-or-get. Two concurrent first-time logins can
      // both reach here, so a plain insert would 23505 on the unique phone_hash
      // (TD23). `created` is true only for the request that actually inserted,
      // so the one-time worker.created event can't be double-emitted on a race.
      const result = await this.workers.createOrGetByPhoneHash({
        // Stored encrypted at rest (AES-256-GCM); key lives only in backend config.
        phoneE164: this.pii.encrypt(phone),
        phoneHash,
        status: "active",
      });
      worker = result.worker;
      isNew = result.created;

      if (result.created) {
        await this.events.emit({
          event_name: "worker.created",
          actor: { actor_type: "worker", actor_id: worker.id },
          subject: { subject_type: "worker", subject_id: worker.id },
          payload: { worker_id: worker.id, phone_hash: phoneHash, status: "active" },
          idempotencyKey: `worker.created:${worker.id}`,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        });
      }
    }

    // No idempotencyKey: a worker legitimately verifies/logs in many times, so
    // each otp_verified is a distinct fact (likewise otp_requested resends above).
    await this.events.emit({
      event_name: "worker.otp_verified",
      actor: { actor_type: "worker", actor_id: worker.id },
      subject: { subject_type: "worker", subject_id: worker.id },
      payload: { worker_id: worker.id, phone_hash: phoneHash, is_new_worker: isNew },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { worker_id: worker.id, is_new_worker: isNew, status: worker.status };
  }
}
