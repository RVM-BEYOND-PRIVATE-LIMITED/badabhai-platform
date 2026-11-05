import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/** Minimal typed view of the raw Redis commands the attempt counter needs. */
interface RedisCounterClient {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Count one failure ATOMICALLY: INCR, then arm the window only if the key has none.
 *
 * Why a script and not `INCR` + `EXPIRE`: two round-trips can fail between them, and an INCR that
 * landed without its EXPIRE is a counter with NO TTL — once it reaches the cap it is a PERMANENT
 * lockout (security review NIT). Redis runs a script as one indivisible unit, so the key never
 * exists without a TTL. `TTL < 0` (rather than `n == 1`) also HEALS a key that somehow already has
 * none, and leaves a live window untouched — the window is armed once and never slides.
 */
export const RECORD_FAILURE_SCRIPT = [
  "local n = redis.call('INCR', KEYS[1])",
  "if redis.call('TTL', KEYS[1]) < 0 then",
  "  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))",
  "end",
  "return n",
].join("\n");

/**
 * WHICH secret is being guessed. Each scope is its own counter, so burning one door's attempts
 * cannot lock another — and, just as important, SUCCEEDING at one door can never reset another.
 *   - `password`   — the sign-in password AND the current-password check on a change. The key
 *                    is the contract's `admin_pw:attempts:<admin_id>`.
 *   - `mfa_toggle` — the 6-digit code on the signed-in two-step confirm/disable routes. Without
 *                    it a stolen session could walk the 10^6 code space to switch two-step off.
 *   - `mfa_login`  — the TOTP on POST /admin/mfa/verify (security review B1). The OTP-pending
 *                    marker allows one guess per first-factor success, and a correct password both
 *                    re-mints that marker and clears the `password` scope — so without a counter
 *                    of its own a leaked password was an unlimited "password → one TOTP guess"
 *                    loop braked only by the shared per-IP cap. Cleared ONLY by a correct TOTP.
 */
export type AdminAttemptScope = "password" | "mfa_toggle" | "mfa_login";

const SCOPE_PREFIX: Readonly<Record<AdminAttemptScope, string>> = {
  password: "admin_pw",
  mfa_toggle: "admin_mfa_toggle",
  mfa_login: "admin_mfa_login",
};

/**
 * Per-ADMIN failed-attempt lockout (migration 0144) — the admin analogue of PayerAuthService's
 * `isPasswordLockedOut` / `recordPasswordFailure` / `clearPasswordFailures` (#2497), extracted
 * into its own provider because four admin flows share it.
 *
 * Keyed on the resolved `admin_id` — a bounded space, never the attacker-controlled identifier.
 * N failures (`ADMIN_PASSWORD_MAX_ATTEMPTS`) inside the window lock the scope for
 * `ADMIN_PASSWORD_LOCKOUT_SECONDS`; the window is armed by the FIRST failure and does not slide,
 * so a trickle cannot hold the lock forever and a burst hits the cap.
 *
 * FAIL CLOSED: a Redis error on the check or the record is a 503 — a failure we cannot count is a
 * failure we must not allow past. Clearing is best-effort (a stale counter costs only headroom
 * and self-expires). Logs carry an 8-char id prefix and the scope — never a secret.
 */
@Injectable()
export class AdminAttemptLockoutService {
  private readonly logger = new Logger(AdminAttemptLockoutService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Reuse BullMQ's Redis connection — never a second client (the IpRateLimit rule).
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /** The Redis key for one admin's counter in one scope. */
  static key(scope: AdminAttemptScope, adminId: string): string {
    return `${SCOPE_PREFIX[scope]}:attempts:${adminId}`;
  }

  /** True while this admin has hit the failure cap in `scope`. Redis error → 503. */
  async isLockedOut(scope: AdminAttemptScope, adminId: string): Promise<boolean> {
    let count = 0;
    try {
      const raw = await (await this.client()).get(AdminAttemptLockoutService.key(scope, adminId));
      count = raw ? Number.parseInt(raw, 10) || 0 : 0;
    } catch {
      throw this.failClosed("check", scope, adminId);
    }
    return count >= this.config.ADMIN_PASSWORD_MAX_ATTEMPTS;
  }

  /**
   * Count one failure in ONE atomic Redis step ({@link RECORD_FAILURE_SCRIPT}); the first failure
   * arms the (non-sliding) window. Redis error → 503.
   */
  async recordFailure(scope: AdminAttemptScope, adminId: string): Promise<void> {
    const key = AdminAttemptLockoutService.key(scope, adminId);
    try {
      await (
        await this.client()
      ).eval(RECORD_FAILURE_SCRIPT, 1, key, String(this.config.ADMIN_PASSWORD_LOCKOUT_SECONDS));
    } catch {
      throw this.failClosed("record", scope, adminId);
    }
  }

  /** Forget the failures after a success (or a reset). Best-effort. */
  async clear(scope: AdminAttemptScope, adminId: string): Promise<void> {
    try {
      await (await this.client()).del(AdminAttemptLockoutService.key(scope, adminId));
    } catch (err) {
      this.logger.warn(
        `admin attempt counter clear failed scope=${scope} admin=${adminId.slice(0, 8)}… reason=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private failClosed(
    op: "check" | "record",
    scope: AdminAttemptScope,
    adminId: string,
  ): ServiceUnavailableException {
    this.logger.error(
      `admin attempt counter ${op} failed (failing closed) scope=${scope} admin=${adminId.slice(0, 8)}…`,
    );
    return new ServiceUnavailableException("Sign-in is temporarily unavailable, please retry");
  }

  private async client(): Promise<RedisCounterClient> {
    return (await this.queue.client) as unknown as RedisCounterClient;
  }
}
