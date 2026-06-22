import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { PayerRole } from "@badabhai/db";

/** Reflector metadata key for the allowed-roles set declared by {@link PayerRoles}. */
export const PAYER_ROLES_KEY = "payer_roles";

/**
 * Declares the payer ROLE(s) allowed to reach a route — the VERTICAL-authz primitive for
 * the Agency Supply Portal (ADR-0022). Pair it with {@link PayerRoleGuard}, AFTER
 * `PayerAuthGuard`, e.g. for an agent-only route:
 *
 *   @UseGuards(PayerAuthGuard, PayerRoleGuard)
 *   @PayerRoles("agent")
 *   @Get("agency/...") ...
 *
 * A route with NO `@PayerRoles(...)` is open to any authenticated payer (the guard is a
 * no-op there) — so attaching `PayerRoleGuard` cannot tighten an existing route by accident.
 */
export const PayerRoles = (...roles: PayerRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PAYER_ROLES_KEY, roles);

/**
 * VERTICAL authz for payer routes (ADR-0022). Runs AFTER {@link PayerAuthGuard} and reads
 * the allowed-roles set declared by {@link PayerRoles}; rejects (403) when the authenticated
 * payer's `role` is not in that set. Used as `@UseGuards(PayerAuthGuard, PayerRoleGuard)`.
 *
 * This is DISTINCT from {@link import("./payer-scope").assertPayerOwns} (HORIZONTAL authz /
 * tenant isolation): `assertPayerOwns` decides WHICH ROWS a payer may touch and is enforced
 * per-row at the data layer; `PayerRoleGuard` decides WHICH ROUTE CLASS a payer may reach and
 * is enforced once at the boundary. They are independent and BOTH apply on an agent-only,
 * tenant-scoped route. This guard never replaces row-level ownership checks.
 *
 * SEMANTICS:
 *   - NO `@PayerRoles` metadata → NO-OP (returns true). It never tightens an undecorated
 *     route, keeping the change additive (existing payer routes are unaffected).
 *   - `req.payer` absent → 401 (guards were misordered or auth was skipped — fail closed).
 *   - `req.payer.role` is `null` (unresolvable, fail-closed from `PayerAuthGuard`) or not in
 *     the allowed set → 403. `null` is never treated as a privileged role.
 */
@Injectable()
export class PayerRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<PayerRole[] | undefined>(PAYER_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No role requirement declared on this route → the guard does nothing.
    if (!allowed || allowed.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const payer = req.payer;
    // Defense-in-depth: PayerAuthGuard runs first and attaches req.payer. If it is absent
    // the guards were misordered (or auth skipped) — fail closed rather than allow.
    if (!payer) {
      throw new UnauthorizedException("No authenticated payer on request");
    }

    // role === null is the fail-closed signal (unresolved role) and is never privileged.
    if (payer.role === null || !allowed.includes(payer.role)) {
      throw new ForbiddenException("Payer role is not permitted for this resource");
    }
    return true;
  }
}
