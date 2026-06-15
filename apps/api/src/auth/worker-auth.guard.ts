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
import { SessionService } from "./session.service";

/** The authenticated worker attached to the request by {@link WorkerAuthGuard}. */
export interface AuthenticatedWorker {
  id: string;
  sid: string;
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
 */
@Injectable()
export class WorkerAuthGuard implements CanActivate {
  constructor(
    private readonly session: SessionService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const token = WorkerAuthGuard.extractBearer(req);
    if (!token) throw new UnauthorizedException("Missing or malformed Authorization header");

    const validated = await this.session.validateAndTouch(token);
    if (!validated) throw new UnauthorizedException("Invalid or expired session");

    req.worker = { id: validated.workerId, sid: validated.sid };

    // Rolling refresh: past the half-life, hand back a fresh token via a header.
    const fullTtl = this.config.SESSION_TTL_DAYS * 86400;
    if (validated.remainingSeconds < fullTtl / 2) {
      const fresh = await this.session.mint(validated.workerId, validated.sid);
      res.setHeader("x-session-token", fresh.token);
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
