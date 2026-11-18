import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConflictException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import type { PayerCheckoutMode } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import type { FeaturePilotRepository } from "../feature-rollout/feature-pilot.repository";
import type { FeaturePilotSubjectsRepository } from "../feature-rollout/feature-pilot-subjects.repository";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { resolverOver } from "../payers/payer-tenant-scope.test-support";
import {
  CREDIT_GRANT_REAL_PAYMENTS_MESSAGE,
  CREDIT_GRANT_REAL_PAYMENTS_REASON,
  CREDIT_GRANT_ROLLOUT_MESSAGE,
  CREDIT_GRANT_ROLLOUT_REASON,
} from "./credit-grant-refused";
import { UnlockService } from "./unlocks.service";

/**
 * #2749 item 10 + hardening 1 and 2 (ADR-0065) — WHICH CREDIT ROUTE IS OPEN FOR A COMPANY.
 *
 * One switch (`CREDIT_CHECKOUT_ROLLOUT`, the `credit_checkout` key), crossed with the deployment's
 * real-payments state (`areRealPaymentsEnabled`, `UnlockService.realPaymentsLive`):
 *
 *   - `isMockPackPurchaseOpen` — `POST /payer/credits`, the free mock packs;
 *   - `isRealCheckoutOpen` — `POST /payer/credits/order` (a NEW order; `/verify` needs only real
 *     payments live, so a paid order still settles after a rollback);
 *   - `grantPackForOps` — `POST /payers/:payerId/credits`, the ops grant;
 *   - `getCredits().checkout` — the same answer, for the front ends (`real` | `free` | `none`).
 *
 * Every row of the table runs through the REAL FeatureRolloutService and the REAL tenancy resolver
 * (over an in-memory membership table); only the pilot-list read, the wallet reads and the
 * purchase itself are doubles. The pilot list is asked by the TENANT key: with tenancy `on` a team
 * member inherits its company's place.
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
    // The wallet reads `getCredits` makes; nothing else on the repository is reached here.
    { getBalance: vi.fn(async () => 7), listOpenLots: vi.fn(async () => []) } as never,
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

type OpsOutcome = "grants" | "409 rollout" | "409 real" | "503";

/**
 * THE TABLE (ADR-0065 §3.6). `mock` / `order` are open (true) or the route's neutral 404 (false);
 * `ops` is what the ops grant does; `checkout` is `GET /payer/credits`'s field. The two `off` rows
 * with real payments off are production today.
 */
const TABLE: Record<
  Rollout,
  Record<
    "realOff" | "realLive",
    { mock: boolean; order: boolean; ops: OpsOutcome; checkout: PayerCheckoutMode }
  >
> = {
  off: {
    realOff: { mock: true, order: false, ops: "grants", checkout: "free" },
    realLive: { mock: false, order: false, ops: "409 real", checkout: "none" },
  },
  "pilot-listed": {
    realOff: { mock: false, order: false, ops: "409 rollout", checkout: "none" },
    realLive: { mock: false, order: true, ops: "409 real", checkout: "real" },
  },
  "pilot-unlisted": {
    realOff: { mock: true, order: false, ops: "grants", checkout: "free" },
    realLive: { mock: false, order: false, ops: "409 real", checkout: "none" },
  },
  "pilot-unreadable": {
    realOff: { mock: false, order: false, ops: "503", checkout: "none" },
    realLive: { mock: false, order: false, ops: "409 real", checkout: "none" },
  },
  on: {
    realOff: { mock: false, order: false, ops: "409 rollout", checkout: "none" },
    realLive: { mock: false, order: true, ops: "409 real", checkout: "real" },
  },
};

const REFUSAL_BODY: Record<"409 rollout" | "409 real", Record<string, unknown>> = {
  "409 rollout": {
    statusCode: 409,
    error: "Conflict",
    message: CREDIT_GRANT_ROLLOUT_MESSAGE,
    reason: CREDIT_GRANT_ROLLOUT_REASON,
  },
  "409 real": {
    statusCode: 409,
    error: "Conflict",
    message: CREDIT_GRANT_REAL_PAYMENTS_MESSAGE,
    reason: CREDIT_GRANT_REAL_PAYMENTS_REASON,
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

        it(`POST /payer/credits/order is ${expected.order ? "open" : "closed (404)"}`, async () => {
          const { svc } = build(rollout, live);
          expect(await svc.isRealCheckoutOpen(COMPANY)).toBe(expected.order);
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
          if (expected.ops === "503") {
            expect(err).toBeInstanceOf(ServiceUnavailableException);
          } else {
            expect(err).toBeInstanceOf(ConflictException);
            expect((err as ConflictException).getResponse()).toEqual(REFUSAL_BODY[expected.ops]);
          }
        });

        it(`GET /payer/credits says checkout: "${expected.checkout}"`, async () => {
          const { svc } = build(rollout, live);
          expect(await svc.getCredits(COMPANY)).toEqual({
            payer_id: COMPANY,
            balance: 7,
            lots: [],
            checkout: expected.checkout,
          });
        });
      });
    }
  }

  it("`checkout` agrees with the route gates in every row (real ⇔ order open, free ⇔ mock open)", async () => {
    for (const rollout of ROLLOUTS) {
      for (const live of [false, true]) {
        const { svc } = build(rollout, live);
        const { checkout } = await svc.getCredits(COMPANY);
        expect(checkout === "real", `${rollout}/${live}`).toBe(
          await svc.isRealCheckoutOpen(COMPANY),
        );
        expect(checkout === "free", `${rollout}/${live}`).toBe(
          await svc.isMockPackPurchaseOpen(COMPANY),
        );
      }
    }
  });
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

  it("GET /payer/credits resolves the tenant once and, off, reads no pilot list", async () => {
    const { svc, isListed, resolve } = build("off", false);
    await svc.getCredits(COMPANY);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(isListed).not.toHaveBeenCalled();

    const pilot = build("pilot-listed", true);
    expect((await pilot.svc.getCredits(COMPANY)).checkout).toBe("real");
    expect(pilot.resolve).toHaveBeenCalledTimes(1); // the getCredits scope is reused
    expect(pilot.isListed).toHaveBeenCalledTimes(1);
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

  it("real payments off: the real-checkout gate never reads the rollout; live: the mock gate and the ops grant never do", async () => {
    const off = build("pilot-listed", false);
    expect(await off.svc.isRealCheckoutOpen(COMPANY)).toBe(false);
    expect(off.resolve).not.toHaveBeenCalled();
    expect(off.isListed).not.toHaveBeenCalled();

    const live = build("pilot-listed", true);
    expect(await live.svc.isMockPackPurchaseOpen(COMPANY)).toBe(false);
    await expect(live.svc.grantPackForOps(COMPANY, "pack_50", CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
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
    expect((await svc.getCredits(MEMBER)).checkout).toBe("real");

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
    expect((await svc.getCredits(MEMBER)).checkout).toBe("none");
  });
});
