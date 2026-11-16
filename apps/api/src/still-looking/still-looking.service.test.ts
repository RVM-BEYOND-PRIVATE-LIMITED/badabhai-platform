import { Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { STILL_LOOKING_ANSWERS, type StillLookingAnswer } from "@badabhai/db";
import { STILL_LOOKING_CHECK_ANSWERS, validateEvent } from "@badabhai/event-schema";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DevicesRepository } from "../auth/devices.repository";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { PushEnqueuer } from "../push/push-enqueuer.service";
import type { SearchExitService } from "../search-exit/search-exit.service";
import type { WorkerActivityRepository } from "../worker-activity/worker-activity.repository";
import { WorkerActivityService } from "../worker-activity/worker-activity.service";
import { openDueChecksStatement, type StillLookingRepository } from "./still-looking.repository";
import {
  availabilityNeedsAnswer,
  resetStillLookingMissingTableWarningForTests,
  STILL_LOOKING_SWEEP_BATCH,
  StillLookingService,
} from "./still-looking.service";

/**
 * #2753 item 5 — `StillLookingService`: the switch first, the GET shape, one answer per check in
 * ONE transaction with its event and its search effect, the repeat no-op, the activity touch after
 * the commit, and the sweep (its predicate's text, its idempotency keys, its push gating). The SQL
 * meaning — one check per worker across two concurrent sweeps, the window, the real search — is
 * the DB gate's (`still-looking.db.test.ts`).
 */

const W = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const CTX = { correlationId: "c-2753-5", requestId: "r-2753-5" } as RequestContext;
// 06:00 UTC = 11:30 IST: the IST day is the UTC day.
const NOW = new Date("2026-11-16T06:00:00.000Z");
const dialect = new PgDialect();

/** Drain fire-and-forget work (the activity touch is deliberately not awaited). */
const flush = () => new Promise((r) => setImmediate(r));

interface Row {
  id: string;
  workerId: string;
  promptedAt: Date;
  answeredAt: Date | null;
  answer: StillLookingAnswer | null;
}

interface Opts {
  check?: boolean | null;
  push?: boolean;
  searchExit?: boolean;
  hires?: boolean;
  activity?: boolean;
  availabilityV2?: boolean;
  availability?: Record<string, unknown> | null;
  everyDays?: number;
  lastActive?: string | null;
  failTx?: unknown;
  sweepBatches?: string[][];
  devices?: string[];
}

