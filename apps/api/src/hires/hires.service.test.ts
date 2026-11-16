import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { EVENT_REGISTRY, validateEvent, type EventName } from "@badabhai/event-schema";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { ownTenantKey } from "../payers/payer-tenant-scope.test-support";
import type { HireState } from "./hire-state";
import type { HeldHire, HireKey } from "./hires.repository";
import { HiresService, type HireOrigin } from "./hires.service";

/**
 * #2753 item 9 — `HiresService` at the service seam, over an in-memory `hires` with the
 * repository's contract (one row per key; an insert that finds one returns null). Every emitted
 * event goes through the REAL registry validation, so a payload the spine would refuse fails here.
 * The SQL runs on Postgres in hires.db.test.ts.
 */

const COMPANY = "aaaaaaaa-0000-4000-8000-00000000000a";
const WORKER = "33333333-3333-4333-8333-000000000001";
const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const T1 = new Date("2026-11-16T04:00:00.000Z");
const T2 = new Date("2026-11-17T04:00:00.000Z");
const T3 = new Date("2026-11-18T04:00:00.000Z");
const TX = { tx: "the caller's" } as never;

const BY_COMPANY: HireOrigin = {
  actor: { actor_type: "payer", actor_id: COMPANY },
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};
const BY_WORKER: HireOrigin = {
  actor: { actor_type: "worker", actor_id: WORKER },
  correlationId: "22222222-2222-4222-8222-222222222223",
};
const BY_DESK: HireOrigin = {
  actor: { actor_type: "admin", actor_id: "dddddddd-0000-4000-8000-00000000000d" },
  correlationId: "22222222-2222-4222-8222-222222222224",
};

async function keyOf(over: Partial<HireKey> = {}): Promise<HireKey> {
  const tenantPayerId: TenantKey = await ownTenantKey(COMPANY);
  return {
    tenantPayerId,
    workerId: WORKER,
    postingKind: "company_posting",
    postingId: POSTING,
    ...over,
  };
}

function memoryHiresRepo() {
  const rows = new Map<string, HeldHire & { key: HireKey }>();
  const id = (k: HireKey) => `${k.tenantPayerId}|${k.workerId}|${k.postingKind}|${k.postingId}`;
  let n = 0;
  /** Set to make the next insert lose a race: the row appears, the insert returns null. */
  let raceNextInsert: HireState | null = null;
  const repo = {
    rows,
    loseNextInsertTo(state: HireState) {
      raceNextInsert = state;
    },
    lockByKey: vi.fn(async (k: HireKey, _tx: unknown): Promise<HeldHire | null> => {
      const r = rows.get(id(k));
      if (!r) return null;
      const { key: _key, ...held } = r;
      return held;
    }),
    insert: vi.fn(async (k: HireKey, state: HireState, _at: Date, _tx: unknown) => {
      if (raceNextInsert !== null) {
        const winner = `0e000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        rows.set(id(k), { id: winner, key: k, ...raceNextInsert });
        raceNextInsert = null;
        return null;
      }
      if (rows.has(id(k))) return null;
      const newId = `0e000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      rows.set(id(k), { id: newId, key: k, ...state });
      return newId;
    }),
    update: vi.fn(async (hireId: string, state: HireState, _at: Date, _tx: unknown) => {
      for (const [k, r] of rows) if (r.id === hireId) rows.set(k, { ...r, ...state });
    }),
    listForAdmin: vi.fn(async () => []),
  };
  return repo;
}

function make(over: { enabled?: boolean } = {}) {
  const repo = memoryHiresRepo();
  const emitted: Record<string, unknown>[] = [];
  const emit = vi.fn(async (params: Record<string, unknown>) => {
    const { correlationId, requestId: _r, tx: _tx, ...rest } = params;
    const result = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_version: EVENT_REGISTRY[rest.event_name as EventName].version,
      occurred_at: T1.toISOString(),
      source: "api",
      correlation_id: correlationId,
      causation_id: null,
      metadata: { environment: "test", service: "api" },
      ...rest,
    });
    if (!result.success) throw new Error(`invalid event: ${JSON.stringify(result.error)}`);
    emitted.push(params);
  });
  const svc = new HiresService(repo as never, { emit } as never, {
    HIRE_RECORDS_ENABLED: over.enabled ?? true,
  });
  const only = () => {
    expect(repo.rows.size).toBe(1);
    return [...repo.rows.values()][0]!;
  };
  return { svc, repo, emit, emitted, only };
}

