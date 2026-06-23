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
import type { PayerRole } from "@badabhai/db";
import { SERVER_CONFIG } from "../config/config.module";
import { PayerSessionService } from "./payer-session.service";
import { PayersRepository } from "./payers.repository";

/**
 * The authenticated payer attached to the request by {@link PayerAuthGuard}.
 *
 * `role` (ADR-0022) is the payer's VERTICAL-authz role — the input
 * {@link import("./payer-role.guard").PayerRoleGuard} reads to gate agent-only routes. It is
 * `PayerRole | null`: `null` means the role could not be resolved (a fail-CLOSED signal),
 * which any `@PayerRoles(...)` route rejects. This is distinct from HORIZONTAL authz
 * ({@link import("./payer-scope").assertPayerOwns}, which decides WHICH ROWS a payer may
 * touch); `role` decides WHICH ROUTES the payer class may reach.
 */
export interface AuthenticatedPayer {
  id: string;
  sid: string;
  role: PayerRole | null;
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
 * ROLE (ADR-0022): this guard always attaches `req.payer.role` (the VERTICAL-authz role
 * that {@link import("./payer-role.guard").PayerRoleGuard} gates on). It is sourced
 * BACKWARD-COMPATIBLY + FAIL-CLOSED:
 *   1. PREFERRED — the session carries `role` (minted at login post-ADR-0022): zero DB hit.
 *   2. FALLBACK — a pre-ADR-0022 session has no role claim, so it is loaded from the
 *      `payers` row, and the refreshed (rolling) token is re-minted WITH the role so the
 *      next request takes the fast path. No token migration is required.
 *   3. FAIL-CLOSED — if the role still cannot be resolved (row missing/lookup error),
 *      `role` is `null`. `null` is NOT a privileged role: every `@PayerRoles(...)` route
 *      rejects it. We never default to `agent` (or any concrete role) on the unknown path.
 * `PayerAuthGuard` itself NEVER rejects on role — it only authenticates; restricting BY
 * role is `PayerRoleGuard`'s job. So adding role here cannot tighten any existing route.
 *
 * ROLLING TOKEN: past the half-life a fresh JWT is returned in `x-session-token`.
 */
@Injectable()
export class PayerAuthGuard implements CanActivate {
  constructor(
    private readonly session: PayerSessionService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly payers: PayersRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const token = PayerAuthGuard.extractBearer(req);
    if (!token) throw new UnauthorizedException("Missing or malformed Authorization header");

    const validated = await this.session.validateAndTouch(token);
    if (!validated) throw new UnauthorizedException("Invalid or expired payer session");

    // Resolve the vertical-authz role: session claim first, else fall back to the row;
    // unresolved → null (fail-closed). This NEVER 401/403s — only PayerRoleGuard gates.
    const role = validated.role ?? (await this.resolveRoleFromRow(validated.payerId));

    req.payer = { id: validated.payerId, sid: validated.sid, role };

    const fullTtl = this.config.SESSION_TTL_DAYS * 86400;
    if (validated.remainingSeconds < fullTtl / 2) {
      // Carry the resolved role onto the rolling token so a pre-ADR-0022 session that just
      // took the fallback path gets it baked in (role ?? undefined → omit the claim if null).
      const fresh = await this.session.mint(validated.payerId, validated.sid, role ?? undefined);
      res.setHeader("x-session-token", fresh.token);
    }

    return true;
  }

  /** Load the payer's role from its row (the pre-ADR-0022 fallback); null = fail-closed. */
  private async resolveRoleFromRow(payerId: string): Promise<PayerRole | null> {
    try {
      const row = await this.payers.findById(payerId);
      return row?.role ?? null;
    } catch {
      return null;
    }
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
