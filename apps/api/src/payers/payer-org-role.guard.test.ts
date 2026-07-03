import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { PayerOrgRoleGuard } from "./payer-org-role.guard";

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

function make(opts: { allowed?: string[]; org?: { orgId: string; orgRole: string } | null; resolveThrows?: boolean }) {
  const reflector = { getAllAndOverride: vi.fn(() => opts.allowed) };
  const orgs = {
    resolveOrgForPayer: vi.fn(async () => {
      if (opts.resolveThrows) throw new Error("db down");
      return opts.org === undefined ? { orgId: "org-1", orgRole: "owner" } : opts.org;
    }),
  };
  const guard = new PayerOrgRoleGuard(reflector as never, orgs as never);
  return { guard, orgs };
}

describe("PayerOrgRoleGuard — org resolution + RBAC (ADR-0027 / B5.3)", () => {
  it("resolves the caller's org, attaches req.payerOrg, and allows any member when no @OrgRoles", async () => {
    const d = make({ allowed: undefined, org: { orgId: "org-1", orgRole: "recruiter" } });
    const { context, req } = ctxWith({ id: PAYER });
    await expect(d.guard.canActivate(context)).resolves.toBe(true);
    expect(req.payerOrg).toEqual({ orgId: "org-1", orgRole: "recruiter" });
    expect(d.orgs.resolveOrgForPayer).toHaveBeenCalledWith(PAYER);
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
