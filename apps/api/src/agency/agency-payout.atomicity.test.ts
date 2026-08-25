import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { AgencyKycStatus } from "@badabhai/db";
import { AgencyPayoutService } from "./agency-payout.service";
import type { AgencyPayoutRepository, QualifyingUnlock } from "./agency-payout.repository";
import { PayoutBelowThresholdError } from "./agency-payout.repository";
import type { AgencyKycService } from "./agency-kyc.service";
import type { EventsService } from "../events/events.service";

/**
 * ATOMICITY (#1129 item 3) — proves the ledger write (`insertAccruals` / `createRequestClaiming`)
 * and the event it produces (`agency_payout.accrued` / `agency_payout.requested`) commit inside
 * ONE transaction: an emit that throws AFTER the ledger write leaves the COMMITTED world
 * unchanged (rolled back), and a retry re-does both and emits exactly once.
 *
 * Before this fix both service methods called the repository write, let it commit, THEN emitted
 * — outside any transaction. A crash (or a validation throw inside `emit`) between the two left a
 * committed ledger row with no event, permanently: `insertAccruals` is `ON CONFLICT DO NOTHING`
 * on `source_unlock_id`, so a retry would silently skip the very row whose event never landed.
 * On a path about to carry real money that gap is not acceptable — this suite is the mutation
 * evidence that it is now closed.
 *
 * Mirrors `admin-actions.atomicity.test.ts`'s STAGING-WORLD technique: `withTransaction` copies
 * the world, hands the copy to the callback as `tx`, and only folds it back into the canonical
 * world if the callback resolves — discarding it (rollback) if the callback throws. The repo's
 * write methods and the (mocked) `EventsService.emit` mutate ONLY the `tx` they are given, exactly
 * as the real Drizzle tx + the H3 transaction-aware `emit` do.
 */

const AGENCY = "11111111-1111-4111-8111-111111111111";
const UNLOCK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNLOCK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

const CONFIG = {
  AGENCY_PAYOUTS_ENABLED: true,
  AGENCY_PAYOUT_UNLOCK_BASIS_INR: 40,
  AGENCY_PAYOUT_RATE_BPS: 2500, // -> floor(40 * 2500 / 10000) = 10 per accrual
  AGENCY_PAYOUT_WINDOW_DAYS: 90,
  AGENCY_PAYOUT_MIN_THRESHOLD_INR: 20,
} as unknown as ServerConfig;

function qualifying(unlockId: string): QualifyingUnlock {
  return {
    unlockId,
    grantedAt: new Date("2026-05-01T00:00:00Z"),
    attributedAt: new Date("2026-04-01T00:00:00Z"),
  };
}

interface AccrualRow {
  sourceUnlockId: string;
  amountInr: number;
  basisInr: number;
  rateBps: number;
  payoutRequestId: string | null;
}
interface RequestRow {
  id: string;
  amountInr: number;
  accrualCount: number;
  status: string;
}
interface World {
  accruals: AccrualRow[];
  requests: RequestRow[];
  events: { event_name: string; idempotencyKey?: string }[];
}

/**
 * Build a service whose `AgencyPayoutRepository.withTransaction` is a real commit/rollback
 * simulator and whose write methods + `events.emit` mutate the STAGED world via the `tx` token.
 * `failEmitOnce` makes the FIRST emit throw AFTER the staged write, so a test can prove the
 * staged write is discarded (the committed world stays untouched).
 */
