import { describe, expect, it } from "vitest";
import "reflect-metadata";
import { AdminCompaniesController } from "./admin-companies.controller";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import type { AdminCapability } from "./admin-capabilities";

function guardNames(target: object | undefined): string[] {
  if (!target) return [];
  const g = Reflect.getMetadata("__guards__", target) as
    | Array<{ name?: string; constructor?: { name: string } }>
    | undefined;
  return (g ?? []).map((x) => x.name ?? x.constructor?.name ?? "anonymous");
}
function effectiveGuards(ctor: new (...a: never[]) => object, method: string): string[] {
  const cls = guardNames(ctor);
  const fn = guardNames((ctor.prototype as Record<string, object>)[method]);
  return [...new Set([...cls, ...fn])];
}

describe("B10 companies routes — guarded + exactly one capability (must-fix #4 extended)", () => {
  const proto = AdminCompaniesController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminCompaniesController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers exactly the seven company routes (no route silently dropped)", () => {
    expect(routeMethods.sort()).toEqual(
      [
        "listCompanies",
        "getCompany",
        "listMembers",
        "createCompany",
        "updateCompany",
        "archiveCompany",
        "restoreCompany",
      ].sort(),
    );
  });

  it("EVERY company route carries AdminAuthGuard AND AdminRolesGuard (no open privileged route)", () => {
    for (const method of routeMethods) {
      const guards = effectiveGuards(AdminCompaniesController, method);
      expect(guards, `${method} must be behind AdminAuthGuard`).toContain(AdminAuthGuard.name);
      expect(guards, `${method} must be behind AdminRolesGuard`).toContain(AdminRolesGuard.name);
    }
  });

  it("EVERY company route declares EXACTLY ONE @RequireAdminRole at the method level (deny-by-default, one role per route)", () => {
    const onClass = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminCompaniesController) as
      | AdminCapability
      | undefined;
    expect(onClass, "AdminCompaniesController must NOT declare a class-level capability").toBeUndefined();
    for (const method of routeMethods) {
      const onMethod = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method] as object) as
        | AdminCapability
        | undefined;
      expect(onMethod, `${method} must declare a @RequireAdminRole at the method level`).toBeDefined();
    }
  });

  it("reads sit on read_entities; every WRITE sits on manage_companies (least-privilege)", () => {
    const capabilityOf = (method: string): AdminCapability | undefined =>
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method] as object) as AdminCapability | undefined;
    for (const read of ["listCompanies", "getCompany", "listMembers"]) {
      expect(capabilityOf(read), read).toBe("read_entities");
    }
    for (const write of ["createCompany", "updateCompany", "archiveCompany", "restoreCompany"]) {
      expect(capabilityOf(write), write).toBe("manage_companies");
    }
  });

  it("lives in the admin module", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const mod = readFileSync(join(__dirname, "admin.module.ts"), "utf8");
    expect(mod).toContain("AdminCompaniesController");
    expect(mod).toContain("AdminCompaniesService");
    expect(mod).toContain("AdminCompaniesRepository");
  });
});
