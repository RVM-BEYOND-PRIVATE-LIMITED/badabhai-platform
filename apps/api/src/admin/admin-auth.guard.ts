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
import type { AdminRole } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { AdminSessionService } from "./admin-session.service";

/**
 * The authenticated admin attached to the request by {@link AdminAuthGuard}. PII-FREE: the
 * opaque admin id + the RBAC role + the session id ONLY — NEVER the admin's email.
 */
export interface AuthenticatedAdmin {
  id: string;
  role: AdminRole;
  sid: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AuthenticatedAdmin;
    }
  }
}

/**
 * Guards admin-only routes (ADR-0025 ADMIN-1) — the 4th, highly-privileged principal.
 * Reads `Authorization: Bearer <jwt>`, validates the ADMIN session (audience-pinned
 * `typ:"admin"`, own Redis namespace, signed with the admin's OWN secret), and attaches
 * `req.admin = { id, role, sid }`. Missing/invalid → 401 (fail-closed).
 *
 * ISOLATION: this is a DISTINCT principal from the worker session, the payer session, and the
 * ops `InternalServiceGuard`. A worker/payer token can NEVER satisfy this guard (different JWT
 * secret + `typ` + Redis namespace), and an admin token can never satisfy theirs — proven by
 * the horizontal-isolation test. AUTHORIZATION (which capability a route needs) is the
 * separate {@link import("./admin-roles.guard").AdminRolesGuard}'s job; this guard only
 * AUTHENTICATES who the admin is — it never 403s on role.
 *
 * ROLLING TOKEN: past the half-life a fresh JWT is returned in `x-session-token` (the admin
 * web stores it httpOnly — see ADR-0025 Decision 2.2).
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly session: AdminSessionService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const token = AdminAuthGuard.extractBearer(req);
    if (!token) throw new UnauthorizedException("Missing or malformed Authorization header");

    const validated = await this.session.validateAndTouch(token);
    if (!validated) throw new UnauthorizedException("Invalid or expired admin session");

    req.admin = { id: validated.adminId, role: validated.role, sid: validated.sid };

    const fullTtl = this.config.SESSION_TTL_DAYS * 86400;
    if (validated.remainingSeconds < fullTtl / 2) {
      const fresh = await this.session.mint(validated.adminId, validated.sid, validated.role);
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
 * Param decorator surfacing the authenticated admin attached by {@link AdminAuthGuard}.
 * Use only on guarded routes. Exposes `{ id, role, sid }` — NEVER PII.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.admin) {
      throw new UnauthorizedException("No authenticated admin on request");
    }
    return req.admin;
  },
);
