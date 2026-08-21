import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Request } from "express";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { PayerCapacityController } from "./payer-capacity.controller";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import type { RequestContext } from "../common/request-context";
import type { BuyCapacityDto } from "../posting-plans/posting-plans.dto";

/** A request carrying no `Idempotency-Key` — the unguarded path every legacy case takes. */
const NO_KEY = { header: () => undefined } as unknown as Request;

/** A request carrying one, so a case can exercise the real dedupe. */
const withKey = (key: string): Request =>
  ({
    header: (n: string) => (n.toLowerCase() === "idempotency-key" ? key : undefined),
  }) as unknown as Request;

const PAYER_A: AuthenticatedPayer = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  sid: "sid-a",
  role: "employer",
};
const PAYER_B: AuthenticatedPayer = {
  id: "bbbbbbbb-0000-4000-8000-000000000002",
  sid: "sid-b",
  role: "employer",
};
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};

function makeCtrl() {
  const plans = {
    getCapacity: vi.fn(async () => ({
      payer_id: PAYER_A.id,
      max_active_vacancies: 3,
      active_plan_count: 2,
      source_tier: null,
      expires_at: null,
    })),
    buyCapacity: vi.fn(async () => ({
      payer_id: PAYER_A.id,
      max_active_vacancies: 10,
      source_tier: "growth",
      expires_at: null,
      resumed_plan_ids: [],
    })),
  };
  // #1148 — a PASS-THROUGH double. The cases in this describe send NO Idempotency-Key, which is
  // exactly the path where runOnce must run the work unchanged, so each assertion keeps testing
  // the handler rather than the seam. The seam has its own suite, and the cases that exercise it
  // through this controller use the REAL one (see the #1148 describe below).
  const idempotency = {
    runOnce: vi.fn(async (o: { work: () => Promise<unknown> }) => o.work()),
  };
  const ctrl = new PayerCapacityController(plans as never, idempotency as never);
  return { ctrl, plans, idempotency };
}

/**
 * XB-A at the payer-capacity boundary: both reads and the buy are bound to the SESSION
 * payer (`req.payer.id`). There is no `:payerId` param and the body never supplies a
 * `payer_id` — a payer can never view or buy capacity under another payer's id.
 */
describe("PayerCapacityController — identity from the session, never a param/body (ADR-0019 XB-A)", () => {
  let d: ReturnType<typeof makeCtrl>;
  beforeEach(() => {
    d = makeCtrl();
  });

  it("ownCapacity scopes to the SESSION payer", async () => {
    await d.ctrl.ownCapacity(PAYER_A);
    expect(d.plans.getCapacity).toHaveBeenCalledWith(PAYER_A.id);
  });

  it("ownCapacity surfaces active_plan_count from the service (A3 — derived live count)", async () => {
    const res = await d.ctrl.ownCapacity(PAYER_A);
    expect(res).toMatchObject({
      payer_id: PAYER_A.id,
      max_active_vacancies: 3,
      active_plan_count: 2,
    });
  });

  it("buyCapacity delegates with the SESSION payer.id (the DTO carries no payer_id)", async () => {
    const dto: BuyCapacityDto = { tier: "growth" };
    await d.ctrl.buyCapacity(dto, PAYER_A, NO_KEY, CTX);
    // UNCHANGED across #1148: adding the seam must not shift the service-call contract. This
    // assertion is the XB-A proof, and it still reads exactly as it did before the wire-up.
    expect(d.plans.buyCapacity).toHaveBeenCalledWith(PAYER_A.id, dto, CTX);
  });
});

