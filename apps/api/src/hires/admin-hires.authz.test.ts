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
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin/admin-roles.guard";
import { ADMIN_CAPABILITY_MATRIX, type AdminCapability } from "../admin/admin-capabilities";
import { AdminHiresController } from "./admin-hires.controller";
import { AdminHiresQuerySchema } from "./admin-hires.dto";
import { HireRecordsEnabledGuard } from "./hires.flag";

/**
 * #2753 item 9 — `GET /admin/hires`: behind the admin session, a 404 for every role while
 * `HIRE_RECORDS_ENABLED` is off, then exactly ONE method-level capability (`manage_companies`,
 * held by super_admin and ops_admin and nobody else — the issue's default, reused from the
 * ADR-0025 matrix as it stands).
 */

const proto = AdminHiresController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const roles = new AdminRolesGuard(new Reflector());
const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];

function ctxFor(who: AuthenticatedAdmin | undefined): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(
    ADMIN_CAPABILITY_KEY,
    Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.list!),
    handler,
  );
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => AdminHiresController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** The class guards in order, then the roles guard: what one request meets. */
function request(on: boolean, who: AuthenticatedAdmin | undefined): "ok" | number {
  try {
    new HireRecordsEnabledGuard({ HIRE_RECORDS_ENABLED: on }).canActivate();
    roles.canActivate(ctxFor(who));
    return "ok";
  } catch (err) {
    if (err instanceof NotFoundException) return 404;
    if (err instanceof ForbiddenException) return 403;
    if (err instanceof UnauthorizedException) return 401;
    throw err;
  }
}

describe("GET /admin/hires — the route", () => {
  it("one GET route, `list`, at /admin/hires", () => {
    const methods = Object.getOwnPropertyNames(AdminHiresController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods).toEqual(["list"]);
    expect(Reflect.getMetadata("path", AdminHiresController)).toBe("admin/hires");
    expect(Reflect.getMetadata("path", proto.list!)).toBe("/");
    expect(Reflect.getMetadata("method", proto.list!)).toBe(0); // RequestMethod.GET
  });

  it("guards, in order: the admin session, then the switch, then the roles", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminHiresController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([
      AdminAuthGuard.name,
      HireRecordsEnabledGuard.name,
      AdminRolesGuard.name,
    ]);
  });

  it("declares EXACTLY ONE method-level capability, manage_companies, and none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminHiresController)).toBeUndefined();
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto.list!) as AdminCapability).toBe(
      "manage_companies",
    );
  });

  it("that capability is held by exactly super_admin and ops_admin (the matrix is not changed)", () => {
    expect([...ADMIN_CAPABILITY_MATRIX.manage_companies].sort()).toEqual([
      "ops_admin",
      "super_admin",
    ]);
  });
});

describe("GET /admin/hires — who gets what", () => {
  it("switch ON: super_admin + ops_admin allowed; support + analyst 403; no session 401", () => {
    expect(request(true, admin("super_admin"))).toBe("ok");
    expect(request(true, admin("ops_admin"))).toBe("ok");
    expect(request(true, admin("support"))).toBe(403);
    expect(request(true, admin("analyst"))).toBe(403);
    expect(request(true, undefined)).toBe(401);
  });

  it("switch OFF: the same neutral 404 for EVERY role (nobody learns the surface exists)", () => {
    for (const role of ROLES) expect(request(false, admin(role)), role).toBe(404);
  });

  it("the off answer is Nest's bare 404 body, with no 'disabled' wording", () => {
    const err = (() => {
      try {
        new HireRecordsEnabledGuard({ HIRE_RECORDS_ENABLED: false }).canActivate();
      } catch (e) {
        return e as NotFoundException;
      }
      throw new Error("expected a 404");
    })();
    expect(err.getStatus()).toBe(404);
    expect(err.getResponse()).toEqual({ message: "Not Found", statusCode: 404 });
  });

  it("an unset switch is off", () => {
    expect(() => new HireRecordsEnabledGuard({} as never).canActivate()).toThrow(NotFoundException);
  });

  it("the handler hands the parsed query to the service", async () => {
    const listForAdmin = vi.fn(async () => ({ items: [], nextCursor: null }));
    const controller = new AdminHiresController({ listForAdmin } as never);
    await controller.list({ limit: 50, status: "reported" });
    expect(listForAdmin).toHaveBeenCalledWith({ limit: 50, status: "reported" });
  });
});

describe("GET /admin/hires — the query", () => {
  it("defaults the page to 50, caps it at 100, and takes one closed status", () => {
    expect(AdminHiresQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(AdminHiresQuerySchema.parse({ limit: "100", status: "confirmed" })).toEqual({
      limit: 100,
      status: "confirmed",
    });
    for (const bad of [
      { limit: "101" },
      { limit: "0" },
      { status: "hired" },
      { status: "CONFIRMED" },
      { workerId: "x" }, // strict: no other filter rides along
      { cursor: "" },
    ]) {
      expect(AdminHiresQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