describe("each source, on its own", () => {
  it("recordCompanyMark: one confirmed record, the mark stamped, the hire day set, one event", async () => {
    const d = make();
    const out = await d.svc.recordCompanyMark(await keyOf(), T1, TX, BY_COMPANY);
    expect(out).toEqual({ changed: true, hire: { id: expect.any(String), status: "confirmed" } });
    expect(d.only()).toMatchObject({
      status: "confirmed",
      companyMarkedAt: T1,
      companyAnsweredAt: null,
      workerAnsweredAt: null,
      deskConfirmedAt: null,
      hiredOn: "2026-11-16",
    });
    expect(d.emitted).toHaveLength(1);
    expect(d.emitted[0]).toMatchObject({
      event_name: "hire.recorded",
      actor: BY_COMPANY.actor,
      subject: { subject_type: "worker", subject_id: WORKER },
      payload: {
        hire_id: out.hire!.id,
        worker_id: WORKER,
        posting_kind: "company_posting",
        posting_id: POSTING,
        status: "confirmed",
        source: "company_mark",
      },
      correlationId: BY_COMPANY.correlationId,
      requestId: "req-1",
      tx: TX,
    });
  });

  it("recordCompanyAnswer: confirmed, the answer stamped", async () => {
    const d = make();
    await d.svc.recordCompanyAnswer(await keyOf(), T1, TX, BY_COMPANY);
    expect(d.only()).toMatchObject({ status: "confirmed", companyAnsweredAt: T1 });
    expect(d.emitted[0]!.payload).toMatchObject({ status: "confirmed", source: "company_answer" });
  });

  it("recordWorkerAnswer: REPORTED (owner question 2 default), the worker the actor", async () => {
    const d = make();
    await d.svc.recordWorkerAnswer(await keyOf(), T1, TX, BY_WORKER);
    expect(d.only()).toMatchObject({ status: "reported", workerAnsweredAt: T1, hiredOn: null });
    expect(d.emitted[0]).toMatchObject({
      actor: BY_WORKER.actor,
      payload: { status: "reported", source: "worker_answer" },
    });
  });

  it("confirmByDesk: confirmed, the desk stamped, the admin the actor", async () => {
    const d = make();
    await d.svc.confirmByDesk(await keyOf(), T1, TX, BY_DESK);
    expect(d.only()).toMatchObject({ status: "confirmed", deskConfirmedAt: T1 });
    expect(d.emitted[0]).toMatchObject({
      actor: BY_DESK.actor,
      payload: { status: "confirmed", source: "desk_confirm" },
    });
  });

  it("reject: rejects an existing record (timestamps kept); on no record it creates nothing", async () => {
    const d = make();
    const key = await keyOf();
    await expect(d.svc.reject(key, T1, TX, BY_DESK)).resolves.toEqual({
      changed: false,
      hire: null,
    });
    expect(d.repo.insert).not.toHaveBeenCalled();
    await d.svc.recordCompanyMark(key, T1, TX, BY_COMPANY);
    const out = await d.svc.reject(key, T2, TX, BY_DESK);
    expect(out).toMatchObject({ changed: true, hire: { status: "rejected" } });
    expect(d.only()).toMatchObject({ status: "rejected", companyMarkedAt: T1 });
    expect(d.emitted.map((e) => (e.payload as { source: string }).source)).toEqual([
      "company_mark",
      "desk_reject",
    ]);
  });
});

