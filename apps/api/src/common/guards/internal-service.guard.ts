import { timingSafeEqual } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../config/config.module";

/** Header carrying the shared internal-service secret. */
export const INTERNAL_SERVICE_TOKEN_HEADER = "x-internal-service-token";

/**
 * Service-to-service auth (NOT user auth) for the ops/backend-only resume routes
 * that return PII or mint signed URLs. Gates them behind a shared secret
 * (`INTERNAL_SERVICE_TOKEN`) until per-request worker auth lands (TD4/R1, R13).
 *
 * FAIL CLOSED: if no token is configured, EVERY request is denied — a mis-configured
 * env cannot accidentally expose these routes. This does NOT establish a per-worker
 * identity; it only restricts the caller to the backend/ops holder of the secret, so
 * a random caller who guesses a resume UUID can no longer reach the name-bearing PDF.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.INTERNAL_SERVICE_TOKEN;
    // No secret configured => deny all (fail closed). These routes are ops-only.
    if (!expected) {
      throw new UnauthorizedException("internal service auth is not configured");
    }

    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const raw = req.headers[INTERNAL_SERVICE_TOKEN_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (typeof provided !== "string" || !InternalServiceGuard.safeEqual(provided, expected)) {
      throw new UnauthorizedException("invalid or missing internal service token");
    }
    return true;
  }

  /** Constant-time compare; a length mismatch short-circuits (negligible length leak). */
  private static safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
