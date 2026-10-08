import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import type { OrgRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerOrgRoleGuard, ORG_ROLES_KEY } from "../payers/payer-org-role.guard";
import type { ResolvedOrg } from "../payers/payer-orgs.repository";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerSessionService } from "../payers/payer-session.service";
import type { PayersRepository } from "../payers/payers.repository";
import { PayerUnlocksController } from "./payer-unlocks.controller";
import { PayerOrgMembersController } from "./payer-org-members.controller";

/**
 * Org-role authz on the payer money + team surfaces (ADR-0027 / B5.3).
 *
 * TEAM MANAGEMENT IS ORG-OWNER-ONLY (#2079): member invite/remove bind the REAL controller's
 * `@UseGuards` / `@OrgRoles` metadata to the REAL {@link PayerOrgRoleGuard} (stubbed membership
 * read) and prove an owner is admitted, while a recruiter, a payer with no active membership, a
 * failed membership read and a just-demoted owner are all refused (403).
 *
 * CREDIT PURCHASE IS OPEN TO ANY AUTHENTICATED PAYER (owner ruling 2026-10-07; ADR-0027 D3).
 * #2098 had made the three credit-purchase routes owner-only; the ruling reverses that. For each
 * route this runs EVERY guard Nest would run (class-level then method-level, each the REAL guard
 * class over stubbed reads) and then the REAL handler, for an owner, a recruiter, a payer with
 * no membership and a payer whose membership read fails. Every one must reach the handler and
 * get the route's 2xx.
 */

type Ctor = new (...args: never[]) => object;
type Handler = (...args: never[]) => unknown;

const PAYER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PAYER: AuthenticatedPayer = { id: PAYER_ID, sid: "s-1", role: "employer" };
const ORG_ID = "org-1";
const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };
const CONFIG = { SESSION_TTL_DAYS: 30 } as unknown as ServerConfig;

function handlerOf(controller: Ctor, method: string): Handler {
  return (controller.prototype as Record<string, Handler>)[method]!;
}

type Membership = () => Promise<ResolvedOrg | null>;

const member =
  (orgRole: OrgRole): Membership =>
  async () => ({ orgId: ORG_ID, orgRole });

// ---------------------------------------------------------------------------------------------
// Team management — owner-only (unchanged by the 2026-10-07 ruling)
// ---------------------------------------------------------------------------------------------

/**
 * A guard whose ONE tenant resolution per request (ADR-0053 §5.2 rule 1) is driven by
 * `membership`: the scope's acting org is the membership, or none.
 */
function guardWith(membership: Membership) {
  const resolve = vi.fn(async (actor: string) => {
    const org = await membership();
    return {
      actorPayerId: actor,
      tenantKey: actor,
      orgId: org?.orgId ?? null,
      orgRole: org?.orgRole ?? null,
      mode: "off",
    };
  });
  const guard = new PayerOrgRoleGuard(new Reflector(), {
    resolve,
  } as unknown as PayerTenantScopeService);
  return { guard, resolve };
}