describe("the issue's check: a hired mark, a company answer and a worker answer give ONE record", () => {
  it("one row, confirmed, every source stamped, one event per source", async () => {
    const d = make();
    const key = await keyOf();
    const a = await d.svc.recordCompanyMark(key, T1, TX, BY_COMPANY);
    const b = await d.svc.recordCompanyAnswer(key, T2, TX, BY_COMPANY);
    const c = await d.svc.recordWorkerAnswer(key, T3, TX, BY_WORKER);
    expect(new Set([a.hire!.id, b.hire!.id, c.hire!.id]).size).toBe(1);
    expect(d.only()).toMatchObject({
      status: "confirmed",
      companyMarkedAt: T1,
      companyAnsweredAt: T2,
      workerAnsweredAt: T3,
      hiredOn: "2026-11-16",
    });
    expect(d.repo.insert).toHaveBeenCalledOnce();
    expect(d.emitted.map((e) => e.payload)).toEqual([
      expect.objectContaining({ status: "confirmed", source: "company_mark" }),
      expect.objectContaining({ status: "confirmed", source: "company_answer" }),
      expect.objectContaining({ status: "confirmed", source: "worker_answer" }),
    ]);
  });

  it("in the other order (the worker first) it is still one record, confirmed by the company", async () => {
    const d = make();
    const key = await keyOf();
    await d.svc.recordWorkerAnswer(key, T1, TX, BY_WORKER);
    await d.svc.recordCompanyAnswer(key, T2, TX, BY_COMPANY);
    await d.svc.recordCompanyMark(key, T3, TX, BY_COMPANY);
    expect(d.only()).toMatchObject({ status: "confirmed", hiredOn: "2026-11-17" });
  });

  it("another posting, worker or company is another record", async () => {
    const d = make();
    await d.svc.recordCompanyMark(await keyOf(), T1, TX, BY_COMPANY);
    await d.svc.recordCompanyMark(await keyOf({ postingKind: "agency_job" }), T1, TX, BY_COMPANY);
    await d.svc.recordCompanyMark(
      await keyOf({ workerId: "33333333-3333-4333-8333-000000000002" }),
      T1,
      TX,
      BY_COMPANY,
    );
    expect(d.repo.rows.size).toBe(3);
  });
});

describe("a worker answer after a confirmation stays confirmed", () => {
  it("company mark, then the worker's answer: confirmed, his answer recorded", async () => {
    const d = make();
    const key = await keyOf();
    await d.svc.recordCompanyMark(key, T1, TX, BY_COMPANY);
    const out = await d.svc.recordWorkerAnswer(key, T2, TX, BY_WORKER);
    expect(out).toMatchObject({ changed: true, hire: { status: "confirmed" } });
    expect(d.only()).toMatchObject({ status: "confirmed", workerAnsweredAt: T2 });
  });
});

