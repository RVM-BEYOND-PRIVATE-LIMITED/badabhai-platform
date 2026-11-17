import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { workforceUuid } from "@badabhai/db";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import type { AdminIdentityService } from "../admin-identity.service";
import type { CandidateSearchRepository } from "../../candidates/candidate-search.repository";
import type { PiiCryptoService } from "../../common/pii-crypto.service";
import type { RequestContext } from "../../common/request-context";
import type { EventsService } from "../../events/events.service";
import {
  AdminLaunchTestRecordSchema,
  type AdminLaunchTestRecordDto,
} from "./admin-launch-tests.dto";
import type {
  AdminLaunchTestsRepository,
  CohortListRow,
  CohortRow,
} from "./admin-launch-tests.repository";
import { AdminLaunchTestsService } from "./admin-launch-tests.service";
import { cohortIdForKey, type HireRecordRow, type ShareWorkerFacts } from "./launch-test-rules";

/**
 * #2755 part D — the service's rules over fakes: who may be sent, outside the portal, the share
 * cap, the idempotent create, the edit's checks (paid_at, the link, the REAL paid order), the name
 * behind the identity layer, the events, and the fail-closed 503.
 */

const ADMIN: AuthenticatedAdmin = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "ops_admin",
  sid: "s",
};
const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };
const KEY = "factory-key-0001";
const COHORT = cohortIdForKey(ADMIN.id, KEY);
const W = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PAYER = "11111111-1111-4111-8111-111111111111";
const CAMPUS = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const OTHER_PAYER = "66666666-6666-4666-8666-666666666666";
const T0 = new Date("2026-12-01T10:00:00.000Z");
const T1 = new Date("2026-12-03T10:00:00.000Z");

function dto(over: Record<string, unknown> = {}): AdminLaunchTestRecordDto {
  return AdminLaunchTestRecordSchema.parse({
    factory_name: "Shree Precision Works",
    factory_phone: "+919876543210",
    city_group: "ncr",
    trade_group: "cnc_operator",
    sent_at: T0.toISOString(),
    worker_ids: [W(1), W(2)],
    ...over,
  });
}

function cohortRow(over: Partial<CohortRow> = {}): CohortRow {
  return {
    id: COHORT,
    hasPhone: true,
    cityGroup: "ncr",
    tradeGroup: "cnc_operator",
    payerId: null,
    sentByAdminId: ADMIN.id,
    sentAt: T0,
    paymentLinkRef: null,
    linkCreatedAt: null,
    result: "pending",
    paidAt: null,
    paymentOrderId: null,
    createdAt: T0,
    updatedAt: T0,
    updatedByAdminId: ADMIN.id,
    ...over,
  };
}

interface HarnessOpts {
  holders?: { payerId: string; campusCompany: boolean }[];
  imported?: boolean;
  payer?: { payerId: string; campusCompany: boolean } | undefined;
  workers?: ShareWorkerFacts[];
  outOfPool?: string[];
  replay?: Awaited<ReturnType<AdminLaunchTestsRepository["replayFacts"]>>;
  phoneRecorded?: boolean;
  existingShares?: number;
  insertWins?: boolean;
  locked?: CohortRow | undefined;
  order?: { payerId: string; status: string; provider: string } | undefined;
  orderElsewhere?: boolean;
  names?: Map<string, string | null> | null;
  listRows?: CohortListRow[];
  failWith?: unknown;
}

