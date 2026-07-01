import {
  type CanActivate,
  type ExecutionContext,
  createParamDecorator,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { OrgRole } from "@badabhai/db";
import { PayerOrgsRepository, type ResolvedOrg } from "./payer-orgs.repository";

/** Reflector metadata key for the allowed org-roles declared by {@link OrgRoles}. */
export const ORG_ROLES_KEY = "org_roles";

/**
 * Declares the ORG-ROLE(s) allowed to reach a route — the org-tenant RBAC primitive
 * (ADR-0027 / B5). Pair with {@link PayerOrgRoleGuard}, AFTER `PayerAuthGuard`, e.g. an
 * owner-only member-management route:
 *
 *   @UseGuards(PayerAuthGuard, PayerOrgRoleGuard)
 *   @OrgRoles("owner")
 *   @Post("payer/org/members") ...
 *
 * A route with NO `@OrgRoles(...)` is reachable by ANY org member (the guard still resolves
 * + attaches the caller's org, but does not restrict by role) — so attaching the guard to a
 * read route surfaces `@CurrentOrg()` without tightening it.
 */
export const OrgRoles = (...roles: OrgRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ORG_ROLES_KEY, roles);

/** The caller's resolved org membership, attached by {@link PayerOrgRoleGuard}. */
export type PayerOrgContext = ResolvedOrg;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      payerOrg?: PayerOrgContext;
    }
  }
}

/**
 * Org-tenant RBAC + org resolution for payer routes (ADR-0027 / B5). Runs AFTER
 * {@link import("./payer-auth.guard").PayerAuthGuard} (which authenticates WHO the payer is)
 * and:
 *   1. resolves the caller's ACTIVE org membership (`org_id` + `org_role`) from the DB via
 *      {@link PayerOrgsRepository.resolveOrgForPayer} and attaches it to `req.payerOrg` (so the
 *      handler reads it via {@link CurrentOrg} with no re-query), and
 *   2. if the route declares {@link OrgRoles}, rejects (403) unless the caller's `org_role` is
 *      in the allowed set.
 *
 * FAIL-CLOSED: `req.payer` absent → 401 (guards misordered). No active membership → 403 (a
 * payer with no org cannot reach any member route — after B5.2 every payer has a solo org, so
 * this only triggers on a genuinely org-less/removed principal). A resolve error → 403 (never
 * allow). This is a LOW-FREQUENCY surface (team management), so a per-request resolve is cheap;
 * baking `org_id`/`org_role` into the session JWT is a deferred perf optimization, not needed
 * for correctness. This guard NEVER replaces row-level ownership — org-scoped writes still bind
 * to `req.payerOrg.orgId`, never a body value (XB-A).
 */
@Injectable()
export class PayerOrgRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly orgs: PayerOrgsRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const payer = req.payer;
    // PayerAuthGuard runs first and attaches req.payer; absent → misordered/auth-skipped.
    if (!payer) throw new UnauthorizedException("No authenticated payer on request");

    // Resolve the caller's active org membership fail-closed (a resolve error is never allowed).
    let org: ResolvedOrg | null;
    try {
      org = await this.orgs.resolveOrgForPayer(payer.id);
    } catch {
      org = null;
    }
    if (!org) throw new ForbiddenException("Not a member of an organization");
    req.payerOrg = org;

    const allowed = this.reflector.getAllAndOverride<OrgRole[] | undefined>(ORG_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No org-role requirement → any resolved member may proceed (read routes).
    if (!allowed || allowed.length === 0) return true;

    if (!allowed.includes(org.orgRole)) {
      throw new ForbiddenException("Org role is not permitted for this resource");
    }
    return true;
  }
}

/**
 * Param decorator surfacing the caller's resolved org (`org_id` + `org_role`) attached by
 * {@link PayerOrgRoleGuard}. Use only on routes guarded by it.
 */
export const CurrentOrg = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PayerOrgContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.payerOrg) {
      throw new UnauthorizedException("No resolved org on request");
    }
    return req.payerOrg;
  },
);