function ctxFor(controller: Ctor, method: string) {
  const req: { payer: AuthenticatedPayer; payerOrg?: ResolvedOrg } = { payer: PAYER };
  const ctx = {
    getHandler: () => handlerOf(controller, method),
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

const OWNER_ONLY: ReadonlyArray<readonly [Ctor, string, string]> = [
  [PayerOrgMembersController, "invite", "POST /payer/org/members"],
  [PayerOrgMembersController, "remove", "DELETE /payer/org/members/:id"],
];

describe("team management stays org-OWNER-only (#2079)", () => {
  for (const [controller, method, route] of OWNER_ONLY) {
    describe(route, () => {
      it("mounts PayerOrgRoleGuard and declares @OrgRoles('owner')", () => {
        const handler = handlerOf(controller, method);
        const guards = [
          ...((Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as Array<{ name: string }>),
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<{ name: string }>),
        ].map((g) => g.name);
        expect(guards).toContain("PayerAuthGuard");
        expect(guards).toContain("PayerOrgRoleGuard");
        // PayerAuthGuard must run FIRST (it attaches req.payer the org guard reads).
        expect(guards.indexOf("PayerAuthGuard")).toBeLessThan(guards.indexOf("PayerOrgRoleGuard"));
        expect(new Reflector().get<OrgRole[]>(ORG_ROLES_KEY, handler)).toEqual(["owner"]);
      });

      it("ADMITS an owner (and attaches the resolved org)", async () => {
        const { guard } = guardWith(member("owner"));
        const { ctx, req } = ctxFor(controller, method);
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
        expect(req.payerOrg).toEqual({ orgId: ORG_ID, orgRole: "owner" });
      });

      it("REFUSES (403) a recruiter", async () => {
        const { guard } = guardWith(member("recruiter"));
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });

      it("REFUSES (403) a payer with no active membership (removed / unknown role)", async () => {
        const { guard } = guardWith(async () => null);
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });

      it("REFUSES (403) when the membership read fails — fail closed, never open", async () => {
        const { guard } = guardWith(async () => {
          throw new Error("pg down");
        });
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });

      it("a DEMOTED owner loses access on the very next request (current role, per request)", async () => {
        let role: OrgRole = "owner";
        const { guard, resolve } = guardWith(async () => ({ orgId: ORG_ID, orgRole: role }));
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).resolves.toBe(true);
        role = "recruiter"; // demoted between two requests on the SAME session
        await expect(guard.canActivate(ctxFor(controller, method).ctx)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(resolve).toHaveBeenCalledTimes(2);
        expect(resolve).toHaveBeenLastCalledWith(PAYER.id);
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Credit purchase — any authenticated payer (owner ruling 2026-10-07)
// ---------------------------------------------------------------------------------------------

interface GuardInstance {
  canActivate(ctx: ExecutionContext): Promise<boolean>;
}

/**
 * Run EVERY guard Nest would run for `PayerUnlocksController[method]`, in Nest's order (class
 * `@UseGuards` first, then method `@UseGuards`), each built from the REAL guard class over
 * stubbed reads: a valid active `employer` session, and `membership` as the caller's org
 * membership. An unmodelled guard class THROWS, so a guard added to these routes later fails
 * here instead of being skipped. A guard that refuses throws (403) or returns false; both fail
 * the test. Returns the request as the chain left it (`req.payer` attached by PayerAuthGuard).
 */
async function runGuardChain(method: string, membership: Membership): Promise<Request> {
  const handler = handlerOf(PayerUnlocksController, method);
  const tenancy = { resolveActingOrg: vi.fn(membership) } as unknown as PayerTenantScopeService;
  const session = {
    // A fresh session (full TTL) → no rolling re-mint, so PayerAuthGuard makes no org read.
    validateAndTouch: vi.fn(async () => ({
      payerId: PAYER_ID,
      sid: "s-1",
      remainingSeconds: 30 * 86400,
      role: "employer",
      org: null,
    })),
    mint: vi.fn(),
  } as unknown as PayerSessionService;
  const payers = {
    findAuthFacts: vi.fn(async () => ({ role: "employer", status: "active" })),
  } as unknown as PayersRepository;

  const build = (guard: unknown): GuardInstance => {
    if (guard === PayerAuthGuard) return new PayerAuthGuard(session, CONFIG, payers, tenancy);
    if (guard === PayerOrgRoleGuard) return new PayerOrgRoleGuard(new Reflector(), tenancy);
    throw new Error(
      `unmodelled guard ${(guard as { name?: string }).name ?? String(guard)} on ${method}`,
    );
  };

  const req = {
    header: (name: string) => (name.toLowerCase() === "authorization" ? "Bearer t" : undefined),
  } as unknown as Request;
  const res = { setHeader: vi.fn() };
  const ctx = {
    getHandler: () => handler,
    getClass: () => PayerUnlocksController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;

  const guards = [
    ...((Reflect.getMetadata(GUARDS_METADATA, PayerUnlocksController) ?? []) as unknown[]),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[]),
  ];
  expect(guards.length).toBeGreaterThan(0); // never vacuously "admitted" by an empty chain
  for (const guard of guards) {
    await expect(build(guard).canActivate(ctx)).resolves.toBe(true);
  }
  return req;
}

/** The controller over stubbed seams; `realPaymentsLive` picks the posture the route serves in. */
function makeCtrl(realPaymentsLive: boolean) {
  const unlocks = {
    realPaymentsLive,
    purchaseCredits: vi.fn(async (payerId: string) => ({
      payer_id: payerId,
      balance: 50,
      credits: 50,
      pack_code: "starter",
    })),
    createCreditOrder: vi.fn(async () => ({
      orderRowId: "11111111-2222-4333-8444-555555555555",
      providerOrderId: "order_TEST1",
      keyId: "rzp_test_keyid",
      amountInr: 2000,
      amountPaise: 200000,
      currency: "INR",
      packCode: "pack_50",
      credits: 50,
    })),
    verifyCheckoutPayment: vi.fn(async (payerId: string) => ({
      verified: true as const,
      payer_id: payerId,
      balance: 50,
      credits: 50,
      pack_code: "pack_50",
    })),
  };
  // Pass-through: no Idempotency-Key on these requests, so runOnce just runs the work.
  const idempotency = { runOnce: vi.fn(async (o: { work: () => Promise<unknown> }) => o.work()) };
  const ctrl = new PayerUnlocksController(unlocks as never, {} as never, idempotency as never);
  return { ctrl, unlocks };
}

type Ctrl = ReturnType<typeof makeCtrl>;

interface CreditRoute {
  method: "buyPack" | "createOrder" | "verifyPayment";
  route: string;
  status: number;
  realPaymentsLive: boolean;
  call: (d: Ctrl, payer: AuthenticatedPayer, req: Request) => Promise<unknown>;
  seam: (d: Ctrl) => { mock: { calls: unknown[][] } };
}

const CREDIT_ROUTES: readonly CreditRoute[] = [
  {
    method: "buyPack",
    route: "POST /payer/credits",
    status: 201,
    realPaymentsLive: false, // the mock path serves only while real payments are off
    call: (d, payer, req) => d.ctrl.buyPack({ pack_code: "starter" }, payer, req, CTX),
    seam: (d) => d.unlocks.purchaseCredits,
  },
  {
    method: "createOrder",
    route: "POST /payer/credits/order",
    status: 201,
    realPaymentsLive: true,
    call: (d, payer) => d.ctrl.createOrder({ pack_code: "pack_50" }, payer, CTX),
    seam: (d) => d.unlocks.createCreditOrder,
  },
  {
    method: "verifyPayment",
    route: "POST /payer/credits/verify",
    status: 200,
    realPaymentsLive: true,
    call: (d, payer) =>
      d.ctrl.verifyPayment(
        { razorpay_order_id: "order_TEST1", razorpay_payment_id: "pay_TEST1", razorpay_signature: "sig" },
        payer,
        CTX,
      ),
    seam: (d) => d.unlocks.verifyCheckoutPayment,
  },
];

const CALLERS: ReadonlyArray<readonly [string, Membership]> = [
  ["an org OWNER", member("owner")],
  ["a RECRUITER", member("recruiter")],
  ["a payer with NO active org membership", async () => null],
  [
    "a payer whose membership read FAILS",
    async () => {
      throw new Error("pg down");
    },
  ],
];

describe("credit purchase is open to ANY authenticated payer (owner ruling 2026-10-07)", () => {
  for (const r of CREDIT_ROUTES) {
    describe(r.route, () => {
      it("carries only the class-level PayerAuthGuard — no PayerOrgRoleGuard, no @OrgRoles", () => {
        const handler = handlerOf(PayerUnlocksController, r.method);
        const guards = [
          ...((Reflect.getMetadata(GUARDS_METADATA, PayerUnlocksController) ?? []) as Array<{ name: string }>),
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<{ name: string }>),
        ].map((g) => g.name);
        expect(guards).toEqual(["PayerAuthGuard"]);
        expect(new Reflector().get<OrgRole[] | undefined>(ORG_ROLES_KEY, handler)).toBeUndefined();
      });

      for (const [who, membership] of CALLERS) {
        it(`${who} passes every guard and gets the route's 2xx (${r.status})`, async () => {
          const req = await runGuardChain(r.method, membership);
          expect(req.payer?.id).toBe(PAYER_ID);

          const d = makeCtrl(r.realPaymentsLive);
          await expect(r.call(d, req.payer!, req)).resolves.toBeDefined();
          // The purchase binds to the SESSION payer PayerAuthGuard attached (XB-A), not an org.
          expect(r.seam(d).mock.calls[0]?.[0]).toBe(PAYER_ID);

          const status = Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(PayerUnlocksController, r.method));
          expect(status).toBe(r.status);
          expect(status).toBeGreaterThanOrEqual(200);
          expect(status).toBeLessThan(300);
        });
      }
    });
  }

  // The rest of the payer money/unlock surface was never org-gated and stays that way.
  const OPEN_TO_EVERY_PAYER = [
    "requestUnlock",
    "reveal",
    "listOwn",
    "ownCredits",
    "creditsLedger",
  ] as const;
  for (const method of OPEN_TO_EVERY_PAYER) {
    it(`PayerUnlocksController.${method} carries no org-role gate`, () => {
      const handler = handlerOf(PayerUnlocksController, method);
      const guards = ((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<{ name: string }>).map(
        (g) => g.name,
      );
      expect(guards).not.toContain("PayerOrgRoleGuard");
      expect(new Reflector().get<OrgRole[] | undefined>(ORG_ROLES_KEY, handler)).toBeUndefined();
    });
  }
});
