import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { CurrentTenantScope, PayerOrgRoleGuard } from "./payer-org-role.guard";

const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";

function ctxWith(payer: unknown) {
  const req: Record<string, unknown> = { payer };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as never;
  return { context, req };
}

/**
 * The guard asks the resolver ONCE per request for the tenant SCOPE (ADR-0053 §5.2 rule 1) and
 * derives the org from it; `org: null` is a scope with no acting org (no membership).
 */
function make(opts: { allowed?: string[]; org?: { orgId: string; orgRole: string } | null; resolveThrows?: boolean }) {
  const reflector = { getAllAndOverride: vi.fn(() => opts.allowed) };
  const org = opts.org === undefined ? { orgId: "org-1", orgRole: "owner" } : opts.org;
  const scope = {
    actorPayerId: PAYER,
    tenantKey: PAYER,
    orgId: org?.orgId ?? null,
    orgRole: org?.orgRole ?? null,
    mode: "off",
  };
  const tenancy = {
    resolve: vi.fn(async () => {
      if (opts.resolveThrows) throw new Error("db down");
      return scope;
    }),
  };
  const guard = new PayerOrgRoleGuard(reflector as never, tenancy as never);
  return { guard, tenancy, scope };
}

describe("PayerOrgRoleGuard — org resolution + RBAC (ADR-0027 / B5.3)", () => {
  it("resolves the caller's org, attaches req.payerOrg, and allows any member when no @OrgRoles", async () => {
    const d = make({ allowed: undefined, org: { orgId: "org-1", orgRole: "recruiter" } });
    const { context, req } = ctxWith({ id: PAYER });
    await expect(d.guard.canActivate(context)).resolves.toBe(true);
    expect(req.payerOrg).toEqual({ orgId: "org-1", orgRole: "recruiter" });
    expect(d.tenancy.resolve).toHaveBeenCalledWith(PAYER);
  });

  it("resolves ONCE and attaches the very scope it authorized on, for @CurrentTenantScope (PR #2175 F1)", async () => {
    const d = make({ allowed: ["owner"], org: { orgId: "org-1", orgRole: "owner" } });
    const { context, req } = ctxWith({ id: PAYER });
    await expect(d.guard.canActivate(context)).resolves.toBe(true);
    expect(d.tenancy.resolve).toHaveBeenCalledTimes(1);
    expect(req.payerTenantScope).toBe(d.scope);
  });

  it("a refused request attaches NO scope (nothing downstream can act on it)", async () => {
    const d = make({ allowed: ["owner"], org: { orgId: "org-1", orgRole: "recruiter" } });
    const { context, req } = ctxWith({ id: PAYER });
    await expect(d.guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    const none = make({ allowed: undefined, org: null });
    const noOrg = ctxWith({ id: PAYER });
    await expect(none.guard.canActivate(noOrg.context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(noOrg.req.payerTenantScope).toBeUndefined();
    // The refused RECRUITER (role check failed) carries neither the org nor the scope.
    expect(req.payerOrg).toBeUndefined();
    expect(req.payerTenantScope).toBeUndefined();
  });

  it("a resolver DENIAL (an `on` 403) is the guard's own 'no membership' 403, never the resolver's body", async () => {
    const reflector = { getAllAndOverride: vi.fn(() => ["owner"]) };
    const tenancy = {
      resolve: vi.fn(async () => {
        throw new ForbiddenException("Not permitted for this organization");
      }),
    };
    const guard = new PayerOrgRoleGuard(reflector as never, tenancy as never);
    const err = await guard.canActivate(ctxWith({ id: PAYER }).context).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).message).toBe("Not a member of an organization");
  });

  it("allows an owner on an @OrgRoles('owner') route", async () => {
    const d = make({ allowed: ["owner"], org: { orgId: "org-1", orgRole: "owner" } });
    const { context } = ctxWith({ id: PAYER });
    await expect(d.guard.canActivate(context)).resolves.toBe(true);
  });

  it("rejects a recruiter on an @OrgRoles('owner') route (403)", async () => {
    const d = make({ allowed: ["owner"], org: { orgId: "org-1", orgRole: "recruiter" } });
    const { context } = ctxWith({ id: PAYER });
    await expect(d.guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects a principal with NO active membership (403, fail-closed)", async () => {
    const d = make({ allowed: undefined, org: null });
    const { context } = ctxWith({ id: PAYER });
    await expect(d.guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("treats a resolve ERROR as no membership (403, never allow)", async () => {
    const d = make({ allowed: ["owner"], resolveThrows: true });
    const { context } = ctxWith({ id: PAYER });
    await expect(d.guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("401s when req.payer is absent (guards misordered / auth skipped)", async () => {
    const d = make({ allowed: ["owner"], org: { orgId: "org-1", orgRole: "owner" } });
    const { context } = ctxWith(undefined);
    await expect(d.guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/** The factory Nest runs for `@CurrentTenantScope()` on a handler parameter. */
function currentTenantScopeFactory(): (data: unknown, ctx: ExecutionContext) => unknown {
  class Probe {
    handler(_scope: unknown): void {}
  }
  CurrentTenantScope()(Probe.prototype, "handler", 0);
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, "handler") as Record<
    string,
    { factory: (data: unknown, ctx: ExecutionContext) => unknown }
  >;
  return Object.values(meta)[0]!.factory;
}

describe("@CurrentTenantScope() — the scope the guard admitted on, or nothing", () => {
  it("returns the very scope PayerOrgRoleGuard attached", () => {
    const scope = { actorPayerId: PAYER, tenantKey: PAYER, orgId: "org-1", orgRole: "owner" };
    const { context, req } = ctxWith({ id: PAYER });
    req.payerTenantScope = scope;
    expect(currentTenantScopeFactory()(undefined, context)).toBe(scope);
  });

  it("401s when no scope is on the request (guard not mounted) — never a fresh resolution", () => {
    const { context } = ctxWith({ id: PAYER });
    expect(() => currentTenantScopeFactory()(undefined, context)).toThrow(UnauthorizedException);
  });
});