function harness(opts: HarnessOpts = {}) {
  const trace: string[] = [];
  const realWorker = (id: string): ShareWorkerFacts => ({
    workerId: id,
    exists: true,
    testWorker: false,
    linkedRvmIdentity: false,
  });
  const repo = {
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      trace.push("tx");
      if (opts.failWith !== undefined) throw opts.failWith;
      return work("TX");
    }),
    listCohort: vi.fn(async () => opts.listRows ?? []),
    sharesFor: vi.fn(async (ids: readonly string[]) =>
      ids.flatMap((id) => [
        { cohortId: id, workerId: W(1) },
        { cohortId: id, workerId: W(2) },
      ]),
    ),
    findCohort: vi.fn(async () => opts.locked ?? cohortRow()),
    lockCohort: vi.fn(async () => {
      trace.push("lock");
      return "locked" in opts ? opts.locked : cohortRow();
    }),
    replayFacts: vi.fn(async () => opts.replay),
    countShares: vi.fn(async () => {
      trace.push("count");
      return opts.existingShares ?? 0;
    }),
    phoneRecorded: vi.fn(async () => opts.phoneRecorded ?? false),
    orderLinkedElsewhere: vi.fn(async () => opts.orderElsewhere ?? false),
    phoneHolders: vi.fn(async () => opts.holders ?? []),
    payerFacts: vi.fn(async () =>
      "payer" in opts ? opts.payer : { payerId: PAYER, campusCompany: false },
    ),
    importedFromPortal: vi.fn(async () => opts.imported ?? false),
    workerFacts: vi.fn(
      async (ids: readonly string[]) => opts.workers ?? ids.map((id) => realWorker(id)),
    ),
    paymentOrder: vi.fn(async () =>
      "order" in opts ? opts.order : { payerId: PAYER, status: "paid", provider: "razorpay" },
    ),
    insertCohort: vi.fn(async (_tx: unknown, _values: unknown, _now: Date) => {
      trace.push("insert");
      return opts.insertWins ?? true;
    }),
    insertShares: vi.fn(async () => {
      trace.push("shares");
    }),
    updateCohort: vi.fn(async () => {
      trace.push("update");
    }),
    contactsPerHire: vi.fn(async () => ({ hires: [] as HireRecordRow[], contacts: [] })),
  };
  const identity = {
    resolve: vi.fn(async () => ("names" in opts ? opts.names : new Map<string, string | null>())),
  };
  const search = {
    findCardRow: vi.fn(async (id: string) =>
      (opts.outOfPool ?? []).includes(id) ? null : { workerId: id },
    ),
  };
  const pii = {
    hashPhone: vi.fn((p: string) => `hash(${p})`),
    encrypt: vi.fn((p: string) => `enc(${p})`),
  };
  const emitted: {
    event_name: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  }[] = [];
  const events = {
    emit: vi.fn(async (e: { event_name: string; payload: Record<string, unknown> }) => {
      trace.push(`emit:${e.event_name}`);
      emitted.push(e);
    }),
  };
  const service = new AdminLaunchTestsService(
    repo as unknown as AdminLaunchTestsRepository,
    identity as unknown as AdminIdentityService,
    search as unknown as CandidateSearchRepository,
    pii as unknown as PiiCryptoService,
    events as unknown as EventsService,
  );
  return { service, repo, identity, search, pii, events, emitted, trace };
}

