import { Injectable, Logger } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import type { LoginResponse, OtpRequestResponse } from "./auth.dto";

/**
 * Real OTP login.
 *
 * `requestOtp` issues + sends a one-time code (via OtpService → SmsProvider) and
 * emits `worker.otp_requested`. `verifyOtp` verifies the code FIRST (OtpService
 * throws on a bad/expired code, so a failed verify never touches the worker
 * table), then create-or-gets the worker (TD23 race-safe), mints a rolling
 * session, and emits `worker.created` (once) + `worker.otp_verified`.
 *
 * PRIVACY: the raw phone is never logged or put into an event — only its keyed
 * HASH. The OTP code never appears in any log/event/return value here.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly events: EventsService,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
  ) {}

  async requestOtp(phone: string, ctx: RequestContext): Promise<OtpRequestResponse> {
    // Issue + send first; OtpService throws (cooldown/cap/send-fail/Redis) and we
    // do NOT emit on failure. Only a real, sent code produces the event.
    let issued: { resendInSeconds: number };
    try {
      issued = await this.otp.issueAndSend(phone);
    } catch (err) {
      // OTP-5: the GLOBAL daily send circuit-breaker (the spend ceiling) tripped — emit
      // the PII-free breach event ONCE (so ops can alert on the spend ceiling), then
      // re-throw the SAME neutral 429 the throttle returns (no new oracle). This fires
      // ONLY on the global breach, never on ordinary per-phone cooldowns/caps (those
      // throw a plain HttpException). The payload is AGGREGATE — no phone/IP/code/id.
      if (err instanceof OtpSendCapExceededException) {
        await this.events.emit({
          event_name: "worker.otp_send_cap_exceeded",
          actor: { actor_type: "system" },
          subject: { subject_type: "worker" },
          payload: {
            channel: err.breach.channel,
            cap: "global_daily",
            limit: err.breach.limit,
            window: err.breach.window,
          },
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        });
      }
      throw err;
    }
    const { resendInSeconds } = issued;

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
    this.logger.log("otp requested");
    // The code is delivered ONLY to the worker's phone via the real SMS provider; it is
    // never returned in the response (real-only — no dev/console echo).
    return {
      success: true,
      channel: "sms",
      resend_in_seconds: resendInSeconds,
    };
  }

  async verifyOtp(phone: string, otp: string, ctx: RequestContext): Promise<LoginResponse> {
    // Verify the code FIRST — throws 401/429 on a bad/expired code or 503 if Redis
    // is down (fail closed). No worker is created on a failed verify.
    await this.otp.verify(phone, otp);

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

    // Mint a rolling session for this worker: a short access JWT + Redis session record
    // PLUS (ADR-0026) an opaque rotating refresh token + family. The legacy access-token
    // fields are unchanged; the refresh token + session block are ADDED.
    const minted = await this.sessions.create(worker.id);

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

    return {
      access_token: minted.access.token,
      token_type: "Bearer",
      expires_in_seconds: minted.access.expiresInSeconds,
      worker_id: worker.id,
      is_new_worker: isNew,
      status: worker.status,
      // ADR-0026 additive fields — the opaque rotating refresh token + session view.
      refresh_token: minted.refresh.token,
      refresh_expires_in_seconds: minted.refresh.expiresInSeconds,
      session: {
        tier: minted.session.tier,
        expires_at: new Date(minted.session.expiresAtMs).toISOString(),
        requires_otp_after:
          minted.session.requiresOtpAfterMs === null
            ? null
            : new Date(minted.session.requiresOtpAfterMs).toISOString(),
      },
    };
  }
}
