import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { HttpException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ServerConfig } from "@badabhai/config";
import type { AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerOrgRoleGuard } from "../payers/payer-org-role.guard";
import { PayerRoleGuard } from "../payers/payer-role.guard";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type { ActiveMembershipFacts } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { EventsService } from "../events/events.service";
import type { PayersRepository } from "../payers/payers.repository";
import { AgencyKycService } from "./agency-kyc.service";
import type { AgencyKycRepository } from "./agency-kyc.repository";
import { AgencyPayoutService } from "./agency-payout.service";
import type { AgencyPayoutRepository } from "./agency-payout.repository";
import { AgencyPayoutsController } from "./agency-payouts.controller";
import { AgencyPayoutsEnabledGuard } from "./agency-payouts-enabled.guard";

/**
 * ADR-0053 owner ruling O-5 — the owner gate and the tenant key must come from ONE resolution.
 *
 * Review finding F1 / M1 of PR #2175: the guard decided "owner?" on one membership read and the
 * service keyed the rows on a SECOND read. An invitee who accepted a team invite between the two
 * was admitted as the owner of their solo org and then keyed to the team's anchor — able to
 * overwrite the team's KYC (PAN / bank) or claim the team's accruals.
 *
 * This drives a whole request the way Nest does: the controller's own guard chain, then the
 * handler with every argument built from its route metadata (custom param decorators run their
 * real factories). The resolver is the REAL one over a membership read that changes between the
 * first and the second call. Mode `on`, payouts flag on.
 */

const SOLO = "11111111-1111-4111-8111-111111111111"; // the invitee: owns a solo org
const ANCHOR = "22222222-2222-4222-8222-222222222222"; // the team they join mid-request
const OTHER = "33333333-3333-4333-8333-333333333333"; // a second team (R3 case)

const CONFIG = {
  PAYER_ORG_TENANCY_MODE: "on",
  AGENCY_PAYOUTS_ENABLED: true,
  AGENCY_PAYOUT_UNLOCK_BASIS_INR: 40,
  AGENCY_PAYOUT_RATE_BPS: 2500,
  AGENCY_PAYOUT_WINDOW_DAYS: 90,
  AGENCY_PAYOUT_MIN_THRESHOLD_INR: 10,
} as unknown as ServerConfig;

function membership(anchor: string, acceptedAt: string): ActiveMembershipFacts {
  return {
    orgId: `org-of-${anchor}`,
    orgRole: anchor === SOLO ? "owner" : "recruiter",
    acceptedAt: new Date(acceptedAt),
    orgStatus: "active",
    anchorPayerId: anchor,
    anchorRole: "agent",
    anchorStatus: "active",
    memberRole: "agent",
  };
}
const SOLO_ONLY = [membership(SOLO, "2026-01-01T00:00:00.000Z")];
const JOINED = [...SOLO_ONLY, membership(ANCHOR, "2026-02-01T00:00:00.000Z")];
const TWO_TEAMS = [...JOINED, membership(OTHER, "2026-03-01T00:00:00.000Z")];

/** The REAL resolver over a membership read that answers `first`, then `later` on every call after. */
function racingResolver(first: ActiveMembershipFacts[], later: ActiveMembershipFacts[]) {
  const reads = vi.fn(
    async (): Promise<ActiveMembershipFacts[]> => (reads.mock.calls.length === 1 ? first : later),
  );
  const orgs = { listActiveMembershipsWithAnchor: reads, ensureSoloOrg: async () => undefined };
  return {
    tenancy: new PayerTenantScopeService(CONFIG, orgs as unknown as PayerOrgsRepository),
    reads,
  };
}

/** Every repository call, with the tenant key it was handed. */
function world(tenancy: PayerTenantScopeService) {
  const kycRepo = {
    upsertPending: vi.fn(async (tenant: string) => ({
      id: "kyc-1",
      payerId: tenant,
      status: "pending",
      panEnc: pii.encrypt("ABCDE1234F"),
      bankAccountEnc: pii.encrypt("123456789012"),
      rejectReason: null,
      updatedAt: new Date(0),
    })),
    findByPayer: vi.fn(async () => undefined),
  };
  const payoutRepo = {
    withTransaction: vi.fn(async (cb: (tx: undefined) => Promise<unknown>) => cb(undefined)),
    findQualifyingUnlocks: vi.fn(async () => [
      { unlockId: "u-1", grantedAt: new Date(1), attributedAt: new Date(0) },
    ]),
    insertAccruals: vi.fn(async (rows: { sourceUnlockId: string; agencyPayerId: string }[]) =>
      rows.map((r) => ({ ...r, amountInr: 10, basisInr: 40, rateBps: 2500 })),
    ),
    aggregate: vi.fn(async () => ({
      totalAccruedInr: 10,
      requestableInr: 10,
      inRequestInr: 0,
      paidInr: 0,
      accrualCount: 1,
    })),
    listRequests: vi.fn(async () => []),
    createRequestClaiming: vi.fn(async () => ({ id: "r-1", amountInr: 10, accrualCount: 1 })),
  };
  const events = { emit: vi.fn(async () => undefined) } as unknown as EventsService;
  const payers = {} as unknown as PayersRepository;
  const kyc = new AgencyKycService(kycRepo as unknown as AgencyKycRepository, pii, events, payers);
  kyc.statusForGate = vi.fn(kyc.statusForGate.bind(kyc));
  const payouts = new AgencyPayoutService(
    payoutRepo as unknown as AgencyPayoutRepository,
    kyc,
    events,
    CONFIG,
  );
  const controller = new AgencyPayoutsController(kyc, payouts);
  const guards: CanActivate[] = [
    new PayerRoleGuard(new Reflector()),
    new AgencyPayoutsEnabledGuard(CONFIG),
    new PayerOrgRoleGuard(new Reflector(), tenancy),
  ];

  /** Every tenant key any repository (or the KYC gate) was handed during the request. */
  const keysTouched = (): unknown[] => [
    ...kycRepo.upsertPending.mock.calls.map((c) => c[0]),
    ...kycRepo.findByPayer.mock.calls.map((c) => (c as unknown[])[0]),
    ...payoutRepo.findQualifyingUnlocks.mock.calls.map((c) => (c as unknown[])[0]),
    ...payoutRepo.insertAccruals.mock.calls.flatMap((c) =>
      (c[0] as { agencyPayerId: string }[]).map((r) => r.agencyPayerId),
    ),
    ...payoutRepo.aggregate.mock.calls.map((c) => (c as unknown[])[0]),
    ...payoutRepo.listRequests.mock.calls.map((c) => (c as unknown[])[0]),
    ...payoutRepo.createRequestClaiming.mock.calls.map(
      (c) => ((c as unknown[])[0] as { tenant: string }).tenant,
    ),
  ];
  const writes = () =>
    kycRepo.upsertPending.mock.calls.length +
    payoutRepo.insertAccruals.mock.calls.length +
    payoutRepo.createRequestClaiming.mock.calls.length;

  return { controller, guards, keysTouched, writes };
}

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: TEST_KEY,
} as unknown as ServerConfig);

