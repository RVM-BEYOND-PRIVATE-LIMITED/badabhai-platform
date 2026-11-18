import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin-roles.guard";
import {
  RefundEligibilityQuerySchema,
  RefundPaymentSchema,
  RetryRefundSchema,
} from "../../payment-refunds/payment-refunds.dto";
import { AdminPaymentRefundsController } from "./admin-payment-refunds.controller";

/**
 * #2750 items 10 and 12 — the refund routes: guarded, ONE method-level capability each
 * (`refund_payments`: super_admin only, owner ruling 2026-11-18), the actor always the session
 * admin, a closed rule code and the admin's reason in the bodies.
 */

const ROUTES = ["refundEligibility", "refundOrder", "getRefund", "retryRefund"] as const;
const proto = AdminPaymentRefundsController.prototype as unknown as Record<string, object>;
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
const guard = new AdminRolesGuard(new Reflector());
const ORDER = "0a000000-0000-4000-8000-000000000001";
const REFUND = "0b000000-0000-4000-8000-000000000002";
const JOB = "0c000000-0000-4000-8000-000000000003";
const REASON = "Company bought the wrong pack by mistake";

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
    getClass: () => AdminPaymentRefundsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("#2750 refunds — authz", () => {
  it("exposes exactly the eligibility read, the refund, the refund read and the retry", () => {
    const methods = Object.getOwnPropertyNames(AdminPaymentRefundsController.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([...ROUTES].sort());
  });

  it("mounts the paths under /admin", () => {
    expect(Reflect.getMetadata("path", AdminPaymentRefundsController)).toBe("admin");
    expect(ROUTES.map((r) => Reflect.getMetadata("path", proto[r]!))).toEqual([
      "payment-orders/:id/refund-eligibility",
      "payment-orders/:id/refund",
      "payment-refunds/:id",
      "payment-refunds/:id/retry",
    ]);
  });

  it("is behind AdminAuthGuard + AdminRolesGuard at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", AdminPaymentRefundsController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
  });

  it("every route declares refund_payments; none on the class", () => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, AdminPaymentRefundsController)).toBeUndefined();
    for (const route of ROUTES) {
      expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[route]!), route).toBe(
        "refund_payments",
      );
    }
  });

  it.each(ROUTES)("%s: super_admin only; ops_admin, support and analyst 403; no session 401", (route) => {
    expect(guard.canActivate(ctxFor(route, admin("super_admin")))).toBe(true);
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(() => guard.canActivate(ctxFor(route, admin(role))), role).toThrow(
        ForbiddenException,
      );
    }
    expect(() => guard.canActivate(ctxFor(route, undefined))).toThrow(UnauthorizedException);
  });
});

describe("#2750 refunds — the controller", () => {
  it("the refund and the retry name the session admin, never a body field", async () => {
    const service = {
      eligibility: vi.fn(),
      refund: vi.fn(),
      get: vi.fn(),
      retry: vi.fn(),
    };
    const c = new AdminPaymentRefundsController(service as never);
    const me = { id: "session-admin", role: "super_admin", sid: "s" } as AuthenticatedAdmin;
    const dto = { rule: "unused" as const, reason_text: REASON };
    await c.refundOrder(me, ORDER, dto, {} as never);
    expect(service.refund).toHaveBeenCalledWith("session-admin", ORDER, dto, {});
    await c.retryRefund(me, REFUND, { reason_text: REASON }, {} as never);
    expect(service.retry).toHaveBeenCalledWith("session-admin", REFUND, REASON, {});
    await c.refundEligibility(ORDER, { job_posting_id: JOB });
    expect(service.eligibility).toHaveBeenCalledWith(ORDER, JOB);
  });
});

describe("#2750 refunds — the bodies", () => {
  it("a refund names a closed rule and a written reason; no amount or admin can ride along", () => {
    expect(RefundPaymentSchema.safeParse({ rule: "unused", reason_text: REASON }).success).toBe(true);
    expect(
      RefundPaymentSchema.safeParse({ rule: "low_match", reason_text: REASON, job_posting_id: JOB })
        .success,
    ).toBe(true);
    expect(RefundPaymentSchema.safeParse({ rule: "partial", reason_text: REASON }).success).toBe(
      false,
    );
    expect(RefundPaymentSchema.safeParse({ rule: "unused" }).success).toBe(false);
    expect(
      RefundPaymentSchema.safeParse({ rule: "unused", reason_text: REASON, amount_paise: 1 })
        .success,
    ).toBe(false);
    expect(
      RefundPaymentSchema.safeParse({ rule: "unused", reason_text: REASON, admin_id: "x" }).success,
    ).toBe(false);
  });

  it("a retry needs a written reason; the eligibility read takes only a job id", () => {
    expect(RetryRefundSchema.safeParse({}).success).toBe(false);
    expect(RetryRefundSchema.safeParse({ reason_text: REASON }).success).toBe(true);
    expect(RefundEligibilityQuerySchema.safeParse({ job_posting_id: "nope" }).success).toBe(false);
    expect(RefundEligibilityQuerySchema.safeParse({ other: "x" }).success).toBe(false);
  });
});
