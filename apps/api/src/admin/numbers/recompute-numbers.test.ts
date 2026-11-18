import { describe, expect, it, vi } from "vitest";
import type { NumbersSnapshotCellRow } from "./numbers-weekly.repository";
import {
  RECOMPUTE_MAX_WEEKS,
  diffWeekRows,
  parseRecomputeNumbersArgs,
  recomputeNumbers,
  type MetricDiff,
  type RecomputeNumbersDeps,
} from "./recompute-numbers";
import { freezeDaysFromEnv } from "./recompute-numbers.cli";

/**
 * #2755 item 4 — the logged recompute: strict arguments (Mondays, in order, from the baseline,
 * never the future, a reason of the operator's own words), the per-metric diff, a dry run that
 * writes nothing, and an apply that rewrites every week, re-freezes the due ones and writes ONE
 * log row on the same transaction — never printing the reason.
 */

const NOW = new Date("2026-11-18T06:00:00.000Z"); // week of 16 Nov
const REASON = "City list for NCR widened (owner, 17 Nov)";
const args = (extra: string[] = []) => [
  "--from",
  "2026-11-02",
  "--to",
  "2026-11-09",
  "--reason",
  REASON,
  ...extra,
];

describe("parseRecomputeNumbersArgs", () => {
  it("takes two Mondays and a reason; dry run unless --apply", () => {
    expect(parseRecomputeNumbersArgs(args(), NOW)).toEqual({
      fromWeek: "2026-11-02",
      toWeek: "2026-11-09",
      reason: REASON,
      apply: false,
    });
    expect(parseRecomputeNumbersArgs(args(["--apply"]), NOW).apply).toBe(true);
    // The production flag is accepted (the ops guard reads it from argv itself).
    expect(() =>
      parseRecomputeNumbersArgs(args(["--i-am-authorised-to-write-to-production"]), NOW),
    ).not.toThrow();
  });

  it("refuses a missing or non-Monday week, weeks out of order, before the baseline or in the future", () => {
    const bad: string[][] = [
      ["--to", "2026-11-09", "--reason", "x"],
      ["--from", "2026-11-03", "--to", "2026-11-09", "--reason", "x"],
      ["--from", "2026-11-09", "--to", "2026-11-02", "--reason", "x"],
      ["--from", "2026-05-25", "--to", "2026-06-01", "--reason", "x"],
      ["--from", "2026-11-16", "--to", "2026-11-23", "--reason", "x"],
    ];
    for (const a of bad) expect(() => parseRecomputeNumbersArgs(a, NOW), a.join(" ")).toThrow();
  });

  it("caps a run at two years of weeks", () => {
    expect(RECOMPUTE_MAX_WEEKS).toBe(104);
  });

  it("requires a reason of 1..500 characters after trimming, and refuses an unknown flag", () => {
    for (const reason of ["", "   ", "x".repeat(501)]) {
      expect(() =>
        parseRecomputeNumbersArgs(
          ["--from", "2026-11-02", "--to", "2026-11-02", "--reason", reason],
          NOW,
        ),
      ).toThrow(/reason/);
    }
    expect(() =>
      parseRecomputeNumbersArgs(["--from", "2026-11-02", "--to", "2026-11-02"], NOW),
    ).toThrow(/reason/);
    expect(
      parseRecomputeNumbersArgs(
        ["--from", "2026-11-02", "--to", "2026-11-02", "--reason", "  ok  "],
        NOW,
      ).reason,
    ).toBe("ok");
    expect(() => parseRecomputeNumbersArgs(args(["--force"]), NOW)).toThrow();
  });
});

describe("freezeDaysFromEnv", () => {
  it("reads the setting as the config does, and refuses a bad value", () => {
    expect(freezeDaysFromEnv(undefined)).toBeUndefined();
    expect(freezeDaysFromEnv("")).toBeUndefined();
    expect(freezeDaysFromEnv("5")).toBe(5);
    for (const bad of ["0", "-1", "2.5", "three"]) expect(() => freezeDaysFromEnv(bad)).toThrow();
  });
});

const cell = (
  metric: string,
  value: number | null,
  over: Partial<NumbersSnapshotCellRow> = {},
): NumbersSnapshotCellRow => ({
  weekStart: "2026-11-02",
  metric,
  cityGroup: "all",
  tradeGroup: "all",
  value,
  numerator: null,
  denominator: null,
  suppressed: false,
  definitionVersion: 1,
  ...over,
});

describe("diffWeekRows", () => {
  it("counts added, removed and changed cells per metric, and returns the week's total", () => {
    const into = new Map<string, MetricDiff>();
    const total = diffWeekRows(
      [cell("a", 1), cell("a", 2, { cityGroup: "pune" }), cell("b", 5), cell("gone", 9)],
      [
        cell("a", 1),
        cell("a", 3, { cityGroup: "pune" }),
        cell("b", 5, { definitionVersion: 2 }),
        cell("new", 0),
      ],
      into,
    );
    expect(total).toBe(4);
    expect(Object.fromEntries(into)).toEqual({
      a: { added: 0, removed: 0, changed: 1 },
      b: { added: 0, removed: 0, changed: 1 },
      gone: { added: 0, removed: 1, changed: 0 },
      new: { added: 1, removed: 0, changed: 0 },
    });
  });

  it("an identical week is no change", () => {
    const into = new Map<string, MetricDiff>();
    expect(diffWeekRows([cell("a", 1)], [cell("a", 1)], into)).toBe(0);
    expect(into.size).toBe(0);
  });
});

