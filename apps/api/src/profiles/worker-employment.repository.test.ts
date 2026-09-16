import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { type Database, workerEmployment, workerEmploymentRole } from "@badabhai/db";

import {
  EmploymentCountMismatchError,
  WorkerEmploymentRepository,
  readEmployerName,
} from "./worker-employment.repository";

/**
 * STRUCTURAL tests for the work-history replace and the worker's edit read (#1504), against a
 * capturing Drizzle chain — no Postgres.
 *
 * WHY HERE AND NOT IN THE SERVICE TEST. Every protection this issue adds is a property of the
 * TRANSACTION: that the count is checked on the rows the transaction read and BEFORE its delete,
 * that an unreadable row is not in the delete, that an old-build blank save issues no delete at
 * all. The service test mocks the repository and can restate all of that while the real statement
 * order is wrong. So the sequence of statements is what is asserted.
 */

const dialect = new PgDialect();
const compile = (node: unknown) => dialect.sqlToQuery(node as SQL);

const WORKER = "11111111-1111-4111-8111-111111111111";
const READABLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNREADABLE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const READABLE_TOKEN = "ENC-READABLE";
const UNREADABLE_TOKEN = "ENC-UNREADABLE";

type Step =
  | { kind: "select"; table: unknown; projection: Record<string, unknown> }
  | { kind: "delete"; table: unknown; where: unknown }
  | { kind: "insert"; table: unknown; values: Record<string, unknown>[] };

/**
 * A capturing fake of exactly the chains the repository issues, recording ONE ordered list of
 * statements across the bare connection and the transaction handle.
 *
 *   select(p).from(t)[.innerJoin(..)].where(c)[.orderBy(..)]   — awaited
 *   delete(t).where(c)                                          — awaited
 *   insert(t).values(v)[.returning(p)]                          — awaited
 */
function makeDb(data: {
  employments?: Record<string, unknown>[];
  roles?: Record<string, unknown>[];
}) {
  const steps: Step[] = [];
  const rowsFor = (table: unknown) =>
    table === workerEmployment ? (data.employments ?? []) : (data.roles ?? []);

  const ops = {
    select: (projection: Record<string, unknown>) => ({
      from: (table: unknown) => {
        steps.push({ kind: "select", table, projection });
        const result = () => Promise.resolve(rowsFor(table));
        const whereable = {
          where: (_c: unknown) => {
            const p = result();
            return Object.assign(p, { orderBy: (_o: unknown) => result() });
          },
        };
        return { ...whereable, innerJoin: () => whereable };
      },
    }),
    delete: (table: unknown) => ({
      where: async (where: unknown) => {
        steps.push({ kind: "delete", table, where });
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>[]) => {
        steps.push({ kind: "insert", table, values });
        const inserted = values.map((_, i) => ({ id: `new-${i}` }));
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => inserted,
        });
      },
    }),
  };
  const db = {
    ...ops,
    transaction: async (cb: (tx: unknown) => unknown) => cb(ops),
  } as unknown as Database;
  const pii = {
    decrypt: (token: string) => {
      if (token === READABLE_TOKEN) return "Sandhar Technologies";
      throw new Error("unable to authenticate data");
    },
  };
  return { steps, repo: new WorkerEmploymentRepository(db, pii as never) };
}

const stored = (id: string, token: string, sortOrder: number) => ({
  id,
  employerNameEnc: token,
  sortOrder,
});

const newRow = {
  employerNameEnc: "ENC-NEW",
  employerCity: "Manesar",
  employerState: "Haryana",
  startYm: "2022-04",
  endYm: null,
  durationStated: true,
  roles: [
    {
      roleLabel: "CNC Turner",
      startYm: "2022-04",
      endYm: null,
      workDone: "Turning",
      workDoneVoiceNoteId: null,
    },
  ],
};

