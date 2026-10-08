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
import type { ResolvedOrg } from "./payer-orgs.repository";
import type { PayerTenantScope } from "./payer-tenant-scope";
import { PayerTenantScopeService } from "./payer-tenant-scope.service";

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
      /** The tenant scope the guard authorized on (ADR-0053 §5.2 rule 1); see {@link CurrentTenantScope}. */
      payerTenantScope?: PayerTenantScope;
    }
  }
}

/**
 * Org-tenant RBAC + org resolution for payer routes (ADR-0027 / B5). Runs AFTER
 * {@link import("./payer-auth.guard").PayerAuthGuard} (which authenticates WHO the payer is)
 * and:
 *   1. resolves the caller's TENANT SCOPE once, via {@link PayerTenantScopeService.resolve} —
 *      the same resolution every tenant-row predicate keys on (ADR-0053 §3.2, §5.2 rule 1) —
 *      derives the ACTING org (`org_id` + `org_role`) from it, and attaches both: the org to
 *      `req.payerOrg` ({@link CurrentOrg}) and the scope to `req.payerTenantScope`
 *      ({@link CurrentTenantScope}). A route that authorizes on the org role hands THAT scope
 *      to its service, which never resolves again: the role the guard checked and the tenant the
 *      rows are keyed by come from ONE membership read, so a membership change landing
 *      mid-request cannot admit a caller on one org and key them to another (PR #2175, F1);
 *   2. if the route declares {@link OrgRoles}, rejects (403) unless the caller's `org_role` is
 *      in the allowed set.
 *
 * FAIL-CLOSED: `req.payer` absent → 401 (guards misordered). No active membership → 403 (a
 * payer with no org cannot reach any member route — after B5.2 every payer has a solo org, so
 * this only triggers on a genuinely org-less/removed principal). A resolve error or an `on`
 * denial → the SAME 403 (never allow, and no rule name: the body is the one a payer with no
 * membership gets). This is a LOW-FREQUENCY surface (team management), so a per-request resolve is cheap;
 * baking `org_id`/`org_role` into the session JWT is a deferred perf optimization, not needed
 * for correctness. This guard NEVER replaces row-level ownership — org-scoped writes still bind
 * to `req.payerOrg.orgId`, never a body value (XB-A).
 */
@Injectable()
export class PayerOrgRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenancy: PayerTenantScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const payer = req.payer;
    // PayerAuthGuard runs first and attaches req.payer; absent → misordered/auth-skipped.
    if (!payer) throw new UnauthorizedException("No authenticated payer on request");

    // Resolve the caller's tenant scope ONCE, fail-closed: a resolve error or an `on` denial is
    // never allowed, and answers the same 403 as no membership at all.
    let scope: PayerTenantScope | null;
    try {
      scope = await this.tenancy.resolve(payer.id);
    } catch {
      scope = null;
    }
    const org: ResolvedOrg | null =
      scope && scope.orgId !== null && scope.orgRole !== null
        ? { orgId: scope.orgId, orgRole: scope.orgRole }
        : null;
    if (!scope || !org) throw new ForbiddenException("Not a member of an organization");

    const allowed = this.reflector.getAllAndOverride<OrgRole[] | undefined>(ORG_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No org-role requirement → any resolved member may proceed (read routes).
    if (allowed && allowed.length > 0 && !allowed.includes(org.orgRole)) {
      throw new ForbiddenException("Org role is not permitted for this resource");
    }
    // Attached only once admitted: a refused request carries no org and no scope.
    req.payerOrg = org;
    req.payerTenantScope = scope;
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

/**
 * Param decorator surfacing the tenant scope {@link PayerOrgRoleGuard} authorized on (ADR-0053
 * §5.2 rule 1). Use only on routes guarded by it, and pass the scope to the service, which must
 * not resolve again. Absent (guard not mounted) → 401, never a fresh resolution.
 */
export const CurrentTenantScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PayerTenantScope => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.payerTenantScope) {
      throw new UnauthorizedException("No resolved tenant scope on request");
    }
    return req.payerTenantScope;
  },
);
