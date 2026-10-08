import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { AgencyKycStatus } from "@badabhai/db";
import { AgencyPayoutService } from "./agency-payout.service";
import {
  AgencyPayoutRepository,
  PayoutBelowThresholdError,
  type AgencyEarningsAgg,
  type QualifyingUnlock,
} from "./agency-payout.repository";
import { AgencyKycService } from "./agency-kyc.service";
import { EventsService } from "../events/events.service";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import {
  defaultModeResolver,
  ownTenantKey,
  resolverOver,
} from "../payers/payer-tenant-scope.test-support";

const AGENCY = "11111111-1111-4111-8111-111111111111";
const UNLOCK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNLOCK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

const CONFIG = {
  AGENCY_PAYOUTS_ENABLED: true,
  AGENCY_PAYOUT_UNLOCK_BASIS_INR: 40,
  AGENCY_PAYOUT_RATE_BPS: 2500,
  AGENCY_PAYOUT_WINDOW_DAYS: 90,
  AGENCY_PAYOUT_MIN_THRESHOLD_INR: 500,
} as unknown as ServerConfig;

const ZERO_AGG: AgencyEarningsAgg = {
  totalAccruedInr: 0,
  requestableInr: 0,
  inRequestInr: 0,
  paidInr: 0,
  accrualCount: 0,
};

function qualifying(unlockId: string): QualifyingUnlock {
  return {
    unlockId,
    grantedAt: new Date("2026-05-01T00:00:00Z"),
    attributedAt: new Date("2026-04-01T00:00:00Z"),
  };
}

function make(opts?: {
  config?: Partial<ServerConfig>;
  kycStatus?: AgencyKycStatus | null;
  qualifying?: QualifyingUnlock[];
  inserted?: QualifyingUnlock[]; // which of the qualifying were NEW (idempotency)
  agg?: Partial<AgencyEarningsAgg>;
  claimThrows?: Error;
  /** ADR-0053 — the REAL resolver; the default mode (`off`) unless a suite passes `on`. */
  tenancy?: PayerTenantScopeService;
}) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const events = { emit } as unknown as EventsService;

  const repo = {
    // #1129 item 3 — the service now runs both mutating paths through `withTransaction`.
    // A plain passthrough (no real staged/committed world) is enough for these
    // business-logic tests; `agency-payout.atomicity.test.ts` proves the commit/rollback
    // guarantee itself with a staged-world harness.
    withTransaction: vi.fn(async (cb: (tx: undefined) => Promise<unknown>) => cb(undefined)),
    findQualifyingUnlocks: vi.fn().mockResolvedValue(opts?.qualifying ?? []),
    insertAccruals: vi
      .fn()
      .mockImplementation(
        async (
          rows: Array<{
            sourceUnlockId: string;
            amountInr: number;
            basisInr: number;
            rateBps: number;
          }>,
        ) => {
          // Echo back only the rows whose unlock is in `inserted` (simulates ON CONFLICT DO NOTHING).
          const newIds = new Set((opts?.inserted ?? opts?.qualifying ?? []).map((q) => q.unlockId));
          return rows.filter((r) => newIds.has(r.sourceUnlockId));
        },
      ),
    aggregate: vi.fn().mockResolvedValue({ ...ZERO_AGG, ...(opts?.agg ?? {}) }),
    listRequests: vi.fn().mockResolvedValue([]),
    createRequestClaiming: opts?.claimThrows
      ? vi.fn().mockRejectedValue(opts.claimThrows)
      : vi
          .fn()
          .mockResolvedValue({
            id: REQUEST_ID,
            agencyPayerId: AGENCY,
            amountInr: opts?.agg?.requestableInr ?? 0,
            accrualCount: 1,
            status: "requested",
          }),
  } as unknown as AgencyPayoutRepository;

  const kyc = {
    statusForGate: vi.fn().mockResolvedValue(opts?.kycStatus ?? null),
  } as unknown as AgencyKycService;

  const svc = new AgencyPayoutService(
    repo,
    kyc,
    events,
    { ...CONFIG, ...(opts?.config ?? {}) } as ServerConfig,
    opts?.tenancy ?? defaultModeResolver(),
  );
  return { svc, repo, kyc, emit };
}

