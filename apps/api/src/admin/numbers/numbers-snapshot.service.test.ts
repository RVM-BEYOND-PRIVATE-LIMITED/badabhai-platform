import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { DEFAULT_NUMBERS_FREEZE_AFTER_DAYS, numbersFreezeAfterDays } from "./admin-numbers.flag";
import {
  NumbersSnapshotService,
  resetNumbersMissingTableWarningForTests,
  snapshotRowsOf,
} from "./numbers-snapshot.service";
import type { NumbersWeeklyRepository } from "./numbers-weekly.repository";

/**
 * #2755 items 4 and 11 — the sweep's decisions over a fake repository: off is nothing at all,
 * missing tables are one warning and no write, every non-frozen week from the baseline is
 * recomputed in its own transaction under its lock, a frozen week is skipped, and a week is frozen
 * once NUMBERS_FREEZE_AFTER_DAYS have passed since it ended. The real SQL is the DB gate's.
 */

afterEach(() => {
  vi.restoreAllMocks();
  resetNumbersMissingTableWarningForTests();
});

const NOW = new Date("2026-11-18T06:00:00.000Z"); // Wednesday 18 Nov 2026 (IST)

function setup(
  over: {
    enabled?: boolean;
    tables?: boolean;
    frozen?: string[];
    /** Weeks whose `week` rows are frozen but whose cohort rows are still open. */
    weekOnlyFrozen?: string[];
    earliest?: Date | null;
    freezeDays?: number;
  } = {},
) {
  const order: string[] = [];
  const tx = { tx: true };
  const repo = {
    snapshotTablesExist: vi.fn(async () => over.tables ?? true),
    workerActivityTableExists: vi.fn(async () => true),
    earliestSourceAt: vi.fn(async () =>
      over.earliest === undefined ? new Date("2026-11-03T00:00:00.000Z") : over.earliest,
    ),
    withTransaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    lockWeek: vi.fn(async (_t: unknown, week: string) => {
      order.push(`lock:${week}`);
    }),
    frozenClasses: vi.fn(async (_t: unknown, week: string) => {
      if ((over.frozen ?? []).includes(week)) return new Set(["week", "cohort"]);
      if ((over.weekOnlyFrozen ?? []).includes(week)) return new Set(["week"]);
      return new Set();
    }),
    replaceWeek: vi.fn(async () => undefined),
    // The sources: every read empty, so each week computes to all-zero cells.
    sourcesFor: vi.fn(() => ({
      paidOrders: async () => [],
      cohortOrders: async () => {
        order.push("cohortOrders");
        return [];
      },
      firstPublications: async () => [],
      currentProfiles: async () => [],
      activity: async () => [],
      confirmedHires: async () => [],
      openedContacts: async () => [],
      formCompletions: async () => [],
      companyDims: async () => new Map(),
      workerDims: async () => new Map(),
    })),
  };
  const service = new NumbersSnapshotService(
    repo as unknown as NumbersWeeklyRepository,
    {
      ADMIN_NUMBERS_ENABLED: over.enabled ?? true,
      NUMBERS_FREEZE_AFTER_DAYS: over.freezeDays ?? 3,
    } as ServerConfig,
  );
  return { repo, service, order, tx };
}

describe("NUMBERS_FREEZE_AFTER_DAYS", () => {
  it("is read from the config, defaulting to 3 when it carries no valid value", () => {
    expect(DEFAULT_NUMBERS_FREEZE_AFTER_DAYS).toBe(3);
    expect(numbersFreezeAfterDays({ NUMBERS_FREEZE_AFTER_DAYS: 5 })).toBe(5);
    expect(numbersFreezeAfterDays(undefined)).toBe(3);
    expect(numbersFreezeAfterDays({ NUMBERS_FREEZE_AFTER_DAYS: 0 } as never)).toBe(3);
  });

  it("a week freezes that many days after it ends (Sunday 23:59:59 IST)", () => {
    const { service } = setup();
    // Week of 2 Nov ends at 9 Nov 00:00 IST = 8 Nov 18:30 UTC; +3 days = 11 Nov 18:30 UTC.
    expect(service.freezesAt("2026-11-02").toISOString()).toBe("2026-11-11T18:30:00.000Z");
    expect(service.isDueToFreeze("2026-11-02", new Date("2026-11-11T18:29:59.999Z"))).toBe(false);
    expect(service.isDueToFreeze("2026-11-02", new Date("2026-11-11T18:30:00.000Z"))).toBe(true);
    const slow = setup({ freezeDays: 7 }).service;
    expect(slow.freezesAt("2026-11-02").toISOString()).toBe("2026-11-15T18:30:00.000Z");
  });
});

