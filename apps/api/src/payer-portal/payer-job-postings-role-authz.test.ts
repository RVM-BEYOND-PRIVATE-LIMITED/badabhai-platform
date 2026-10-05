import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { ForbiddenException, HttpException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PayerRole } from "@badabhai/db";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerRoleGuard, PAYER_ROLES_KEY } from "../payers/payer-role.guard";
import { PayerJobPostingsController } from "./payer-job-postings.controller";
import { JobPostingChatController } from "./job-posting-chat/job-posting-chat.controller";
import { AgencyJobsController } from "../agency/agency-jobs.controller";

/**
 * #1885 (owner ruling 2026-10-01; GAP-FE-06) — the company job-posting surface
 * (`job_postings`) is EMPLOYER-ONLY. Binds the REAL controllers' `@PayerRoles` metadata to
 * {@link PayerRoleGuard} (the agency-role-authz.test.ts pattern) and proves:
 *   - an AGENT is refused on every company-posting write and on chat publish,
 *   - an EMPLOYER is unchanged,
 *   - an AGENT can still READ (list / detail) — its pre-existing rows become read-only,
 *   - the refusal is byte-identical to the one an employer gets on the agency surface.
 */

type Ctor = new (...args: never[]) => object;

const guard = new PayerRoleGuard(new Reflector());
const agent: AuthenticatedPayer = { id: "p-agent", sid: "s", role: "agent" };
const employer: AuthenticatedPayer = { id: "p-emp", sid: "s", role: "employer" };
const unresolved: AuthenticatedPayer = { id: "p-x", sid: "s", role: null };

type Handler = (...args: never[]) => unknown;

function handlerOf(controller: Ctor, method: string): Handler {
  return (controller.prototype as Record<string, Handler>)[method]!;
}

function ctxFor(controller: Ctor, method: string, payer: AuthenticatedPayer): ExecutionContext {
  const handler = handlerOf(controller, method);
  const req = { payer };
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function refusalOf(controller: Ctor, method: string, payer: AuthenticatedPayer): HttpException {
  try {
    guard.canActivate(ctxFor(controller, method, payer));
  } catch (e) {
    return e as HttpException;
  }
  throw new Error(`${controller.name}.${method} did not refuse`);
}

const COMPANY_WRITES = [
  "create",
  "update",
  "close",
  "pause",
  "resume",
  "buyPlan",
  "buyBoost",
  "topUpQuota",
] as const;
const COMPANY_READS = ["list", "getOne"] as const;

describe("PayerJobPostingsController — writes are employer-only (#1885)", () => {
  it("attaches the agency guard pair at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", PayerJobPostingsController) ?? []) as Array<{
      name: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(["PayerAuthGuard", "PayerRoleGuard"]);
  });

  for (const method of COMPANY_WRITES) {
    describe(method, () => {
      it("declares @PayerRoles('employer') on the handler", () => {
        const handler = handlerOf(PayerJobPostingsController, method);
        expect(new Reflector().get<PayerRole[]>(PAYER_ROLES_KEY, handler)).toEqual(["employer"]);
      });

      it("REJECTS (403) an agent principal", () => {
        expect(() => guard.canActivate(ctxFor(PayerJobPostingsController, method, agent))).toThrow(
          ForbiddenException,
        );
      });

      it("ALLOWS an employer principal (unchanged)", () => {
        expect(guard.canActivate(ctxFor(PayerJobPostingsController, method, employer))).toBe(true);
      });

      it("REJECTS (403) an unresolved (null) role", () => {
        expect(() =>
          guard.canActivate(ctxFor(PayerJobPostingsController, method, unresolved)),
        ).toThrow(ForbiddenException);
      });
    });
  }

  // Owner decision: an agent's pre-existing job_postings rows stay READABLE (read-only).
  for (const method of COMPANY_READS) {
    it(`${method} carries no role metadata — an agent can still read its own postings`, () => {
      const handler = handlerOf(PayerJobPostingsController, method);
      expect(
        new Reflector().get<PayerRole[] | undefined>(PAYER_ROLES_KEY, handler),
      ).toBeUndefined();
      expect(guard.canActivate(ctxFor(PayerJobPostingsController, method, agent))).toBe(true);
      expect(guard.canActivate(ctxFor(PayerJobPostingsController, method, employer))).toBe(true);
    });
  }
});

describe("JobPostingChatController — publish is employer-only (#1885)", () => {
  it("attaches the agency guard pair at the class level, auth first", () => {
    const guards = (Reflect.getMetadata("__guards__", JobPostingChatController) ?? []) as Array<{
      name: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(["PayerAuthGuard", "PayerRoleGuard"]);
  });

  it("REJECTS (403) an agent on publish", () => {
    expect(() => guard.canActivate(ctxFor(JobPostingChatController, "publish", agent))).toThrow(
      ForbiddenException,
    );
  });

  it("ALLOWS an employer on publish (unchanged)", () => {
    expect(guard.canActivate(ctxFor(JobPostingChatController, "publish", employer))).toBe(true);
  });

  it("REJECTS (403) an unresolved (null) role on publish", () => {
    expect(() =>
      guard.canActivate(ctxFor(JobPostingChatController, "publish", unresolved)),
    ).toThrow(ForbiddenException);
  });

  // Scope is the publish path only — the conversation routes are untouched.
  for (const method of ["startSession", "postMessage", "listSessions", "listMessages"]) {
    it(`${method} carries no role metadata (guard is a no-op)`, () => {
      expect(guard.canActivate(ctxFor(JobPostingChatController, method, agent))).toBe(true);
    });
  }
});

describe("refusal shape — reuses the agency wrong-role refusal (no new error shape)", () => {
  const agencyRefusal = refusalOf(AgencyJobsController, "create", employer);

  for (const [ctor, method] of [
    ...COMPANY_WRITES.map((m) => [PayerJobPostingsController, m] as const),
    [JobPostingChatController, "publish"] as const,
  ]) {
    it(`${ctor.name}.${method} answers the same status + body`, () => {
      const refusal = refusalOf(ctor, method, agent);
      expect(refusal.getStatus()).toBe(403);
      expect(refusal.getStatus()).toBe(agencyRefusal.getStatus());
      expect(refusal.getResponse()).toEqual(agencyRefusal.getResponse());
    });
  }
});
