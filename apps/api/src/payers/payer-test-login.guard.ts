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

/** Header carrying the payer test-login gate secret (PAYER_TEST_LOGIN_TOKEN). */
export const PAYER_TEST_LOGIN_TOKEN_HEADER = "x-test-login-token";

/**
 * Gate for the PAYER test-login (session-mint) seam — `POST /payer/test-login`.
 *
 * WHY THE SEAM EXISTS: payer login is email OTP with no dev echo and no mock provider, so
 * nothing can complete a payer login without a mailbox. That single fact blocks local E2E of
 * the entire payer + agency surface and is why `payer-tenancy.e2e.test.ts` and three sibling
 * suites are hard `describe.skip` — meaning cross-tenant isolation on `/payer/*` is asserted
 * only by unit tests and by reading the code (PAY-SEC-09).
 *
 * This is a deliberate, narrowly-bounded exception to that, NOT a dev-mode bypass. It is the
 * exact shape of the worker seam ({@link import("../auth/test-login.guard").TestLoginGuard}) so
 * there is one pattern to review rather than two:
 *
 *   1. `PAYER_TEST_LOGIN_ENABLED` off (the default) → a NEUTRAL 404, indistinguishable from a
 *      route that does not exist. Not a 403 and not a 501: "this seam exists but is switched
 *      off here" is configuration state a caller has no business learning.
 *   2. `x-test-login-token` must match `PAYER_TEST_LOGIN_TOKEN` under an HMAC timing-safe
 *      compare — both sides are HMAC'd under a fresh random key, so the buffers are always
 *      equal-length and the compare leaks neither content nor length. Missing/wrong → a neutral
 *      401 that never says which.
 *
 * It runs as a GUARD, not an in-handler check, so both tests execute BEFORE any validation pipe:
 * a disabled route can never leak a 400-shape oracle for its body.
 *
 * DEFENCE IN DEPTH: `assertPayerAuthConfig` already refuses to BOOT when this is armed outside
 * development/test/staging, or armed with a token under 32 chars. The re-check below is for the
 * case where a config object somehow reached the guard without passing that — it answers the
 * same neutral 404 rather than arming vacuously on an empty-string secret (the TD67 lesson).
 */
@Injectable()
export class PayerTestLoginGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(context: ExecutionContext): boolean {
    // 1. Flag OFF → neutral 404, checked FIRST so a disabled seam is fully invisible.
    if (!this.config.PAYER_TEST_LOGIN_ENABLED) throw new NotFoundException("Not found");

    // A missing/short token can only mean the boot guard was bypassed — deny identically.
    const expected = this.config.PAYER_TEST_LOGIN_TOKEN;
    if (!expected || expected.length < 32) throw new NotFoundException("Not found");

    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const raw = req.headers[PAYER_TEST_LOGIN_TOKEN_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (typeof provided !== "string" || !PayerTestLoginGuard.hmacSafeEqual(provided, expected)) {
      // Neutral — never echoes the provided value nor hints at the expected one.
      throw new UnauthorizedException("invalid or missing test-login token");
    }
    return true;
  }

  /**
   * HMAC timing-safe compare: both values are HMAC-SHA256'd under a fresh random key, so the
   * buffers handed to timingSafeEqual are ALWAYS equal-length — no length short-circuit and no
   * content/length timing signal.
   */
  private static hmacSafeEqual(a: string, b: string): boolean {
    const key = randomBytes(32);
    const ha = createHmac("sha256", key).update(a).digest();
    const hb = createHmac("sha256", key).update(b).digest();
    return timingSafeEqual(ha, hb);
  }
}

/**
 * The ONLY email domain the payer test-login seam will mint a session for.
 *
 * Staging runs a REAL email provider, so real payer accounts exist there. Without this the seam
 * would mint a session for ANY existing payer given only the gate token — turning one leaked
 * staging secret into full impersonation of a real customer. `.invalid` is reserved by RFC 2606
 * and can never be registered, so an address in this domain cannot belong to a real person.
 */
export const PAYER_TEST_LOGIN_DOMAIN = "@e2e.badabhai.invalid";

/** True when `email` is inside the reserved synthetic domain the seam is allowed to mint for. */
export function isSyntheticPayerEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(PAYER_TEST_LOGIN_DOMAIN);
}
