import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { loadServerConfig } from "@badabhai/config";
import { EVENT_REGISTRY, validateEvent, type EventName } from "@badabhai/event-schema";
import type { UnlockOutcome, UnlockOutcomeAnswerer } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { defaultModeResolver, resolverOver } from "../payers/payer-tenant-scope.test-support";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { decodeDueCursor, type DueUnlocksQueryDto } from "./unlock-outcomes.dto";
import type {
  DueRow,
  HeldOutcome,
  OpenedUnlock,
  OutcomeAnswer,
} from "./unlock-outcomes.repository";
import { UnlockOutcomesService, postingOf, type OutcomeOrigin } from "./unlock-outcomes.service";

/**
 * #2753 item 10 — `UnlockOutcomesService` at the service seam, over an in-memory `unlocks` +
 * `unlock_outcomes` with the repository's contract (the ownership read returns null for anything
 * not the tenant's opened contact; one answer row per unlock; an insert that finds one returns
 * false). Every emitted event goes through the REAL registry validation. The SQL — the due list,
 * the ownership predicate, the CHECKs, the cascade — runs on Postgres in unlock-outcomes.db.test.ts.
 */

const COMPANY = "aaaaaaaa-0000-4000-8000-00000000000a";
const TEAMMATE = "aaaaaaaa-0000-4000-8000-00000000000b";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";
const ADMIN = "dddddddd-0000-4000-8000-00000000000d";
const WORKER = "33333333-3333-4333-8333-000000000001";
const POSTING = "0c000000-0000-4000-8000-0000000000a1";
const JOB = "0b000000-0000-4000-8000-0000000000b1";
const U = {
  posting: "0a000000-0000-4000-8000-000000000001",
  job: "0a000000-0000-4000-8000-000000000002",
  bare: "0a000000-0000-4000-8000-000000000003",
  other: "0a000000-0000-4000-8000-000000000004",
  unknown: "0a000000-0000-4000-8000-0000000000ff",
};
const T1 = new Date("2026-11-16T04:00:00.000Z");
const T2 = new Date("2026-11-17T04:00:00.000Z");
const T3 = new Date("2026-11-25T04:00:00.000Z");
const TX = { tx: "the answer's" } as never;
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};
const BY_DESK: OutcomeOrigin = {
  actor: { actor_type: "admin", actor_id: ADMIN },
  correlationId: "22222222-2222-4222-8222-222222222224",
};

/** The opened contacts in the world: the company's three (by context) and another company's. */
const OPENED: OpenedUnlock[] = [
  {
    unlockId: U.posting,
    tenantPayerId: COMPANY,
    workerId: WORKER,
    jobId: null,
    jobPostingId: POSTING,
  },
  { unlockId: U.job, tenantPayerId: COMPANY, workerId: WORKER, jobId: JOB, jobPostingId: null },
  { unlockId: U.bare, tenantPayerId: COMPANY, workerId: WORKER, jobId: null, jobPostingId: null },
  { unlockId: U.other, tenantPayerId: OTHER, workerId: WORKER, jobId: null, jobPostingId: null },
];

interface StoredRow extends HeldOutcome {
  readonly tenantPayerId: string;
  readonly workerId: string;
}

function memoryRepo() {
  const rows = new Map<string, StoredRow>();
  /** Set to make the next insert lose a race: the row appears, the insert returns false. */
  let raceNextInsert: HeldOutcome | null = null;
  /** Set to make the next insert fail as Postgres does when the worker is gone (23503). */
  let workerGoneOnInsert = false;
  const repo = {
    rows,
    loseNextInsertTo(held: HeldOutcome) {
      raceNextInsert = held;
    },
    eraseWorkerBeforeInsert() {
      workerGoneOnInsert = true;
    },
    withTransaction: vi.fn(async <T>(fn: (tx: never) => Promise<T>) => fn(TX)),
    findOwnedOpened: vi.fn(async (unlockId: string, tenant: string, _tx: unknown) => {
      return OPENED.find((u) => u.unlockId === unlockId && u.tenantPayerId === tenant) ?? null;
    }),
    findOpened: vi.fn(async (unlockId: string, _tx: unknown) => {
      return OPENED.find((u) => u.unlockId === unlockId) ?? null;
    }),
    lockOutcome: vi.fn(async (unlockId: string, _tx: unknown): Promise<HeldOutcome | null> => {
      const r = rows.get(unlockId);
      return r ? { outcome: r.outcome, answeredBy: r.answeredBy, answeredAt: r.answeredAt } : null;
    }),
    insertOutcome: vi.fn(async (unlock: OpenedUnlock, answer: OutcomeAnswer, _tx: unknown) => {
      if (workerGoneOnInsert) {
        workerGoneOnInsert = false;
        throw Object.assign(new Error("Failed query"), { cause: { code: "23503" } });
      }
      if (raceNextInsert !== null) {
        rows.set(unlock.unlockId, { ...unlock, ...raceNextInsert });
        raceNextInsert = null;
        return false;
      }
      if (rows.has(unlock.unlockId)) return false;
      rows.set(unlock.unlockId, { ...unlock, ...answer });
      return true;
    }),
    updateOutcome: vi.fn(async (unlockId: string, answer: OutcomeAnswer, _tx: unknown) => {
      const r = rows.get(unlockId)!;
      rows.set(unlockId, { ...r, ...answer });
    }),
    listDue: vi.fn(
      async (
        _tenant: string,
        _cutoff: Date,
        _after: unknown,
        _limit: number,
      ): Promise<DueRow[]> => [],
    ),
  };
  return repo;
}

