import { timingSafeEqual } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/** Header carrying the SKILLS-scoped internal secret (distinct from the all-routes one). */
export const SKILLS_INTERNAL_TOKEN_HEADER = "x-skills-internal-token";

/**
 * SCOPED service-to-service auth for the FORK-B-1 skills seam ONLY (least privilege —
 * review finding on PR #222): the ai-service holds `SKILLS_INTERNAL_TOKEN` and can reach
 * nothing but /internal/skills/* — deliberately NOT `INTERNAL_SERVICE_TOKEN`, which also
 * opens the resume-PII and (mock) money routes. A compromise of the ai-service therefore
 * yields a credential whose blast radius is a vocabulary lookup + a pseudonymized-miss
 * upsert, not raw PII.
 *
 * FAIL CLOSED: if `SKILLS_INTERNAL_TOKEN` is not configured, EVERY request is denied —
 * there is no fallback to the broad token (a fallback would silently re-create the
 * scope creep this guard exists to remove).
 */
@Injectable()
export class SkillsInternalGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.SKILLS_INTERNAL_TOKEN;
    if (!expected) {
      throw new UnauthorizedException("skills internal auth is not configured");
    }

    const req = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const raw = req.headers[SKILLS_INTERNAL_TOKEN_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (typeof provided !== "string" || !SkillsInternalGuard.safeEqual(provided, expected)) {
      throw new UnauthorizedException("invalid or missing skills internal token");
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
