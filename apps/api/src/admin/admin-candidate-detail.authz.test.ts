import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { ADMIN_CAPABILITY_MATRIX, can, type AdminCapability } from "./admin-capabilities";
import { AdminCandidateDetailController } from "./admin-candidate-detail.controller";
import { AdminActionsController } from "./admin-actions.controller";
import { AdminPiiRevealController } from "./admin-pii-reveal.controller";
import { AdminCandidateParamsSchema } from "./admin-candidate-detail.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";

/**
 * Per-ROLE authz for `GET /admin/candidates/:id` (ADR-0062 §3.8), driving the REAL
 * {@link AdminRolesGuard} with the route's REAL declared capability: all four roles read the
 * record; reading it confers no write and no phone; the name stays a separate `read_identity`.
 */

const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });

function declaredCapability(ctor: new (...a: never[]) => object, method: string): AdminCapability {
  const proto = ctor.prototype as unknown as Record<string, object>;
  const cap = Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!) as
    | AdminCapability
    | undefined;
  if (!cap) throw new Error(`route ${method} declares no @RequireAdminRole`);
  return cap;
}

function ctxFor(
  ctor: new (...a: never[]) => object,
  method: string,
  who: AuthenticatedAdmin | undefined,
): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(ADMIN_CAPABILITY_KEY, declaredCapability(ctor, method), handler);
  const req = { admin: who };
  return {
    getHandler: () => handler,
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guard = new AdminRolesGuard(new Reflector());

describe("#2560 authz — the candidate record sits on `read_candidates`", () => {
  it("declares read_candidates, whose ADR-0062 §3.8 row is all four roles", () => {
    expect(declaredCapability(AdminCandidateDetailController, "getCandidate")).toBe(
      "read_candidates",
    );
    expect([...ADMIN_CAPABILITY_MATRIX.read_candidates].sort()).toEqual([...ROLES].sort());
  });

  it("ALL four roles pass the guard", () => {
    for (const role of ROLES) {
      expect(
        guard.canActivate(ctxFor(AdminCandidateDetailController, "getCandidate", admin(role))),
      ).toBe(true);
    }
  });

  it("unauthenticated → 401; an unknown role → 403 (deny-by-default)", () => {
    expect(() =>
      guard.canActivate(ctxFor(AdminCandidateDetailController, "getCandidate", undefined)),
    ).toThrow(UnauthorizedException);
    const rogue = { id: "a", role: "root" as AdminRole, sid: "s" };
    expect(() =>
      guard.canActivate(ctxFor(AdminCandidateDetailController, "getCandidate", rogue)),
    ).toThrow(ForbiddenException);
  });

  it("reading a record confers NO action on the worker and NO phone", () => {
    expect(
      guard.canActivate(ctxFor(AdminCandidateDetailController, "getCandidate", admin("analyst"))),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctxFor(AdminActionsController, "flagWorker", admin("analyst"))),
    ).toThrow(ForbiddenException);
    expect(
      guard.canActivate(ctxFor(AdminCandidateDetailController, "getCandidate", admin("ops_admin"))),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctxFor(AdminPiiRevealController, "revealContact", admin("ops_admin"))),
    ).toThrow(ForbiddenException);
  });

  it("the analyst holds the record but NOT the name — the name is a separate, in-service gate", () => {
    expect(can("analyst", "read_candidates")).toBe(true);
    expect(can("analyst", "read_identity")).toBe(false);
  });
});

describe("#2560 controller — HTTP only", () => {
  it("passes the SESSION admin, the validated path id and the request context straight through", async () => {
    const service = { getCandidate: vi.fn(async () => ({ ok: true })) };
    const controller = new AdminCandidateDetailController(service as never);
    const who = admin("support");
    const ctx = { correlationId: "c", requestId: "r" };
    await controller.getCandidate(who, { id: "0b7f1a52-4a0e-4c41-9d61-2f1f3c1e9a01" }, ctx);
    expect(service.getCandidate).toHaveBeenCalledWith(
      who,
      "0b7f1a52-4a0e-4c41-9d61-2f1f3c1e9a01",
      ctx,
    );
  });

  it("the :id param must be a uuid — anything else is a 400 before the service runs", () => {
    const pipe = new ZodValidationPipe(AdminCandidateParamsSchema);
    expect(() => pipe.transform({ id: "not-a-uuid" })).toThrow();
    expect(() => pipe.transform({ id: "Ramesh Kumar" })).toThrow();
    expect(() =>
      pipe.transform({ id: "0b7f1a52-4a0e-4c41-9d61-2f1f3c1e9a01", extra: 1 }),
    ).toThrow();
    expect(pipe.transform({ id: "0b7f1a52-4a0e-4c41-9d61-2f1f3c1e9a01" })).toEqual({
      id: "0b7f1a52-4a0e-4c41-9d61-2f1f3c1e9a01",
    });
  });
});