const kinds = (steps: Step[]) => steps.map((s) => s.kind);
const deletes = (steps: Step[]) =>
  steps.filter((s): s is Extract<Step, { kind: "delete" }> => s.kind === "delete");
const inserts = (steps: Step[]) =>
  steps.filter((s): s is Extract<Step, { kind: "insert" }> => s.kind === "insert");

describe("WorkerEmploymentRepository.replaceForWorker — expected_existing_count (#1504)", () => {
  it("throws on a mismatch BEFORE any delete or insert, on the transaction's own read", async () => {
    const m = makeDb({
      employments: [
        stored(READABLE_ID, READABLE_TOKEN, 0),
        stored(UNREADABLE_ID, READABLE_TOKEN, 1),
      ],
    });
    await expect(
      m.repo.replaceForWorker(WORKER, [newRow], { expectedExistingCount: 1 }),
    ).rejects.toBeInstanceOf(EmploymentCountMismatchError);
    // ONE statement ran — the existing-rows read. Nothing was deleted, nothing was written.
    expect(kinds(m.steps)).toEqual(["select"]);
  });

  it("proceeds when the count matches, reading before deleting", async () => {
    const m = makeDb({ employments: [stored(READABLE_ID, READABLE_TOKEN, 0)] });
    const out = await m.repo.replaceForWorker(WORKER, [newRow], { expectedExistingCount: 1 });
    expect(out).toMatchObject({ replacedExisting: true, existingCount: 1, skipped: false });
    const order = kinds(m.steps);
    expect(order.indexOf("select")).toBeLessThan(order.indexOf("delete"));
    // The mismatch carries counts only.
    expect(new EmploymentCountMismatchError(3, 2).message).toBe(
      "expected 2 stored employment row(s), found 3",
    );
  });
});

describe("WorkerEmploymentRepository.replaceForWorker — unreadable rows survive (#1504)", () => {
  it("deletes ONLY the readable row, scoped to the worker, and numbers new rows after the carried one", async () => {
    const m = makeDb({
      employments: [
        stored(READABLE_ID, READABLE_TOKEN, 0),
        stored(UNREADABLE_ID, UNREADABLE_TOKEN, 1),
      ],
    });
    const out = await m.repo.replaceForWorker(WORKER, [newRow], { expectedExistingCount: 2 });
    expect(out).toMatchObject({ existingCount: 2, carriedUnreadable: 1, skipped: false });

    const [del] = deletes(m.steps);
    expect(del?.table).toBe(workerEmployment);
    const { sql, params } = compile(del!.where);
    expect(sql).toContain('"worker_id"');
    expect(params).toEqual([WORKER, READABLE_ID]);
    expect(params).not.toContain(UNREADABLE_ID);

    // `we_worker_sort_uq`: the carried row holds sort_order 1, so the insert starts at 2.
    const employmentInsert = inserts(m.steps).find((s) => s.table === workerEmployment)!;
    expect(employmentInsert.values.map((v) => v.sortOrder)).toEqual([2]);
  });

  it("issues NO delete at all when every stored row is unreadable", async () => {
    const m = makeDb({ employments: [stored(UNREADABLE_ID, UNREADABLE_TOKEN, 0)] });
    await m.repo.replaceForWorker(WORKER, [], { expectedExistingCount: 1 });
    expect(deletes(m.steps)).toEqual([]);
  });

  it("numbers from zero when nothing is carried — the pre-#1504 rows are byte-identical", async () => {
    const m = makeDb({ employments: [stored(READABLE_ID, READABLE_TOKEN, 0)] });
    await m.repo.replaceForWorker(WORKER, [newRow, newRow]);
    const employmentInsert = inserts(m.steps).find((s) => s.table === workerEmployment)!;
    expect(employmentInsert.values.map((v) => v.sortOrder)).toEqual([0, 1]);
    expect(inserts(m.steps).some((s) => s.table === workerEmploymentRole)).toBe(true);
  });
});

