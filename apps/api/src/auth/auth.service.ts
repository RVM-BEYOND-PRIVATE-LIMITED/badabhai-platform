import { Injectable, Logger } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { hashPhone } from "../common/crypto";
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
  ) {}

  async requestOtp(phone: string, ctx: RequestContext): Promise<{ success: true; channel: string }> {
    const phoneHash = hashPhone(phone);
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
    const phoneHash = hashPhone(phone);

    let worker = await this.workers.findByPhoneHash(phoneHash);
    const isNew = !worker;

    if (!worker) {
      worker = await this.workers.create({
        phoneE164: phone,
        phoneHash,
        status: "active",
      });
      await this.events.emit({
        event_name: "worker.created",
        actor: { actor_type: "worker", actor_id: worker.id },
        subject: { subject_type: "worker", subject_id: worker.id },
        payload: { worker_id: worker.id, phone_hash: phoneHash, status: "active" },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

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