function harness(opts: Opts = {}) {
  const rows: Row[] = [];
  const log: string[] = [];
  let txOpen = false;
  let seq = 0;
  const TX = { tx: "the-transaction" };
  const inTx = (tx: unknown) => {
    if (tx !== TX || !txOpen) throw new Error("a write outside the transaction");
  };
  const sweepBatches = [...(opts.sweepBatches ?? [])];

  const repo = {
    withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      if (opts.failTx !== undefined) throw opts.failTx;
      txOpen = true;
      const snapshot = rows.map((r) => ({ ...r }));
      try {
        const out = await cb(TX);
        log.push("commit");
        return out;
      } catch (err) {
        rows.splice(0, rows.length, ...snapshot);
        log.push("rollback");
        throw err;
      } finally {
        txOpen = false;
      }
    }),
    lockWorker: vi.fn(async (_w: string, tx: unknown) => {
      inTx(tx);
      log.push("lock");
    }),
    findOpen: vi.fn(async (workerId: string, tx?: unknown, o: { forUpdate?: boolean } = {}) => {
      if (tx !== undefined) inTx(tx);
      log.push(o.forUpdate ? "findOpen(lock)" : "findOpen");
      const open = rows.find((r) => r.workerId === workerId && r.answeredAt === null);
      return open ? { id: open.id, promptedAt: open.promptedAt } : null;
    }),
    findLatest: vi.fn(async (workerId: string, tx?: unknown) => {
      if (tx !== undefined) inTx(tx);
      log.push("findLatest");
      const mine = rows
        .filter((r) => r.workerId === workerId)
        .sort(
          (a, b) =>
            (b.answeredAt ?? b.promptedAt).getTime() - (a.answeredAt ?? a.promptedAt).getTime(),
        );
      return mine[0]
        ? { id: mine[0].id, answer: mine[0].answer, answeredAt: mine[0].answeredAt }
        : null;
    }),
    answerOpen: vi.fn(async (id: string, answer: StillLookingAnswer, at: Date, tx: unknown) => {
      inTx(tx);
      log.push(`answerOpen:${answer}`);
      const row = rows.find((r) => r.id === id && r.answeredAt === null);
      if (!row) return false;
      row.answer = answer;
      row.answeredAt = at;
      return true;
    }),
    insertAnswered: vi.fn(
      async (workerId: string, answer: StillLookingAnswer, at: Date, tx: unknown) => {
        inTx(tx);
        log.push(`insertAnswered:${answer}`);
        const id = `check-${++seq}`;
        rows.push({ id, workerId, promptedAt: at, answeredAt: at, answer });
        return id;
      },
    ),
    openDue: vi.fn(async (now: Date, cutoff: Date, limit: number, tx: unknown) => {
      inTx(tx);
      log.push(`openDue:${cutoff.toISOString()}:${limit}`);
      const workers = sweepBatches.shift() ?? [];
      return workers.map((workerId) => {
        const id = `check-${++seq}`;
        rows.push({ id, workerId, promptedAt: now, answeredAt: null, answer: null });
        return { checkId: id, workerId };
      });
    }),
    availabilityAnswer: vi.fn(async () => {
      log.push("availability");
      return opts.availability === undefined ? null : opts.availability;
    }),
  };

  const events = {
    emit: vi.fn(
      async (p: { tx?: unknown; event_name: string; payload: Record<string, unknown> }) => {
        inTx(p.tx);
        log.push(`emit:${p.event_name}`);
        return { event_id: `event-${p.payload.check_id as string}` };
      },
    ),
  };
  const searchExit = {
    setVisibilityInTransaction: vi.fn(
      async (_w: string, visible: boolean, via: string, _c: unknown, tx: unknown) => {
        inTx(tx);
        log.push(`search:${visible}:${via}`);
        return { reply: { visible, hidden_since: null }, changed: true };
      },
    ),
  };
  const activityRepo = {
    touch: vi.fn(async () => {
      log.push("touch");
    }),
    lastActiveDays: vi.fn(async () => {
      log.push("lastActiveDays");
      return opts.lastActive === null || opts.lastActive === undefined
        ? new Map<string, string>()
        : new Map([[W, opts.lastActive]]);
    }),
  };
  const config = {
    ...(opts.check === null ? {} : { STILL_LOOKING_CHECK_ENABLED: opts.check ?? true }),
    STILL_LOOKING_PUSH_ENABLED: opts.push ?? false,
    STILL_LOOKING_EVERY_DAYS: opts.everyDays ?? 30,
    SEARCH_EXIT_ENABLED: opts.searchExit ?? true,
    HIRE_RECORDS_ENABLED: opts.hires ?? true,
    WORKER_ACTIVITY_ENABLED: opts.activity ?? true,
    NOT_RECENTLY_ACTIVE_DAYS: 90,
    AVAILABILITY_ANSWERS_V2_ENABLED: opts.availabilityV2 ?? true,
  } as unknown as ServerConfig;
  // The REAL part-B service over a mocked repository: the mark is its helper, not a copy.
  const activity = new WorkerActivityService(
    activityRepo as unknown as WorkerActivityRepository,
    config,
  );
  const devices = {
    listPushTargets: vi.fn(async (workerId: string) =>
      (opts.devices ?? ["dev-1"]).map((id) => ({ id: `${workerId}:${id}` })),
    ),
  };
  const push = { enqueue: vi.fn(async () => undefined) };

  const svc = new StillLookingService(
    repo as unknown as StillLookingRepository,
    events as unknown as EventsService,
    searchExit as unknown as SearchExitService,
    activity,
    devices as unknown as DevicesRepository,
    push as unknown as PushEnqueuer,
    config,
  );
  return { svc, repo, events, searchExit, activityRepo, devices, push, rows, log };
}