describe("the sweep", () => {
  it("OFF: returns at once and reads nothing", async () => {
    const { repo, service } = setup({ enabled: false });
    expect(await service.sweep(NOW)).toEqual({ armed: false, computed: 0, frozen: 0, skipped: 0 });
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });

  it("ON before the migration: one warning per process, nothing written", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { repo, service } = setup({ tables: false });
    expect(await service.sweep(NOW)).toMatchObject({ armed: false, computed: 0 });
    await service.sweep(NOW);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("numbers_weekly");
    expect(repo.withTransaction).not.toHaveBeenCalled();
    expect(repo.replaceWeek).not.toHaveBeenCalled();
  });

  it("recomputes every week from the first source week to the current one, each locked in its own transaction", async () => {
    const { repo, service, order, tx } = setup();
    const out = await service.sweep(NOW);
    // Earliest source row 3 Nov → its week 2 Nov; the current week is 16 Nov.
    expect(order.filter((o) => o.startsWith("lock:"))).toEqual([
      "lock:2026-11-02",
      "lock:2026-11-09",
      "lock:2026-11-16",
    ]);
    expect(repo.withTransaction).toHaveBeenCalledTimes(3);
    expect(repo.sourcesFor).toHaveBeenCalledWith(tx, true);
    // Every week read its cohort orders once (the repeat-buying windows).
    expect(order.filter((o) => o === "cohortOrders")).toHaveLength(3);
    // 2 Nov froze on 11 Nov; 9 Nov freezes on 18 Nov 18:30 UTC (not yet); 16 Nov is in progress.
    expect(out).toEqual({ armed: true, computed: 2, frozen: 1, skipped: 0 });
    const calls = repo.replaceWeek.mock.calls as unknown as Array<
      [unknown, string, string, Array<{ weekStart: string; metric: string }>, Date, Date | null]
    >;
    // Each week's two freeze classes are replaced on their own; the cohort rows (repeat buying)
    // stay open until 90 days after the week, so none of these freeze yet.
    expect(calls.map((c) => [c[1], c[2], c[4], c[5]])).toEqual([
      ["2026-11-02", "week", NOW, NOW],
      ["2026-11-02", "cohort", NOW, null],
      ["2026-11-09", "week", NOW, null],
      ["2026-11-09", "cohort", NOW, null],
      ["2026-11-16", "week", NOW, null],
      ["2026-11-16", "cohort", NOW, null],
    ]);
    // Every stored metric × 42 cells, stamped with the week, each row in its own class.
    for (const c of calls) {
      expect(c[3].length % 42).toBe(0);
      for (const r of c[3]) expect(r.weekStart).toBe(c[1]);
      const repeat = c[3].filter((r) => r.metric.startsWith("repeat_purchase_"));
      expect(repeat.length).toBe(c[2] === "cohort" ? c[3].length : 0);
    }
    expect(calls.find((c) => c[2] === "cohort")![3].length).toBe(3 * 42);
  });

  it("never touches a frozen week again", async () => {
    const { repo, service } = setup({ frozen: ["2026-11-02"] });
    expect(await service.sweep(NOW)).toEqual({ armed: true, computed: 2, frozen: 0, skipped: 1 });
    const weeks = (repo.replaceWeek.mock.calls as unknown as Array<[unknown, string]>).map(
      (c) => c[1],
    );
    expect(weeks).toEqual(["2026-11-09", "2026-11-09", "2026-11-16", "2026-11-16"]);
  });

  it("starts no earlier than the baseline week, whatever the oldest row says", async () => {
    const { service } = setup({ earliest: new Date("2025-01-01T00:00:00.000Z") });
    expect(await service.firstWeek(NOW)).toBe("2026-06-01");
  });

  it("with no source row at all, computes the current week only", async () => {
    const { service, order } = setup({ earliest: null });
    expect(await service.firstWeek(NOW)).toBe("2026-11-16");
    await service.sweep(NOW);
    expect(order.filter((o) => o.startsWith("lock:"))).toEqual(["lock:2026-11-16"]);
  });
});