function makeHarness(
  opts: { failEmitOnce?: boolean; kycStatus?: AgencyKycStatus | null; thresholdInr?: number } = {},
) {
  const world: World = { accruals: [], requests: [], events: [] };
  let armed = opts.failEmitOnce ?? false;

  const withTransaction = async <T>(cb: (tx: World) => Promise<T>): Promise<T> => {
    const staged: World = structuredClone(world);
    const result = await cb(staged); // may throw → staged is discarded (rollback)
    world.accruals = staged.accruals;
    world.requests = staged.requests;
    world.events = staged.events;
    return result;
  };

  const repo = {
    withTransaction,
    findQualifyingUnlocks: async () => [qualifying(UNLOCK_A), qualifying(UNLOCK_B)],
    // ON CONFLICT (source_unlock_id) DO NOTHING, simulated against the STAGED world.
    insertAccruals: async (
      rows: Array<{ sourceUnlockId: string; amountInr: number; basisInr: number; rateBps: number }>,
      tx: World | undefined,
    ) => {
      const w = tx!;
      const inserted: AccrualRow[] = [];
      for (const r of rows) {
        if (w.accruals.some((a) => a.sourceUnlockId === r.sourceUnlockId)) continue;
        const row: AccrualRow = { ...r, payoutRequestId: null };
        w.accruals.push(row);
        inserted.push(row);
      }
      return inserted;
    },
    aggregate: async () => {
      const requestable = world.accruals
        .filter((a) => a.payoutRequestId === null)
        .reduce((s, a) => s + a.amountInr, 0);
      return {
        totalAccruedInr: world.accruals.reduce((s, a) => s + a.amountInr, 0),
        requestableInr: requestable,
        inRequestInr: 0,
        paidInr: 0,
        accrualCount: world.accruals.length,
      };
    },
    listRequests: async () => [],
    // Claims every unclaimed accrual on the STAGED world into a new request row.
    createRequestClaiming: async (
      input: { agencyId: string; thresholdInr: number },
      tx: World | undefined,
    ) => {
      const w = tx!;
      const request: RequestRow = {
        id: REQUEST_ID,
        amountInr: 0,
        accrualCount: 0,
        status: "requested",
      };
      w.requests.push(request);
      const claimable = w.accruals.filter((a) => a.payoutRequestId === null);
      for (const a of claimable) a.payoutRequestId = request.id;
      const amountInr = claimable.reduce((s, a) => s + a.amountInr, 0);
      if (claimable.length === 0 || amountInr < input.thresholdInr) {
        throw new PayoutBelowThresholdError(amountInr);
      }
      request.amountInr = amountInr;
      request.accrualCount = claimable.length;
      return request;
    },
  } as unknown as AgencyPayoutRepository;

  const kyc = {
    statusForGate: async () => opts.kycStatus ?? "verified",
  } as unknown as AgencyKycService;

  const events = {
    emit: async (params: { event_name: string; idempotencyKey?: string; tx?: World }) => {
      if (armed) {
        armed = false; // fail once, then succeed on retry
        throw new Error("simulated emit failure");
      }
      // `blocked()` (agency_payout.blocked) is OUT of item 3's scope — no ledger row to pair
      // it with — and emits with no `tx`. It writes straight to the canonical world, exactly
      // as the real standalone `EventsService.emit` (no tx) inserts immediately.
      const w = params.tx ?? world;
      w.events.push({ event_name: params.event_name, idempotencyKey: params.idempotencyKey });
      return undefined;
    },
  } as unknown as EventsService;

  const config: ServerConfig =
    opts.thresholdInr === undefined
      ? CONFIG
      : ({
          ...CONFIG,
          AGENCY_PAYOUT_MIN_THRESHOLD_INR: opts.thresholdInr,
        } as unknown as ServerConfig);
  const service = new AgencyPayoutService(repo, kyc, events, config);
  return { service, world };
}

describe("AgencyPayoutService.recomputeAccruals atomicity (#1129 item 3) — insert + emits commit together or roll back", () => {
  it("an emit that throws AFTER insertAccruals rolls back the WHOLE batch (no accrual rows, no events committed)", async () => {
    const h = makeHarness({ failEmitOnce: true });

    await expect(h.service.recomputeAccruals(AGENCY)).rejects.toThrow(/emit failure/);

    // ROLLBACK: neither accrual survived, even though the first one's INSERT ran inside the
    // staged tx before the emit threw — this is exactly the gap #1129 item 3 closes.
    expect(h.world.accruals).toHaveLength(0);
    expect(h.world.events).toHaveLength(0);
  });

  it("a retry after an emit failure re-inserts BOTH accruals and emits exactly one event each", async () => {
    const h = makeHarness({ failEmitOnce: true });

    await expect(h.service.recomputeAccruals(AGENCY)).rejects.toThrow();
    // Retry (emit no longer armed to fail): the whole batch commits together.
    const n = await h.service.recomputeAccruals(AGENCY);

    expect(n).toBe(2);
    expect(h.world.accruals.map((a) => a.sourceUnlockId).sort()).toEqual(
      [UNLOCK_A, UNLOCK_B].sort(),
    );
    expect(h.world.events.filter((e) => e.event_name === "agency_payout.accrued")).toHaveLength(2);
  });

  it("a successful recompute commits the accrual rows AND their events together (one transaction)", async () => {
    const h = makeHarness({ failEmitOnce: false });
    const n = await h.service.recomputeAccruals(AGENCY);
    expect(n).toBe(2);
    expect(h.world.accruals).toHaveLength(2);
    expect(h.world.events.filter((e) => e.event_name === "agency_payout.accrued")).toHaveLength(2);
  });
});