type EmitCall = {
  event_name: string;
  actor: unknown;
  subject: unknown;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  correlationId?: string;
};
const emits = (h: ReturnType<typeof harness>) =>
  h.events.emit.mock.calls.map((c) => c[0] as unknown as EmitCall);

beforeEach(() => resetStillLookingMissingTableWarningForTests());
afterEach(() => vi.restoreAllMocks());

describe("StillLookingService — the switch first", () => {
  it.each([
    [false, "false"],
    [null, "absent"],
  ])(
    "STILL_LOOKING_CHECK_ENABLED %s (%s): both routes 404 and the sweep returns, touching nothing",
    async (check, _label) => {
      const h = harness({ check, push: true, sweepBatches: [[W]] });
      await expect(h.svc.status(W, NOW)).rejects.toBeInstanceOf(NotFoundException);
      for (const answer of STILL_LOOKING_ANSWERS) {
        await expect(h.svc.answer(W, answer, CTX, NOW)).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(await h.svc.sweep(NOW)).toEqual({ armed: false, opened: 0, pushed: 0 });
      // No table read, no transaction, no event, no push, no activity read or write.
      await flush();
      expect(h.log).toEqual([]);
      expect(h.events.emit).not.toHaveBeenCalled();
      expect(h.push.enqueue).not.toHaveBeenCalled();
      expect(h.devices.listPushTargets).not.toHaveBeenCalled();
    },
  );
});

describe("StillLookingService — GET", () => {
  it("no check open: not due, no id; the open-check read and the availability read, no event", async () => {
    const h = harness({ availability: { status: "join_now" }, lastActive: "2026-11-10" });
    expect(await h.svc.status(W, NOW)).toEqual({
      due: false,
      check_id: null,
      availability_needs_answer: false,
      last_active_on: "2026-11-10",
      not_recently_active: false,
    });
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });

  it("a check open: due, with its id", async () => {
    const h = harness();
    h.rows.push({ id: "open-1", workerId: W, promptedAt: NOW, answeredAt: null, answer: null });
    expect(await h.svc.status(W, NOW)).toMatchObject({ due: true, check_id: "open-1" });
  });

  it("the mark is part B's: last active 91 days ago is marked, 90 days ago is not", async () => {
    expect(await harness({ lastActive: "2026-08-17" }).svc.status(W, NOW)).toMatchObject({
      last_active_on: "2026-08-17",
      not_recently_active: true,
    });
    expect(await harness({ lastActive: "2026-08-18" }).svc.status(W, NOW)).toMatchObject({
      last_active_on: "2026-08-18",
      not_recently_active: false,
    });
    // No day at all is not marked (part B's rule: he has not gone anywhere).
    expect(await harness({ lastActive: null }).svc.status(W, NOW)).toMatchObject({
      last_active_on: null,
      not_recently_active: false,
    });
  });

  it("WORKER_ACTIVITY_ENABLED off: last_active_on null, not_recently_active false, and NO activity read", async () => {
    const h = harness({ activity: false, lastActive: "2026-01-01" });
    expect(await h.svc.status(W, NOW)).toMatchObject({
      last_active_on: null,
      not_recently_active: false,
    });
    expect(h.activityRepo.lastActiveDays).not.toHaveBeenCalled();
  });

  it("42P01 (switched on before 0173): 503, never 500, logged with the code", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const h = harness();
    h.repo.findOpen.mockRejectedValueOnce(
      Object.assign(new Error("x"), { cause: { code: "42P01" } }),
    );
    await expect(h.svc.status(W, NOW)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("42P01");
  });
});

describe("availability_needs_answer — part A's map decides what is old", () => {
  it.each([
    [null, true, true, "empty"],
    [{}, true, true, "a row with no status"],
    [{ status: "made_up" }, true, true, "an unknown key"],
    [{ status: "immediate" }, true, true, "an OLD key, the four on"],
    [{ status: "within_month" }, true, true, "an OLD key, the four on"],
    [{ status: "join_now" }, true, false, "a NEW key, the four on"],
    [{ status: "working_open" }, true, false, "a NEW key, the four on"],
    [{ status: "immediate" }, false, false, "an OLD key, the four OFF (it is what the app offers)"],
    [null, false, true, "empty, the four off"],
    [{ status: "in_15_days" }, false, false, "a NEW key, the four off"],
  ])("%j with the four answers %s → %s (%s)", async (availability, v2, expected, _label) => {
    const h = harness({ availability, availabilityV2: v2 });
    expect((await h.svc.status(W, NOW)).availability_needs_answer).toBe(expected);
  });

  it("the pure rule", () => {
    expect(availabilityNeedsAnswer(null, true)).toBe(true);
    expect(availabilityNeedsAnswer("within_week", true)).toBe(true);
    expect(availabilityNeedsAnswer("in_30_days", true)).toBe(false);
    expect(availabilityNeedsAnswer("within_week", false)).toBe(false);
  });
});

describe("StillLookingService — POST: one answer, ONE transaction", () => {
  it("answers the open check: lock, store, event, search effect — all inside, then commit", async () => {
    const h = harness();
    h.rows.push({ id: "open-1", workerId: W, promptedAt: NOW, answeredAt: null, answer: null });
    const out = await h.svc.answer(W, "yes", CTX, NOW);
    expect(h.log.slice(0, 6)).toEqual([
      "lock",
      "findOpen(lock)",
      "answerOpen:yes",
      "emit:worker.still_looking_answered",
      "search:true:monthly_check",
      "commit",
    ]);
    expect(h.rows[0]).toMatchObject({ answer: "yes", answeredAt: NOW });
    const [answered] = emits(h);
    expect(answered).toMatchObject({
      event_name: "worker.still_looking_answered",
      actor: { actor_type: "worker", actor_id: W },
      subject: { subject_type: "worker", subject_id: W },
      payload: { worker_id: W, check_id: "open-1", answer: "yes" },
      idempotencyKey: "worker.still_looking_answered:open-1",
      correlationId: CTX.correlationId,
    });
    // The GET shape back: nothing open any more.
    expect(out).toMatchObject({ due: false, check_id: null });
  });

  it("no check open (from Settings): opens and answers one row at once", async () => {
    const h = harness();
    await h.svc.answer(W, "not_now", CTX, NOW);
    expect(h.log).toContain("insertAnswered:not_now");
    expect(h.rows).toEqual([
      { id: "check-1", workerId: W, promptedAt: NOW, answeredAt: NOW, answer: "not_now" },
    ]);
    expect(emits(h)[0]!.payload).toEqual({ worker_id: W, check_id: "check-1", answer: "not_now" });
  });

  it("THE REPEAT IS A NO-OP: the same answer again writes no row and emits no answer event, and answers the same body", async () => {
    const h = harness();
    const first = await h.svc.answer(W, "yes", CTX, NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const again = await h.svc.answer(W, "yes", CTX, later);
    expect(again).toEqual(first);
    expect(h.rows).toHaveLength(1);
    expect(h.repo.insertAnswered).toHaveBeenCalledTimes(1);
    expect(emits(h).filter((e) => e.event_name === "worker.still_looking_answered")).toHaveLength(
      1,
    );
  });

  it("a DIFFERENT answer with none open opens a new row (yes, then not now from Settings)", async () => {
    const h = harness();
    await h.svc.answer(W, "yes", CTX, NOW);
    await h.svc.answer(W, "not_now", CTX, new Date(NOW.getTime() + 60_000));
    expect(h.rows.map((r) => r.answer)).toEqual(["yes", "not_now"]);
    expect(emits(h).map((e) => e.payload.answer)).toEqual(["yes", "not_now"]);
  });

  it("the SAME answer after the window is a new answer: a new row and event (it restarts the month)", async () => {
    const h = harness({ everyDays: 30 });
    await h.svc.answer(W, "yes", CTX, NOW);
    // 30 days on is still inside the window: a repeat.
    await h.svc.answer(W, "yes", CTX, new Date(NOW.getTime() + 30 * 24 * 3_600_000));
    expect(h.rows).toHaveLength(1);
    // 31 days on: a fresh answer.
    await h.svc.answer(W, "yes", CTX, new Date(NOW.getTime() + 31 * 24 * 3_600_000));
    expect(h.rows.map((r) => r.answer)).toEqual(["yes", "yes"]);
    expect(emits(h)).toHaveLength(2);
  });

  it("every payload it emits validates against the registered event", async () => {
    const h = harness();
    for (const [i, answer] of STILL_LOOKING_ANSWERS.entries()) {
      await h.svc.answer(W, answer, CTX, new Date(NOW.getTime() + i * 1000));
    }
    for (const e of emits(h)) {
      const result = validateEvent({
        event_id: "33333333-3333-4333-8333-333333333333",
        event_name: e.event_name,
        event_version: 1,
        occurred_at: NOW.toISOString(),
        actor: e.actor,
        subject: e.subject,
        source: "api",
        correlation_id: "44444444-4444-4444-8444-444444444444",
        causation_id: null,
        payload: { ...e.payload, check_id: "55555555-5555-4555-8555-555555555555" },
        metadata: { environment: "test", service: "api" },
      });
      expect(result.success, String(e.payload.answer)).toBe(true);
    }
  });
});

describe("StillLookingService — what each answer does (C and H on and off)", () => {
  it.each([
    ["yes", true, "search:true:monthly_check"],
    ["not_now", true, "search:false:monthly_check"],
  ] as const)(
    "%s with SEARCH_EXIT_ENABLED on → %s, on the answer's transaction",
    async (answer, _on, step) => {
      const h = harness({ searchExit: true });
      await h.svc.answer(W, answer, CTX, NOW);
      expect(h.searchExit.setVisibilityInTransaction).toHaveBeenCalledTimes(1);
      expect(h.log.indexOf(step)).toBeLessThan(h.log.indexOf("commit"));
    },
  );

  it.each(["yes", "not_now"] as const)(
    "%s with SEARCH_EXIT_ENABLED OFF: the effect is skipped, the answer is still stored and evented",
    async (answer) => {
      const h = harness({ searchExit: false });
      await h.svc.answer(W, answer, CTX, NOW);
      expect(h.searchExit.setVisibilityInTransaction).not.toHaveBeenCalled();
      expect(h.rows[0]!.answer).toBe(answer);
      expect(emits(h)).toHaveLength(1);
    },
  );

  it.each([true, false])(
    "hired (HIRE_RECORDS_ENABLED %s): stored and reported only — no search move, no hire record",
    async (hires) => {
      const h = harness({ hires, searchExit: true });
      await h.svc.answer(W, "hired", CTX, NOW);
      expect(h.rows[0]!.answer).toBe("hired");
      expect(emits(h).map((e) => e.event_name)).toEqual(["worker.still_looking_answered"]);
      expect(h.searchExit.setVisibilityInTransaction).not.toHaveBeenCalled();
    },
  );

  it("there is no hire-record collaborator at all: the answer names no company or posting", () => {
    // Constructor: repo, events, search exit, activity, devices, push, config. No HiresService.
    expect(StillLookingService.length).toBe(7);
  });

  it("the repeat still re-applies the search effect (a no-op unless his own switch moved him since)", async () => {
    const h = harness();
    await h.svc.answer(W, "yes", CTX, NOW);
    await h.svc.answer(W, "yes", CTX, new Date(NOW.getTime() + 1000));
    expect(h.searchExit.setVisibilityInTransaction).toHaveBeenCalledTimes(2);
  });

  it("a failed search effect rolls the answer back: the row, the event and the exit commit together", async () => {
    const h = harness();
    h.searchExit.setVisibilityInTransaction.mockRejectedValueOnce(new Error("spine down"));
    await expect(h.svc.answer(W, "not_now", CTX, NOW)).rejects.toThrow("spine down");
    expect(h.rows).toEqual([]);
    expect(h.log).toContain("rollback");
  });
});

describe("StillLookingService — the activity touch, AFTER the commit", () => {
  it.each([...STILL_LOOKING_ANSWERS])(
    "%s: touches today's IST day after the commit, and the reply already counts today",
    async (answer) => {
      // Last active 200 days ago: marked, until this tap.
      const h = harness({ lastActive: "2026-04-30" });
      expect((await h.svc.status(W, NOW)).not_recently_active).toBe(true);
      const out = await h.svc.answer(W, answer, CTX, NOW);
      await flush();
      expect(h.activityRepo.touch).toHaveBeenCalledWith(W, "2026-11-16");
      expect(h.log.indexOf("touch")).toBeGreaterThan(h.log.indexOf("commit"));
      expect(out).toMatchObject({ last_active_on: "2026-11-16", not_recently_active: false });
    },
  );

  it("the touch is the IST day: 19:00 UTC is already tomorrow in India", async () => {
    const h = harness();
    await h.svc.answer(W, "yes", CTX, new Date("2026-11-16T19:00:00.000Z"));
    await flush();
    expect(h.activityRepo.touch).toHaveBeenCalledWith(W, "2026-11-17");
  });

  it("a failed transaction never touches the day", async () => {
    const h = harness();
    h.repo.insertAnswered.mockRejectedValueOnce(new Error("deadlock"));
    await expect(h.svc.answer(W, "yes", CTX, NOW)).rejects.toThrow("deadlock");
    await flush();
    expect(h.activityRepo.touch).not.toHaveBeenCalled();
  });

  it("WORKER_ACTIVITY_ENABLED off: no write, and the reply carries null / false", async () => {
    const h = harness({ activity: false });
    expect(await h.svc.answer(W, "yes", CTX, NOW)).toMatchObject({
      last_active_on: null,
      not_recently_active: false,
    });
    await flush();
    expect(h.activityRepo.touch).not.toHaveBeenCalled();
    expect(h.activityRepo.lastActiveDays).not.toHaveBeenCalled();
  });

  it("42P01 on the write: 503, nothing committed, no touch", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const h = harness({ failTx: Object.assign(new Error("x"), { cause: { code: "42P01" } }) });
    await expect(h.svc.answer(W, "yes", CTX, NOW)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await flush();
    expect(h.activityRepo.touch).not.toHaveBeenCalled();
  });
});

describe("StillLookingService — the sweep", () => {
  it("opens the due checks batch by batch, one prompted event each, keyed by the check, one correlation per tick", async () => {
    const full = Array.from({ length: STILL_LOOKING_SWEEP_BATCH }, (_, i) => `w-${i}`);
    const h = harness({ sweepBatches: [full, [W, W2]] });
    expect(await h.svc.sweep(NOW)).toEqual({ armed: true, opened: full.length + 2, pushed: 0 });
    // A full batch is followed by another; a short one ends the tick.
    expect(h.repo.openDue).toHaveBeenCalledTimes(2);
    const prompted = emits(h);
    expect(prompted).toHaveLength(full.length + 2);
    const last = prompted.at(-1)!;
    expect(last).toMatchObject({
      event_name: "worker.still_looking_prompted",
      actor: { actor_type: "system" },
      subject: { subject_type: "worker", subject_id: W2 },
      payload: { worker_id: W2, check_id: `check-${full.length + 2}` },
      idempotencyKey: `worker.still_looking_prompted:check-${full.length + 2}`,
    });
    expect(new Set(prompted.map((e) => e.correlationId)).size).toBe(1);
  });

  it("the window is STILL_LOOKING_EVERY_DAYS before now (30 by default, the setting when set)", async () => {
    const h30 = harness({ sweepBatches: [[]] });
    await h30.svc.sweep(NOW);
    expect(h30.log[0]).toBe(`openDue:2026-10-17T06:00:00.000Z:${STILL_LOOKING_SWEEP_BATCH}`);
    const h45 = harness({ everyDays: 45, sweepBatches: [[]] });
    await h45.svc.sweep(NOW);
    expect(h45.log[0]).toBe(`openDue:2026-10-02T06:00:00.000Z:${STILL_LOOKING_SWEEP_BATCH}`);
  });

  it("nothing due: one empty batch, no event, no push", async () => {
    const h = harness({ push: true, sweepBatches: [[]] });
    expect(await h.svc.sweep(NOW)).toEqual({ armed: true, opened: 0, pushed: 0 });
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.push.enqueue).not.toHaveBeenCalled();
  });

  it("42P01 (switched on before 0173): opens nothing, one warning for the process, never throws", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const missing = Object.assign(new Error("x"), { cause: { code: "42P01" } });
    const h = harness({ failTx: missing });
    expect(await h.svc.sweep(NOW)).toEqual({ armed: true, opened: 0, pushed: 0 });
    expect(await h.svc.sweep(NOW)).toEqual({ armed: true, opened: 0, pushed: 0 });
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("0173"));
    expect(lines).toHaveLength(1);
  });

  it("any other error propagates (the tick fails and BullMQ retries it)", async () => {
    const h = harness({ failTx: new Error("connection reset") });
    await expect(h.svc.sweep(NOW)).rejects.toThrow("connection reset");
  });
});

