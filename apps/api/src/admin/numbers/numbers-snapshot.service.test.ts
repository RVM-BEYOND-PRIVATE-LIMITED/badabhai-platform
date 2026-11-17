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
    isWeekFrozen: vi.fn(async (_t: unknown, week: string) => (over.frozen ?? []).includes(week)),
    replaceWeek: vi.fn(async () => undefined),
    // The sources: every read empty, so each week computes to all-zero cells.
    sourcesFor: vi.fn(() => ({
      paidOrders: async () => [],
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
    expect(order).toEqual(["lock:2026-11-02", "lock:2026-11-09", "lock:2026-11-16"]);
    expect(repo.withTransaction).toHaveBeenCalledTimes(3);
    expect(repo.sourcesFor).toHaveBeenCalledWith(tx, true);
    // 2 Nov froze on 11 Nov; 9 Nov freezes on 18 Nov 18:30 UTC (not yet); 16 Nov is in progress.
    expect(out).toEqual({ armed: true, computed: 2, frozen: 1, skipped: 0 });
    const calls = repo.replaceWeek.mock.calls as unknown as Array<
      [unknown, string, unknown[], Date, Date | null]
    >;
    expect(calls.map((c) => [c[1], c[3], c[4]])).toEqual([
      ["2026-11-02", NOW, NOW],
      ["2026-11-09", NOW, null],
      ["2026-11-16", NOW, null],
    ]);
    // Every stored metric × 42 cells, stamped with the week.
    for (const c of calls) {
      expect(c[2].length % 42).toBe(0);
      for (const r of c[2] as Array<{ weekStart: string }>) expect(r.weekStart).toBe(c[1]);
    }
  });

  it("never touches a frozen week again", async () => {
    const { repo, service } = setup({ frozen: ["2026-11-02"] });
    expect(await service.sweep(NOW)).toEqual({ armed: true, computed: 2, frozen: 0, skipped: 1 });
    const weeks = (repo.replaceWeek.mock.calls as unknown as Array<[unknown, string]>).map(
      (c) => c[1],
    );
    expect(weeks).toEqual(["2026-11-09", "2026-11-16"]);
  });

  it("starts no earlier than the baseline week, whatever the oldest row says", async () => {
    const { service } = setup({ earliest: new Date("2025-01-01T00:00:00.000Z") });
    expect(await service.firstWeek(NOW)).toBe("2026-06-01");
  });

  it("with no source row at all, computes the current week only", async () => {
    const { service, order } = setup({ earliest: null });
    expect(await service.firstWeek(NOW)).toBe("2026-11-16");
    await service.sweep(NOW);
    expect(order).toEqual(["lock:2026-11-16"]);
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
