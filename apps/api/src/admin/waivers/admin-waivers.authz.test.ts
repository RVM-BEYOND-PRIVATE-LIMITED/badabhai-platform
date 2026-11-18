import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import {
  WaiverCompanyNotFoundError,
  WaiverPostingNotFoundError,
} from "../../rvm-waivers/rvm-waivers.service";
import { AdminWaiversController } from "./admin-waivers.controller";
import { AdminListWaiversQuerySchema, AdminSetWaiverSchema } from "./admin-waivers.dto";

/**
 * #2750 items 5 and 12 — `/admin/waivers`: guarded, ONE method-level capability each
 * (`manage_waivers`, super_admin only), the actor always the session admin, and a body that names
 * a posting exactly for a job waiver.
 */

const ROUTES = ["listWaivers", "setWaiver"] as const;
const proto = AdminWaiversController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const guard = new AdminRolesGuard(new Reflector());
const COMPANY = "c0000000-0000-4000-8000-000000000001";
const POSTING = "d0000000-0000-4000-8000-000000000001";
const REASON = "Placement team asked for the November drive";

function ctxFor(method: string, who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(
    ADMIN_CAPABILITY_KEY,
    Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!),
    handler,
  );
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => AdminWaiversController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#2750 /admin/waivers — authz", () => {
  it("exposes exactly the list and the set", () => {
    const methods = Object.getOwnPropertyNames(AdminWaiversController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminWaiversController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("both routes declare manage_waivers; none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminWaiversController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!), route).toBe(
        "manage_waivers",
      );
    }
  });

  it.each(ROUTES)("%s: super_admin only; every other role 403; no session 401", (route) => {
    expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(() => guard.canActivate(ctxFor(route, admin(role))), role).toThrow(ForbiddenException);
    }
    expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });
});

describe("#2750 /admin/waivers — the controller", () => {
  function controller() {
    const service = {
      set: vi.fn(async () => ({ active: true, changed: true, waiver: null })),
      list: vi.fn(async () => ({ waivers: [], nextCursor: null })),
    };
    return { service, controller: new AdminWaiversController(service as never) };
  }

  it("the actor is the session admin, never a body field", async () => {
    const { service, controller: c } = controller();
    await c.setWaiver(
      { id: "session-admin", role: "super_admin", sid: "s" },
      { scope: "company", company_id: COMPANY, active: true, reason_text: REASON },
      {} as never,
    );
    expect(service.set).toHaveBeenCalledWith(
      {
        scope: "company",
        companyId: COMPANY,
        postingId: null,
        active: true,
        reason: REASON,
        actor: { kind: "admin", adminId: "session-admin" },
      },
      {},
    );
  });

  it("an unknown company or a posting not that company's is a 404", async () => {
    for (const err of [new WaiverCompanyNotFoundError(), new WaiverPostingNotFoundError()]) {
      const { service, controller: c } = controller();
      service.set.mockRejectedValue(err);
      await expect(
        c.setWaiver(
          admin("super_admin"),
          { scope: "company", company_id: COMPANY, active: true, reason_text: REASON },
          {} as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it("the list passes include_cleared through as a boolean", async () => {
    const { service, controller: c } = controller();
    await c.listWaivers({ include_cleared: "true", limit: 50 });
    expect(service.list).toHaveBeenCalledWith({ includeCleared: true, limit: 50 });
  });
});

describe("#2750 /admin/waivers — the body", () => {
  const valid = { scope: "company", company_id: COMPANY, active: true, reason_text: REASON };

  it("a company waiver names no posting; a job waiver needs one", () => {
    expect(AdminSetWaiverSchema.safeParse(valid).success).toBe(true);
    expect(AdminSetWaiverSchema.safeParse({ ...valid, posting_id: POSTING }).success).toBe(false);
    expect(AdminSetWaiverSchema.safeParse({ ...valid, scope: "job" }).success).toBe(false);
    expect(
      AdminSetWaiverSchema.safeParse({ ...valid, scope: "job", posting_id: POSTING }).success,
    ).toBe(true);
  });

  it("refuses an admin id in the body, a short reason and one carrying a phone number", () => {
    expect(AdminSetWaiverSchema.safeParse({ ...valid, admin_id: "x" }).success).toBe(false);
    expect(AdminSetWaiverSchema.safeParse({ ...valid, reason_text: "short" }).success).toBe(false);
    expect(
      AdminSetWaiverSchema.safeParse({
        ...valid,
        reason_text: "Asked on a call with 9876543210 today",
      }).success,
    ).toBe(false);
  });

  it("the list query is strict and capped", () => {
    expect(AdminListWaiversQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(AdminListWaiversQuerySchema.safeParse({ scope: "job" }).success).toBe(false);
    expect(AdminListWaiversQuerySchema.parse({}).limit).toBe(50);
  });
});
