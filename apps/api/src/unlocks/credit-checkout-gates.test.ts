import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConflictException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { FeaturePilotRepository } from "../feature-rollout/feature-pilot.repository";
import type { FeaturePilotSubjectsRepository } from "../feature-rollout/feature-pilot-subjects.repository";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import { CREDIT_GRANT_ROLLOUT_MESSAGE, CREDIT_GRANT_ROLLOUT_REASON } from "./credit-grant-refused";
import { UnlockService } from "./unlocks.service";

/**
 * #2749 item 10 + hardening 1 and 2 (ADR-0065) — WHICH CREDIT ROUTE IS OPEN FOR A COMPANY.
 *
 * Three gates, one switch (`CREDIT_CHECKOUT_ROLLOUT`, the `credit_checkout` key), crossed with the
 * deployment's real-payments state (`areRealPaymentsEnabled`, `UnlockService.realPaymentsLive`):
 *
 *   - `isMockPackPurchaseOpen` — `POST /payer/credits`, the free mock packs;
 *   - `isRealCheckoutOpen` — `POST /payer/credits/order` and `/verify`;
 *   - `grantPackForOps` — `POST /payers/:payerId/credits`, the ops grant.
 *
 * Every row of the table runs through the REAL FeatureRolloutService and the REAL tenancy resolver
 * (over an in-memory membership table); only the pilot-list read and the purchase itself are
 * doubles. The pilot list is asked by the TENANT key: with tenancy `on` a team member inherits its
 * company's place.
 */

const COMPANY = "aaaaaaaa-0000-4000-8000-00000000000a";
const MEMBER = "bbbbbbbb-0000-4000-8000-00000000000b";
const CTX: RequestContext = {
  correlationId: "c0000000-0000-4000-8000-000000000000",
  requestId: "r-1",
};
const GRANTED = { payer_id: COMPANY, balance: 50, credits: 50, pack_code: "pack_50" };

type Rollout = "off" | "pilot-listed" | "pilot-unlisted" | "pilot-unreadable" | "on";

interface Built {
  svc: UnlockService;
  isListed: ReturnType<typeof vi.fn>;
  resolve: MockInstance<PayerTenantScopeService["resolve"]>;
  purchase: MockInstance<UnlockService["purchaseCredits"]>;
}

function build(
  rollout: Rollout,
  realPaymentsLive: boolean,
  tenancyMode: "off" | "on" = "off",
): Built {
  const mode = rollout.startsWith("pilot") ? "pilot" : rollout;
  const config: ServerConfig = loadServerConfig({
    NODE_ENV: "test",
    CREDIT_CHECKOUT_ROLLOUT: mode,
    PAYER_ORG_TENANCY_MODE: tenancyMode,
  });
  const isListed = vi.fn(async (_feature: string, tenantKey: string) => {
    if (rollout === "pilot-unreadable") throw new Error("connection reset");
    return rollout === "pilot-listed" && tenantKey === COMPANY;
  });
  const rolloutService = new FeatureRolloutService(
    config,
    { isListed } as unknown as FeaturePilotRepository,
    { isListed: vi.fn(async () => false) } as unknown as FeaturePilotSubjectsRepository,
  );
  const tenancy: PayerTenantScopeService = resolverOver(config, [
    { anchor: COMPANY, members: [MEMBER] },
  ]);
  const resolve = vi.spyOn(tenancy, "resolve");
  const svc = new UnlockService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { realCall: realPaymentsLive } as never, // PaymentGateway.realCall = areRealPaymentsEnabled
    {} as never,
    config,
    { add: vi.fn() } as never,
    {} as never,
    {} as never,
    tenancy,
    {} as never,
    rolloutService,
  );
  const purchase = vi.spyOn(svc, "purchaseCredits").mockResolvedValue(GRANTED);
  return { svc, isListed, resolve, purchase };
}

const ROLLOUTS: readonly Rollout[] = [
  "off",
  "pilot-listed",
  "pilot-unlisted",
  "pilot-unreadable",
  "on",
];

/**
 * THE TABLE (ADR-0065 §5). `mock` / `real` are open (true) or the route's neutral 404 (false);
 * `ops` is what the ops grant does. The two `off` rows with real payments off are production today.
 */
const TABLE: Record<
  Rollout,
  Record<"realOff" | "realLive", { mock: boolean; real: boolean; ops: "grants" | "409" | "503" }>
> = {
  off: {
    realOff: { mock: true, real: false, ops: "grants" },
    realLive: { mock: false, real: false, ops: "grants" },
  },
  "pilot-listed": {
    realOff: { mock: false, real: false, ops: "409" },
    realLive: { mock: false, real: true, ops: "409" },
  },
  "pilot-unlisted": {
    realOff: { mock: true, real: false, ops: "grants" },
    realLive: { mock: false, real: false, ops: "grants" },
  },
  "pilot-unreadable": {
    realOff: { mock: false, real: false, ops: "503" },
    realLive: { mock: false, real: false, ops: "503" },
  },
  on: {
    realOff: { mock: false, real: false, ops: "409" },
    realLive: { mock: false, real: true, ops: "409" },
  },
};