function emittedNames(emit: ReturnType<typeof vi.fn>): string[] {
  return emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
}

describe("AgencyPayoutService — accrual math (25% × ₹40 per granted unlock)", () => {
  it("accrues ₹10 per qualifying unlock and emits agency_payout.accrued for each NEW accrual", async () => {
    const { svc, repo, emit } = make({ qualifying: [qualifying(UNLOCK_A), qualifying(UNLOCK_B)] });
    const n = await svc.recomputeAccruals(await ownTenantKey(AGENCY));

    expect(n).toBe(2);
    const rows = ((repo.insertAccruals as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ??
      []) as Array<{
      agencyPayerId: string;
      basisInr: number;
      rateBps: number;
      amountInr: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      agencyPayerId: AGENCY,
      basisInr: 40,
      rateBps: 2500,
      amountInr: 10,
    });
    expect(emittedNames(emit)).toEqual(["agency_payout.accrued", "agency_payout.accrued"]);
  });

  it("is IDEMPOTENT — an already-accrued unlock (ON CONFLICT DO NOTHING) fires no second event", async () => {
    const { svc, emit } = make({
      qualifying: [qualifying(UNLOCK_A), qualifying(UNLOCK_B)],
      inserted: [qualifying(UNLOCK_A)], // only A is new this run
    });
    const n = await svc.recomputeAccruals(await ownTenantKey(AGENCY));
    expect(n).toBe(1);
    expect(emittedNames(emit)).toEqual(["agency_payout.accrued"]);
  });

  it("passes the CONFIGURED window to the repo (90d) — the accrual source is real unlock data", async () => {
    const { svc, repo } = make({});
    await svc.recomputeAccruals(await ownTenantKey(AGENCY));
    expect(repo.findQualifyingUnlocks).toHaveBeenCalledWith(AGENCY, 90);
  });
});

describe("AgencyPayoutService — the KYC GATE is provably unreachable-to-request without a verified row", () => {
  for (const status of [null, "pending", "rejected"] as const) {
    it(`BLOCKS a payout request when KYC is ${status ?? "absent"} (no claim, blocked event, no state change)`, async () => {
      const { svc, repo, emit } = make({ kycStatus: status, agg: { requestableInr: 5000 } });
      const out = await svc.requestPayout(AGENCY);

      expect(out).toEqual({ ok: false, blocked: true, reason: "kyc_not_verified" });
      expect(repo.createRequestClaiming).not.toHaveBeenCalled();
      const blocked = emit.mock.calls.find(
        (c) => (c[0] as { event_name: string }).event_name === "agency_payout.blocked",
      );
      expect((blocked?.[0] as { payload: { reason: string } }).payload.reason).toBe(
        "kyc_not_verified",
      );
    });
  }
});

describe("AgencyPayoutService — the ₹500 threshold gate", () => {
  it("BLOCKS below threshold even with verified KYC (no claim)", async () => {
    const { svc, repo, emit } = make({ kycStatus: "verified", agg: { requestableInr: 490 } });
    const out = await svc.requestPayout(AGENCY);
    expect(out).toEqual({ ok: false, blocked: true, reason: "below_threshold" });
    expect(repo.createRequestClaiming).not.toHaveBeenCalled();
    expect(emittedNames(emit)).toContain("agency_payout.blocked");
  });

  it("ALLOWS at/above threshold with verified KYC — claims the accruals + emits requested", async () => {
    const { svc, repo, emit } = make({ kycStatus: "verified", agg: { requestableInr: 500 } });
    const out = await svc.requestPayout(AGENCY);

    expect(out).toEqual({ ok: true, requestId: REQUEST_ID, amountInr: 500, accrualCount: 1 });
    // #1129 item 3 — the second arg is the transaction executor `withTransaction` handed the
    // callback (undefined in this passthrough mock; the real Database in production/atomicity
    // coverage), which is what makes the claim + its emit commit together.
    expect(repo.createRequestClaiming).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: AGENCY, kycStatus: "verified", thresholdInr: 500 }),
      undefined,
    );
    expect(emittedNames(emit)).toContain("agency_payout.requested");
  });

  it("treats a lost claim RACE (repo throws PayoutBelowThresholdError) as below_threshold", async () => {
    const { svc, emit } = make({
      kycStatus: "verified",
      agg: { requestableInr: 500 },
      claimThrows: new PayoutBelowThresholdError(0),
    });
    const out = await svc.requestPayout(AGENCY);
    expect(out).toEqual({ ok: false, blocked: true, reason: "below_threshold" });
    expect(emittedNames(emit)).toContain("agency_payout.blocked");
  });
});