function make(
  over: {
    enabled?: boolean;
    hiresEnabled?: boolean;
    days?: number;
    tenancy?: PayerTenantScopeService;
  } = {},
) {
  const repo = memoryRepo();
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
  const hires = {
    enabled: over.hiresEnabled ?? true,
    recordCompanyAnswer: vi.fn(async () => ({ changed: true, hire: null })),
  };
  const svc = new UnlockOutcomesService(
    repo as never,
    { emit } as never,
    hires as never,
    over.tenancy ?? defaultModeResolver(),
    { UNLOCK_FOLLOWUP_ENABLED: over.enabled ?? true, UNLOCK_FOLLOWUP_AFTER_DAYS: over.days ?? 7 },
  );
  const answer = (unlockId: string, outcome: "hired" | "not_hired" | "still_talking", at = T1) =>
    svc.recordCompanyOutcome(COMPANY, unlockId, outcome, CTX, at);
  return { svc, repo, emit, emitted, hires, answer };
}

const expectEvent = (
  e: Record<string, unknown> | undefined,
  unlockId: string,
  outcome: UnlockOutcome,
  answeredBy: UnlockOutcomeAnswerer,
  actor: { actor_type: string; actor_id: string },
) =>
  expect(e).toMatchObject({
    event_name: "unlock.outcome_recorded",
    actor,
    subject: { subject_type: "unlock", subject_id: unlockId },
    payload: { unlock_id: unlockId, worker_id: WORKER, outcome, answered_by: answeredBy },
    tx: TX,
  });

describe("the switch OFF: 404 on both routes, and the desk writes nothing", () => {
  it("the routes 404 before any read, and nothing touches the table", async () => {
    const d = make({ enabled: false });
    await expect(d.answer(U.posting, "hired")).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      d.svc.listDue(COMPANY, { limit: 20 } as DueUnlocksQueryDto, T1),
    ).rejects.toBeInstanceOf(NotFoundException);
    for (const fn of Object.values(d.repo)) {
      if (typeof fn === "function" && "mock" in fn) expect(fn).not.toHaveBeenCalled();
    }
    expect(d.emitted).toEqual([]);
    expect(d.hires.recordCompanyAnswer).not.toHaveBeenCalled();
  });

  it("recordDeskOutcome answers null and touches nothing (the desk's tx never sees 42P01)", async () => {
    const d = make({ enabled: false });
    await expect(d.svc.recordDeskOutcome(U.posting, "not_reached", TX, BY_DESK, T1)).resolves.toBe(
      null,
    );
    expect(d.repo.findOpened).not.toHaveBeenCalled();
    expect(d.repo.lockOutcome).not.toHaveBeenCalled();
    expect(d.emitted).toEqual([]);
  });
});