describe("WorkerEmploymentRepository.replaceForWorker — the old-build blank save (#1504)", () => {
  it("with preserveWhenEmpty, [] over stored rows deletes NOTHING and reports skipped", async () => {
    const m = makeDb({ employments: [stored(READABLE_ID, READABLE_TOKEN, 0)] });
    const out = await m.repo.replaceForWorker(WORKER, [], { preserveWhenEmpty: true });
    expect(out).toEqual({
      replacedExisting: false,
      existingCount: 1,
      skipped: true,
      carriedUnreadable: 0,
    });
    expect(kinds(m.steps)).toEqual(["select"]);
  });

  it("without it, [] clears the readable rows as it always has", async () => {
    const m = makeDb({ employments: [stored(READABLE_ID, READABLE_TOKEN, 0)] });
    const out = await m.repo.replaceForWorker(WORKER, [], { expectedExistingCount: 1 });
    expect(out.skipped).toBe(false);
    expect(deletes(m.steps)).toHaveLength(1);
  });

  it("with preserveWhenEmpty and NOTHING stored, proceeds normally (nothing to protect)", async () => {
    const m = makeDb({ employments: [] });
    const out = await m.repo.replaceForWorker(WORKER, [], { preserveWhenEmpty: true });
    expect(out.skipped).toBe(false);
  });
});

describe("WorkerEmploymentRepository.loadForWorkerEdit — the edit read (#1504)", () => {
  it("selects the clip id and polish state, never the rewrite text, and keeps every row sealed", async () => {
    const m = makeDb({
      employments: [
        {
          id: READABLE_ID,
          employerNameEnc: READABLE_TOKEN,
          employerCity: null,
          employerState: null,
          startYm: null,
          endYm: null,
        },
        {
          id: UNREADABLE_ID,
          employerNameEnc: UNREADABLE_TOKEN,
          employerCity: null,
          employerState: null,
          startYm: null,
          endYm: null,
        },
      ],
      roles: [
        {
          employmentId: READABLE_ID,
          roleLabel: "CNC Turner",
          startYm: null,
          endYm: null,
          workDone: "Turning",
          workDoneVoiceNoteId: "22222222-2222-4222-8222-222222222222",
          workDonePolishDeclined: false,
          workDonePolished: "Operated CNC lathes.",
        },
      ],
    });
    const out = await m.repo.loadForWorkerEdit(WORKER);
    // BOTH rows come back — the unreadable one is the service's to count, not this layer's to drop.
    expect(out.map((e) => e.id)).toEqual([READABLE_ID, UNREADABLE_ID]);
    expect(out[0]!.employerNameEnc).toBe(READABLE_TOKEN);
    expect(out[0]!.roles[0]).toEqual({
      roleLabel: "CNC Turner",
      startYm: null,
      endYm: null,
      workDone: "Turning",
      workDoneVoiceNoteId: "22222222-2222-4222-8222-222222222222",
      workDonePolishDeclined: false,
      hasPolish: true,
    });
    expect(JSON.stringify(out)).not.toContain("Operated CNC lathes.");
    const roleSelect = m.steps.find(
      (s) => s.kind === "select" && s.table === workerEmploymentRole,
    ) as Extract<Step, { kind: "select" }> | undefined;
    expect(Object.keys(roleSelect!.projection)).toContain("workDoneVoiceNoteId");
  });
});

describe("readEmployerName — the one readability predicate (#1504)", () => {
  const pii = {
    decrypt: (t: string) => {
      if (t === "blank") return "   ";
      if (t === "ok") return "RVM CAD";
      throw new Error(`bad token ${t}`);
    },
  };
  it("returns the name, and null for a throw or a blank — never rethrowing", () => {
    expect(readEmployerName(pii, "ok")).toBe("RVM CAD");
    expect(readEmployerName(pii, "blank")).toBeNull();
    expect(() => readEmployerName(pii, "garbage")).not.toThrow();
    expect(readEmployerName(pii, "garbage")).toBeNull();
  });
});
