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
import { PayerSessionService } from "./payer-session.service";

/** The authenticated payer attached to the request by {@link PayerAuthGuard}. */
export interface AuthenticatedPayer {
  id: string;
  sid: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      payer?: AuthenticatedPayer;
    }
  }
}

/**
 * Guards payer-only routes (ADR-0019 — the deferred `PayerAuthGuard`, LC-1/TD33).
 * Reads `Authorization: Bearer <jwt>`, validates the PAYER session (audience-pinned
 * `typ:"payer"`), and attaches `req.payer = { id, sid }`. Missing/invalid → 401.
 *
 * This is a DISTINCT principal from the worker session and the ops
 * `InternalServiceGuard`: a route is reachable by exactly one principal class, and a
 * worker token can never satisfy this guard (different Redis namespace + JWT `typ`).
 * Tenant isolation (a payer may only touch their OWN rows) is enforced separately at
 * the data layer via {@link import("./payer-scope").assertPayerOwns} — the guard
 * authenticates *who* the payer is; the scope chokepoint authorizes *which rows*.
 *
 * ROLLING TOKEN: past the half-life a fresh JWT is returned in `x-session-token`.
 */
@Injectable()
export class PayerAuthGuard implements CanActivate {
  constructor(
    private readonly session: PayerSessionService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const token = PayerAuthGuard.extractBearer(req);
    if (!token) throw new UnauthorizedException("Missing or malformed Authorization header");

    const validated = await this.session.validateAndTouch(token);
    if (!validated) throw new UnauthorizedException("Invalid or expired payer session");

    req.payer = { id: validated.payerId, sid: validated.sid };

    const fullTtl = this.config.SESSION_TTL_DAYS * 86400;
    if (validated.remainingSeconds < fullTtl / 2) {
      const fresh = await this.session.mint(validated.payerId, validated.sid);
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
 * Param decorator surfacing the authenticated payer attached by {@link PayerAuthGuard}.
 * Use only on guarded routes.
 */
export const CurrentPayer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPayer => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.payer) {
      throw new UnauthorizedException("No authenticated payer on request");
    }
    return req.payer;
  },
);