describe("StillLookingService — the push gate (each switch combination)", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])("check %s, push %s → pushed: %s", async (check, pushOn, expected) => {
    const h = harness({ check, push: pushOn, sweepBatches: [[W, W2]] });
    const result = await h.svc.sweep(NOW);
    if (!check) {
      // The check off: no sweep at all, so nothing to push either.
      expect(result).toEqual({ armed: false, opened: 0, pushed: 0 });
    }
    expect(h.push.enqueue).toHaveBeenCalledTimes(expected ? 2 : 0);
    expect(h.devices.listPushTargets).toHaveBeenCalledTimes(expected ? 2 : 0);
    expect(result.pushed).toBe(expected ? 2 : 0);
  });

  it("both on: refs only — the worker, the prompted event's id, the event name and his device ids", async () => {
    const h = harness({ push: true, sweepBatches: [[W]], devices: ["a", "b"] });
    await h.svc.sweep(NOW);
    expect(h.push.enqueue).toHaveBeenCalledWith({
      workerId: W,
      sourceEventId: "event-check-1",
      eventName: "worker.still_looking_prompted",
      deviceIds: [`${W}:a`, `${W}:b`],
    });
    // Enqueued after the batch committed, never inside it.
    expect(h.log.indexOf("commit")).toBeGreaterThan(-1);
  });

  it("a worker with no push device is skipped, and a failed device read loses only his push", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const h = harness({ push: true, sweepBatches: [[W, W2]], devices: [] });
    expect((await h.svc.sweep(NOW)).pushed).toBe(0);
    const h2 = harness({ push: true, sweepBatches: [[W, W2]] });
    h2.devices.listPushTargets.mockRejectedValueOnce(new Error("pool"));
    expect(await h2.svc.sweep(NOW)).toEqual({ armed: true, opened: 2, pushed: 1 });
  });
});