describe("AgencyPayoutService — the launch flag", () => {
  it("when AGENCY_PAYOUTS_ENABLED is OFF, a request is blocked 'disabled' and nothing is claimed", async () => {
    const { svc, repo } = make({
      config: { AGENCY_PAYOUTS_ENABLED: false } as Partial<ServerConfig>,
      kycStatus: "verified",
      agg: { requestableInr: 5000 },
    });
    const out = await svc.requestPayout(AGENCY);
    expect(out).toEqual({ ok: false, blocked: true, reason: "disabled" });
    expect(repo.createRequestClaiming).not.toHaveBeenCalled();
    expect(repo.findQualifyingUnlocks).not.toHaveBeenCalled();
  });
});

describe("AgencyPayoutService — earnings analytics off real accrual data", () => {
  it("reports canRequest=true when verified + above threshold + flag ON", async () => {
    const { svc } = make({
      kycStatus: "verified",
      agg: { totalAccruedInr: 1000, requestableInr: 600, accrualCount: 60 },
    });
    const view = await svc.getEarnings(AGENCY);
    expect(view).toMatchObject({
      totalAccruedInr: 1000,
      requestableInr: 600,
      kycStatus: "verified",
      thresholdInr: 500,
      canRequest: true,
      blockedReason: null,
    });
  });

  it("surfaces the blocking reason CODE (below_threshold) without allowing a request", async () => {
    const { svc } = make({ kycStatus: "verified", agg: { requestableInr: 400 } });
    const view = await svc.getEarnings(AGENCY);
    expect(view.canRequest).toBe(false);
    expect(view.blockedReason).toBe("below_threshold");
  });

  it("surfaces kyc_not_verified when KYC is not verified", async () => {
    const { svc } = make({ kycStatus: "pending", agg: { requestableInr: 5000 } });
    const view = await svc.getEarnings(AGENCY);
    expect(view.canRequest).toBe(false);
    expect(view.blockedReason).toBe("kyc_not_verified");
    expect(view.kycStatus).toBe("pending");
  });
});

/**
 * ADR-0053 (PAY-DB-01 P2d, owner ruling O-5) — earnings and payouts are ORG-level: each entry
 * point resolves the session payer's tenancy ONCE and keys the accruals, the requests and the KYC
 * gate read by the TENANT key; the acting login is the actor of `.blocked` / `.requested`. Who may
 * reach them is the ROUTE's decision (owner only — agency-payouts-owner-only.test.ts).
 */
