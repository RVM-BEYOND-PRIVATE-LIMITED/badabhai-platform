import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { DevicesRepository } from "./devices.repository";
import { PinHasher } from "./pin-hasher.service";
import { PinRepository } from "./pin.repository";
import { ConsentRepository } from "../consent/consent.repository";
import type { PinVerifyResponse } from "./pin.dto";

/** Minimal typed view of the Redis commands the PIN throttle needs (ioredis at runtime). */
interface RedisThrottleClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

/** The transient per-(worker,device) throttle record in Redis. */
interface ThrottleRecord {
  failed: number;
  lockedUntil: number | null;
  cycle: number;
}

/** Args for a PIN verify. Identity is derived from `refreshToken`, never from a body id. */
export interface VerifyPinInput {
  refreshToken: string;
  pin: string;
  /** Advisory only — the trusted device is resolved from the refresh token, not this. */
  deviceId?: string;
}

/**
 * Device-bound unlock PIN (ADR-0026 Phase 3).
 *
 * A correct PIN NEVER authenticates from scratch — it only unlocks a session on a device
 * the worker already OTP-bound. The identity for /verify comes from the device-bound
 * REFRESH TOKEN the client holds from its last login; a new/unknown device has no trusted
 * refresh token, so the worker must OTP (the existing path). THIS is the SIM-swap defense.
 *
 * THROTTLE = transient per-(worker,device) in Redis (`pin_throttle:<workerId>:<deviceId>`)
 * + durable per-worker force-OTP escalation in `worker_credentials` (otp_cycle_count +
 * lockout_cycles), so a Redis flush cannot wipe the force-OTP state.
 *
 * NEUTRAL NO-ORACLE: wrong-PIN / locked / untrusted-device / invalidated-PIN ALL return the
 * IDENTICAL failure to the client (one 401, one generic body). Internally we still emit
 * distinct PII-FREE events for ops. The raw PIN, the pin_hash, the device fingerprint, and
 * the phone NEVER enter an event/log (CLAUDE.md §2) — logs carry only static reasons + ids.
 */
@Injectable()
export class PinService {
  private readonly logger = new Logger(PinService.name);

  /** Transient throttle TTL — a few days; the durable force-OTP state lives in the DB. */
  private static readonly THROTTLE_TTL_SECONDS = 3 * 86400;

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    private readonly hasher: PinHasher,
    private readonly pins: PinRepository,
    private readonly workers: WorkersRepository,
    private readonly sessions: SessionService,
    private readonly devices: DevicesRepository,
    private readonly otp: OtpService,
    private readonly auth: AuthService,
    private readonly consents: ConsentRepository,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  // ---------------------------------------------------------------------------
  // set / reset — write the PIN (authenticated full session, or OTP-gated reset).
  // ---------------------------------------------------------------------------

  /**
   * Set (or replace) the PIN for an already-authenticated worker (the caller is behind
   * WorkerAuthGuard, so the worker id is the token's). Validates exact PIN_LENGTH + the
   * denylist (400 on weak/bad), hashes, upserts (which clears the whole throttle +
   * force-OTP state), and emits `worker.pin_set`.
   */
  async setPin(workerId: string, pin: string, ctx: RequestContext): Promise<void> {
    await this.writePin(workerId, pin, "worker.pin_set", ctx);
  }

  /**
   * Start a PIN reset by sending an OTP to the worker's phone. Reuses the existing OTP send
   * path (AuthService.requestOtp → OtpService) — NO new SMS path, NO new oracle (the
   * response is the same as a login OTP request). Identity is resolved on confirm, not here.
   */
  async resetRequest(phone: string, ctx: RequestContext): Promise<void> {
    await this.auth.requestOtp(phone, ctx);
  }

