import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PayOnJoiningHire } from "@badabhai/db";
import { createEvent } from "@badabhai/event-schema";
import { RedactedQueryError } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import type { CreatePojHireDto } from "./pay-on-joining-hires.dto";
import type { PojHireUpdate, PojHireWrite } from "./pay-on-joining-hires.repository";
import { PayOnJoiningHiresService } from "./pay-on-joining-hires.service";

/**
 * #2753 item 11 — the hire record's contract with the database and the event spine faked. What is
 * pinned here is what a DB gate cannot see as directly:
 *
 *   - the percent is COPIED from the setting at create, and an edit's recompute uses the STORED
 *     percent even after the setting moved;
 *   - the share is the server's floor, never a client's;
 *   - an edit that moves nothing writes, audits and emits nothing;
 *   - the row, the audit row and both events run on ONE transaction, and a failing emit fails the
 *     write;
 *   - the events carry ids, paise and closed values, and the note never rides one;
 *   - database refusals become 409 / 400, and anything else is rethrown with its bound
 *     parameters (the note) stripped.
 */

const TX = { tx: "the-one-transaction" } as never;
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `poj-${randomUUID()}` };
const ADMIN = { id: randomUUID(), role: "ops_admin" as const, sid: "s" };
const FACTORY = randomUUID();
const PARTNER = randomUUID();
const WORKER = randomUUID();
const POSTING = randomUUID();
const HIRE = randomUUID();
const NOTE = "Joined on the second shift; the plant manager confirmed by visit";

const BASE: CreatePojHireDto = {
  factory_payer_id: FACTORY,
  worker_id: WORKER,
  joined_on: "2026-12-01",
  fee_paise: 500_000,
  partner_payer_id: PARTNER,
  note: NOTE,
};

function stored(over: Partial<PayOnJoiningHire> = {}): PayOnJoiningHire {
  return {
    id: HIRE,
    factoryPayerId: FACTORY,
    jobPostingId: null,
    workerId: WORKER,
    partnerPayerId: PARTNER,
    joinedOn: "2026-12-01",
    stayCheckedOn: null,
    stayed30Days: null,
    feePaise: 500_000,
    partnerSharePercent: 70,
    partnerSharePaise: 350_000,
    invoicedOn: null,
    factoryPaidOn: null,
    partnerPaidOn: null,
    note: NOTE,
    createdByAdminId: ADMIN.id,
    updatedByAdminId: ADMIN.id,
    createdAt: new Date("2026-12-01T05:00:00.000Z"),
    updatedAt: new Date("2026-12-01T05:00:00.000Z"),
    ...over,
  };
}

function harness(opts: { percent?: number; current?: PayOnJoiningHire | undefined } = {}) {
  const config = { POJ_PARTNER_SHARE_PERCENT: opts.percent ?? 70 };
  const calls: string[] = [];
  const current = "current" in opts ? opts.current : stored();
  const repo = {
    withTransaction: vi.fn(async (work: (tx: never) => Promise<unknown>) => {
      calls.push("begin");
      const out = await work(TX);
      calls.push("commit");
      return out;
    }),
    list: vi.fn(async () => []),
    lockById: vi.fn(async (tx: unknown) => {
      expect(tx).toBe(TX);
      calls.push("lock");
      return current;
    }),
    insert: vi.fn(async (tx: unknown, values: PojHireWrite) => {
      expect(tx).toBe(TX);
      calls.push("insert");
      return stored({ ...(values as Partial<PayOnJoiningHire>), id: HIRE });
    }),
    update: vi.fn(async (tx: unknown, _id: string, set: PojHireUpdate) => {
      expect(tx).toBe(TX);
      calls.push("update");
      return { ...current!, ...(set as Partial<PayOnJoiningHire>) };
    }),
    writeAudit: vi.fn(async (tx: unknown) => {
      expect(tx).toBe(TX);
      calls.push("audit");
    }),
  };
  const emitted: Array<{
    event_name: string;
    payload: Record<string, unknown>;
    tx: unknown;
    idempotencyKey?: string;
  }> = [];
  const events = {
    emit: vi.fn(
      async (params: { event_name: string; payload: Record<string, unknown>; tx: unknown }) => {
        calls.push(`emit:${params.event_name}`);
        emitted.push(params);
        // The real contract: the event is built and VALIDATED against the registry.
        return createEvent({
          event_name: params.event_name,
          actor: { actor_type: "admin", actor_id: ADMIN.id },
          subject: { subject_type: "payer", subject_id: FACTORY },
          source: "api",
          correlation_id: CTX.correlationId,
          payload: params.payload,
          metadata: { environment: "test", service: "api" },
        } as never);
      },
    ),
  };
  const service = new PayOnJoiningHiresService(repo as never, events as never, config as never);
  return { service, repo, events, emitted, calls, config };
}