const KYC_DTO = {
  pan: "ABCDE1234F",
  bank_account: "123456789012",
  ifsc: "HDFC0001234",
  account_holder_name: "Acme",
};

function contextFor(method: string, payerId: string): ExecutionContext {
  const handler = (AgencyPayoutsController.prototype as unknown as Record<string, unknown>)[method];
  const payer: AuthenticatedPayer = { id: payerId, sid: "s", role: "agent" };
  const req = { payer };
  return {
    getHandler: () => handler,
    getClass: () => AgencyPayoutsController,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/**
 * One request, as Nest runs it: the guards in order (PayerAuthGuard's `req.payer` is already on
 * the context), then the handler with each argument built from the route metadata — a custom
 * param decorator runs its real factory, `@Body` receives the (already valid) body.
 */
async function request(
  w: ReturnType<typeof world>,
  method: string,
  payerId: string,
): Promise<{ status: number; body: unknown }> {
  const ctx = contextFor(method, payerId);
  try {
    for (const guard of w.guards) await guard.canActivate(ctx);
    const meta = (Reflect.getMetadata("__routeArguments__", AgencyPayoutsController, method) ??
      {}) as Record<
      string,
      { index: number; data?: unknown; factory?: (data: unknown, c: ExecutionContext) => unknown }
    >;
    const args: unknown[] = [];
    for (const [key, m] of Object.entries(meta)) {
      if (m.factory) args[m.index] = m.factory(m.data, ctx);
      else if (key.startsWith("3:")) args[m.index] = KYC_DTO;
      else throw new Error(`unsupported route param ${key}`);
    }
    const handler = (w.controller as unknown as Record<string, (...a: unknown[]) => unknown>)[
      method
    ]!;
    return { status: 200, body: await handler.apply(w.controller, args) };
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    return { status: err.getStatus(), body: err.getResponse() };
  }
}

const ROUTES = ["submitKyc", "getKyc", "getEarnings", "requestPayout", "listPayouts"] as const;

describe("AgencyPayoutsController — the owner gate and the tenant key are ONE resolution (F1 / M1)", () => {
  for (const route of ROUTES) {
    it(`${route}: an accept landing mid-request never keys the TEAM's rows — one membership read per request`, async () => {
      // Read 1 (whoever reads first): the payer owns only their solo org. Every later read: they
      // have joined ANCHOR's team as a recruiter — `on` would key them to ANCHOR.
      const { tenancy, reads } = racingResolver(SOLO_ONLY, JOINED);
      const w = world(tenancy);
      const res = await request(w, route, SOLO);
      // THE BREACH: no repository (and not the KYC gate) is ever handed the team's key.
      expect(w.keysTouched()).not.toContain(ANCHOR);
      expect(reads).toHaveBeenCalledTimes(1);
      // Admitted on the one read it made, the request acts on that read's org — the solo org.
      expect(res.status).toBe(200);
      expect(new Set(w.keysTouched())).toEqual(new Set([SOLO]));
    });
  }

  it("a removal landing mid-request: refused on the guard's read (403), no repository call, one read", async () => {
    for (const route of ROUTES) {
      // Read 1: a recruiter in ANCHOR's team (refused). Every later read: removed, solo owner.
      const { tenancy, reads } = racingResolver(JOINED, SOLO_ONLY);
      const w = world(tenancy);
      expect((await request(w, route, SOLO)).status, route).toBe(403);
      expect(reads, route).toHaveBeenCalledTimes(1);
      expect(w.keysTouched(), route).toEqual([]);
      expect(w.writes(), route).toBe(0);
    }
  });

  it("a resolver DENIAL (two team memberships, R3) is the guard's existing 403 body — no write", async () => {
    const { tenancy } = racingResolver(TWO_TEAMS, SOLO_ONLY);
    const w = world(tenancy);
    const res = await request(w, "submitKyc", SOLO);
    expect(res).toEqual({
      status: 403,
      body: { statusCode: 403, message: "Not a member of an organization", error: "Forbidden" },
    });
    expect(w.writes()).toBe(0);
  });
});
