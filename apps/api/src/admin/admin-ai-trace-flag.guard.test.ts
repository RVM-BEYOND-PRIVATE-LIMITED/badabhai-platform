import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { NotFoundException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@badabhai/db";

import { AdminAiTraceFlagGuard } from "./admin-ai-trace-flag.guard";
import { AdminRolesGuard, ADMIN_CAPABILITY_KEY } from "./admin-roles.guard";
import { AdminAiTracesController } from "./admin-ai-traces.controller";

/**
 * `AdminAiTraceFlagGuard` — the `ADMIN_AI_TRACE_READ_ENABLED` master switch (migration 0083).
 *
 * ── WHAT WAS ACTUALLY WRONG, SO THIS FILE IS NOT MISTAKEN FOR CEREMONY ──────────────────
 * The owner ruling was "behind ADMIN_AI_TRACE_READ_ENABLED, default OFF, returning a NEUTRAL 404
 * when off — NOT a 403, it must not confirm the feature exists". The first cut implemented that
 * as an `if (!this.service.isEnabled()) throw new NotFoundException(...)` at the top of the
 * handler. Nest runs guards before handlers, so for three of the four admin roles that line was
 * unreachable: `AdminRolesGuard` had already thrown 403. Measured, flag off:
 *
 *     super_admin  guard PASS  → handler 404       ops_admin  guard 403  → never reached
 *     support      guard 403   → never reached     analyst    guard 403  → never reached
 *
 * The ruling held only for the one principal already entitled to the data. Moving the check into
 * a guard listed AHEAD of the roles guard is the fix, and the assertions below are about the
 * ANSWER EVERY ROLE GETS rather than about one boolean being read.
 */

const ROLES: AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];

const guardFor = (enabled: boolean) =>
  new AdminAiTraceFlagGuard({ ADMIN_AI_TRACE_READ_ENABLED: enabled } as never);

describe("flag OFF — a neutral 404 for EVERY role, on BOTH routes", () => {
  it("throws NotFoundException regardless of who is asking", () => {
    const guard = guardFor(false);
    for (const _role of ROLES) {
      expect(() => guard.canActivate()).toThrow(NotFoundException);
    }
  });

  it("the message is the same bare 'Not found' the service's own refusals use", () => {
    // Every denied case on this surface — flag off, unknown id, over cap, Redis down — must be
    // byte-identical, or the differences between them become an oracle. This pins the flag half.
    try {
      guardFor(false).canActivate();
      expect.unreachable("the guard must throw when the flag is off");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).message).toBe("Not found");
      expect((err as NotFoundException).getStatus()).toBe(404);
    }
  });

  it("takes NO role, session or request — it CANNOT vary its answer by caller", () => {
    // The strongest available statement of "neutral": not "it happens to answer the same", but
    // "it has nothing to answer differently from". `canActivate()` is zero-arity by design.
    expect(AdminAiTraceFlagGuard.prototype.canActivate.length).toBe(0);
  });
});

describe("flag ON — the guard steps aside and the ROLES guard decides", () => {
  it("permits every caller, so 403-vs-200 is the capability's call and not the flag's", () => {
    expect(guardFor(true).canActivate()).toBe(true);
  });

  it("with the flag on, a lesser role is refused by the ROLES guard — 403, which is correct", () => {
    // Once the feature is on, the surface is legitimately known to exist and "not you" is the
    // honest answer. This is the half of the behaviour the neutral 404 must NOT swallow.
    const roles = new AdminRolesGuard(new Reflector());
    const handler = () => undefined;
    Reflect.defineMetadata(
      ADMIN_CAPABILITY_KEY,
      Reflect.getMetadata(
        ADMIN_CAPABILITY_KEY,
        (AdminAiTracesController.prototype as unknown as Record<string, object>).readOne!,
      ),
      handler,
    );
    const ctxFor = (role: AdminRole) =>
      ({
        getHandler: () => handler,
        getClass: () => AdminAiTracesController,
        switchToHttp: () => ({ getRequest: () => ({ admin: { id: "a", role, sid: "s" } }) }),
      }) as unknown as ExecutionContext;

    expect(guardFor(true).canActivate()).toBe(true);
    expect(roles.canActivate(ctxFor("super_admin"))).toBe(true);
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      expect(() => roles.canActivate(ctxFor(role))).toThrow();
    }
  });
});
