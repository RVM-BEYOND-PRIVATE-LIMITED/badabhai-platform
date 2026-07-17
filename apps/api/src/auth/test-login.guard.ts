import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/** Header carrying the test-login gate secret (TEST_LOGIN_TOKEN). */
export const TEST_LOGIN_TOKEN_HEADER = "x-test-login-token";

/**
 * Gate for the D-3 test-login (worker session-mint) seam — POST /auth/test-login.
 * Staging smoke / e2e ONLY; assertAuthConfig makes it STRUCTURALLY impossible to
 * arm in production (enabled + NODE_ENV not explicitly development/test/staging →
 * the API refuses to boot). NOT a resurrection of DEV_QUICK_LOGIN: there is no
 * client/dev-mode bypass — the seam is a server secret + env gate.
 *
 * Two checks, in order (a GUARD so both run BEFORE body validation pipes — a
 * disabled route can never leak a 400 shape oracle):
 *
 *   1. TEST_LOGIN_ENABLED off (the default) → a NEUTRAL 404, indistinguishable
 *      from a non-existent route (the ADMIN_PII_REVEAL_ENABLED / Control-1
 *      convention — no oracle that the seam exists).
 *   2. `x-test-login-token` must match TEST_LOGIN_TOKEN via an HMAC timing-safe
 *      compare (both sides are HMAC'd under a fresh random key, so the digests
 *      are equal-length and the compare leaks neither content nor length).
 *      Missing/wrong → a neutral 401 (no oracle on which).
 *
 * FAIL CLOSED: enabled with no/short token is unreachable (assertAuthConfig fails
 * boot — TD67), but if a config object ever bypassed that, this guard still
 * answers the neutral 404, never an open gate.
 */
@Injectable()
export class TestLoginGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(context: ExecutionContext): boolean {
    // 1. Flag OFF → neutral 404 (checked FIRST — a disabled seam is invisible).
    if (!this.config.TEST_LOGIN_ENABLED) throw new NotFoundException("Not found");

    // Defense-in-depth: a missing/short token can only mean the boot guard was
    // bypassed — deny with the SAME neutral 404 (never arm vacuously, TD67).
    const expected = this.config.TEST_LOGIN_TOKEN;
    if (!expected || expected.length < 32) throw new NotFoundException("Not found");

    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const raw = req.headers[TEST_LOGIN_TOKEN_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (typeof provided !== "string" || !TestLoginGuard.hmacSafeEqual(provided, expected)) {
      // Neutral message — never echoes the provided value or hints at the expected one.
      throw new UnauthorizedException("invalid or missing test-login token");
    }
    return true;
  }

  /**
   * HMAC timing-safe compare: both values are HMAC-SHA256'd under a fresh random
   * key, so the buffers handed to timingSafeEqual are ALWAYS equal-length — no
   * length short-circuit, no content/length timing signal.
   */
  private static hmacSafeEqual(a: string, b: string): boolean {
    const key = randomBytes(32);
    const ha = createHmac("sha256", key).update(a).digest();
    const hb = createHmac("sha256", key).update(b).digest();
    return timingSafeEqual(ha, hb);
  }
}
