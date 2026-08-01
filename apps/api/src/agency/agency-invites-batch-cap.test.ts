import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpStatus, type HttpException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { AgencyService } from "./agency.service";
import { AgencyInvitesController } from "./agency-invites.controller";
import { CreateAgencyInviteBatchSchema, CreateAgencyInviteSchema } from "./agency.dto";

/**
 * ADR-0022 Amendment 3, condition C1 — CAP ACCOUNTING for the batch invite mint.
 *
 * `assertWithinHourlyCap` INCRs by exactly 1. If a batch of N consumed 1 unit, the endpoint
 * would be an N× BYPASS of AGENCY_INVITE_MINT_MAX_PER_HOUR (60 → 3000/hour) — strictly worse
 * than the singular mint it sits beside — and it would inflate live-invite-code density in
 * the 48-bit code space by N×, which is what the entropy argument depends on.
 *
 * These tests drive the REAL controller + the REAL rate-limit service against a fake Redis,
 * so they assert the actual counter value, not an intention.
 */

const PAYER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "66666666-6666-4666-8666-666666666666", requestId: "req-1" };
const CAP = 60;

/** The same `ratelimit:<scope>:<payer>:<YYYYMMDDHH>` key the service builds. */
function capKey(payerId = PAYER, scope = "agency_invite_mint"): string {
  const n = new Date();
  const stamp = `${n.getUTCFullYear()}${String(n.getUTCMonth() + 1).padStart(2, "0")}${String(
    n.getUTCDate(),
  ).padStart(2, "0")}${String(n.getUTCHours()).padStart(2, "0")}`;
  return `ratelimit:${scope}:${payerId}:${stamp}`;
}

function setup(opts: { cap?: number; redisDown?: boolean } = {}) {
  const store = new Map<string, number>();

  const incr = vi.fn(async (key: string) => {
    if (opts.redisDown) throw new Error("redis down");
    const n = (store.get(key) ?? 0) + 1;
    store.set(key, n);
    return n;
  });
  const incrby = vi.fn(async (key: string, by: number) => {
    if (opts.redisDown) throw new Error("redis down");
    const n = (store.get(key) ?? 0) + by;
    store.set(key, n);
    return n;
  });
  const expire = vi.fn(async () => 1);

  const queue = { client: Promise.resolve({ incr, incrby, expire }) } as unknown as Queue;
  const config = {
    PAYER_DISCLOSURE_MAX_PER_HOUR: 3,
    AGENCY_INVITE_MINT_MAX_PER_HOUR: opts.cap ?? CAP,
  } as unknown as ServerConfig;

  const rateLimit = new PayerDisclosureRateLimit(config, queue);

  const emit = vi.fn().mockResolvedValue(undefined);
  let created = 0;
  const invitesRepo = {
    create: vi.fn().mockImplementation((input: { code: string; inviterPayerId: string }) => {
      created += 1;
      return Promise.resolve({
        id: `aaaaaaaa-0000-4000-8000-${String(created).padStart(12, "0")}`,
        code: input.code,
        inviterPayerId: input.inviterPayerId,
      });
    }),
  };
  const svc = new AgencyService({} as never, invitesRepo as never, {} as never, { emit } as never);
  const controller = new AgencyInvitesController(svc, rateLimit, config);
  const payer = { id: PAYER, sid: "s", role: "agent" as const };

  const batch = (body: unknown) =>
    controller.createInviteBatch(
      CreateAgencyInviteBatchSchema.parse(body) as never,
      payer as never,
      CTX as never,
    );
  const single = (body: unknown = {}) =>
    controller.createInvite(CreateAgencyInviteSchema.parse(body) as never, payer as never, CTX as never);

  return { batch, single, store, incr, incrby, emit, invitesRepo, rows: () => created };
}

