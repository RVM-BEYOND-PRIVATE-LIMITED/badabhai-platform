import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { Queue } from "bullmq";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ServerConfig } from "@badabhai/config";
import { DEFAULT_CATALOG } from "@badabhai/pricing";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";

import type { ConsentRepository } from "../consent/consent.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type { PricingService } from "../pricing/pricing.service";
import type { ReferralBonusJobData } from "../queue/queue.constants";
import { PaymentGateway } from "../unlocks/payment-gateway";
import type { RazorpayClient } from "../unlocks/razorpay.client";
import { neutralUnavailable } from "../unlocks/unlock-response";
import { UnlockService } from "../unlocks/unlocks.service";
import type { UnlocksRepository } from "../unlocks/unlocks.repository";
import type { WorkersRepository } from "../workers/workers.repository";

/**
 * #2753 item 6 — the ONE call `UnlockService.requestUnlock` makes into `searchExitRefuses`, through
 * the real service over fakes (the `unlocks.service.test.ts` harness, trimmed). Kept in this module
 * so the unlock suite another session is rewriting needs no edit.
 *
 *   - hidden, an applicant of this company        → granted (the normal paid grant);
 *   - hidden, this company holds an OPEN grant     → the existing grant, and the gate never runs
 *                                                     (it sits after the open-grant early return);
 *   - hidden, unrelated company                    → the byte-identical neutral body: no debit, no
 *                                                     grant row, no deny row, and `unlock.denied`
 *                                                     with an internal reason;
 *   - hidden, a LAPSED grant of this company       → refused like an unrelated one;
 *   - not hidden                                   → unchanged (one extra read, then the grant);
 *   - switch off                                   → unchanged and the gate reads nothing;
 *   - switch on, the table MISSING (before 0169)   → granted: the probe fails open and the
 *                                                     table is never named (no aborted tx).
 * Every read of the gate is on the transaction's handle.
 */
const dialect = new PgDialect();
const CTX = { correlationId: "corr-2753", requestId: "req-2753" } as RequestContext;
const PAYER = "11111111-1111-1111-1111-111111111111";
const WORKER = "22222222-2222-2222-2222-222222222222";

const BASE = {
  UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY: 5,
  UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK: 10,
  UNLOCK_MAX_ATTEMPTS_PER_UNLOCK: 3,
  UNLOCK_LATENCY_TARGET_MS: 0,
  PAYMENTS_ENABLE_REAL: false,
};

interface Opts {
  switchOn?: boolean;
  hidden?: boolean;
  applied?: boolean;
  /** Migration 0169 not applied: `to_regclass` answers NULL, and naming the table would raise. */
  tableMissing?: boolean;
  existingUnlock?: Record<string, unknown>;
}