describe("#2749 item 10 — the credit-route gates, every rollout state × real payments", () => {
  // The unreadable pilot list logs a warning (ids and the SQLSTATE only); keep the run quiet.
  beforeEach(() => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  for (const rollout of ROLLOUTS) {
    for (const live of [false, true] as const) {
      const expected = TABLE[rollout][live ? "realLive" : "realOff"];
      describe(`rollout ${rollout}, real payments ${live ? "LIVE" : "off"}`, () => {
        it(`POST /payer/credits (free mock packs) is ${expected.mock ? "open" : "closed (404)"}`, async () => {
          const { svc } = build(rollout, live);
          expect(await svc.isMockPackPurchaseOpen(COMPANY)).toBe(expected.mock);
        });

        it(`POST /payer/credits/order and /verify are ${expected.real ? "open" : "closed (404)"}`, async () => {
          const { svc } = build(rollout, live);
          expect(await svc.isRealCheckoutOpen(COMPANY)).toBe(expected.real);
        });

        it(`POST /payers/:payerId/credits (ops grant) ${expected.ops}`, async () => {
          const { svc, purchase } = build(rollout, live);
          const outcome = svc.grantPackForOps(COMPANY, "pack_50", CTX);
          if (expected.ops === "grants") {
            await expect(outcome).resolves.toEqual(GRANTED);
            expect(purchase).toHaveBeenCalledWith(COMPANY, "pack_50", CTX);
            return;
          }
          const err = await outcome.then(
            () => null,
            (e: unknown) => e,
          );
          expect(purchase).not.toHaveBeenCalled(); // nothing is granted, not even attempted
          if (expected.ops === "409") {
            expect(err).toBeInstanceOf(ConflictException);
            expect((err as ConflictException).getResponse()).toEqual({
              statusCode: 409,
              error: "Conflict",
              message: CREDIT_GRANT_ROLLOUT_MESSAGE,
              reason: CREDIT_GRANT_ROLLOUT_REASON,
            });
          } else {
            expect(err).toBeInstanceOf(ServiceUnavailableException);
          }
        });
      });
    }
  }
});

describe("#2749 — with the switch OFF nothing changes, and nothing extra is read", () => {
  it("off + real payments off (production today): mock open, real closed, ops grants — no resolve, no list read", async () => {
    const { svc, isListed, resolve, purchase } = build("off", false);
    expect(await svc.isMockPackPurchaseOpen(COMPANY)).toBe(true);
    expect(await svc.isRealCheckoutOpen(COMPANY)).toBe(false);
    await expect(svc.grantPackForOps(COMPANY, "pack_50", CTX)).resolves.toEqual(GRANTED);
    expect(purchase).toHaveBeenCalledTimes(1);
    // The gates answered from config alone: the purchase is the only resolution left to run.
    expect(resolve).not.toHaveBeenCalled();
    expect(isListed).not.toHaveBeenCalled();
  });

  it("on: answered from config alone too (no resolve, no list read)", async () => {
    const { svc, isListed, resolve } = build("on", true);
    expect(await svc.isRealCheckoutOpen(COMPANY)).toBe(true);
    expect(await svc.isMockPackPurchaseOpen(COMPANY)).toBe(false);
    await expect(svc.grantPackForOps(COMPANY, "pack_50", CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(isListed).not.toHaveBeenCalled();
  });

  it("real payments off: the real-checkout gate never reads the rollout; live: the mock gate never does", async () => {
    const off = build("pilot-listed", false);
    expect(await off.svc.isRealCheckoutOpen(COMPANY)).toBe(false);
    expect(off.resolve).not.toHaveBeenCalled();
    expect(off.isListed).not.toHaveBeenCalled();

    const live = build("pilot-listed", true);
    expect(await live.svc.isMockPackPurchaseOpen(COMPANY)).toBe(false);
    expect(live.resolve).not.toHaveBeenCalled();
    expect(live.isListed).not.toHaveBeenCalled();
  });

  it("a hand-built UnlockService with no rollout service reads as off (today's routes)", async () => {
    const config = loadServerConfig({ NODE_ENV: "test", CREDIT_CHECKOUT_ROLLOUT: "on" });
    const tenancy = resolverOver(config, []);
    const svc = new UnlockService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { realCall: false } as never,
      {} as never,
      config,
      { add: vi.fn() } as never,
      {} as never,
      {} as never,
      tenancy,
      {} as never,
    );
    vi.spyOn(svc, "purchaseCredits").mockResolvedValue(GRANTED);
    expect(await svc.isMockPackPurchaseOpen(COMPANY)).toBe(true);
    await expect(svc.grantPackForOps(COMPANY, "pack_50", CTX)).resolves.toEqual(GRANTED);
  });
});

describe("#2749 — pilot asks the list by the TENANT key, never the raw id", () => {
  it("tenancy on: a team member inherits the company's pilot place (both directions)", async () => {
    const { svc, isListed, resolve } = build("pilot-listed", true, "on");
    expect(await svc.isRealCheckoutOpen(MEMBER)).toBe(true);
    expect(resolve).toHaveBeenCalledWith(MEMBER);
    expect(isListed).toHaveBeenCalledWith("credit_checkout", COMPANY);

    const mock = build("pilot-listed", false, "on");
    expect(await mock.svc.isMockPackPurchaseOpen(MEMBER)).toBe(false); // free packs stop for the team
    await expect(mock.svc.grantPackForOps(MEMBER, "pack_50", CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("tenancy off: the login is its own tenant, so an unlisted login of a listed company is not in", async () => {
    const { svc, isListed } = build("pilot-listed", true, "off");
    expect(await svc.isRealCheckoutOpen(MEMBER)).toBe(false);
    expect(isListed).toHaveBeenCalledWith("credit_checkout", MEMBER);
  });
});
