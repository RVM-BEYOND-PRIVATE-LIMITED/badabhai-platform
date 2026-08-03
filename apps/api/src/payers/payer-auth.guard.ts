import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
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
 * LIFECYCLE (ADR-0037): this guard is ALSO the platform-wide suspension gate. Every
 * request loads the payer's CURRENT `{role, status}` from the row via
 * {@link PayersRepository.findAuthFacts} and rejects anything but `active` with a 403.
 *
 * Enforced HERE rather than in a new `PayerStatusGuard` on purpose: `guard-contract.test.ts`
 * (and `match-skills.controller.test.ts` / `agency-role-authz.test.ts`) assert the exact
 * guard array per route with strict `toEqual`, so a new guard class would mean editing ~20
 * route entries across 3+ test files for zero behavioural gain — and one forgotten route
 * would be an unguarded hole. One seam, 55 routes, nothing to forget.
 *
 * It is deliberately NOT read from the session/JWT: `PayerSessionService` writes its blob
 * once at `create()` and thereafter only slides the TTL (which itself re-slides to a fresh
 * 30 days per request, with no absolute ceiling), so a cached status would be stale for the
 * unbounded life of the session. `revokeAll` on suspend is still required — it kills the
 * live sessions immediately — but this read is what makes the gate hold even if a revoke
 * is missed, and what makes a REINSTATE take effect without the payer logging in again.
 *
 * ROLE (ADR-0022): this guard always attaches `req.payer.role` (the VERTICAL-authz role
 * that {@link import("./payer-role.guard").PayerRoleGuard} gates on). It now comes from the
 * SAME row read as `status` — the session claim is a hint, the row is authoritative — which
 * also retires the old pre-ADR-0022 session fallback. `PayerAuthGuard` still never rejects
 * on role; restricting BY role remains `PayerRoleGuard`'s job.
 *
 * FAIL-CLOSED on a missing row: a payer hard-deleted mid-session gets 401, not a
 * `role: null` request handed to the service to re-litigate.
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

    // ADR-0037 — LIFECYCLE GATE. One narrow row read (role + status) per request. The
    // session is NOT the authority here: `PayerSessionService` writes its blob once at
    // create() and only slides the TTL thereafter, and the TTL re-slides to a fresh 30
    // days on every request with no absolute ceiling — so a status cached in the session
    // (or in the JWT) would be stale for the unbounded life of that session. Suspension
    // has to bite on the NEXT request, not whenever the payer happens to log in again.
    const facts = await this.payers.findAuthFacts(validated.payerId);

    // Row gone (hard-deleted mid-session) → fail CLOSED. Previously this path resolved
    // `role: null` and let the request through to the service, which decided; a missing
    // principal is not something a route handler should have to re-litigate.
    if (!facts) throw new UnauthorizedException("Invalid or expired payer session");

    // `active` is the ONLY status that may hold a live session. `pending` is included
    // deliberately: a never-verified account must not be able to act, and after ADR-0037
    // it cannot obtain a session at all — this closes the window for any that predate it.
    if (facts.status !== "active") {
      throw new ForbiddenException("Account is not active");
    }

    // Role now comes from the same read (the session claim is only a hint, and the row is
    // authoritative). This also retires the pre-ADR-0022 fallback: every request resolves
    // the role from the row, so a stale session claim can never outrank it.
    const role = facts.role;

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