function setup(opts: Opts = {}) {
  const order: string[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    const { sql } = dialect.sqlToQuery(statement);
    if (sql.includes("to_regclass(")) {
      order.push("gate:probe");
      return [{ present: opts.tableMissing !== true }];
    }
    if (sql.includes("FROM worker_search_exits")) {
      if (opts.tableMissing) throw new Error("42P01 would abort the unlock transaction");
      order.push("gate:exit");
      return opts.hidden ? [{ hidden: 1 }] : [];
    }
    if (sql.includes("FROM applications a")) {
      order.push("gate:applied");
      return opts.applied ? [{ member: 1 }] : [];
    }
    throw new Error(`unexpected statement on tx: ${sql}`);
  });
  const tx = {
    execute,
    findByPayerWorker: vi.fn(async () => opts.existingUnlock),
    lockWorker: vi.fn(async () => undefined),
    getWorkerDeletionMarker: vi.fn(async () => {
      order.push("marker");
      return { deletionScheduledAt: null, status: "active" };
    }),
    countRevealsSince: vi.fn(async () => {
      order.push("caps");
      return 0;
    }),
    countDistinctPayersSince: vi.fn(async () => 0),
    findTradeLevels: vi.fn(async () => []),
    tryDebit: vi.fn(async () => 4),
    upsertGrant: vi.fn(async (_tx: unknown, input: Record<string, unknown>) => ({
      id: "unlock-new",
      ...input,
      status: "granted",
    })),
    appendLedger: vi.fn(async () => undefined),
    recordDeny: vi.fn(async () => ({ id: "deny-1" })),
    extendOpenUntil: vi.fn(async () => undefined),
  };
  // The global-pool repository: NO `execute`, so a gate read off the transaction would throw.
  const repo = {
    withTransaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    getBalance: vi.fn(async () => 5),
    findOwnedJobRef: vi.fn(async () => null),
    legacyJobExists: vi.fn(async () => true),
    findAgencyTwinSourceJobId: vi.fn(async () => null),
    ...Object.fromEntries(Object.entries(tx).filter(([k]) => k !== "execute")),
  };
  const consents = {
    findLatestByWorker: vi.fn(async () => ({
      purposes: ["employer_sharing"],
      revokedAt: null,
      consentVersion: "2026-11-04",
    })),
  };
  const workers = {
    findById: vi.fn(async () => ({ id: WORKER, deletionScheduledAt: null, status: "active" })),
  };
  const events = { emit: vi.fn(async (p: Record<string, unknown>) => p) };
  const config = {
    ...BASE,
    SEARCH_EXIT_ENABLED: opts.switchOn ?? true,
  } as unknown as ServerConfig;
  const payments = new PaymentGateway(
    repo as unknown as UnlocksRepository,
    config,
    {
      getActiveCatalog: vi.fn(async () => ({
        catalog: DEFAULT_CATALOG,
        revision: 1,
        source: "db" as const,
      })),
    } as unknown as PricingService,
    { isLive: false, keyId: null, createOrder: vi.fn() } as unknown as RazorpayClient,
  );
  const tenancy = new PayerTenantScopeService(
    { PAYER_ORG_TENANCY_MODE: "off" } as unknown as ServerConfig,
    {
      listActiveMembershipsWithAnchor: vi.fn(async () => []),
      ensureSoloOrg: vi.fn(async () => null),
    } as unknown as PayerOrgsRepository,
  );
  const svc = new UnlockService(
    repo as unknown as UnlocksRepository,
    consents as unknown as ConsentRepository,
    workers as unknown as WorkersRepository,
    { decrypt: vi.fn() } as unknown as PiiCryptoService,
    payments,
    events as unknown as EventsService,
    config,
    { add: vi.fn(async () => undefined) } as unknown as Queue<ReferralBonusJobData>,
    { get: vi.fn().mockResolvedValue(DEFAULT_MATCH_CONFIG) } as never,
    { findAuthFacts: vi.fn(async () => ({ role: "employer", status: "active" })) } as never,
    tenancy,
    { decide: vi.fn(async () => "not_linked") } as never,
  );
  const unlock = () => svc.requestUnlock({ payerId: PAYER, workerId: WORKER, jobId: null }, CTX);
  const emitted = () =>
    events.emit.mock.calls.map((c) => c[0] as { event_name: string; payload: unknown });
  return { unlock, tx, repo, execute, events, emitted, order };
}

const openGrant = () => ({
  id: "unlock-held",
  payerId: PAYER,
  workerId: WORKER,
  status: "granted",
  routingTokenRef: "44444444-4444-4444-4444-444444444444",
  revealCount: 0,
  expiresAt: new Date(Date.now() + 60_000),
});