describe("create — the percent is the setting's, copied; the share is the server's", () => {
  it("copies POJ_PARTNER_SHARE_PERCENT onto the row and computes the floor share", async () => {
    const { service, repo } = harness({ percent: 70 });
    const out = await service.create(ADMIN, { ...BASE, fee_paise: 500_099 }, CTX);
    const values = repo.insert.mock.calls[0]![1];
    expect(values.partnerSharePercent).toBe(70);
    // floor(500099 * 70 / 100) = floor(350069.3)
    expect(values.partnerSharePaise).toBe(350_069);
    expect(values.createdByAdminId).toBe(ADMIN.id);
    expect(values.updatedByAdminId).toBe(ADMIN.id);
    expect(out.changed).toBe(true);
    expect(out.hire).toMatchObject({
      partner_share_percent: 70,
      partner_share_paise: 350_069,
      payment_state: "awaiting_factory",
    });
  });

  it("70% of ₹5,000 is 350000 paise; another setting is copied as it stands", async () => {
    const seventy = harness({ percent: 70 });
    await seventy.service.create(ADMIN, BASE, CTX);
    expect(seventy.repo.insert.mock.calls[0]![1].partnerSharePaise).toBe(350_000);

    const sixty = harness({ percent: 60 });
    await sixty.service.create(ADMIN, BASE, CTX);
    expect(sixty.repo.insert.mock.calls[0]![1]).toMatchObject({
      partnerSharePercent: 60,
      partnerSharePaise: 300_000,
    });
  });

  it("row, audit and both events run on ONE transaction, in that order", async () => {
    const { service, calls, emitted } = harness();
    await service.create(ADMIN, BASE, CTX);
    expect(calls).toEqual([
      "begin",
      "insert",
      "audit",
      "emit:pay_on_joining.recorded",
      "emit:admin.action_performed",
      "commit",
    ]);
    for (const e of emitted) expect(e.tx).toBe(TX);
  });

  it("a failing emit fails the write: nothing commits", async () => {
    const { service, events, calls } = harness();
    events.emit.mockRejectedValueOnce(new Error("spine down"));
    await expect(service.create(ADMIN, BASE, CTX)).rejects.toThrow("spine down");
    expect(calls).not.toContain("commit");
  });

  it("the events carry ids, paise and closed values — never the note", async () => {
    const { service, emitted, repo } = harness();
    await service.create(ADMIN, { ...BASE, job_posting_id: POSTING, stay_checked_on: null }, CTX);
    const [recorded, action] = emitted;
    expect(recorded!.event_name).toBe("pay_on_joining.recorded");
    expect(recorded!.payload).toEqual({
      hire_id: HIRE,
      change: "created",
      // The keys the admin SET (a key sent as null set nothing).
      changed_fields: [
        "factory_payer_id",
        "job_posting_id",
        "worker_id",
        "partner_payer_id",
        "joined_on",
        "fee_paise",
        "note",
      ],
      factory_payer_id: FACTORY,
      partner_payer_id: PARTNER,
      job_posting_id: POSTING,
      worker_id: WORKER,
      fee_paise: 500_000,
      partner_share_percent: 70,
      partner_share_paise: 350_000,
      stayed_30_days: null,
      payment_state: "awaiting_factory",
    });
    expect(action!.payload).toEqual({
      admin_id: ADMIN.id,
      action_code: ADMIN_ACTION_CODES.pay_on_joining_hire_created,
      target_type: "pay_on_joining_hire",
      target_id: HIRE,
    });
    for (const e of emitted) expect(JSON.stringify(e.payload)).not.toContain("plant manager");
    const audit = repo.writeAudit.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(audit[1]).toEqual({
      adminId: ADMIN.id,
      hireId: HIRE,
      action: ADMIN_ACTION_CODES.pay_on_joining_hire_created,
      changedFields: expect.arrayContaining(["note", "fee_paise"]),
    });
    expect(JSON.stringify(audit[1])).not.toContain("plant manager");
  });

  it.each([
    [{ stay_checked_on: "2026-12-31" }, "go together"],
    [{ stayed_30_days: true }, "go together"],
    [{ partner_payer_id: null, partner_paid_on: "2027-01-10" }, "needs a partner_payer_id"],
    [{ partner_payer_id: FACTORY }, "cannot be the factory"],
  ])(
    "refuses a record that breaks a rule (%j) with a 400 and writes nothing",
    async (over, message) => {
      const { service, repo } = harness();
      const run = service.create(ADMIN, { ...BASE, ...over } as CreatePojHireDto, CTX);
      await expect(run).rejects.toBeInstanceOf(BadRequestException);
      await expect(run).rejects.toThrow(message);
      expect(repo.withTransaction).not.toHaveBeenCalled();
    },
  );
});