function deps(stored: Record<string, NumbersSnapshotCellRow[]>) {
  const lines: string[] = [];
  const tx = { tx: true };
  let rolledBack = false;
  const repo = {
    snapshotTablesExist: vi.fn(async () => true),
    workerActivityTableExists: vi.fn(async () => true),
    withTransaction: vi.fn(async (work: (t: never) => Promise<unknown>) => {
      try {
        return await work(tx as never);
      } catch (err) {
        rolledBack = true;
        throw err;
      }
    }),
    lockWeek: vi.fn(async (_t: unknown, _week: string) => undefined),
    readWeek: vi.fn(async (_t: unknown, week: string) => stored[week] ?? []),
    replaceWeek: vi.fn(async () => undefined),
    insertRecomputeLog: vi.fn(async () => "log-1"),
  };
  const snapshot = {
    computeWeekRows: vi.fn(async (_t: unknown, week: string, _h: boolean, _asOf: Date) => [
      cell("paying_companies", 7, { weekStart: week }),
      cell("repeat_purchase_30d", null, { weekStart: week, denominator: 2 }),
    ]),
    // The week rows of 2 Nov are due; no cohort row is (90 days after the week).
    isDueToFreeze: vi.fn(
      (week: string, _now: Date, cls: string) => cls === "week" && week < "2026-11-09",
    ),
  };
  const d = {
    repo,
    snapshot,
    log: (line: string) => lines.push(line),
  } as unknown as RecomputeNumbersDeps;
  return { d, repo, snapshot, lines, tx, rolledBack: () => rolledBack };
}

describe("recomputeNumbers", () => {
  const parsed = (apply: boolean) => ({
    fromWeek: "2026-11-02",
    toWeek: "2026-11-09",
    reason: REASON,
    apply,
  });
  const stored = {
    "2026-11-02": [
      cell("paying_companies", 5),
      cell("repeat_purchase_30d", null, { denominator: 2 }),
    ],
    "2026-11-09": [
      cell("paying_companies", 7, { weekStart: "2026-11-09" }),
      cell("repeat_purchase_30d", null, { weekStart: "2026-11-09", denominator: 2 }),
    ],
  };

  it("a DRY RUN prints the per-metric diff, takes no lock, writes nothing and rolls back", async () => {
    const { d, repo, lines, rolledBack } = deps(stored);
    const out = await recomputeNumbers(d, parsed(false), NOW);
    expect(out).toMatchObject({ applied: false, rowsChanged: 1, logId: null });
    expect(repo.lockWeek).not.toHaveBeenCalled();
    expect(repo.replaceWeek).not.toHaveBeenCalled();
    expect(repo.insertRecomputeLog).not.toHaveBeenCalled();
    expect(rolledBack()).toBe(true);
    expect(lines.join("\n")).toContain("DRY RUN");
    expect(lines.join("\n")).toContain("paying_companies: added=0 removed=0 changed=1");
    expect(lines.join("\n")).toContain("rows_would_change=1");
  });

  it("APPLY rewrites every week (frozen ones included) under its lock, re-freezes the due ones, and logs ONE row on the same transaction", async () => {
    const { d, repo, tx, lines, snapshot } = deps(stored);
    const out = await recomputeNumbers(d, parsed(true), NOW);
    expect(out).toMatchObject({ applied: true, rowsChanged: 1, logId: "log-1" });
    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
    expect(repo.lockWeek.mock.calls.map((c) => c[1])).toEqual(["2026-11-02", "2026-11-09"]);
    // Computed as of the run's clock (it decides which repeat windows are still pending).
    expect(snapshot.computeWeekRows.mock.calls.map((c) => c[3])).toEqual([NOW, NOW]);
    const writes = (
      repo.replaceWeek.mock.calls as unknown as Array<
        [unknown, string, string, Array<{ metric: string }>, Date, Date | null]
      >
    ).map((c) => [c[0], c[1], c[2], c[3].map((r) => r.metric), c[4], c[5]]);
    // Each freeze class on its own: the cohort rows re-freeze only once their window has closed.
    expect(writes).toEqual([
      [tx, "2026-11-02", "week", ["paying_companies"], NOW, NOW],
      [tx, "2026-11-02", "cohort", ["repeat_purchase_30d"], NOW, null],
      [tx, "2026-11-09", "week", ["paying_companies"], NOW, null],
      [tx, "2026-11-09", "cohort", ["repeat_purchase_30d"], NOW, null],
    ]);
    expect(repo.insertRecomputeLog).toHaveBeenCalledTimes(1);
    expect(repo.insertRecomputeLog).toHaveBeenCalledWith(tx, {
      actor: "cli",
      fromWeek: "2026-11-02",
      toWeek: "2026-11-09",
      definitionVersion: 4,
      reason: REASON,
      rowsChanged: 1,
    });
    expect(lines.join("\n")).toContain("log_id=log-1");
  });

  it("NEVER prints the reason", async () => {
    for (const apply of [false, true]) {
      const { d, lines } = deps(stored);
      await recomputeNumbers(d, parsed(apply), NOW);
      expect(lines.join("\n")).not.toContain("NCR widened");
    }
  });

  it("refuses to run before the snapshot's migration", async () => {
    const { d, repo } = deps(stored);
    repo.snapshotTablesExist.mockResolvedValueOnce(false);
    await expect(recomputeNumbers(d, parsed(true), NOW)).rejects.toThrow(/migration/);
    expect(repo.withTransaction).not.toHaveBeenCalled();
  });

  it("a failure inside the apply rolls the whole run back: no log row survives it", async () => {
    const { d, repo } = deps(stored);
    repo.replaceWeek.mockRejectedValueOnce(new Error("disk full"));
    await expect(recomputeNumbers(d, parsed(true), NOW)).rejects.toThrow("disk full");
    expect(repo.insertRecomputeLog).not.toHaveBeenCalled();
  });
});