describe("the undo rule, and a re-mark", () => {
  it("out of hired with only the mark: rejected, history kept; a re-mark confirms it again", async () => {
    const d = make();
    const key = await keyOf();
    await d.svc.recordCompanyMark(key, T1, TX, BY_COMPANY);
    const undone = await d.svc.undoCompanyMark(key, T2, TX, BY_COMPANY);
    expect(undone).toMatchObject({ changed: true, hire: { status: "rejected" } });
    expect(d.only()).toMatchObject({
      status: "rejected",
      companyMarkedAt: T1,
      hiredOn: "2026-11-16",
    });
    const again = await d.svc.recordCompanyMark(key, T3, TX, BY_COMPANY);
    expect(again).toMatchObject({ changed: true, hire: { status: "confirmed" } });
    expect(d.only()).toMatchObject({ status: "confirmed", companyMarkedAt: T1 });
    expect(d.emitted.map((e) => e.payload)).toEqual([
      expect.objectContaining({ status: "confirmed", source: "company_mark" }),
      expect.objectContaining({ status: "rejected", source: "company_unmark" }),
      expect.objectContaining({ status: "confirmed", source: "company_mark" }),
    ]);
  });

  it("out of hired when the company's answer also confirmed it: stays confirmed, no event", async () => {
    const d = make();
    const key = await keyOf();
    await d.svc.recordCompanyMark(key, T1, TX, BY_COMPANY);
    await d.svc.recordCompanyAnswer(key, T2, TX, BY_COMPANY);
    d.emit.mockClear();
    const out = await d.svc.undoCompanyMark(key, T3, TX, BY_COMPANY);
    expect(out).toMatchObject({ changed: false, hire: { status: "confirmed" } });
    expect(d.repo.update).toHaveBeenCalledTimes(1); // the answer's, never the undo's
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("out of hired when the desk confirmed it: stays confirmed", async () => {
    const d = make();
    const key = await keyOf();
    await d.svc.recordCompanyMark(key, T1, TX, BY_COMPANY);
    await d.svc.confirmByDesk(key, T2, TX, BY_DESK);
    await expect(d.svc.undoCompanyMark(key, T3, TX, BY_COMPANY)).resolves.toMatchObject({
      changed: false,
    });
    expect(d.only().status).toBe("confirmed");
  });

  it("out of hired with no record (a mark from before the switch): nothing written", async () => {
    const d = make();
    await expect(d.svc.undoCompanyMark(await keyOf(), T1, TX, BY_COMPANY)).resolves.toEqual({
      changed: false,
      hire: null,
    });
    expect(d.repo.insert).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });
});

describe("one event per REAL change", () => {
  it("a repeat of any source writes nothing and emits nothing", async () => {
    const d = make();
    const key = await keyOf();
    await d.svc.recordCompanyMark(key, T1, TX, BY_COMPANY);
    await d.svc.recordCompanyAnswer(key, T1, TX, BY_COMPANY);
    await d.svc.recordWorkerAnswer(key, T1, TX, BY_WORKER);
    await d.svc.confirmByDesk(key, T1, TX, BY_DESK);
    d.emit.mockClear();
    d.repo.update.mockClear();
    for (const call of [
      () => d.svc.recordCompanyMark(key, T2, TX, BY_COMPANY),
      () => d.svc.recordCompanyAnswer(key, T2, TX, BY_COMPANY),
      () => d.svc.recordWorkerAnswer(key, T2, TX, BY_WORKER),
      () => d.svc.confirmByDesk(key, T2, TX, BY_DESK),
    ]) {
      await expect(call()).resolves.toMatchObject({
        changed: false,
        hire: { status: "confirmed" },
      });
    }
    expect(d.repo.update).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.only()).toMatchObject({ companyMarkedAt: T1, deskConfirmedAt: T1 });
  });

  it("an event failure fails the call (the caller's transaction rolls the row back with it)", async () => {
    const d = make();
    d.emit.mockRejectedValueOnce(new Error("events insert failed"));
    await expect(d.svc.recordCompanyMark(await keyOf(), T1, TX, BY_COMPANY)).rejects.toThrow(
      "events insert failed",
    );
  });
});

describe("a concurrent first write", () => {
  it("losing the insert locks the winner's row and decides again from it", async () => {
    const d = make();
    const key = await keyOf();
    // A worker answer committed between our lock (no row) and our insert.
    d.repo.loseNextInsertTo({
      status: "reported",
      companyMarkedAt: null,
      companyAnsweredAt: null,
      workerAnsweredAt: T1,
      deskConfirmedAt: null,
      hiredOn: null,
    });
    const out = await d.svc.recordCompanyMark(key, T2, TX, BY_COMPANY);
    expect(out).toMatchObject({ changed: true, hire: { status: "confirmed" } });
    expect(d.repo.lockByKey).toHaveBeenCalledTimes(2);
    expect(d.only()).toMatchObject({
      status: "confirmed",
      workerAnsweredAt: T1,
      companyMarkedAt: T2,
    });
    expect(d.emitted).toHaveLength(1);
  });
});

describe("HIRE_RECORDS_ENABLED off: absent", () => {
  it("every source answers nothing without touching the table or the spine", async () => {
    const d = make({ enabled: false });
    expect(d.svc.enabled).toBe(false);
    const key = await keyOf();
    for (const call of [
      () => d.svc.recordCompanyMark(key, T1, TX, BY_COMPANY),
      () => d.svc.undoCompanyMark(key, T1, TX, BY_COMPANY),
      () => d.svc.recordCompanyAnswer(key, T1, TX, BY_COMPANY),
      () => d.svc.recordWorkerAnswer(key, T1, TX, BY_WORKER),
      () => d.svc.confirmByDesk(key, T1, TX, BY_DESK),
      () => d.svc.reject(key, T1, TX, BY_DESK),
    ]) {
      await expect(call()).resolves.toEqual({ changed: false, hire: null });
    }
    expect(d.repo.lockByKey).not.toHaveBeenCalled();
    expect(d.repo.insert).not.toHaveBeenCalled();
    expect(d.repo.update).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("the admin list is a 404 and runs no query", async () => {
    const d = make({ enabled: false });
    await expect(d.svc.listForAdmin({ limit: 50 })).rejects.toBeInstanceOf(NotFoundException);
    expect(d.repo.listForAdmin).not.toHaveBeenCalled();
  });

  it("only `true` is on: a config without the key is off", () => {
    const svc = new HiresService({} as never, {} as never, {} as never);
    expect(svc.enabled).toBe(false);
  });
});

describe("listForAdmin — the admin page", () => {
  const row = (i: number) => ({
    id: `0e000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    tenantPayerId: COMPANY,
    workerId: WORKER,
    postingKind: "company_posting" as const,
    postingId: POSTING,
    status: "confirmed" as const,
    companyMarkedAt: T1,
    companyAnsweredAt: null,
    workerAnsweredAt: null,
    deskConfirmedAt: null,
    hiredOn: "2026-11-16",
    createdAt: new Date(T1.getTime() - i * 1000),
    updatedAt: T1,
  });

  it("over-fetches by one, maps to snake_case, and the cursor names the last row", async () => {
    const d = make();
    d.repo.listForAdmin.mockResolvedValueOnce([row(1), row(2), row(3)] as never);
    const page = await d.svc.listForAdmin({ limit: 2, status: "confirmed" });
    expect(d.repo.listForAdmin).toHaveBeenCalledWith({ status: "confirmed" }, null, 3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toEqual({
      id: row(1).id,
      tenant_payer_id: COMPANY,
      worker_id: WORKER,
      posting_kind: "company_posting",
      posting_id: POSTING,
      status: "confirmed",
      company_marked_at: T1,
      company_answered_at: null,
      worker_answered_at: null,
      desk_confirmed_at: null,
      hired_on: "2026-11-16",
      created_at: row(1).createdAt,
      updated_at: T1,
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    // The next page asks from the second row.
    await d.svc.listForAdmin({ limit: 2, cursor: page.nextCursor! });
    expect(d.repo.listForAdmin).toHaveBeenLastCalledWith(
      { status: undefined },
      { createdAt: row(2).createdAt.toISOString(), id: row(2).id },
      3,
    );
  });

  it("an exact page has no phantom next page; a garbage cursor reads as the first page", async () => {
    const d = make();
    d.repo.listForAdmin.mockResolvedValueOnce([row(1), row(2)] as never);
    const page = await d.svc.listForAdmin({ limit: 2, cursor: "not-a-cursor" });
    expect(page.nextCursor).toBeNull();
    expect(d.repo.listForAdmin).toHaveBeenCalledWith({ status: undefined }, null, 3);
  });
});