async function refusal(
  p: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    const e = err as BadRequestException;
    return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

describe("POST — record a factory", () => {
  it("encrypts the name and phone, links the one ordinary account, writes the shares, emits ids only", async () => {
    const h = harness({ holders: [{ payerId: PAYER, campusCompany: false }] });
    const out = await h.service.recordFactory(ADMIN, dto(), KEY, CTX);
    expect(out.created).toBe(true);
    expect(out.factory.id).toBe(COHORT);
    expect(h.repo.insertCohort).toHaveBeenCalledWith(
      "TX",
      expect.objectContaining({
        id: COHORT,
        factoryNameEnc: "enc(Shree Precision Works)",
        factoryPhoneEnc: "enc(+919876543210)",
        factoryPhoneHash: "hash(+919876543210)",
        payerId: PAYER,
        sentByAdminId: ADMIN.id,
        sentAt: T0,
      }),
      expect.any(Date),
    );
    // The lock, then the count, then the shares — all inside the one transaction.
    expect(h.trace).toEqual([
      "tx",
      "insert",
      "lock",
      "count",
      "shares",
      "emit:admin.launch_test_factory_recorded",
      "emit:admin.action_performed",
    ]);
    expect(h.repo.insertShares).toHaveBeenCalledWith("TX", COHORT, [W(1), W(2)], T0);
    const [recorded, action] = h.emitted;
    expect(recorded!.payload).toEqual({
      cohort_id: COHORT,
      admin_id: ADMIN.id,
      share_count: 2,
      has_phone: true,
      payer_id: PAYER,
    });
    expect(recorded!.idempotencyKey).toBe(`admin.launch_test_factory_recorded:${COHORT}`);
    expect(action!.payload).toEqual({
      admin_id: ADMIN.id,
      action_code: "launch_test_factory_recorded",
      target_type: "launch_test_cohort",
      target_id: COHORT,
    });
    // Nothing on the spine names the factory, its phone or a worker.
    const spine = JSON.stringify(h.emitted);
    for (const leak of ["Shree", "9876543210", "hash(", "enc(", W(1)]) {
      expect(spine).not.toContain(leak);
    }
  });

  it("several ordinary accounts on one phone: recorded, with no account linked", async () => {
    const h = harness({
      holders: [
        { payerId: PAYER, campusCompany: false },
        { payerId: "44444444-4444-4444-8444-444444444444", campusCompany: false },
      ],
    });
    await h.service.recordFactory(ADMIN, dto(), KEY, CTX);
    expect(h.repo.insertCohort.mock.calls[0]![1]).toMatchObject({ payerId: null });
  });

  it("no phone: no hash, no holder lookup, has_phone false", async () => {
    const h = harness();
    await h.service.recordFactory(ADMIN, dto({ factory_phone: undefined }), KEY, CTX);
    expect(h.repo.phoneHolders).not.toHaveBeenCalled();
    expect(h.repo.insertCohort.mock.calls[0]![1]).toMatchObject({
      factoryPhoneEnc: null,
      factoryPhoneHash: null,
    });
    expect(h.emitted[0]!.payload.has_phone).toBe(false);
  });

  describe("outside the portal", () => {
    it("a Campus company holding the phone: 409 campus_company, nothing written", async () => {
      const h = harness({
        holders: [
          { payerId: PAYER, campusCompany: false },
          { payerId: CAMPUS, campusCompany: true },
        ],
      });
      const r = await refusal(h.service.recordFactory(ADMIN, dto(), KEY, CTX));
      expect(r).toMatchObject({ status: 409, body: { reason: "campus_company" } });
      expect(h.repo.withTransaction).not.toHaveBeenCalled();
      expect(h.emitted).toEqual([]);
    });

    it("the account named for it is a Campus company: 409 campus_company", async () => {
      const h = harness({ payer: { payerId: CAMPUS, campusCompany: true } });
      const r = await refusal(
        h.service.recordFactory(
          ADMIN,
          dto({ factory_phone: undefined, payer_id: CAMPUS }),
          KEY,
          CTX,
        ),
      );
      expect(r).toMatchObject({ status: 409, body: { reason: "campus_company" } });
    });

    it("the #2754 import ledger hook holds the phone: 409 portal_import", async () => {
      const h = harness({ imported: true });
      const r = await refusal(h.service.recordFactory(ADMIN, dto(), KEY, CTX));
      expect(r).toMatchObject({ status: 409, body: { reason: "portal_import" } });
      expect(h.repo.importedFromPortal).toHaveBeenCalledWith("hash(+919876543210)");
    });

    it("a named account that does not exist: 400 payer_not_found", async () => {
      const h = harness({ payer: undefined });
      const r = await refusal(h.service.recordFactory(ADMIN, dto({ payer_id: PAYER }), KEY, CTX));
      expect(r).toMatchObject({ status: 400, body: { reason: "payer_not_found" } });
    });

    it("a named ordinary account is linked even when the phone matches another", async () => {
      const other = "55555555-5555-4555-8555-555555555555";
      const h = harness({ holders: [{ payerId: other, campusCompany: false }] });
      await h.service.recordFactory(ADMIN, dto({ payer_id: PAYER }), KEY, CTX);
      expect(h.repo.insertCohort.mock.calls[0]![1]).toMatchObject({ payerId: PAYER });
    });
  });

  describe("who may be sent", () => {
    it("refuses the WHOLE write with each offender's closed code, in the request's order", async () => {
      const sample = workforceUuid("worker", 3);
      const h = harness({
        workers: [
          { workerId: W(2), exists: true, testWorker: true, linkedRvmIdentity: false },
          { workerId: W(3), exists: true, testWorker: false, linkedRvmIdentity: true },
          { workerId: sample, exists: true, testWorker: false, linkedRvmIdentity: false },
          { workerId: W(5), exists: true, testWorker: false, linkedRvmIdentity: false },
          { workerId: W(6), exists: true, testWorker: false, linkedRvmIdentity: false },
        ],
        outOfPool: [W(5)],
      });
      const r = await refusal(
        h.service.recordFactory(
          ADMIN,
          dto({ worker_ids: [W(1), W(2), W(3), sample, W(5)] }),
          KEY,
          CTX,
        ),
      );
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({
        reason: "workers_not_eligible",
        workers: [
          { worker_id: W(1), reason: "not_found" },
          { worker_id: W(2), reason: "test_worker" },
          { worker_id: W(3), reason: "linked_rvm_identity" },
          { worker_id: sample, reason: "sample_worker" },
          { worker_id: W(5), reason: "not_in_search_pool" },
        ],
      });
      // The pool is asked only for the worker that passed every other rule.
      expect(h.search.findCardRow.mock.calls.map((c) => c[0])).toEqual([W(5)]);
      expect(h.repo.withTransaction).not.toHaveBeenCalled();
    });

    it("every worker eligible: the pool is asked for each, and the write goes ahead", async () => {
      const h = harness();
      await h.service.recordFactory(ADMIN, dto({ worker_ids: [W(1), W(2), W(3)] }), KEY, CTX);
      expect(h.search.findCardRow.mock.calls.map((c) => c[0])).toEqual([W(1), W(2), W(3)]);
    });

    it("THE SHARE CAP, under the lock: four already there plus two is refused (409)", async () => {
      const h = harness({ existingShares: 4 });
      const r = await refusal(h.service.recordFactory(ADMIN, dto(), KEY, CTX));
      expect(r).toMatchObject({ status: 409, body: { reason: "share_limit_exceeded" } });
      expect(h.trace).toEqual(["tx", "insert", "lock", "count"]);
      expect(h.repo.insertShares).not.toHaveBeenCalled();
    });
  });

  describe("the idempotent create", () => {
    const replay = {
      samePhone: true,
      cityGroup: "ncr",
      tradeGroup: "cnc_operator",
      sentAt: T0,
      workerIds: [W(2), W(1)],
    };

    it("a retry with the same key and the same factory: the stored row, created false, nothing re-run", async () => {
      const h = harness({ replay });
      const out = await h.service.recordFactory(ADMIN, dto(), KEY, CTX);
      expect(out.created).toBe(false);
      expect(h.repo.replayFacts).toHaveBeenCalledWith(COHORT, "hash(+919876543210)");
      for (const fn of [h.repo.phoneHolders, h.repo.workerFacts, h.repo.withTransaction]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(h.emitted).toEqual([]);
    });

    it("the same key for a different factory: 409 idempotency_key_reused", async () => {
      for (const changed of [
        { ...replay, samePhone: false },
        { ...replay, cityGroup: "pune" },
        { ...replay, workerIds: [W(1)] },
        { ...replay, sentAt: T1 },
      ]) {
        const h = harness({ replay: changed });
        const r = await refusal(h.service.recordFactory(ADMIN, dto(), KEY, CTX));
        expect(r).toMatchObject({ status: 409, body: { reason: "idempotency_key_reused" } });
      }
    });

    it("a concurrent same-key create won the insert: answered as its replay", async () => {
      const h = harness({ insertWins: false });
      h.repo.replayFacts.mockResolvedValueOnce(undefined).mockResolvedValueOnce(replay);
      const out = await h.service.recordFactory(ADMIN, dto(), KEY, CTX);
      expect(out.created).toBe(false);
      expect(h.repo.insertShares).not.toHaveBeenCalled();
      expect(h.emitted).toEqual([]);
    });
  });

  it("a phone already recorded: 409 factory_already_recorded (the pre-check and the index race)", async () => {
    const h = harness({ phoneRecorded: true });
    const r = await refusal(h.service.recordFactory(ADMIN, dto(), KEY, CTX));
    expect(r).toMatchObject({ status: 409, body: { reason: "factory_already_recorded" } });
    // ANOTHER row: this key's own row (a concurrent retry) answers as a replay, not a 409.
    expect(h.repo.phoneRecorded).toHaveBeenCalledWith("TX", "hash(+919876543210)", COHORT);
    expect(h.repo.insertCohort).not.toHaveBeenCalled();

    const race = harness({
      failWith: { code: "23505", constraint_name: "launch_test_cohort_phone_hash_uq" },
    });
    const r2 = await refusal(race.service.recordFactory(ADMIN, dto(), KEY, CTX));
    expect(r2).toMatchObject({ status: 409, body: { reason: "factory_already_recorded" } });
  });

  it("a link time with no link: 400 link_created_without_ref", async () => {
    const h = harness();
    const r = await refusal(
      h.service.recordFactory(ADMIN, dto({ link_created_at: T0.toISOString() }), KEY, CTX),
    );
    expect(r).toMatchObject({ status: 400, body: { reason: "link_created_without_ref" } });
  });

  it("FAILS CLOSED on a database without the tables: 503, never a half-written record", async () => {
    const h = harness({ failWith: Object.assign(new Error("missing"), { code: "42P01" }) });
    await expect(h.service.recordFactory(ADMIN, dto(), KEY, CTX)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe("PATCH — the link, the result, the account and the paid order", () => {
  it("an unknown factory is a 404", async () => {
    const h = harness({ locked: undefined });
    await expect(
      h.service.updateFactory(ADMIN, COHORT, { result: "declined" }, KEY, CTX),
    ).rejects.toThrow(NotFoundException);
  });

  it("a PATCH that changes nothing writes nothing and emits nothing", async () => {
    const h = harness({ locked: cohortRow({ result: "declined" }) });
    const out = await h.service.updateFactory(ADMIN, COHORT, { result: "declined" }, KEY, CTX);
    expect(out.changed).toBe(false);
    expect(h.repo.updateCohort).not.toHaveBeenCalled();
    expect(h.emitted).toEqual([]);
  });

  it("THE paid_at RULE on the merged row: paid without a time, or a time without paid, is a 400", async () => {
    for (const patch of [{ result: "paid" as const }, { paid_at: T1 }]) {
      const h = harness();
      const r = await refusal(h.service.updateFactory(ADMIN, COHORT, patch, KEY, CTX));
      expect(r).toMatchObject({ status: 400, body: { reason: "paid_at_mismatch" } });
      expect(h.repo.updateCohort).not.toHaveBeenCalled();
    }
    // Leaving paid clears the time in the same PATCH, or it is refused.
    const paid = harness({ locked: cohortRow({ result: "paid", paidAt: T1 }) });
    const r = await refusal(
      paid.service.updateFactory(ADMIN, COHORT, { result: "declined" }, KEY, CTX),
    );
    expect(r.body.reason).toBe("paid_at_mismatch");
  });

  it("records paid with its time: one update, one event naming the changed part", async () => {
    const h = harness();
    const out = await h.service.updateFactory(
      ADMIN,
      COHORT,
      { result: "paid", paid_at: T1 },
      KEY,
      CTX,
    );
    expect(out.changed).toBe(true);
    expect(h.repo.updateCohort).toHaveBeenCalledWith(
      "TX",
      COHORT,
      expect.objectContaining({ result: "paid", paidAt: T1 }),
      ADMIN.id,
      expect.any(Date),
    );
    expect(h.emitted.map((e) => e.event_name)).toEqual([
      "admin.launch_test_factory_updated",
      "admin.action_performed",
    ]);
    expect(h.emitted[0]!.payload).toEqual({
      cohort_id: COHORT,
      admin_id: ADMIN.id,
      changed: ["result"],
      result: "paid",
      payer_id: null,
      payment_order_id: null,
    });
    expect(h.emitted[0]!.idempotencyKey).toMatch(
      new RegExp(`^admin\\.launch_test_factory_updated:${COHORT}:${KEY}:[0-9a-f]{16}$`),
    );
  });

  it("the payment link: its ref and time, never on the spine", async () => {
    const h = harness();
    await h.service.updateFactory(
      ADMIN,
      COHORT,
      { payment_link_ref: "https://rzp.io/l/AbC123", link_created_at: T0 },
      KEY,
      CTX,
    );
    expect(h.emitted[0]!.payload.changed).toEqual(["payment_link"]);
    expect(JSON.stringify(h.emitted)).not.toContain("rzp.io");
    const bad = harness();
    const r = await refusal(
      bad.service.updateFactory(ADMIN, COHORT, { link_created_at: T0 }, KEY, CTX),
    );
    expect(r.body.reason).toBe("link_created_without_ref");
  });

  describe("THE PAID-ORDER CHECK", () => {
    const paidRow = cohortRow({ result: "paid", paidAt: T1, payerId: PAYER });

    it("a real paid order of the factory's own account is linked", async () => {
      const h = harness({ locked: paidRow });
      const out = await h.service.updateFactory(
        ADMIN,
        COHORT,
        { payment_order_id: ORDER },
        KEY,
        CTX,
      );
      expect(out.changed).toBe(true);
      expect(h.repo.paymentOrder).toHaveBeenCalledWith("TX", ORDER);
      expect(h.repo.orderLinkedElsewhere).toHaveBeenCalledWith("TX", ORDER, COHORT);
      expect(h.emitted[0]!.payload).toMatchObject({
        changed: ["payment_order"],
        payment_order_id: ORDER,
        payer_id: PAYER,
      });
    });

    it.each([
      [undefined, "payment_order_not_found"],
      [{ payerId: PAYER, status: "paid", provider: "mock" }, "payment_order_not_real"],
      [{ payerId: PAYER, status: "created", provider: "razorpay" }, "payment_order_not_paid"],
      [{ payerId: CAMPUS, status: "paid", provider: "razorpay" }, "payment_order_other_payer"],
    ])("%o is refused: %s (409)", async (order, reason) => {
      const h = harness({ locked: paidRow, order });
      const r = await refusal(
        h.service.updateFactory(ADMIN, COHORT, { payment_order_id: ORDER }, KEY, CTX),
      );
      expect(r).toMatchObject({ status: 409, body: { reason } });
      expect(h.repo.updateCohort).not.toHaveBeenCalled();
    });

    it("an order already linked to another factory: 409 payment_order_already_linked", async () => {
      const h = harness({ locked: paidRow, orderElsewhere: true });
      const r = await refusal(
        h.service.updateFactory(ADMIN, COHORT, { payment_order_id: ORDER }, KEY, CTX),
      );
      expect(r).toMatchObject({ status: 409, body: { reason: "payment_order_already_linked" } });
    });

    it("an order needs an account and a paid result first (400s)", async () => {
      const noAccount = harness({ locked: cohortRow({ result: "paid", paidAt: T1 }) });
      expect(
        (
          await refusal(
            noAccount.service.updateFactory(ADMIN, COHORT, { payment_order_id: ORDER }, KEY, CTX),
          )
        ).body.reason,
      ).toBe("payment_order_without_payer");
      const unpaid = harness({ locked: cohortRow({ payerId: PAYER }) });
      expect(
        (
          await refusal(
            unpaid.service.updateFactory(ADMIN, COHORT, { payment_order_id: ORDER }, KEY, CTX),
          )
        ).body.reason,
      ).toBe("payment_order_needs_paid_result");
    });

    it("moving the account re-checks the linked order against the new account", async () => {
      const h = harness({
        locked: cohortRow({ result: "paid", paidAt: T1, payerId: PAYER, paymentOrderId: ORDER }),
        payer: { payerId: OTHER_PAYER, campusCompany: false },
      });
      const r = await refusal(
        h.service.updateFactory(ADMIN, COHORT, { payer_id: OTHER_PAYER }, KEY, CTX),
      );
      expect(r.body.reason).toBe("payment_order_other_payer");
    });
  });

  it("linking a Campus company's account is refused (409), as at the create", async () => {
    const h = harness({ payer: { payerId: CAMPUS, campusCompany: true } });
    const r = await refusal(h.service.updateFactory(ADMIN, COHORT, { payer_id: CAMPUS }, KEY, CTX));
    expect(r).toMatchObject({ status: 409, body: { reason: "campus_company" } });
  });

  it("the paid-order index race maps to the closed code too", async () => {
    const h = harness({
      failWith: {
        cause: { code: "23505", constraint_name: "launch_test_cohort_payment_order_uq" },
      },
    });
    const r = await refusal(
      h.service.updateFactory(ADMIN, COHORT, { payment_order_id: ORDER }, KEY, CTX),
    );
    expect(r).toMatchObject({ status: 409, body: { reason: "payment_order_already_linked" } });
  });
});

describe("GET cohort — the name only through the identity layer", () => {
  const listRow = (n: number): CohortListRow => ({
    ...cohortRow({ id: W(900 + n) }),
    sortKey: `2026-12-01T10:00:0${n}.000000Z`,
  });

  it("with names disclosed: factory_name on each row, and never a phone", async () => {
    const h = harness({
      listRows: [listRow(1), listRow(2)],
      names: new Map([
        [W(901), "Shree Precision Works"],
        [W(902), null],
      ]),
    });
    const page = await h.service.listCohort(ADMIN, { limit: 50 }, CTX);
    expect(h.identity.resolve).toHaveBeenCalledWith(
      ADMIN,
      "launch_test_factories",
      [W(901), W(902)],
      null,
      CTX,
    );
    expect(page.rows.map((r) => r.factory_name)).toEqual(["Shree Precision Works", null]);
    expect(page.rows[0]).toMatchObject({
      has_phone: true,
      share_count: 2,
      worker_ids: [W(1), W(2)],
    });
    expect(JSON.stringify(page)).not.toMatch(/phone_(e164|hash|enc)|factory_phone"/);
    expect(page.next_cursor).toBeNull();
  });

  it("without read_identity (the identity layer answers null): the field is ABSENT, not null", async () => {
    const h = harness({ listRows: [listRow(1)], names: null });
    const page = await h.service.listCohort(ADMIN, { limit: 50 }, CTX);
    expect(page.rows[0]).not.toHaveProperty("factory_name");
  });

  it("one row past the page: a cursor from the last row's full-precision key", async () => {
    const h = harness({ listRows: [listRow(1), listRow(2), listRow(3)] });
    const page = await h.service.listCohort(ADMIN, { limit: 2 }, CTX);
    expect(page.rows).toHaveLength(2);
    expect(h.repo.listCohort).toHaveBeenCalledWith(null, 3);
    const decoded = JSON.parse(Buffer.from(page.next_cursor!, "base64url").toString("utf8")) as {
      c: string;
      i: string;
    };
    expect(decoded).toEqual({ c: "2026-12-01T10:00:02.000000Z", i: W(902) });
  });
});

describe("GET contacts-per-hire", () => {
  it("answers the report of the repository's rows, with its limit", async () => {
    const h = harness();
    h.repo.contactsPerHire.mockResolvedValueOnce({
      hires: [
        {
          hireId: W(1),
          tenantPayerId: PAYER,
          workerId: W(2),
          postingKind: "company_posting",
          postingId: W(3),
          postingExists: true,
          confirmedKey: "2026-12-10T10:00:00.000000Z",
        },
      ],
      contacts: [],
    });
    const report = await h.service.contactsPerHire();
    expect(h.repo.contactsPerHire).toHaveBeenCalledWith(50);
    expect(report.limit).toBe(50);
    expect(report.hires[0]).toMatchObject({ hire_id: W(1), contacts: [], contacts_reason: null });
    expect(report.totals.contacts_per_hire).toEqual({ numerator: 0, denominator: 1 });
  });

  it("FAILS CLOSED when a #2753 table is missing: 503", async () => {
    const h = harness();
    h.repo.contactsPerHire.mockRejectedValueOnce({ cause: { code: "42P01" } });
    await expect(h.service.contactsPerHire()).rejects.toThrow(ServiceUnavailableException);
  });
});

describe("errors keep their meaning", () => {
  it("a refusal is a Nest HTTP exception with a closed reason, never a 500", async () => {
    const h = harness({ phoneRecorded: true });
    await expect(h.service.recordFactory(ADMIN, dto(), KEY, CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