describe("AgencyPayoutService — the tenant key keys the org's money (ADR-0053 P2d)", () => {
  const ANCHOR = AGENCY;
  const MEMBER = "77777777-7777-4777-8777-777777777777";
  const OUTSIDER = "88888888-8888-4888-8888-888888888888";
  const TEAM = [{ anchor: ANCHOR, members: [MEMBER] }];
  const ON = { PAYER_ORG_TENANCY_MODE: "on" } as unknown as ServerConfig;

  type Emitted = {
    event_name: string;
    actor: { actor_id: string | null };
    subject: { subject_id: string };
    payload: Record<string, unknown>;
  };
  const emitted = (emit: ReturnType<typeof vi.fn>) => emit.mock.calls.map((c) => c[0] as Emitted);

  /** Every repo + KYC-gate read the three entry points make, with the key each was given. */
  function keysRead(d: ReturnType<typeof make>): unknown[] {
    return [
      ...(d.repo.findQualifyingUnlocks as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
      ...(d.repo.aggregate as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
      ...(d.repo.listRequests as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
      ...(d.kyc.statusForGate as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    ];
  }

  async function everyEntryPoint(d: ReturnType<typeof make>, actor: string) {
    await d.svc.getEarnings(actor);
    const out = await d.svc.requestPayout(actor);
    await d.svc.listRequests(actor);
    return out;
  }

  it("off: byte-identical — a team member is their own tenant on every read, write and event", async () => {
    const d = make({
      tenancy: defaultModeResolver(TEAM),
      kycStatus: "verified",
      qualifying: [qualifying(UNLOCK_A)],
      agg: { requestableInr: 500 },
    });
    expect(await everyEntryPoint(d, MEMBER)).toMatchObject({ ok: true });
    const keys = keysRead(d);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set([MEMBER]));
    const rows = (d.repo.insertAccruals as ReturnType<typeof vi.fn>).mock.calls.flatMap(
      (c) => c[0] as { agencyPayerId: string }[],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.agencyPayerId))).toEqual(new Set([MEMBER]));
    expect(d.repo.createRequestClaiming).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: MEMBER }),
      undefined,
    );
    const requested = emitted(d.emit).find((e) => e.event_name === "agency_payout.requested");
    expect(requested).toMatchObject({
      actor: { actor_id: MEMBER },
      payload: { agency_payer_id: MEMBER },
    });
    const accrued = emitted(d.emit).find((e) => e.event_name === "agency_payout.accrued");
    expect(accrued?.payload.agency_payer_id).toBe(MEMBER);
  });

  it("on: the org's money — every read and stamp is the ANCHOR's key; the login is the actor", async () => {
    const d = make({
      tenancy: resolverOver(ON, TEAM),
      kycStatus: "verified",
      qualifying: [qualifying(UNLOCK_A)],
      agg: { requestableInr: 500 },
    });
    expect(await everyEntryPoint(d, MEMBER)).toMatchObject({ ok: true });
    expect(new Set(keysRead(d))).toEqual(new Set([ANCHOR]));
    const rows = (d.repo.insertAccruals as ReturnType<typeof vi.fn>).mock.calls.flatMap(
      (c) => c[0] as { agencyPayerId: string }[],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.agencyPayerId))).toEqual(new Set([ANCHOR]));
    expect(d.repo.createRequestClaiming).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: ANCHOR }),
      undefined,
    );
    const requested = emitted(d.emit).find((e) => e.event_name === "agency_payout.requested");
    expect(requested).toMatchObject({
      actor: { actor_id: MEMBER },
      payload: { agency_payer_id: ANCHOR },
    });
    // The accrual is a system fact owned by the org.
    const accrued = emitted(d.emit).find((e) => e.event_name === "agency_payout.accrued");
    expect(accrued).toMatchObject({
      actor: { actor_id: null },
      payload: { agency_payer_id: ANCHOR },
    });
  });

  it("on: a blocked request names the login as actor and the ORG as agency_payer_id and subject", async () => {
    const d = make({ tenancy: resolverOver(ON, TEAM), kycStatus: "pending" });
    expect(await d.svc.requestPayout(MEMBER)).toMatchObject({ reason: "kyc_not_verified" });
    const blocked = emitted(d.emit).find((e) => e.event_name === "agency_payout.blocked");
    expect(blocked).toMatchObject({
      actor: { actor_id: MEMBER },
      subject: { subject_id: ANCHOR },
      payload: { agency_payer_id: ANCHOR, reason: "kyc_not_verified" },
    });
  });

  it("on: an outsider's reads are keyed to the outsider alone, never the team's org", async () => {
    const d = make({ tenancy: resolverOver(ON, TEAM) });
    await everyEntryPoint(d, OUTSIDER);
    expect(new Set(keysRead(d))).toEqual(new Set([OUTSIDER]));
  });

  it("on: a refused resolution is a 403 before any read, claim or event — on all three entry points", async () => {
    const twoTeams = [TEAM[0]!, { anchor: OUTSIDER, members: [MEMBER] }];
    const d = make({
      tenancy: resolverOver(ON, twoTeams),
      kycStatus: "verified",
      agg: { requestableInr: 500 },
    });
    await expect(d.svc.getEarnings(MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(d.svc.requestPayout(MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(d.svc.listRequests(MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(keysRead(d)).toEqual([]);
    expect(d.repo.createRequestClaiming).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });
});
