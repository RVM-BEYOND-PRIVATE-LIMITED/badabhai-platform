import { type CanActivate, type ExecutionContext, Injectable, Logger } from "@nestjs/common";
import type { Request } from "express";
import { SessionService } from "./session.service";

/**
 * ATTRIBUTION, NOT AUTHENTICATION. Attaches `req.worker` when a valid worker session token
 * happens to be present, and **always returns true**.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
 * `GET /interview-kit/:tradeKey/download` is deliberately public: the content is per-trade
 * and PII-free, and a worker who has not logged in must still be able to prepare for an
 * interview. But `interview_kit.downloaded` then carries NO worker id at all, so step 7 of
 * the admin worker-journey funnel ("did this worker take the kit?") had no signal to read —
 * the event and the worker were unlinkable by construction.
 *
 * This closes that WITHOUT closing the route. A request with no token, an expired token, a
 * forged token or a revoked session is served exactly as it is today; only the event's
 * optional `worker_id` differs.
 *
 * ── IT IS NOT A GUARD IN THE SECURITY SENSE, AND MUST NEVER BECOME ONE ──────────────────
 * `canActivate` has ONE return statement and it is `true`. There is no branch that can deny
 * a request, deliberately — the moment this file can return false or throw, a public route
 * has silently become a private one and every anonymous worker loses access to the kit.
 * A route that needs real authentication uses {@link WorkerAuthGuard}; do not "harden" this.
 *
 * ── FAIL-CLOSED ON ATTRIBUTION ──────────────────────────────────────────────────────────
 * Every failure mode — malformed header, bad signature, expired JWT, revoked session, Redis
 * down — leaves `req.worker` UNSET, so the event records "we do not know who this was"
 * rather than a guess. `SessionService.validateAndTouch` already returns null (never throws)
 * on all of them; the try/catch is the second wall, because an unexpected throw here would
 * 500 a route whose whole contract is that it works without a session.
 *
 * ── ONE SIDE EFFECT, STATED ─────────────────────────────────────────────────────────────
 * `validateAndTouch` SLIDES the session TTL, exactly as it does on every other worker route.
 * A logged-in worker downloading a kit therefore counts as activity, which is the same
 * reading every other authenticated request gets. It is a Redis round trip taken ONLY when
 * an `Authorization` header is actually present — an anonymous request touches nothing.
 */
@Injectable()
export class OptionalWorkerAuthGuard implements CanActivate {
  private readonly logger = new Logger(OptionalWorkerAuthGuard.name);

  constructor(private readonly session: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = OptionalWorkerAuthGuard.extractBearer(req);
    if (!token) return true;

    try {
      const validated = await this.session.validateAndTouch(token);
      if (validated) {
        req.worker = {
          id: validated.workerId,
          sid: validated.sid,
          deviceId: validated.deviceId,
        };
      }
    } catch (err) {
      // Never logs the token, the worker id, or anything derived from either — this line is
      // reachable on a public route, and an attribution failure is not worth a PII risk.
      this.logger.warn(
        `optional worker attribution unavailable (request served anonymously): ` +
          `${err instanceof Error ? err.name : "unknown error"}`,
      );
    }

    return true;
  }

  /** `Authorization: Bearer <jwt>` → the token, or null. Mirrors {@link WorkerAuthGuard}. */
  private static extractBearer(req: Request): string | null {
    const header = req.header("authorization");
    if (!header) return null;
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !value) return null;
    return value.trim() || null;
  }
}
