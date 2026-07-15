import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { ConsentRepository } from "../consent/consent.repository";
import { SessionService } from "./session.service";

/** The authenticated worker attached to the request by {@link WorkerAuthGuard}. */
export interface AuthenticatedWorker {
  id: string;
  sid: string;
  /** ADR-0026 Phase 2 — the bound trusted-device row uuid (the token `did` claim), if any. */
  deviceId?: string;
}

// Augment Express's Request with the authenticated worker (global namespace).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      worker?: AuthenticatedWorker;
    }
  }
}

/**
 * Guards worker-only routes. Reads `Authorization: Bearer <jwt>`, validates +
 * touches the session, and attaches `req.worker = { id, sid }`. A missing/invalid
 * token → 401.
 *
 * ROLLING TOKEN: when the current token is past its half-life, a fresh JWT is
 * minted and returned in the `x-session-token` response header so an active
 * client transparently keeps a fresh token without a separate refresh call.
 *
 * A5 residual (ADR-0026 amendment): the half-life re-mint is CONSENT-GATED — a worker
 * whose latest consent is REVOKED no longer gets a silent fresh full-TTL token, so a
 * revoked worker's residual access is bounded by the CURRENT token's remaining TTL.
 * The request itself still passes (logout keeps working for revoked workers), and a
 * NEVER-consented worker keeps the re-mint (the pre-consent onboarding window — the
 * same asymmetry as ConsentNotRevokedGuard). Cost: ONE consent read at most once per
 * half-life, never on the ordinary per-request path.
 *
 * FAIL-SAFE BOTH WAYS: the consent read is the guard's ONLY Postgres dependency
 * (validateAndTouch is Redis-only, mint is pure JWT), so a read error must never turn
 * into a 500 on `[W]`-only routes — POST /auth/logout and /auth/logout-all are exactly
 * the routes that must survive a DB incident. On ANY consent-read error the guard
 * WITHHOLDS the extension (no re-mint without proof of not-revoked — the security
 * property holds) and lets the already-authenticated request pass, the same
 * degradation shape validateAndTouch applies to a Redis error (request outcome,
 * never a 500).
 */
@Injectable()
export class WorkerAuthGuard implements CanActivate {
  constructor(
    private readonly session: SessionService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly consents: ConsentRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const token = WorkerAuthGuard.extractBearer(req);
    if (!token) throw new UnauthorizedException("Missing or malformed Authorization header");

    const validated = await this.session.validateAndTouch(token);
    if (!validated) throw new UnauthorizedException("Invalid or expired session");

    req.worker = { id: validated.workerId, sid: validated.sid, deviceId: validated.deviceId };

    // Rolling refresh: past the half-life, hand back a fresh token via a header. Preserve
    // the device binding (`did`) so the rolled token stays bound to the same device.
    const fullTtl = this.config.SESSION_TTL_DAYS * 86400;
    if (validated.remainingSeconds < fullTtl / 2) {
      // A5 residual: SKIP the re-mint for a REVOKED-consent worker (latest row exists AND
      // revokedAt is stamped). Never-consented (no row) and active consent both re-mint.
      // FAIL-SAFE: a consent-read error also SKIPS the re-mint (consent state unknown →
      // withhold the extension) but never fails the already-authenticated request — a
      // PG blip must not 500 logout/logout-all past the token half-life.
      let allowRemint = false;
      try {
        const latest = await this.consents.findLatestByWorker(validated.workerId);
        allowRemint = !latest || latest.revokedAt === null;
      } catch {
        allowRemint = false;
      }
      if (allowRemint) {
        const fresh = await this.session.mint(
          validated.workerId,
          validated.sid,
          validated.deviceId,
        );
        res.setHeader("x-session-token", fresh.token);
      }
    }

    return true;
  }

  private static extractBearer(req: Request): string | null {
    const header = req.header("authorization");
    if (!header) return null;
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !value) return null;
    return value.trim() || null;
  }
}

/**
 * Param decorator surfacing the authenticated worker attached by
 * {@link WorkerAuthGuard}. Use only on guarded routes.
 *
 *   @Get("me") me(@CurrentWorker() worker: AuthenticatedWorker) { ... }
 */
export const CurrentWorker = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedWorker => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.worker) {
      // Should never happen: the guard runs first and throws on no worker.
      throw new UnauthorizedException("No authenticated worker on request");
    }
    return req.worker;
  },
);