describe("Batch cap accounting — a batch of N consumes N units (C1)", () => {
  it("a batch of 50 leaves the bucket at 50, NOT 1 (no N× bypass)", async () => {
    const t = setup();
    const res = await t.batch({ count: 50 });

    expect(res.invites).toHaveLength(50);
    expect(t.store.get(capKey())).toBe(50);
    expect(t.rows()).toBe(50);
    expect(t.emit).toHaveBeenCalledTimes(50);
  });

  it("the reservation is ONE atomic INCRBY — never a loop of N INCRs", async () => {
    const t = setup();
    await t.batch({ count: 50 });

    expect(t.incrby).toHaveBeenCalledTimes(1);
    expect(t.incrby).toHaveBeenCalledWith(capKey(), 50);
    expect(t.incr).not.toHaveBeenCalled();
  });

  /**
   * ALL-OR-NOTHING: the reservation happens UP FRONT, so a batch that would cross the cap
   * mints ZERO invites and emits ZERO events. (50 of 60 spent → a further 11 must fail.)
   */
  it("a batch that would cross the cap mints ZERO rows and emits ZERO events", async () => {
    const t = setup();
    await t.batch({ count: 50 });
    expect(t.rows()).toBe(50);

    await expect(t.batch({ count: 11 })).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(t.rows()).toBe(50); // unchanged — nothing partially minted
    expect(t.emit).toHaveBeenCalledTimes(50); // unchanged — nothing partially emitted
  });

  it("a batch exactly AT the remaining budget still succeeds (50 + 10 == cap 60)", async () => {
    const t = setup();
    await t.batch({ count: 50 });
    const res = await t.batch({ count: 10 });
    expect(res.invites).toHaveLength(10);
    expect(t.store.get(capKey())).toBe(60);
  });

  /**
   * A REJECTED batch does NOT refund its reservation. Fail-closed is the safe direction
   * (over-count rather than under-count), and it denies a cap-probing binary search: an
   * attacker cannot free-roll rejected requests to locate the exact remaining budget.
   */
  it("a rejected batch KEEPS its reservation (no refund → no cap-probing oracle)", async () => {
    const t = setup();
    await t.batch({ count: 50 });
    await expect(t.batch({ count: 11 })).rejects.toMatchObject({ status: 429 });
    expect(t.store.get(capKey())).toBe(61); // consumed, not rolled back
    await expect(t.batch({ count: 1 })).rejects.toMatchObject({ status: 429 });
  });

  /**
   * The two paths MUST share one budget — otherwise an attacker just alternates between
   * them. 55 via batch + 5 via singular == the cap; the 61st unit is refused either way.
   */
  it("batch and singular mints share ONE bucket (alternating between them buys nothing)", async () => {
    const t = setup();
    await t.batch({ count: 50 });
    for (let i = 0; i < 10; i += 1) await t.single();
    expect(t.store.get(capKey())).toBe(60);

    await expect(t.single()).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    await expect(t.batch({ count: 1 })).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });
});

describe("Singular mint cap consumption is UNCHANGED by the batch edit", () => {
  it("still uses a plain INCR of exactly 1 (never INCRBY)", async () => {
    const t = setup();
    await t.single();
    expect(t.incr).toHaveBeenCalledTimes(1);
    expect(t.incr).toHaveBeenCalledWith(capKey());
    expect(t.incrby).not.toHaveBeenCalled();
    expect(t.store.get(capKey())).toBe(1);
  });

  it("still rejects with 429 on the (cap + 1)-th single mint", async () => {
    const t = setup({ cap: 3 });
    await t.single();
    await t.single();
    await t.single();
    await expect(t.single()).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(t.rows()).toBe(3);
  });
});

describe("Redis fail-closed applies to the WHOLE batch (C6)", () => {
  it("a Redis outage rejects the entire batch: 429, ZERO rows, ZERO events", async () => {
    const t = setup({ redisDown: true });
    await expect(t.batch({ count: 50 })).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(t.rows()).toBe(0);
    expect(t.emit).not.toHaveBeenCalled();
  });

  /**
   * Cap-reached and Redis-down must be INDISTINGUISHABLE to the caller — distinguishing them
   * would hand an abuser a probe for infrastructure state. (They previously differed:
   * "This is temporarily unavailable…" vs "Too many requests…". Unified in this change.)
   */
  it("the Redis-down 429 body is byte-identical to the cap-reached 429 body", async () => {
    const down = setup({ redisDown: true });
    const downErr = (await down.batch({ count: 5 }).catch((e: Error) => e)) as HttpException;

    const capped = setup({ cap: 1 });
    await capped.single();
    const capErr = (await capped.batch({ count: 5 }).catch((e: Error) => e)) as HttpException;

    expect(downErr.getStatus()).toBe(capErr.getStatus());
    expect(JSON.stringify(downErr.getResponse())).toBe(JSON.stringify(capErr.getResponse()));
    expect(JSON.stringify(downErr.message)).toBe(JSON.stringify(capErr.message));
    expect(downErr.message).not.toMatch(/redis|cap|quota|remaining|unavailable/i);
  });

  it("the SINGULAR mint's two 429 causes are indistinguishable too (same shared service)", async () => {
    const down = setup({ redisDown: true });
    const downErr = (await down.single().catch((e: Error) => e)) as HttpException;

    const capped = setup({ cap: 1 });
    await capped.single();
    const capErr = (await capped.single().catch((e: Error) => e)) as HttpException;

    expect(JSON.stringify(downErr.getResponse())).toBe(JSON.stringify(capErr.getResponse()));
  });

  it("there is NO state in which a Redis failure leaves a PARTIALLY consumed batch", async () => {
    const t = setup({ redisDown: true });
    await expect(t.batch({ count: 50 })).rejects.toMatchObject({ status: 429 });
    // The single atomic reservation either happened or it did not — never 27 of 50.
    expect(t.store.size).toBe(0);
    expect(t.incrby).toHaveBeenCalledTimes(1);
  });
});

describe("PayerDisclosureRateLimit.amount — defensive input handling", () => {
  it("fails CLOSED (429) on a non-positive/non-integer amount rather than uncapping", async () => {
    const queue = {
      client: Promise.resolve({
        incr: vi.fn(async () => 1),
        incrby: vi.fn(async () => 1),
        expire: vi.fn(async () => 1),
      }),
    } as unknown as Queue;
    const svc = new PayerDisclosureRateLimit(
      { PAYER_DISCLOSURE_MAX_PER_HOUR: 3 } as unknown as ServerConfig,
      queue,
    );
    for (const amount of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(svc.assertWithinHourlyCap(PAYER, { amount })).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    }
  });
});