describe("update — a fee change recomputes with the STORED percent", () => {
  it("keeps the percent copied at create even after the setting changed", async () => {
    // Recorded at 70%; the setting is 50% now.
    const { service, repo } = harness({
      percent: 50,
      current: stored({ partnerSharePercent: 70 }),
    });
    const out = await service.update(ADMIN, HIRE, { fee_paise: 1_000_001 }, CTX);
    const set = repo.update.mock.calls[0]![2];
    expect(set).toEqual({
      feePaise: 1_000_001,
      partnerSharePaise: 700_000, // floor(1000001 * 70 / 100) = floor(700000.7)
      updatedByAdminId: ADMIN.id,
    });
    expect(set).not.toHaveProperty("partnerSharePercent");
    expect(out.hire).toMatchObject({ partner_share_percent: 70, partner_share_paise: 700_000 });
  });

  it("an edit that does not touch the fee leaves the share alone", async () => {
    const { service, repo } = harness();
    await service.update(ADMIN, HIRE, { factory_paid_on: "2027-01-05" }, CTX);
    expect(repo.update.mock.calls[0]![2]).toEqual({
      factoryPaidOn: "2027-01-05",
      updatedByAdminId: ADMIN.id,
    });
  });

  it("emits the changed KEYS and the state after the write, on the lock's transaction", async () => {
    const { service, emitted, calls } = harness();
    const out = await service.update(
      ADMIN,
      HIRE,
      {
        factory_paid_on: "2027-01-05",
        note: "Paid by NEFT after the second reminder",
        fee_paise: 500_000,
      },
      CTX,
    );
    expect(calls).toEqual([
      "begin",
      "lock",
      "update",
      "audit",
      "emit:pay_on_joining.recorded",
      "emit:admin.action_performed",
      "commit",
    ]);
    // fee_paise was sent unchanged, so it is not a changed field.
    expect(emitted[0]!.payload).toMatchObject({
      change: "updated",
      changed_fields: ["factory_paid_on", "note"],
      payment_state: "partner_due",
    });
    expect(JSON.stringify(emitted[0]!.payload)).not.toContain("NEFT");
    expect(emitted[1]!.payload).toMatchObject({
      action_code: ADMIN_ACTION_CODES.pay_on_joining_hire_updated,
    });
    // A create and an edit sharing a request id are still two events: the key carries the change.
    expect(emitted[0]!.idempotencyKey).toBe(
      `pay_on_joining.recorded:updated:${HIRE}:${CTX.requestId}`,
    );
    expect(out.changed).toBe(true);
  });

  it("an edit that moves nothing writes, audits and emits nothing", async () => {
    const { service, repo, events } = harness();
    const out = await service.update(ADMIN, HIRE, { fee_paise: 500_000, note: NOTE }, CTX);
    expect(out.changed).toBe(false);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.writeAudit).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a missing record is a 404", async () => {
    const { service } = harness({ current: undefined });
    await expect(service.update(ADMIN, HIRE, { fee_paise: 1 }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("judges the rules on the MERGED record: clearing the partner under a partner payment is a 400", async () => {
    const { service, repo } = harness({
      current: stored({ partnerPaidOn: "2027-01-10", factoryPaidOn: "2027-01-05" }),
    });
    await expect(service.update(ADMIN, HIRE, { partner_payer_id: null }, CTX)).rejects.toThrow(
      "needs a partner_payer_id",
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("the 30-day check can be recorded as a pair, and cleared as a pair", async () => {
    const first = harness();
    await first.service.update(
      ADMIN,
      HIRE,
      { stay_checked_on: "2026-12-31", stayed_30_days: true },
      CTX,
    );
    expect(first.emitted[0]!.payload).toMatchObject({ stayed_30_days: true });

    const second = harness({
      current: stored({ stayCheckedOn: "2026-12-31", stayed30Days: true }),
    });
    await expect(second.service.update(ADMIN, HIRE, { stayed_30_days: null }, CTX)).rejects.toThrow(
      "go together",
    );
  });
});

describe("what the database refuses", () => {
  const dbError = (code: string, constraint?: string) =>
    Object.assign(new Error("Failed query: insert ...\nparams: " + NOTE), {
      query: 'insert into "pay_on_joining_hires" ...',
      params: [NOTE],
      cause: { code, constraint_name: constraint },
    });

  it("a second record of the same hire is a 409", async () => {
    const { service, repo } = harness();
    repo.insert.mockRejectedValueOnce(dbError("23505", "pay_on_joining_hires_hire_uq"));
    await expect(service.create(ADMIN, BASE, CTX)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    ["pay_on_joining_hires_factory_payer_id_payers_id_fk", "factory_payer_id names no record"],
    ["pay_on_joining_hires_partner_payer_id_payers_id_fk", "partner_payer_id names no record"],
    ["pay_on_joining_hires_job_posting_id_job_postings_id_fk", "job_posting_id names no record"],
    ["pay_on_joining_hires_worker_id_workers_id_fk", "worker_id names no record"],
  ])("an unknown id (%s) is a 400 naming the field", async (constraint, message) => {
    const { service, repo } = harness();
    repo.insert.mockRejectedValueOnce(dbError("23503", constraint));
    const run = service.create(ADMIN, BASE, CTX);
    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.toThrow(message);
  });

  it("anything else is rethrown with the bound parameters (the note) stripped", async () => {
    const { service, repo } = harness();
    repo.insert.mockRejectedValueOnce(dbError("40P01"));
    const err = await service.create(ADMIN, BASE, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedactedQueryError);
    expect((err as Error).message).not.toContain("plant manager");
    expect((err as Error).stack ?? "").not.toContain("plant manager");
  });
});

describe("list", () => {
  it("pages newest first and hands back an honest cursor", async () => {
    const { service, repo } = harness();
    const rows = [0, 1, 2].map((i) => ({
      ...stored({ id: randomUUID() }),
      sortKey: `2026-12-0${3 - i}T05:00:00.000123Z`,
    }));
    repo.list.mockResolvedValueOnce(rows as never);
    const page = await service.list({ limit: 2, paid: "partner_due" });
    expect(repo.list).toHaveBeenCalledWith(
      { factoryPayerId: undefined, partnerPayerId: undefined, paid: "partner_due" },
      null,
      3,
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    expect(decoded).toEqual({ c: rows[1]!.sortKey, i: rows[1]!.id });
  });

  it("the last page has no cursor", async () => {
    const { service, repo } = harness();
    repo.list.mockResolvedValueOnce([
      { ...stored(), sortKey: "2026-12-01T05:00:00.000000Z" },
    ] as never);
    expect((await service.list({ limit: 50 })).nextCursor).toBeNull();
  });
});