describe("AgencyPayoutService.requestPayout atomicity (#1129 item 3) — the claim + its emit commit together or roll back", () => {
  it("an emit that throws AFTER createRequestClaiming rolls back the CLAIM (accruals stay unclaimed, no request row, no event)", async () => {
    // Arm the emit inside `requestPayout` (the recompute leg finds nothing new to insert, so
    // this is the `agency_payout.requested` emit) to fail AFTER the claim UPDATE has run.
    const h = makeHarness({ failEmitOnce: true });
    h.world.accruals.push(
      {
        sourceUnlockId: UNLOCK_A,
        amountInr: 10,
        basisInr: 40,
        rateBps: 2500,
        payoutRequestId: null,
      },
      {
        sourceUnlockId: UNLOCK_B,
        amountInr: 10,
        basisInr: 40,
        rateBps: 2500,
        payoutRequestId: null,
      },
    );

    await expect(h.service.requestPayout(AGENCY)).rejects.toThrow(/emit failure/);

    // ROLLBACK: the request row never survives, and — the property that matters most — the
    // accruals the claim UPDATE touched inside the staged tx are back to UNCLAIMED, not stuck
    // half-claimed with no request to point to and no audit trail of the attempt.
    expect(h.world.requests).toHaveLength(0);
    expect(h.world.events.filter((e) => e.event_name === "agency_payout.requested")).toHaveLength(
      0,
    );
    expect(h.world.accruals.every((a) => a.payoutRequestId === null)).toBe(true);
  });

  it("a retry after an emit failure re-claims the SAME accruals and emits exactly one requested event", async () => {
    const h = makeHarness({ failEmitOnce: true });
    h.world.accruals.push(
      {
        sourceUnlockId: UNLOCK_A,
        amountInr: 10,
        basisInr: 40,
        rateBps: 2500,
        payoutRequestId: null,
      },
      {
        sourceUnlockId: UNLOCK_B,
        amountInr: 10,
        basisInr: 40,
        rateBps: 2500,
        payoutRequestId: null,
      },
    );

    await expect(h.service.requestPayout(AGENCY)).rejects.toThrow();
    expect(h.world.requests).toHaveLength(0); // first attempt fully rolled back

    const out = await h.service.requestPayout(AGENCY);
    expect(out).toEqual({ ok: true, requestId: REQUEST_ID, amountInr: 20, accrualCount: 2 });
    expect(h.world.requests).toHaveLength(1);
    expect(h.world.events.filter((e) => e.event_name === "agency_payout.requested")).toHaveLength(
      1,
    );
    expect(h.world.accruals.every((a) => a.payoutRequestId === REQUEST_ID)).toBe(true);
  });

  it("a successful request commits the claim AND the event together (one transaction)", async () => {
    const h = makeHarness({ failEmitOnce: false });
    h.world.accruals.push(
      {
        sourceUnlockId: UNLOCK_A,
        amountInr: 10,
        basisInr: 40,
        rateBps: 2500,
        payoutRequestId: null,
      },
      {
        sourceUnlockId: UNLOCK_B,
        amountInr: 10,
        basisInr: 40,
        rateBps: 2500,
        payoutRequestId: null,
      },
    );
    const out = await h.service.requestPayout(AGENCY);
    expect(out).toEqual({ ok: true, requestId: REQUEST_ID, amountInr: 20, accrualCount: 2 });
    expect(h.world.requests).toHaveLength(1);
    expect(h.world.events.filter((e) => e.event_name === "agency_payout.requested")).toHaveLength(
      1,
    );
  });

  it("staying below threshold never opens a claim transaction at all — unchanged by this fix", async () => {
    // Threshold raised to ₹30 so that even after `recomputeAccruals` (which the harness's
    // `findQualifyingUnlocks` always reports BOTH unlocks for) auto-accrues the still-missing
    // UNLOCK_B, the ₹20 combined total stays genuinely below threshold. GATE 2 in the service
    // blocks BEFORE `withTransaction`/`createRequestClaiming` is ever called — the atomicity
    // refactor must not have changed that pre-check.
    const h = makeHarness({ failEmitOnce: false, thresholdInr: 30 });
    const out = await h.service.requestPayout(AGENCY);
    expect(out).toEqual({ ok: false, blocked: true, reason: "below_threshold" });
    expect(h.world.requests).toHaveLength(0);
    expect(h.world.accruals.every((a) => a.payoutRequestId === null)).toBe(true);
  });
});
