import { describe, expect, it } from "vitest";
import "reflect-metadata";
import { AdminPaymentHistoryController } from "./admin-payment-history.controller";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import type { AdminCapability } from "./admin-capabilities";

const ADMIN_DIR = __dirname;

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

describe("B11 payment-history route — guarded + read_entities (must-fix #4 extended)", () => {
  const proto = AdminPaymentHistoryController.prototype as unknown as Record<string, unknown>;
  const routeMethods = Object.getOwnPropertyNames(AdminPaymentHistoryController.prototype).filter(
    (m) =>
      m !== "constructor" &&
      typeof proto[m] === "function" &&
      Reflect.getMetadata("path", proto[m] as object) !== undefined,
  );

  it("discovers exactly the one history route", () => {
    expect(routeMethods.sort()).toEqual(["history"]);
  });

  it("carries AdminAuthGuard AND AdminRolesGuard", () => {
    expect(effectiveGuards(AdminPaymentHistoryController, "history")).toContain(
      AdminAuthGuard.name,
    );
    expect(effectiveGuards(AdminPaymentHistoryController, "history")).toContain(
      AdminRolesGuard.name,
    );
  });

  it("declares EXACTLY ONE @RequireAdminRole('read_entities') at the method level", () => {
    const onMethod = Reflect.getMetadata(
      ADMIN_CAPABILITY_KEY,
      proto.history as object,
    ) as AdminCapability | undefined;
    const onClass = Reflect.getMetadata(
      ADMIN_CAPABILITY_KEY,
      AdminPaymentHistoryController,
    ) as AdminCapability | undefined;
    expect(onMethod).toBe("read_entities");
    expect(onClass, "must NOT declare a class-level capability").toBeUndefined();
  });

  it("lives in the admin module", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const mod = readFileSync(join(ADMIN_DIR, "admin.module.ts"), "utf8");
    expect(mod).toContain("AdminPaymentHistoryController");
    expect(mod).toContain("AdminPaymentHistoryService");
    expect(mod).toContain("AdminPaymentHistoryRepository");
  });
});