  /**
   * Confirm a PIN reset: verify the OTP via the EXISTING OtpService.verify (throws 401/429 on
   * a bad/expired code — same neutral behavior as login), then set the new PIN (denylist +
   * hash + upsert, which clears the throttle + otp_cycle_count) and emit `worker.pin_reset`.
   * The worker is resolved from the phone the verified OTP proves ownership of — never a body
   * worker_id.
   */
  async resetConfirm(
    phone: string,
    otp: string,
    newPin: string,
    ctx: RequestContext,
  ): Promise<void> {
    // Verify the OTP FIRST — a bad code throws before we touch any credential row.
    await this.otp.verify(phone, otp);

    // The verified OTP proves phone ownership; resolve the worker by phone HASH (the raw
    // phone never leaves PiiCryptoService into a lookup key) — never a body worker_id.
    const worker = await this.workers.findByPhoneHash(this.pii.hashPhone(phone));
    if (!worker) {
      // An OTP that verified but maps to no worker is not reachable on the normal path (a
      // worker row is created on first OTP login). Fail neutrally rather than leak anything.
      throw new BadRequestException("PIN reset could not be completed");
    }

    await this.writePin(worker.id, newPin, "worker.pin_reset", ctx);
  }

  /** Shared PIN write: format + denylist gate → hash → upsert (clears throttle) → emit. */
  private async writePin(
    workerId: string,
    pin: string,
    eventName: "worker.pin_set" | "worker.pin_reset",
    ctx: RequestContext,
  ): Promise<void> {
    if (!this.hasher.isCorrectFormat(pin)) {
      throw new BadRequestException(`PIN must be exactly ${this.config.PIN_LENGTH} digits`);
    }
    if (this.hasher.isWeakPin(pin)) {
      // Reject easily-guessed PINs. The PIN itself is NEVER echoed back or logged.
      throw new BadRequestException("PIN is too easy to guess; choose a less common PIN");
    }

    const { pinHash, pepperVersion } = this.hasher.hash(pin);
    await this.pins.upsertPin(workerId, pinHash, pepperVersion);
    // Also drop any transient Redis throttle for this worker's devices is unnecessary here:
    // the durable state is cleared by the upsert, and a stale transient lockout only ever
    // makes the next verify MORE conservative (it re-reads the DB invalidation = cleared).

    await this.events.emit({
      event_name: eventName,
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  // ---------------------------------------------------------------------------
  // verify — the device-bound PIN unlock. Neutral on every negative path.
  // ---------------------------------------------------------------------------

  /**
   * Verify a device-bound PIN and, on success, mint a fresh login-shape session. Every
   * negative path returns the IDENTICAL neutral 401 (no oracle); ops still gets a distinct
   * PII-free event. See the class doc for the throttle + identity model.
   */
  async verifyPin(input: VerifyPinInput, ctx: RequestContext): Promise<PinVerifyResponse> {
    // (a) Identity from the device-bound refresh token — NEVER a body worker_id. A missing/
    // unresolvable token has no identity to even emit against → neutral failure, no event.
    const resolved = await this.sessions.resolveRefreshToken(input.refreshToken);
    if (!resolved || !resolved.deviceId) {
      // No trusted refresh token (or an unbound legacy one) ⇒ this is not a trusted device;
      // the worker must OTP. Nothing to emit (no resolved identity / device).
      throw PinService.neutralFailure();
    }
    const { workerId, deviceId } = resolved;

    // (b) Trusted-device gate: the resolved device must be a NON-revoked device owned by the
    // worker. A revoked/foreign device is untrusted ⇒ neutral failure (+ a verify-failed
    // fact for ops). (A revoked device already fails refresh in Phase 2; we gate here too.)
    const device = await this.devices.findActiveById(workerId, deviceId);
    if (!device) {
      // INTENTIONAL pre-scrypt early return (not a PIN-value oracle): a latency probe can
      // only learn device-trust STATE, which the refresh-token holder already controls and
      // which is independently observable (an untrusted device must OTP regardless). Padding
      // this with a throwaway scrypt would hand an attacker a 32MB-KDF CPU/memory
      // amplification lever. See the ADR-0026 Phase-3 residual-timing note.
      await this.emitVerifyFailed(workerId, deviceId, "untrusted_device", ctx);
      throw PinService.neutralFailure();
    }

    const cred = await this.pins.findByWorkerId(workerId);
    if (!cred) {
      // No PIN set for this worker ⇒ nothing to verify. Neutral (do NOT distinguish from a
      // wrong PIN). We still do an equivalent-cost scrypt verify against a throwaway to keep
      // timing roughly uniform with the wrong-PIN path.
      this.hasher.verify(input.pin, this.hasher.hash(input.pin).pinHash, 1);
      await this.emitVerifyFailed(workerId, deviceId, "no_pin_set", ctx);
      throw PinService.neutralFailure();
    }

    // (c) Durable force-OTP invalidation. A PIN whose lockout ladder was exhausted is dead
    // until an OTP-gated reset (the client just re-OTPs). The escalation bumps BOTH the
    // durable `lockout_cycles` mirror (to PIN_MAX_LOCKOUT_CYCLES at exhaustion) AND
    // `otp_cycle_count` (≥1 = at-least-one force-OTP round); checking EITHER makes the gate
    // survive a Redis flush (the whole point of the durable mirror — only an OTP reset, which
    // zeroes both, clears it). We do NOT compare otp_cycle_count to PIN_MAX_LOCKOUT_CYCLES
    // (that counter starts at 0 and only reaches 1 on the first exhaustion).
    if (
      cred.otpCycleCount >= 1 ||
      cred.lockoutCycles >= this.config.PIN_MAX_LOCKOUT_CYCLES
    ) {
      // INTENTIONAL pre-scrypt early return (not a PIN-value oracle): leaks only force-OTP
      // STATE, which is the intended UX signal (the client must re-OTP) — see Finding 3.
      await this.emitVerifyFailed(workerId, deviceId, "force_otp", ctx);
      throw PinService.neutralFailure();
    }

    const redis = await this.client();
    const now = Date.now();
    // Rehydrate the transient throttle from the DURABLE lockout_cycles mirror on a Redis
    // miss (flush/eviction) so the exponential ladder + force-OTP progress cannot be reset
    // to cycle 0 with a zero-wait fresh attempt budget (security Finding 1).
    const throttle = await this.readThrottle(redis, workerId, deviceId, cred.lockoutCycles, now);

    // (d) Redis transient lockout window still open ⇒ neutral failure. We deliberately still
    // run the scrypt verify below ONLY on the success/normal path; a locked path returns
    // early (the lockout itself is the timing-uniform behaviour — see the residual-timing
    // note in the report).
    if (throttle.lockedUntil !== null && throttle.lockedUntil > now) {
      await this.emitVerifyFailed(workerId, deviceId, "locked", ctx);
      throw PinService.neutralFailure();
    }

    // (e) scrypt verify (slow KDF, constant-time, fail-closed).
    const ok = this.hasher.verify(input.pin, cred.pinHash, cred.pepperVersion);

    if (ok) {
      // A5 (ADR-0026 amendment): a correct PIN unlocks/RESUMES a session — but a worker whose
      // consent was REVOKED must not resume (parity with /auth/token/refresh). Checked AFTER the
      // scrypt verify so it is not a pre-scrypt oracle — only the legitimate PIN-holder reaches
      // it — and returns the SAME neutral 401 as every other negative path (no consent oracle on
      // this strict no-oracle surface). A never-consented worker is allowed (pre-consent
      // onboarding); profiling stays ConsentGuard-blocked regardless.
      const consent = await this.consents.findLatestByWorker(workerId);
      if (consent && consent.revokedAt !== null) {
        await this.emitVerifyFailed(workerId, deviceId, "consent_revoked", ctx);
        throw PinService.neutralFailure();
      }

      // SUCCESS — clear the transient + DB throttle (leave otp_cycle_count as-is), mint a
      // fresh device-bound session (the SAME shape OTP login returns), emit pin_verified.
      await this.clearThrottle(redis, workerId, deviceId);
      await this.pins.clearThrottle(workerId);

      const minted = await this.sessions.create(workerId, deviceId);
      await this.events.emit({
        event_name: "worker.pin_verified",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId, device_id: deviceId },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });

      return {
        access_token: minted.access.token,
        token_type: "Bearer",
        expires_in_seconds: minted.access.expiresInSeconds,
        worker_id: workerId,
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

    // FAILURE — escalate the throttle and emit pin_verify_failed (+ pin_locked on a cycle
    // step). Always a neutral 401.
    await this.recordFailure(redis, workerId, deviceId, throttle, now, ctx);
    throw PinService.neutralFailure();
  }

  // ---------------------------------------------------------------------------
  // throttle internals (Redis transient + DB durable mirror).
  // ---------------------------------------------------------------------------

  /**
   * One wrong-PIN step. Increment the transient `failed`; at PIN_MAX_ATTEMPTS arm the
   * exponential lockout (PIN_LOCKOUT_BASE_SECONDS * 2^cycle), advance the cycle, reset
   * `failed`, durably mirror lockout_cycles, and — when the cycle reaches
   * PIN_MAX_LOCKOUT_CYCLES — durably bump otp_cycle_count (force-OTP) + emit pin_locked with
   * force_otp:true. A non-final cycle step still emits pin_locked (force_otp:false). Always
   * emits pin_verify_failed last.
   */
  private async recordFailure(
    redis: RedisThrottleClient,
    workerId: string,
    deviceId: string,
    current: ThrottleRecord,
    now: number,
    ctx: RequestContext,
  ): Promise<void> {
    const failed = current.failed + 1;
    let next: ThrottleRecord = { failed, lockedUntil: current.lockedUntil, cycle: current.cycle };
    let lockoutStepped = false;
    let forceOtp = false;

    if (failed >= this.config.PIN_MAX_ATTEMPTS) {
      const cycle = current.cycle; // lock for the CURRENT cycle's backoff, then advance.
      const backoffSeconds = this.config.PIN_LOCKOUT_BASE_SECONDS * 2 ** cycle;
      const nextCycle = cycle + 1;
      next = { failed: 0, lockedUntil: now + backoffSeconds * 1000, cycle: nextCycle };
      lockoutStepped = true;

      // Durably mirror the lockout cycle count (a Redis flush can't wipe the escalation).
      let otpCycleCount = current.cycle; // placeholder; recomputed below on force-OTP.
      if (nextCycle >= this.config.PIN_MAX_LOCKOUT_CYCLES) {
        // Final cycle reached ⇒ durably bump the force-OTP counter (atomic) + mirror cycles.
        otpCycleCount = await this.pins.incrementOtpCycle(workerId);
        await this.pins.recordFailureEscalation(workerId, {
          lockoutCycles: nextCycle,
          otpCycleCount,
        });
        forceOtp = true;
      } else {
        await this.pins.recordFailureEscalation(workerId, {
          lockoutCycles: nextCycle,
          otpCycleCount: current.cycle, // unchanged until the final cycle
        });
      }
    }

    await this.writeThrottle(redis, workerId, deviceId, next);

    if (lockoutStepped) {
      await this.events.emit({
        event_name: "worker.pin_locked",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          device_id: deviceId,
          lockout_cycle: next.cycle,
          force_otp: forceOtp,
        },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    await this.emitVerifyFailed(workerId, deviceId, "wrong_pin", ctx);
  }

  /** Emit the PII-free pin_verify_failed fact. `reason` is a STATIC code for the log only —
   * it is NOT placed in the payload (the event stays the two-uuid shape; no oracle). */
  private async emitVerifyFailed(
    workerId: string,
    deviceId: string,
    reason: string,
    ctx: RequestContext,
  ): Promise<void> {
    this.logger.warn(`pin verify failed worker=${workerId} reason=${reason}`);
    await this.events.emit({
      event_name: "worker.pin_verify_failed",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId, device_id: deviceId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async readThrottle(
    redis: RedisThrottleClient,
    workerId: string,
    deviceId: string,
    durableCycles: number,
    now: number,
  ): Promise<ThrottleRecord> {
    try {
      const raw = await redis.get(PinService.throttleKey(workerId, deviceId));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ThrottleRecord>;
        return {
          failed: typeof parsed.failed === "number" ? parsed.failed : 0,
          lockedUntil: typeof parsed.lockedUntil === "number" ? parsed.lockedUntil : null,
          cycle: typeof parsed.cycle === "number" ? parsed.cycle : 0,
        };
      }
      // Redis MISS. If the worker carries a durable lockout-cycle escalation (mirrored in
      // worker_credentials), the transient was flushed/evicted — REHYDRATE from the durable
      // mirror rather than hand back a fresh cycle-0, zero-wait budget: preserve the cycle
      // (so the backoff exponent + force-OTP-after-K progress can't be reset below the
      // durably-recorded cycle) and re-impose the current cycle's lockout window, then
      // persist it so it counts down normally (security Finding 1). A flush therefore costs
      // the attacker a lockout, never a free reset. (force-OTP cycles never reach here — the
      // durable invalidation guard returns before readThrottle.)
      if (durableCycles > 0) {
        const rehydrated = this.rehydratedThrottle(durableCycles, now);
        await this.writeThrottle(redis, workerId, deviceId, rehydrated);
        return rehydrated;
      }
      return { failed: 0, lockedUntil: null, cycle: 0 };
    } catch {
      // A Redis read error reads as "no transient state" — but the DURABLE escalation must
      // still hold: a mid-ladder worker stays conservatively locked (never a fresh budget)
      // during a Redis outage; the DB force-OTP guard above already covers the final cycle.
      return durableCycles > 0
        ? this.rehydratedThrottle(durableCycles, now)
        : { failed: 0, lockedUntil: null, cycle: 0 };
    }
  }

  /**
   * Reconstruct a conservative, re-locked transient record from the durable lockout-cycle
   * mirror after a Redis flush/eviction/error (security Finding 1). Keeps the cycle (so the
   * exponential ladder + force-OTP progress survive) and re-imposes the current cycle's
   * backoff window. `durableCycles` is < PIN_MAX_LOCKOUT_CYCLES here (the force-OTP guard
   * catches the final cycle before the throttle is read), so the backoff stays bounded.
   */
  private rehydratedThrottle(durableCycles: number, now: number): ThrottleRecord {
    const backoffMs = this.config.PIN_LOCKOUT_BASE_SECONDS * 2 ** durableCycles * 1000;
    return { failed: 0, cycle: durableCycles, lockedUntil: now + backoffMs };
  }

  private async writeThrottle(
    redis: RedisThrottleClient,
    workerId: string,
    deviceId: string,
    record: ThrottleRecord,
  ): Promise<void> {
    try {
      await redis.set(
        PinService.throttleKey(workerId, deviceId),
        JSON.stringify(record),
        "EX",
        PinService.THROTTLE_TTL_SECONDS,
      );
    } catch (err) {
      // Best-effort: a failed transient write still leaves the DB durable mirror intact.
      this.logger.error(
        `pin throttle write failed; durable DB state still holds (errorType: ${
          err instanceof Error ? err.name : "unknown"
        })`,
      );
    }
  }

  private async clearThrottle(
    redis: RedisThrottleClient,
    workerId: string,
    deviceId: string,
  ): Promise<void> {
    try {
      await redis.del(PinService.throttleKey(workerId, deviceId));
    } catch {
      // Non-fatal — a leftover transient record only makes the next verify more conservative.
    }
  }

  private async client(): Promise<RedisThrottleClient> {
    return (await this.queue.client) as unknown as RedisThrottleClient;
  }

  private static throttleKey(workerId: string, deviceId: string): string {
    return `pin_throttle:${workerId}:${deviceId}`;
  }

  /** The ONE neutral failure every negative path returns — no field/status/message oracle. */
  private static neutralFailure(): UnauthorizedException {
    return new UnauthorizedException("Could not verify PIN");
  }
}