// ---------------------------------------------------------------------------
// #1148 — POST /payer/capacity honours Idempotency-Key.
//
// WHY A NATURAL KEY CANNOT DO IT, which is the whole decision and is not settled by copying
// #1046. `POST /payer/unlocks` is idempotent by `(payer, worker)` because it writes a
// per-purchase GRANT row; boosts key on `posting_boosts`, the immutable one-row-per-purchase
// receipt. Capacity writes no such artifact — `payer_capacity` is ONE mutable allowance row per
// payer that `upsertCapacity` collapses every buy into, so two identical purchases and one leave
// identical rows. There is nothing for a natural key to be a key OF.
//
// And the one candidate, `(payer, tier)`, blocks a legitimate action: `maxActiveVacancies` is
// monotonic (`greatest`) but `expiresAt` is REPLACED, so re-buying the same tier RENEWS the
// window — and the catalog window is 30 days, making that next month's ordinary renewal.
//
// These cases drive the REAL seam against an in-memory Redis, so the mutex, the replay and the
// in-flight branch are exercised rather than described.
// ---------------------------------------------------------------------------
describe("#1148 — one tap is one capacity purchase", () => {
  /** In-memory Redis covering the commands the seam uses, with NX semantics. */
  function makeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      client: {
        async set(key: string, value: string, _m: string, _s: number, nx?: string) {
          if (nx === "NX") {
            if (store.has(key)) return null;
            store.set(key, value);
            return "OK";
          }
          store.set(key, value);
          return "OK";
        },
        async get(key: string) {
          return store.get(key) ?? null;
        },
      },
    };
  }

  function realSeam() {
    const redis = makeRedis();
    const pii = {
      // A REAL digest. An echoing double would make the "never the raw header" case below pass
      // for the wrong reason, and a length-based fake would collide "k-1" with "k-2" and make
      // the fresh-key case pass for the wrong reason too.
      hmac: (v: string) => createHash("sha256").update(v).digest("hex"),
      hashPhone: (v: string) => "phash_" + v,
      encrypt: (v: string) => "enc(" + v + ")",
      decrypt: (v: string) => v.replace(/^enc\(/, "").replace(/\)$/, ""),
    };
    const queue = { client: Promise.resolve(redis.client) };
    return { seam: new RequestIdempotency(pii as never, queue as never), redis };
  }

  /**
   * A FAITHFUL double. The real `BuyCapacityResult` nests a `quote` (itself carrying a `grants`
   * discriminated union) and a `resumed_plan_ids` array — unlike the credits result, which is
   * flat primitives. The nesting is the point: it gives the replay-fidelity case below something
   * that could actually fail.
   */
  function ctrlWithRealSeam() {
    // Each call returns a DISTINGUISHABLE `expires_at`, mirroring the real service (which
    // recomputes now + validityDays every time). Without this the double returns an equal object
    // on every call, and "second equals first" would hold even with the seam removed — the
    // assertion would pass for the wrong reason. With it, equality can only come from a replay.
    let call = 0;
    const buyCapacity = vi.fn(async (payerId: string, dto: BuyCapacityDto) => {
      if (dto.tier === "no_such_tier") {
        throw new BadRequestException("hiring_capacity/" + dto.tier + " is not available");
      }
      call += 1;
      return {
        payer_id: payerId,
        quote: {
          productCode: "hiring_capacity",
          tierCode: dto.tier,
          kind: "capacity",
          basePriceInr: 5000,
          discountInr: 0,
          finalInr: 5000,
          offerApplied: null,
          couponApplied: null,
          grants: { kind: "capacity", maxActiveVacancies: 5, validityDays: 30 },
        },
        max_active_vacancies: 5,
        source_tier: dto.tier,
        expires_at: "2026-09-2" + call + "T00:00:00.000Z",
        resumed_plan_ids: ["plan-1", "plan-2"],
      };
    });
    const plans = { getCapacity: vi.fn(), buyCapacity };
    const { seam, redis } = realSeam();
    const ctrl = new PayerCapacityController(plans as never, seam);
    return { ctrl, plans, buyCapacity, redis };
  }

  const CAP_5: BuyCapacityDto = { tier: "cap_5" };

  it("THE DOUBLE-BUY: the same key twice purchases ONCE and replays the original result", async () => {
    const { ctrl, buyCapacity } = ctrlWithRealSeam();
    const first = await ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-1"), CTX);
    const second = await ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-1"), CTX);
    expect(buyCapacity).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("REPLAY FIDELITY through JSON: the nested quote and the plan-id array survive intact", async () => {
    // The capacity-ONLY property. The seam stores `JSON.stringify(outcome)` and replays
    // `JSON.parse(...)`. Credits' result is flat primitives so it cannot test this; capacity's
    // nests a `quote` with a `grants` union plus a string array. It round-trips today because
    // Quote is all strings/numbers/null — this pins that, so a `Date` added to Quote later makes
    // a replay differ from a first call HERE rather than in production.
    const { ctrl } = ctrlWithRealSeam();
    const first = await ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-nested"), CTX);
    const second = (await ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-nested"), CTX)) as {
      quote: { grants: unknown };
      resumed_plan_ids: string[];
      expires_at: string;
    };
    expect(second).toStrictEqual(first);
    expect(second.quote.grants).toEqual({
      kind: "capacity",
      maxActiveVacancies: 5,
      validityDays: 30,
    });
    expect(second.resumed_plan_ids).toEqual(["plan-1", "plan-2"]);
    // The teeth: the double stamps a fresh expiry per call, so this equality is only possible if
    // the second response came from the STORE. Remove the seam and it reads ...22T..., not ...21T...
    expect(second.expires_at).toBe("2026-09-21T00:00:00.000Z");
  });

  it("A DUPLICATE LANDING MID-FLIGHT is refused 409, and the purchase never starts twice", async () => {
    // The case the whole bug is made of: the second tap arrives while the first is still running,
    // so there is no stored result to replay yet. Only a reservation taken BEFORE the work stops
    // the second purchase starting.
    const { ctrl, buyCapacity } = ctrlWithRealSeam();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    buyCapacity.mockImplementationOnce(async (payerId: string, dto: BuyCapacityDto) => {
      await gate;
      return {
        payer_id: payerId,
        quote: null,
        max_active_vacancies: 5,
        source_tier: dto.tier,
        expires_at: null,
        resumed_plan_ids: [],
      } as never;
    });

    const inflight = ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-2"), CTX);
    await expect(ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-2"), CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(buyCapacity).toHaveBeenCalledTimes(1);
    release();
    await inflight;
    expect(buyCapacity).toHaveBeenCalledTimes(1);
  });

  it("the 409 carries NO number a client could render as capacity", async () => {
    // Deliberately unlike the OTP path, which may answer a mid-flight duplicate optimistically
    // because "a code is on its way" is honest. A purchase cannot invent an allowance or an
    // expiry it has not computed — a guessed figure would have the app render state that never
    // existed. 4242 is the sentinel precisely because 5 / 10 / 30 could appear incidentally.
    const { ctrl, buyCapacity } = ctrlWithRealSeam();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    buyCapacity.mockImplementationOnce(async () => {
      await gate;
      return { payer_id: PAYER_A.id, max_active_vacancies: 4242, resumed_plan_ids: [] } as never;
    });

    const inflight = ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-3"), CTX);
    const err = await ctrl
      .buyCapacity(CAP_5, PAYER_A, withKey("tap-3"), CTX)
      .catch((e: Error) => e);
    const body = JSON.stringify((err as ConflictException).getResponse());
    expect(body).not.toContain("4242");
    expect(body).not.toMatch(/"max_active_vacancies"|"resumed_plan_ids"|"expires_at"|"quote"/);
    release();
    await inflight;
  });

  it("a SAME-TICK dead heat still purchases once", async () => {
    const { ctrl, buyCapacity } = ctrlWithRealSeam();
    const results = await Promise.allSettled([
      ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-4"), CTX),
      ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-4"), CTX),
    ]);
    expect(buyCapacity).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("a DIFFERENT key buys again — a renewal is legitimate and must not be deduped", async () => {
    // The counterpart to the double-buy case, and the reason a natural key was rejected: the
    // 30-day window means re-buying the SAME tier next month is the ordinary renewal. A guard
    // that made that impossible would be worse than the bug.
    const { ctrl, buyCapacity } = ctrlWithRealSeam();
    await ctrl.buyCapacity(CAP_5, PAYER_A, withKey("month-1"), CTX);
    await ctrl.buyCapacity(CAP_5, PAYER_A, withKey("month-2"), CTX);
    expect(buyCapacity).toHaveBeenCalledTimes(2);
  });

  it("SAME KEY, DIFFERENT TIER replays the first purchase — the key names the intent, not the body", async () => {
    // Pinned as a DECISION rather than inherited by analogy, because capacity has a real upgrade
    // flow (cap_5 -> cap_15). One key means one purchase: a client that reuses a key while
    // changing the tier has a bug, and replaying is the safe answer because the alternative
    // charges them for a tier the first call may already have granted. An upgrade gets its own
    // key, exactly as a renewal does.
    const { ctrl, buyCapacity } = ctrlWithRealSeam();
    const first = await ctrl.buyCapacity(CAP_5, PAYER_A, withKey("tap-5"), CTX);
    const second = (await ctrl.buyCapacity({ tier: "cap_15" }, PAYER_A, withKey("tap-5"), CTX)) as {
      source_tier: string;
    };
    expect(buyCapacity).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.source_tier).toBe("cap_5");
  });

  it("another payer's key does NOT reach this payer's bucket (XB-A)", async () => {
    // Subject scoping is a safety property, not bookkeeping: without the payer in the key, one
    // payer could present another's key and be served their stored purchase result.
    const { ctrl, buyCapacity } = ctrlWithRealSeam();
    await ctrl.buyCapacity(CAP_5, PAYER_A, withKey("shared"), CTX);
    await ctrl.buyCapacity(CAP_5, PAYER_B, withKey("shared"), CTX);
    expect(buyCapacity).toHaveBeenCalledTimes(2);
    expect(buyCapacity.mock.calls[0]![0]).toBe(PAYER_A.id);
    expect(buyCapacity.mock.calls[1]![0]).toBe(PAYER_B.id);
  });

  it("NO key behaves exactly as before — the header is optional (no breaking change)", async () => {
    const { ctrl, buyCapacity, redis } = ctrlWithRealSeam();
    await ctrl.buyCapacity(CAP_5, PAYER_A, NO_KEY, CTX);
    await ctrl.buyCapacity(CAP_5, PAYER_A, NO_KEY, CTX);
    expect(buyCapacity).toHaveBeenCalledTimes(2);
    // ...and nothing was reserved, so an un-keyed caller cannot fill Redis either.
    expect([...redis.store.keys()]).toHaveLength(0);
  });

  it("an UNKNOWN tier replays its 400 rather than re-running the lookup", async () => {
    // Inside the guard: an unknown tier is a property of THIS request. The service raises it, so
    // it is `work` that throws and the outcome is stored. Replay rethrows by status, not class.
    const { ctrl, buyCapacity } = ctrlWithRealSeam();
    const first = await ctrl
      .buyCapacity({ tier: "no_such_tier" }, PAYER_A, withKey("tap-6"), CTX)
      .catch((e: Error) => e);
    expect(first).toBeInstanceOf(BadRequestException);
    const second = await ctrl
      .buyCapacity({ tier: "no_such_tier" }, PAYER_A, withKey("tap-6"), CTX)
      .catch((e: Error) => e);
    expect(second).toMatchObject({ status: 400 });
    expect(buyCapacity).toHaveBeenCalledTimes(1);
  });

  it("the RAW header never appears in a Redis key, and the scope is capacity's own", async () => {
    const { ctrl, redis } = ctrlWithRealSeam();
    const raw = "raw-header-value-1148";
    await ctrl.buyCapacity(CAP_5, PAYER_A, withKey(raw), CTX);
    const keys = [...redis.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(raw);
    // Its OWN dedupe bucket — sharing credits' would serve the wrong purchase to a client that
    // reused one key across both routes.
    expect(keys[0]).toContain("payer_idem:capacity_purchase:");
    expect(keys[0]).not.toContain("credits_purchase");
    expect(keys[0]).toContain(PAYER_A.id);
  });
});
