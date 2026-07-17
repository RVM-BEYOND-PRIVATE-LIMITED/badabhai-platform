import { Injectable, Logger } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import { OtpSendFailedException } from "../common/otp-send-failure";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { DevicesService } from "./devices.service";
import { PinRepository } from "./pin.repository";
import type { LoginResponse, OtpRequestResponse } from "./auth.dto";
import type { DeviceInfoDto } from "./devices.dto";

/**
 * Real OTP login.
 *
 * `requestOtp` issues + sends a one-time code (via OtpService → SmsProvider) and
 * emits `worker.otp_requested`. `verifyOtp` verifies the code FIRST (OtpService
 * throws on a bad/expired code, so a failed verify never touches the worker
 * table), then create-or-gets the worker (TD23 race-safe), mints a rolling
 * session, and emits `worker.created` (once) + `worker.otp_verified`. `testLogin`
 * (D-3, gated + prod-boot-blocked) drives the SAME post-verification mint seam
 * and emits `worker.test_login` instead — never `worker.otp_verified`.
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
    private readonly devices: DevicesService,
    private readonly pins: PinRepository,
  ) {}

  async requestOtp(phone: string, ctx: RequestContext): Promise<OtpRequestResponse> {
    // Issue + send through the SHARED failure-signal seam; OtpService throws
    // (cooldown/cap/send-fail/Redis) and we do NOT emit worker.otp_requested on
    // failure — only a real, sent code produces that event. The seam's two MONITORING
    // events (cap breach, send failure) are the only failure-path emissions, and both
    // are aggregate/PII-free.
    const { resendInSeconds } = await this.issueAndSendWithSignals(phone, ctx);

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

  /**
   * Issue + send a worker OTP through the SHARED failure-signal seam. EVERY caller
   * that triggers a real Fast2SMS send MUST route through here (today: {@link requestOtp}
   * — which also serves the PIN-reset step-up via PinService — and the account-delete
   * step-up request in AuthController), so every send-failure outcome signals the event
   * spine identically:
   *
   *   - OTP-5 global-cap breach → ONE PII-free `worker.otp_send_cap_exceeded`
   *     (channel/cap/limit/window — no phone/IP/code/id), then the SAME neutral 429
   *     the throttle returns (no new oracle; per-phone cooldowns/caps throw a plain
   *     HttpException and are NOT emitted).
   *   - F4 (#168) provider send failure → ONE PII-free `worker.otp_send_failed`
   *     (provider literal + failure-kind enum — no phone/hash/code/status), then the
   *     SAME neutral 502 the send failure already returned.
   *
   * The original error is ALWAYS re-thrown unchanged — this seam adds observability,
   * never a response change.
   */
  async issueAndSendWithSignals(
    phone: string,
    ctx: RequestContext,
  ): Promise<{ resendInSeconds: number }> {
    try {
      return await this.otp.issueAndSend(phone);
    } catch (err) {
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
      if (err instanceof OtpSendFailedException) {
        await this.events.emit({
          event_name: "worker.otp_send_failed",
          actor: { actor_type: "system" },
          subject: { subject_type: "worker" },
          payload: {
            provider: err.failure.provider,
            reason: err.failure.reason,
          },
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        });
      }
      throw err;
    }
  }

  // TD62: the service returns the login payload MINUS `consent_accepted` — the
  // controller composes that additive field from ConsentRepository (the same
  // pattern as the A5 consent-on-resume check), keeping this method single-purpose.
  async verifyOtp(
    phone: string,
    otp: string,
    ctx: RequestContext,
    deviceInfo?: DeviceInfoDto,
  ): Promise<Omit<LoginResponse, "consent_accepted">> {
    // Verify the code FIRST — throws 401/429 on a bad/expired code or 503 if Redis
    // is down (fail closed). No worker is created on a failed verify.
    await this.otp.verify(phone, otp);

    // Post-verification mint (the SHARED seam — also driven by testLogin below).
    const { response, worker, phoneHash, isNew } = await this.mintLoginForPhone(
      phone,
      ctx,
      deviceInfo,
    );

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

    return response;
  }

  /**
   * D-3 — the GATED test-login mint (POST /auth/test-login; staging smoke / e2e
   * ONLY). The route is invisible unless TEST_LOGIN_ENABLED + TEST_LOGIN_TOKEN are
   * armed (TestLoginGuard: neutral 404 / 401), and assertAuthConfig makes arming it
   * in production a BOOT FAILURE — this method can never run there.
   *
   * It rides the SAME post-verification seam as {@link verifyOtp} (no forked
   * session-mint logic): create-or-get the worker by phone_hash, mint the rolling
   * session + refresh token, return the identical LoginResponse shape. What it
   * SKIPS is only the OTP verify itself — everything downstream (ConsentGuard,
   * consent.accepted gating, session tiers, revocation) treats the minted session
   * EXACTLY like an OTP session: consent is neither created nor bypassed here.
   *
   * Emits the DISTINCT `worker.test_login` event (never worker.otp_verified), so a
   * test mint is always distinguishable on the audit spine. PII posture is the OTP
   * path's: only the keyed phone HASH enters the event; the raw phone/token never do.
   */
  async testLogin(
    phone: string,
    ctx: RequestContext,
  ): Promise<Omit<LoginResponse, "consent_accepted">> {
    const { response, worker, phoneHash, isNew } = await this.mintLoginForPhone(phone, ctx);

    // No idempotencyKey: each test mint is a distinct fact (like otp_verified).
    await this.events.emit({
      event_name: "worker.test_login",
      actor: { actor_type: "worker", actor_id: worker.id },
      subject: { subject_type: "worker", subject_id: worker.id },
      payload: { worker_id: worker.id, phone_hash: phoneHash, is_new_worker: isNew },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    this.logger.log("test login minted");

    return response;
  }

  /**
   * The POST-VERIFICATION login mint — the single seam both {@link verifyOtp} (after
   * a real OTP verify) and {@link testLogin} (after the TestLoginGuard gate) drive.
   * Create-or-get the worker for the phone's keyed hash (TD23 race-safe, emitting
   * worker.created exactly once), register an optional trusted device, mint the
   * rolling session + opaque refresh token, and surface pin_set. The caller emits
   * its OWN outcome event (worker.otp_verified vs worker.test_login) — never here.
   */
  private async mintLoginForPhone(
    phone: string,
    ctx: RequestContext,
    deviceInfo?: DeviceInfoDto,
  ): Promise<{
    response: Omit<LoginResponse, "consent_accepted">;
    worker: { id: string; status: string };
    phoneHash: string;
    isNew: boolean;
  }> {
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

    // ADR-0026 Phase 2 — register the trusted device (only if the client sent device_info)
    // and bind the new session to it via the `did` claim. BEST-EFFORT: a device failure
    // returns undefined and login proceeds unbound — device binding never breaks login.
    const deviceId = await this.devices.registerOnLogin(worker.id, deviceInfo, ctx);

    // Mint a rolling session for this worker: a short access JWT + Redis session record
    // PLUS (ADR-0026) an opaque rotating refresh token + family. The legacy access-token
    // fields are unchanged; the refresh token + session block are ADDED. When device-bound,
    // the access JWT also carries the opaque `did` claim.
    const minted = await this.sessions.create(worker.id, deviceId);

    // ADR-0026 Phase 4 — does this worker already have a device-unlock PIN? The app routes a
    // returning worker to enter-PIN (true) vs set-PIN (false). A brand-new worker has no
    // worker_credentials row → false. Only the boolean is surfaced — never the PIN/hash.
    const pinSet = !!(await this.pins.findByWorkerId(worker.id));

    const response: Omit<LoginResponse, "consent_accepted"> = {
      access_token: minted.access.token,
      token_type: "Bearer",
      expires_in_seconds: minted.access.expiresInSeconds,
      worker_id: worker.id,
      is_new_worker: isNew,
      status: worker.status,
      // ADR-0026 Phase 4 — lets the app route enter-PIN (true) vs set-PIN (false).
      pin_set: pinSet,
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
    return { response, worker, phoneHash, isNew };
  }
}