describe("the sweep's predicate (the statement the DB gate runs)", () => {
  const { sql, params } = dialect.sqlToQuery(
    openDueChecksStatement(NOW, new Date("2026-10-17T06:00:00.000Z"), 200),
  );
  const flat = sql.replace(/\s+/g, " ");

  it("asks only active, consented workers outside the deletion window", () => {
    expect(flat).toContain("w.status = 'active'");
    expect(flat).toContain("w.deletion_scheduled_at IS NULL");
    expect(flat).toContain("bool_and(c.revoked_at IS NULL)");
    expect(flat).toContain("SELECT max(c2.accepted_at) FROM worker_consents c2");
  });

  it("skips a worker with an OPEN check, or one opened or answered inside the window", () => {
    expect(flat).toContain("s.answered_at IS NULL");
    expect(flat).toMatch(/s\.prompted_at >= \$\d+::timestamptz/);
    expect(flat).toMatch(/s\.answered_at >= \$\d+::timestamptz/);
    expect(params).toContain("2026-10-17T06:00:00.000Z");
    expect(params).toContain(NOW.toISOString());
  });

  it("is guarded by the open-check unique index and returns only what it inserted", () => {
    expect(flat).toContain("ON CONFLICT (worker_id) WHERE answered_at IS NULL DO NOTHING");
    expect(flat).toContain("RETURNING id, worker_id");
    expect(flat).toMatch(/ORDER BY w\.id LIMIT \$\d+/);
    expect(params).toContain(200);
  });
});

describe("the answer vocabulary is ONE set in three places", () => {
  it("the table's CHECK constant, the event's enum and the route's body agree", () => {
    expect([...STILL_LOOKING_ANSWERS]).toEqual([...STILL_LOOKING_CHECK_ANSWERS]);
  });
});