describe("the cohort freeze (part C): keyed on the end of the longest repeat window", () => {
  it("a cohort row freezes 90 days plus NUMBERS_FREEZE_AFTER_DAYS after its week ends", () => {
    const { service } = setup();
    // Week of 2 Nov ends 8 Nov 18:30 UTC; +90 days = 6 Feb 2027; +3 days = 9 Feb 2027.
    expect(service.freezesAt("2026-11-02", "cohort").toISOString()).toBe(
      "2027-02-09T18:30:00.000Z",
    );
    expect(service.freezesAt("2026-11-02", "week").toISOString()).toBe("2026-11-11T18:30:00.000Z");
    expect(
      service.isDueToFreeze("2026-11-02", new Date("2027-02-09T18:29:59.999Z"), "cohort"),
    ).toBe(false);
    expect(
      service.isDueToFreeze("2026-11-02", new Date("2027-02-09T18:30:00.000Z"), "cohort"),
    ).toBe(true);
  });

  it("a week whose other rows are frozen recomputes ONLY its open cohort rows", async () => {
    const { repo, service, order } = setup({ weekOnlyFrozen: ["2026-11-02"] });
    await service.sweep(NOW, ["2026-11-02"]);
    const calls = repo.replaceWeek.mock.calls as unknown as Array<
      [unknown, string, string, Array<{ metric: string }>, Date, Date | null]
    >;
    expect(calls.map((c) => [c[1], c[2], c[5]])).toEqual([["2026-11-02", "cohort", null]]);
    expect(calls[0]![3].every((r) => r.metric.startsWith("repeat_purchase_"))).toBe(true);
    // Only the cohort read ran: no other source of a frozen week is read again.
    expect(order).toEqual(["lock:2026-11-02", "cohortOrders"]);
  });

  /**
   * A stateful fake of the snapshot table: rows per week and class, each with its `frozen_at`.
   * `frozenClasses` and `replaceWeek` behave as the repository does, so a test can watch a row
   * across several sweeps.
   */
  function statefulSetup() {
    const { repo, service } = setup();
    const store = new Map<string, { rows: unknown[]; frozenAt: Date | null; writes: number }>();
    const key = (week: string, cls: string) => `${week}|${cls}`;
    repo.frozenClasses.mockImplementation(async (_t: unknown, week: string) => {
      const out = new Set<string>();
      for (const cls of ["week", "cohort"]) {
        if (store.get(key(week, cls))?.frozenAt) out.add(cls);
      }
      return out;
    });
    repo.replaceWeek.mockImplementation((async (
      _t: unknown,
      week: string,
      cls: string,
      rows: unknown[],
      _computedAt: Date,
      frozenAt: Date | null,
    ) => {
      const prev = store.get(key(week, cls));
      if (prev?.frozenAt) throw new Error(`a frozen ${cls} row of ${week} was rewritten`);
      store.set(key(week, cls), { rows, frozenAt, writes: (prev?.writes ?? 0) + 1 });
    }) as never);
    return { repo, service, store, key };
  }

  it("a frozen row NEVER changes: the week rows freeze first, the cohort rows 90 days later", async () => {
    const { service, store, key } = statefulSetup();
    const WEEK = "2026-09-28"; // ends 4 Oct 18:30 UTC: week rows due 7 Oct, cohort rows 5 Jan 2027
    const OLD = "2026-07-06"; // both classes long due at NOW

    await service.sweep(NOW, [OLD, WEEK]);
    expect(store.get(key(OLD, "week"))?.frozenAt).toEqual(NOW);
    expect(store.get(key(OLD, "cohort"))?.frozenAt).toEqual(NOW);
    expect(store.get(key(WEEK, "week"))?.frozenAt).toEqual(NOW);
    expect(store.get(key(WEEK, "cohort"))?.frozenAt).toBeNull();
    const frozenWeekRows = store.get(key(WEEK, "week"))!.rows;

    // Nightly: the open cohort rows are recomputed, the frozen rows are never touched (the fake
    // throws on any rewrite of a frozen class).
    const next = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(await service.sweep(next, [OLD, WEEK])).toEqual({
      armed: true,
      computed: 1,
      frozen: 0,
      skipped: 1,
    });
    expect(store.get(key(WEEK, "week"))!.rows).toBe(frozenWeekRows);
    expect(store.get(key(WEEK, "cohort"))!.writes).toBe(2);

    // Once the 90-day window has closed (plus the freeze delay) the cohort rows freeze too…
    const closed = new Date("2027-01-05T18:30:00.000Z");
    expect(await service.sweep(closed, [WEEK])).toMatchObject({ frozen: 1, skipped: 0 });
    expect(store.get(key(WEEK, "cohort"))?.frozenAt).toEqual(closed);
    // …and the week is skipped from then on.
    expect(await service.sweep(new Date("2027-02-01T00:00:00.000Z"), [WEEK])).toMatchObject({
      computed: 0,
      frozen: 0,
      skipped: 1,
    });
    expect(store.get(key(WEEK, "cohort"))!.writes).toBe(3);
  });

  it("a week frozen before part C (no cohort row) gets its cohort rows, frozen at once when due", async () => {
    const { repo, service, store, key } = statefulSetup();
    const OLD = "2026-07-06";
    store.set(key(OLD, "week"), { rows: ["part B"], frozenAt: new Date("2026-07-15"), writes: 1 });
    await service.sweep(NOW, [OLD]);
    expect(store.get(key(OLD, "week"))!.rows).toEqual(["part B"]);
    expect(store.get(key(OLD, "cohort"))?.frozenAt).toEqual(NOW);
    expect(repo.replaceWeek).toHaveBeenCalledTimes(1);
  });
});

describe("snapshotRowsOf", () => {
  it("flattens each metric's cells into rows stamped with the week and the definition version", () => {
    const rows = snapshotRowsOf("2026-11-16", [
      {
        metric: "paying_companies",
        cells: [
          {
            cityGroup: "all",
            tradeGroup: "all",
            value: 3,
            numerator: null,
            denominator: null,
            suppressed: false,
          },
        ],
      },
    ]);
    expect(rows).toEqual([
      {
        weekStart: "2026-11-16",
        metric: "paying_companies",
        cityGroup: "all",
        tradeGroup: "all",
        value: 3,
        numerator: null,
        denominator: null,
        suppressed: false,
        definitionVersion: 1,
      },
    ]);
  });
});