describe("requestUnlock × a worker who left company search (switch on)", () => {
  it("hidden, an applicant of this company → granted, the normal paid grant", async () => {
    const t = setup({ hidden: true, applied: true });
    expect(await t.unlock()).toMatchObject({
      ok: true,
      status: "granted",
      unlock_id: "unlock-new",
    });
    expect(t.tx.tryDebit).toHaveBeenCalledTimes(1);
    expect(t.tx.upsertGrant).toHaveBeenCalledTimes(1);
  });

  it("hidden, this company already holds an OPEN grant → that grant, and the gate never runs", async () => {
    const t = setup({ hidden: true, applied: false, existingUnlock: openGrant() });
    expect(await t.unlock()).toMatchObject({
      ok: true,
      status: "granted",
      unlock_id: "unlock-held",
    });
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.tx.tryDebit).not.toHaveBeenCalled();
  });

  it("hidden, an unrelated company → the byte-identical neutral body: no debit, no grant, no deny row", async () => {
    const t = setup({ hidden: true, applied: false });
    const out = await t.unlock();
    expect(JSON.stringify(out)).toBe(JSON.stringify(neutralUnavailable()));
    expect(t.tx.tryDebit).not.toHaveBeenCalled();
    expect(t.tx.upsertGrant).not.toHaveBeenCalled();
    expect(t.tx.appendLedger).not.toHaveBeenCalled();
    expect(t.tx.recordDeny).not.toHaveBeenCalled();
    // The house deny event, internal reason only, no unlock row named (the subject is the worker).
    const deny = t.emitted().find((e) => e.event_name === "unlock.denied");
    expect(deny).toMatchObject({
      subject: { subject_type: "worker", subject_id: WORKER },
      payload: { unlock_id: null, payer_id: PAYER, worker_id: WORKER, reason: "no_consent" },
    });
    expect(t.emitted().map((e) => e.event_name)).toEqual(["unlock.requested", "unlock.denied"]);
  });

  it("refused INSIDE the transaction, after the deletion re-check and before the caps", async () => {
    const t = setup({ hidden: true, applied: false });
    await t.unlock();
    expect(t.order).toEqual(["marker", "gate:probe", "gate:exit", "gate:applied"]);
    // Every read of the gate went through the transaction's handle (the repo has no `execute`).
    expect(t.execute).toHaveBeenCalledTimes(3);
  });

  it("hidden, a LAPSED grant of this company → refused like an unrelated one (only an open grant re-opens)", async () => {
    const lapsed = { ...openGrant(), expiresAt: new Date(Date.now() - 60_000) };
    const t = setup({ hidden: true, applied: false, existingUnlock: lapsed });
    expect(await t.unlock()).toEqual(neutralUnavailable());
    expect(t.tx.tryDebit).not.toHaveBeenCalled();
  });

  it("not hidden → unchanged: the probe and one exit read, then the caps and the grant", async () => {
    const t = setup({ hidden: false });
    expect(await t.unlock()).toMatchObject({ ok: true, status: "granted" });
    expect(t.order).toEqual(["marker", "gate:probe", "gate:exit", "caps"]);
    expect(t.tx.tryDebit).toHaveBeenCalledTimes(1);
  });

  it("the table MISSING (switch on before 0169): FAIL OPEN — granted after the probe alone, no 500", async () => {
    const t = setup({ hidden: true, applied: false, tableMissing: true });
    expect(await t.unlock()).toMatchObject({ ok: true, status: "granted" });
    expect(t.order).toEqual(["marker", "gate:probe", "caps"]);
    expect(t.tx.tryDebit).toHaveBeenCalledTimes(1);
    expect(t.emitted().map((e) => e.event_name)).not.toContain("unlock.denied");
  });
});

describe("requestUnlock with SEARCH_EXIT_ENABLED off — unchanged", () => {
  it("a worker with an exit row is granted as before, and the gate reads nothing", async () => {
    const t = setup({ switchOn: false, hidden: true, applied: false });
    expect(await t.unlock()).toMatchObject({ ok: true, status: "granted" });
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.order).toEqual(["marker", "caps"]);
    expect(t.emitted().map((e) => e.event_name)).not.toContain("unlock.denied");
  });
});
