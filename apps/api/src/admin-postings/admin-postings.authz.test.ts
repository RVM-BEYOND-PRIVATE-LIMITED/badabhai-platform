import "reflect-metadata";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { UpdateJobPostingSchema } from "../job-postings/job-postings.dto";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin/admin-roles.guard";
import type { AdminCapability } from "../admin/admin-capabilities";
import { AdminPostingsController } from "./admin-postings.controller";
import {
  AdminPostingEditSchema,
  AdminPostingReasonSchema,
  AdminPostingVerificationReasonSchema,
} from "./admin-postings.dto";

/**
 * #2566 — the admin posting-control routes: guarded, exactly ONE method-level capability
 * (`manage_postings`), super_admin + ops_admin allowed, support + analyst 403, no session 401.
 * And every write body REQUIRES a written reason: the company cannot unhide (no payer route
 * writes `hidden_*`), and an admin cannot hide or unhide without explaining why.
 */

const ROUTES = ["edit", "pause", "resume", "close", "hide", "unhide", "verify", "reject"] as const;
const proto = AdminPostingsController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const guard = new AdminRolesGuard(new Reflector());

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
    getClass: () => AdminPostingsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#2566 admin posting-control routes — authz", () => {
  it("the controller exposes exactly the eight posting actions", () => {
    const methods = Object.getOwnPropertyNames(AdminPostingsController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminPostingsController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("every route declares EXACTLY ONE method-level @RequireAdminRole('manage_postings')", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminPostingsController)).toBeUndefined();
    for (const route of ROUTES) {
      const cap = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!) as
        | AdminCapability
        | undefined;
      expect(cap, route).toBe("manage_postings");
    }
  });

  it.each(ROUTES)(
    "%s: super_admin + ops_admin allowed; support + analyst 403; no session 401",
    (route) => {
      expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
      expect(guard.canActivate(ctxFor(route, admin("ops_admin")))).toBe(true);
      expect(() => guard.canActivate(ctxFor(route, admin("support")))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctxFor(route, admin("analyst")))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
    },
  );
});

describe("#2566 only an admin can hide or unhide — the company has no write path", () => {
  const SRC = join(__dirname, "..");

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return sources(full);
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
    });
  }

  it("exactly ONE file under apps/api writes a hidden_* column on job_postings or jobs", () => {
    const writers = sources(SRC).filter((file) => {
      const code = readFileSync(file, "utf8");
      const drizzleWrite = /\.update\((jobPostings|jobs)\)\s*\.set\(\{[^}]*hidden/;
      const rawWrite = /UPDATE\s+(job_postings|jobs)\s+SET[^;`]*hidden_/i;
      return drizzleWrite.test(code) || rawWrite.test(code);
    });
    expect(writers.map((f) => relative(SRC, f).replace(/\\/g, "/"))).toEqual([
      "admin-postings/admin-postings.repository.ts",
    ]);
  });

  it("the payer/ops posting PATCH schema cannot carry a hidden field (stripped, never written)", () => {
    const parsed = UpdateJobPostingSchema.parse({
      role_title: "CNC Operator",
      hidden: false,
      hidden_at: null,
      hidden_by: null,
    });
    expect(parsed).not.toHaveProperty("hidden");
    expect(parsed).not.toHaveProperty("hidden_at");
    expect(parsed).not.toHaveProperty("hidden_by");
  });
});

describe("#2566 every posting write requires a written reason", () => {
  const TEXT = "Title promises a salary the posting does not state";

  it("rejects a missing, short or identifier-bearing reason", () => {
    expect(AdminPostingReasonSchema.safeParse({ reason_code: "misleading" }).success).toBe(false);
    expect(
      AdminPostingReasonSchema.safeParse({ reason_code: "misleading", reason_text: "too short" })
        .success,
    ).toBe(false);
    expect(
      AdminPostingReasonSchema.safeParse({
        reason_code: "misleading",
        reason_text: "Call the owner on 9876543210 before reopening",
      }).success,
    ).toBe(false);
    expect(
      AdminPostingReasonSchema.safeParse({ reason_code: "misleading", reason_text: TEXT }).success,
    ).toBe(true);
  });

  it("is .strict(): no actor, target or hidden_* field can ride the body", () => {
    expect(
      AdminPostingReasonSchema.safeParse({
        reason_code: "misleading",
        reason_text: TEXT,
        hidden_by: "00000000-0000-4000-8000-000000000000",
      }).success,
    ).toBe(false);
    expect(
      AdminPostingVerificationReasonSchema.safeParse({
        reason_code: "meets_standards",
        reason_text: TEXT,
        admin_id: "x",
      }).success,
    ).toBe(false);
  });

  it("edit carries the reason AND a changes object", () => {
    expect(
      AdminPostingEditSchema.safeParse({ reason_code: "misleading", reason_text: TEXT }).success,
    ).toBe(false);
    expect(
      AdminPostingEditSchema.safeParse({
        reason_code: "misleading",
        reason_text: TEXT,
        changes: { role_title: "CNC Machinist" },
      }).success,
    ).toBe(true);
  });
});