describe("ownership: the unlock routes' chokepoint, one neutral 404", () => {
  it("an unknown id and another company's unlock get the SAME bare 404, nothing written", async () => {
    const d = make();
    const unknown = await d.answer(U.unknown, "hired").catch((e: unknown) => e);
    const foreign = await d.answer(U.other, "hired").catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(NotFoundException);
    expect(foreign).toBeInstanceOf(NotFoundException);
    expect((foreign as NotFoundException).getResponse()).toEqual(
      (unknown as NotFoundException).getResponse(),
    );
    // The same body the switch-off guard gives: Nest's bare NotFoundException.
    expect((foreign as NotFoundException).getResponse()).toEqual(
      new NotFoundException().getResponse(),
    );
    expect(d.repo.rows.size).toBe(0);
    expect(d.emitted).toEqual([]);
  });

  it("reads ownership with the TENANT key the session resolves to, inside the transaction", async () => {
    const d = make();
    await d.answer(U.posting, "not_hired");
    expect(d.repo.withTransaction).toHaveBeenCalledOnce();
    expect(d.repo.findOwnedOpened).toHaveBeenCalledWith(U.posting, COMPANY, TX);
  });

  it("org tenancy `on`: a teammate answers for the founder's company's unlock", async () => {
    const tenancy = resolverOver(
      loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" }),
      [{ anchor: COMPANY, members: [TEAMMATE] }],
    );
    const d = make({ tenancy });
    const out = await d.svc.recordCompanyOutcome(TEAMMATE, U.posting, "hired", CTX, T1);
    expect(out.changed).toBe(true);
    expect(d.repo.findOwnedOpened).toHaveBeenCalledWith(U.posting, COMPANY, TX);
    // The row is the company's; the event's actor is the teammate who answered.
    expect(d.repo.rows.get(U.posting)).toMatchObject({ tenantPayerId: COMPANY });
    expectEvent(d.emitted[0], U.posting, "hired", "company", {
      actor_type: "payer",
      actor_id: TEAMMATE,
    });
  });

  it("the worker erased between the read and the insert (23503) is the same 404", async () => {
    const d = make();
    d.repo.eraseWorkerBeforeInsert();
    await expect(d.answer(U.posting, "hired")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("any other failure is never converted (fail closed)", async () => {
    const d = make();
    d.repo.updateOutcome.mockRejectedValueOnce(new Error("boom"));
    await d.answer(U.posting, "still_talking");
    await expect(d.answer(U.posting, "hired", T2)).rejects.toThrow("boom");
  });
});

describe("one row per unlock, the event only on a real change", () => {
  it("the first answer: one row (company), one event, changed, no previous", async () => {
    const d = make();
    const out = await d.answer(U.posting, "still_talking");
    expect(out).toEqual({
      unlock_id: U.posting,
      worker_id: WORKER,
      outcome: "still_talking",
      previous_outcome: null,
      answered_at: T1.toISOString(),
      changed: true,
    });
    expect(d.repo.rows.get(U.posting)).toEqual({
      ...OPENED[0],
      outcome: "still_talking",
      answeredBy: "company",
      answeredAt: T1,
    });
    expect(d.emitted).toHaveLength(1);
    expectEvent(d.emitted[0], U.posting, "still_talking", "company", {
      actor_type: "payer",
      actor_id: COMPANY,
    });
  });

  it("a later answer REPLACES it (still_talking → hired): one row, one more event", async () => {
    const d = make();
    await d.answer(U.posting, "still_talking", T1);
    const out = await d.answer(U.posting, "hired", T2);
    expect(out).toMatchObject({
      outcome: "hired",
      previous_outcome: "still_talking",
      answered_at: T2.toISOString(),
      changed: true,
    });
    expect(d.repo.rows.size).toBe(1);
    expect(d.repo.rows.get(U.posting)).toMatchObject({ outcome: "hired", answeredAt: T2 });
    expect(d.emitted.map((e) => (e.payload as { outcome: string }).outcome)).toEqual([
      "still_talking",
      "hired",
    ]);
  });

  it("a repeated `hired` writes nothing and emits nothing: answered_at keeps its week", async () => {
    const d = make();
    await d.answer(U.posting, "hired", T1);
    d.repo.updateOutcome.mockClear();
    const out = await d.answer(U.posting, "hired", T2);
    expect(out).toMatchObject({
      outcome: "hired",
      previous_outcome: "hired",
      answered_at: T1.toISOString(),
      changed: false,
    });
    expect(d.repo.updateOutcome).not.toHaveBeenCalled();
    expect(d.emitted).toHaveLength(1);
  });

  it("a repeated `still_talking` restarts the wait (answered_at moves) with no event", async () => {
    const d = make();
    await d.answer(U.posting, "still_talking", T1);
    const out = await d.answer(U.posting, "still_talking", T3);
    expect(out).toMatchObject({ answered_at: T3.toISOString(), changed: false });
    expect(d.repo.rows.get(U.posting)).toMatchObject({ outcome: "still_talking", answeredAt: T3 });
    expect(d.emitted).toHaveLength(1);
  });

  it("a first answer that loses the insert race decides from the winner's committed row", async () => {
    const d = make();
    d.repo.loseNextInsertTo({ outcome: "still_talking", answeredBy: "company", answeredAt: T1 });
    const out = await d.answer(U.posting, "hired", T2);
    expect(out).toMatchObject({ previous_outcome: "still_talking", changed: true });
    expect(d.repo.lockOutcome).toHaveBeenCalledTimes(2);
    expect(d.repo.rows.get(U.posting)).toMatchObject({ outcome: "hired", answeredAt: T2 });
    // Only OUR change is emitted here; the winner emitted its own in its own transaction.
    expect(d.emitted).toHaveLength(1);
  });

  it("the same race with the same answer is a repeat: no event", async () => {
    const d = make();
    d.repo.loseNextInsertTo({ outcome: "not_hired", answeredBy: "company", answeredAt: T1 });
    const out = await d.answer(U.posting, "not_hired", T2);
    expect(out).toMatchObject({ changed: false, answered_at: T1.toISOString() });
    expect(d.emitted).toEqual([]);
  });
});

describe("the hire link (#2753 item 9): `hired` → HiresService.recordCompanyAnswer", () => {
  it("a company posting: the tenant, the worker and the posting, on the answer's tx", async () => {
    const d = make();
    await d.answer(U.posting, "hired", T1);
    expect(d.hires.recordCompanyAnswer).toHaveBeenCalledOnce();
    expect(d.hires.recordCompanyAnswer).toHaveBeenCalledWith(
      {
        tenantPayerId: COMPANY,
        workerId: WORKER,
        postingKind: "company_posting",
        postingId: POSTING,
      },
      T1,
      TX,
      {
        actor: { actor_type: "payer", actor_id: COMPANY },
        correlationId: CTX.correlationId,
        requestId: CTX.requestId,
      },
    );
  });

  it("an agency job: posting kind agency_job", async () => {
    const d = make();
    await d.answer(U.job, "hired", T1);
    expect(d.hires.recordCompanyAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ postingKind: "agency_job", postingId: JOB }),
      T1,
      TX,
      expect.anything(),
    );
  });

  it("no posting on the unlock: the outcome is stored, no hire is called", async () => {
    const d = make();
    const out = await d.answer(U.bare, "hired", T1);
    expect(out.changed).toBe(true);
    expect(d.repo.rows.get(U.bare)).toMatchObject({ outcome: "hired" });
    expect(d.hires.recordCompanyAnswer).not.toHaveBeenCalled();
  });

  it("HIRE_RECORDS_ENABLED off: the outcome is stored, no hire is called", async () => {
    const d = make({ hiresEnabled: false });
    await d.answer(U.posting, "hired", T1);
    expect(d.repo.rows.get(U.posting)).toMatchObject({ outcome: "hired" });
    expect(d.hires.recordCompanyAnswer).not.toHaveBeenCalled();
  });

  it("not_hired and still_talking never call it", async () => {
    const d = make();
    await d.answer(U.posting, "still_talking", T1);
    await d.answer(U.posting, "not_hired", T2);
    expect(d.hires.recordCompanyAnswer).not.toHaveBeenCalled();
  });

  it("a repeated `hired` calls it again (its own rules make the repeat a no-op)", async () => {
    const d = make();
    await d.answer(U.posting, "hired", T1);
    await d.answer(U.posting, "hired", T2);
    expect(d.hires.recordCompanyAnswer).toHaveBeenCalledTimes(2);
  });

  it("the posting of an unlock: company posting first, then agency job, else none", () => {
    expect(postingOf({ jobId: null, jobPostingId: POSTING })).toEqual({
      postingKind: "company_posting",
      postingId: POSTING,
    });
    expect(postingOf({ jobId: JOB, jobPostingId: null })).toEqual({
      postingKind: "agency_job",
      postingId: JOB,
    });
    expect(postingOf({ jobId: null, jobPostingId: null })).toBeNull();
  });
});

describe("the desk's not_reached (#2750, no route yet)", () => {
  it("stores not_reached answered by the desk, on the DESK's tx, with an admin-actor event", async () => {
    const d = make();
    const out = await d.svc.recordDeskOutcome(U.other, "not_reached", TX, BY_DESK, T1);
    expect(out).toEqual({
      unlockId: U.other,
      workerId: WORKER,
      outcome: "not_reached",
      previousOutcome: null,
      answeredAt: T1,
      changed: true,
    });
    // Any company's opened contact: the desk acts for whichever company holds it.
    expect(d.repo.findOpened).toHaveBeenCalledWith(U.other, TX);
    expect(d.repo.findOwnedOpened).not.toHaveBeenCalled();
    expect(d.repo.withTransaction).not.toHaveBeenCalled();
    expect(d.repo.rows.get(U.other)).toMatchObject({
      tenantPayerId: OTHER,
      outcome: "not_reached",
      answeredBy: "desk",
    });
    expectEvent(d.emitted[0], U.other, "not_reached", "desk", BY_DESK.actor);
    expect(d.hires.recordCompanyAnswer).not.toHaveBeenCalled();
  });

  it("not an opened contact (or an erased worker): null, nothing written", async () => {
    const d = make();
    await expect(
      d.svc.recordDeskOutcome(U.unknown, "not_reached", TX, BY_DESK, T1),
    ).resolves.toBeNull();
    expect(d.repo.lockOutcome).not.toHaveBeenCalled();
    expect(d.emitted).toEqual([]);
  });

  it("a later company answer replaces the desk's (a different answerer is a change)", async () => {
    const d = make();
    await d.svc.recordDeskOutcome(U.posting, "not_reached", TX, BY_DESK, T1);
    const out = await d.answer(U.posting, "not_hired", T2);
    expect(out).toMatchObject({ previous_outcome: "not_reached", changed: true });
    expect(d.repo.rows.get(U.posting)).toMatchObject({
      outcome: "not_hired",
      answeredBy: "company",
    });
    expect(d.emitted).toHaveLength(2);
  });
});

describe("the due list", () => {
  const row = (n: number): DueRow => ({
    unlockId: `0a000000-0000-4000-8000-00000000010${n}`,
    workerId: WORKER,
    grantedAt: new Date(`2026-11-0${n}T04:00:00.000Z`),
    grantedKey: `2026-11-0${n}T04:00:00.123456Z`,
    outcome: n % 2 === 0 ? "still_talking" : null,
  });

  it("asks for the TENANT's rows granted at least the setting ago, one over the page size", async () => {
    const d = make({ days: 7 });
    await d.svc.listDue(COMPANY, { limit: 20 } as DueUnlocksQueryDto, T3);
    expect(d.repo.listDue).toHaveBeenCalledWith(
      COMPANY,
      new Date("2026-11-18T04:00:00.000Z"),
      null,
      21,
    );
    const e = make({ days: 3 });
    await e.svc.listDue(COMPANY, { limit: 5 } as DueUnlocksQueryDto, T3);
    expect(e.repo.listDue).toHaveBeenCalledWith(
      COMPANY,
      new Date("2026-11-22T04:00:00.000Z"),
      null,
      6,
    );
  });

  it("ids only, and a cursor at the last served row when there is more", async () => {
    const d = make();
    d.repo.listDue.mockResolvedValueOnce([row(1), row(2), row(3)]);
    const page = await d.svc.listDue(COMPANY, { limit: 2 } as DueUnlocksQueryDto, T3);
    expect(page.items).toEqual([
      {
        unlock_id: row(1).unlockId,
        worker_id: WORKER,
        granted_at: "2026-11-01T04:00:00.000Z",
        outcome: null,
      },
      {
        unlock_id: row(2).unlockId,
        worker_id: WORKER,
        granted_at: "2026-11-02T04:00:00.000Z",
        outcome: "still_talking",
      },
    ]);
    expect(decodeDueCursor(page.nextCursor!)).toEqual({
      grantedKey: row(2).grantedKey,
      unlockId: row(2).unlockId,
    });
  });

  it("the last page has no cursor; a cursor passed in reaches the read", async () => {
    const d = make();
    d.repo.listDue.mockResolvedValueOnce([row(4)]);
    const after = { grantedKey: row(3).grantedKey, unlockId: row(3).unlockId };
    const page = await d.svc.listDue(
      COMPANY,
      { limit: 2, cursor: after } as DueUnlocksQueryDto,
      T3,
    );
    expect(page.nextCursor).toBeNull();
    expect(d.repo.listDue).toHaveBeenCalledWith(COMPANY, expect.any(Date), after, 3);
  });
});
