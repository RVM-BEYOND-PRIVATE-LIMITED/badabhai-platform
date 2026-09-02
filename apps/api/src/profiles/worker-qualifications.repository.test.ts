import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { type Database, workerCertificates, workerEducations } from "@badabhai/db";

import { WorkerQualificationsRepository } from "./worker-qualifications.repository";

/**
 * STRUCTURAL tests for Zone 5's credential writer (migration 0098), against a capturing Drizzle
 * chain — no Postgres.
 *
 * The service tests mock this repository, so every guarantee that lives in the CALL SEQUENCE or
 * in the QUERY is unfalsifiable from there: a fake can restate the intended semantics and pass
 * while the real statements are wrong. What is captured here is which drizzle method ran against
 * which table, in which order, and through the transaction handle or the bare connection — the
 * ai-jobs / admin-actions repository-test pattern.
 *
 * THE PROPERTY THIS FILE EXISTS FOR is the three-state contract. `undefined` and `[]` reach the
 * repository looking almost identical and mean opposite things, and normalising the first to the
 * second is a one-line change that wipes a worker's certificates the first time a client saves
 * only their education. Nothing above this layer can catch it: the service forwards, the DTO
 * permits both, and the loss is silent.
 */

const dialect = new PgDialect();
const compile = (node: unknown): { sql: string; params: unknown[] } => {
  const q = dialect.sqlToQuery(node as SQL);
  return { sql: q.sql, params: q.params };
};

const WORKER = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKER = "22222222-2222-4222-8222-222222222222";

/** Whether a statement ran on the transaction handle or on the bare connection. */
type Via = "db" | "tx";

interface SelectCall {
  kind: "select";
  via: Via;
  table: unknown;
  projection: Record<string, unknown>;
  where: unknown;
  orderBy?: unknown[];
}
interface DeleteCall {
  kind: "delete";
  via: Via;
  table: unknown;
  where: unknown;
}
interface InsertCall {
  kind: "insert";
  via: Via;
  table: unknown;
  values: Record<string, unknown>[];
}
type Call = SelectCall | DeleteCall | InsertCall;

interface Rows {
  certificates?: Record<string, unknown>[];
  educations?: Record<string, unknown>[];
}

/**
 * A capturing mock of the two chains this repository uses:
 *   select(proj).from(t).where(c)              — awaited directly (the existence probe)
 *   select(proj).from(t).where(c).orderBy(o)   — awaited after ordering (loadForResume)
 * plus delete(t).where(c) and insert(t).values(rows).
 *
 * `where` therefore has to be BOTH awaitable and chainable, which is why it hands back a promise
 * with `orderBy` bolted on rather than a plain builder object.
 */
function makeDb(rows: Rows = {}, failInsertOn?: unknown) {
  const calls: Call[] = [];
  const state = { entered: 0, aborted: false };
  const rowsFor = (table: unknown): Record<string, unknown>[] =>
    table === workerCertificates ? (rows.certificates ?? []) : (rows.educations ?? []);

  const makeOps = (via: Via) => ({
    select: (projection: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (where: unknown) => {
          const call: SelectCall = { kind: "select", via, table, projection, where };
          calls.push(call);
          const resolved = rowsFor(table);
          return Object.assign(Promise.resolve(resolved), {
            orderBy: (...order: unknown[]) => {
              call.orderBy = order;
              return Promise.resolve(resolved);
            },
          });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (where: unknown): Promise<void> => {
        calls.push({ kind: "delete", via, table, where });
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>[]): Promise<void> => {
        calls.push({ kind: "insert", via, table, values });
        if (failInsertOn !== undefined && table === failInsertOn) throw new Error("insert failed");
      },
    }),
  });

  const db = {
    ...makeOps("db"),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      state.entered += 1;
      try {
        return await cb(makeOps("tx"));
      } catch (err) {
        // A rejected callback is what makes the driver ROLL BACK. Recorded so a test can prove
        // the failure propagated rather than being swallowed half-way through the submission.
        state.aborted = true;
        throw err;
      }
    },
  } as unknown as Database;

  return { db, calls, state };
}

/** Kept in sync with the real signature so a shape change breaks here rather than drifting. */
type ReplaceInput = Parameters<WorkerQualificationsRepository["replaceForWorker"]>[1];

async function replace(input: ReplaceInput, existing: Rows = {}) {
  const m = makeDb(existing);
  const result = await new WorkerQualificationsRepository(m.db).replaceForWorker(WORKER, input);
  return { calls: m.calls, state: m.state, result };
}

const on = (calls: Call[], table: unknown): Call[] => calls.filter((c) => c.table === table);
const kindsOn = (calls: Call[], table: unknown): string[] => on(calls, table).map((c) => c.kind);
const insertOn = (calls: Call[], table: unknown): InsertCall | undefined =>
  on(calls, table).find((c): c is InsertCall => c.kind === "insert");
const selectOn = (calls: Call[], table: unknown): SelectCall | undefined =>
  on(calls, table).find((c): c is SelectCall => c.kind === "select");

const certificate = (name: string, year: number | null = null) => ({ name, issuer: null, year });
const education = (field: string, year: number | null = null) => ({
  credential: "iti",
  field,
  council: "ncvt",
  year,
  institute: null,
});

describe("WorkerQualificationsRepository.replaceForWorker — the three-state contract", () => {
  it("leaves worker_certificate COMPLETELY UNTOUCHED when `certificates` is undefined", async () => {
    // The whole point of the optional key, and the assertion that kills the normalising bug:
    // a client saving only the education half must not so much as SELECT the certificate table,
    // let alone delete from it. `toEqual([])` on the calls is stronger than "no insert ran" —
    // a repository that deleted and then skipped the insert would also write nothing.
    const { calls, result } = await replace(
      { educations: [education("Machinist")] },
      { certificates: [{ id: "c1" }] },
    );
    expect(on(calls, workerCertificates)).toEqual([]);
    expect(result.certificatesWritten).toBe(0);
  });

  it("leaves worker_education COMPLETELY UNTOUCHED when `educations` is undefined", async () => {
    // The mirror case. Both halves of the page save independently, so both directions of the
    // partial save have to be safe, not just the one the form happens to submit first.
    const { calls, result } = await replace(
      { certificates: [certificate("Wireman Licence")] },
      { educations: [{ id: "e1" }] },
    );
    expect(on(calls, workerEducations)).toEqual([]);
    expect(result.educationsWritten).toBe(0);
  });

  it("an EMPTY list DELETES and inserts nothing — `[]` is 'I have none', a real answer", async () => {
    // No insert at all, rather than an insert of zero rows: Drizzle throws on an empty `values`
    // array, so "delete then insert unconditionally" is a 500 on the clear-my-certificates path.
    const { calls, result } = await replace({ certificates: [] }, { certificates: [{ id: "c1" }] });
    expect(kindsOn(calls, workerCertificates)).toEqual(["select", "delete"]);
    expect(result.certificatesWritten).toBe(0);
  });

  it("a LIST deletes first and then inserts — never an upsert over the old positions", async () => {
    // `wc_worker_sort_uq` is UNIQUE on (worker_id, sort_order), so re-submitting a list with the
    // second of three removed collides on every position after it unless the old rows are gone
    // before the new ones land. The ORDER here is the guarantee, not merely the presence of both.
    const { calls } = await replace({ certificates: [certificate("A"), certificate("B")] });
    expect(kindsOn(calls, workerCertificates)).toEqual(["select", "delete", "insert"]);
  });
});

describe("WorkerQualificationsRepository.replaceForWorker — one submission, one transaction", () => {
  it("opens exactly ONE transaction and runs BOTH lists inside it", async () => {
    // Two transactions would let a failure between them leave a worker whose certificates are the
    // new ones and whose education is the old — the exact split this repository exists to prevent.
    // `via` is what proves it: a statement issued on the bare connection is outside the rollback.
    const { calls, state } = await replace({
      certificates: [certificate("A")],
      educations: [education("Machinist")],
    });
    expect(state.entered).toBe(1);
    expect(calls).not.toHaveLength(0);
    expect(calls.every((c) => c.via === "tx")).toBe(true);
  });

  it("aborts the WHOLE submission when the second list fails", async () => {
    // The certificates are already deleted and re-inserted by the time the education insert
    // blows up. The error has to leave the transaction callback so the driver rolls that back;
    // swallowing it here is what would ship the half-updated worker.
    const m = makeDb({}, workerEducations);
    const repo = new WorkerQualificationsRepository(m.db);
    await expect(
      repo.replaceForWorker(WORKER, {
        certificates: [certificate("A")],
        educations: [education("Machinist")],
      }),
    ).rejects.toThrow("insert failed");
    expect(m.state.aborted).toBe(true);
  });

  it("opens NO transaction at all when neither key is present", async () => {
    // A round trip that can only ever answer "nothing happened". The DTO refuses an empty body,
    // but this layer is called from more than one place and answers honestly without a database.
    const { calls, state, result } = await replace({});
    expect(state.entered).toBe(0);
    expect(calls).toEqual([]);
    expect(result).toEqual({
      certificatesWritten: 0,
      educationsWritten: 0,
      replacedExisting: false,
    });
  });
});

describe("WorkerQualificationsRepository.replaceForWorker — sort_order is the SUBMITTED order", () => {
  it("numbers certificates 0,1,2 in submission order even when the years descend", async () => {
    // Years deliberately out of order. Sorting by year would reshuffle rows between renders and
    // make every regenerated PDF a false diff — and an undated certificate has no year to sort by
    // at all, yet still has the place the worker gave it.
    const { calls } = await replace({
      certificates: [
        certificate("Newest", 2024),
        certificate("Undated", null),
        certificate("Oldest", 1998),
      ],
    });
    const inserted = insertOn(calls, workerCertificates);
    expect(inserted?.values.map((v) => v.sortOrder)).toEqual([0, 1, 2]);
    expect(inserted?.values.map((v) => v.name)).toEqual(["Newest", "Undated", "Oldest"]);
  });

  it("numbers educations the same way, and stamps the worker id on every row", async () => {
    // The FIELDS are the assertion here, not the numbers. `sortOrder` is re-derived from the
    // index AFTER whatever order the rows arrive in, so it reads 0,1,2 under every permutation,
    // and `workerId` is the same on all of them — a sort inserted above this map is invisible to
    // both. The certificate twin only catches it because it also pins the names.
    //
    // The rows are shaped like that twin for the same reason: an UNDATED row between two dated
    // ones. Two rows with descending years would sit still under a "newest first" sort and prove
    // nothing; with the null in the middle, every ordering by `year` moves something.
    const { calls } = await replace({
      educations: [
        education("Machinist", 2018),
        education("Fitter", null),
        education("Mechanical Engineering", 2012),
      ],
    });
    const inserted = insertOn(calls, workerEducations);
    expect(inserted?.values.map((v) => v.sortOrder)).toEqual([0, 1, 2]);
    expect(inserted?.values.map((v) => v.field)).toEqual([
      "Machinist",
      "Fitter",
      "Mechanical Engineering",
    ]);
    // Without this the rows insert under whatever default the schema has and belong to nobody.
    expect(inserted?.values.every((v) => v.workerId === WORKER)).toBe(true);
  });

  it("carries every certificate column through unchanged", async () => {
    // The repository stores plaintext (0098's ruling) and transforms nothing. A mapping that
    // dropped `issuer` would print a certificate with no awarding body and no error anywhere.
    const { calls } = await replace({
      certificates: [{ name: "Internal Auditor — IATF 16949", issuer: "TÜV", year: 2021 }],
    });
    expect(insertOn(calls, workerCertificates)?.values[0]).toEqual({
      workerId: WORKER,
      name: "Internal Auditor — IATF 16949",
      issuer: "TÜV",
      year: 2021,
      sortOrder: 0,
    });
  });

  it("carries all five education segments through unchanged", async () => {
    // Five columns because the sheet prints five segments; a dropped one is a silently shorter
    // line rather than a failure, so nothing downstream would report it.
    const { calls } = await replace({
      educations: [
        {
          credential: "iti",
          field: "Machinist",
          council: "ncvt",
          year: 2018,
          institute: "Govt. ITI, Faridabad",
        },
      ],
    });
    expect(insertOn(calls, workerEducations)?.values[0]).toEqual({
      workerId: WORKER,
      credential: "iti",
      field: "Machinist",
      council: "ncvt",
      year: 2018,
      institute: "Govt. ITI, Faridabad",
      sortOrder: 0,
    });
  });
});

describe("WorkerQualificationsRepository.replaceForWorker — replacedExisting", () => {
  it("is false when the worker had nothing stored", async () => {
    const { result } = await replace({ certificates: [certificate("A")], educations: [] });
    expect(result.replacedExisting).toBe(false);
  });

  it("is true when either list had rows to replace", async () => {
    const fromCertificates = await replace(
      { certificates: [certificate("A")] },
      { certificates: [{ id: "c1" }] },
    );
    expect(fromCertificates.result.replacedExisting).toBe(true);

    const fromEducations = await replace(
      { educations: [education("Machinist")] },
      { educations: [{ id: "e1" }] },
    );
    expect(fromEducations.result.replacedExisting).toBe(true);
  });

  it("is true when an EMPTY list clears rows that existed", async () => {
    // Clearing IS a replacement. Reporting false would tell the spine a first-time save happened
    // where a worker actually deleted every certificate they had.
    const { result } = await replace({ certificates: [] }, { certificates: [{ id: "c1" }] });
    expect(result.replacedExisting).toBe(true);
  });

  it("ignores rows in the half of the page the submission did not touch", async () => {
    // Certificates exist, but only educations were submitted and the worker had none. Probing a
    // table the submission never writes would report a replacement that did not happen.
    const { result } = await replace(
      { educations: [education("Machinist")] },
      { certificates: [{ id: "c1" }] },
    );
    expect(result.replacedExisting).toBe(false);
  });

  it("counts what was SUBMITTED, not what was found", async () => {
    const { result } = await replace(
      { certificates: [certificate("A"), certificate("B")], educations: [education("Machinist")] },
      { certificates: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] },
    );
    expect(result.certificatesWritten).toBe(2);
    expect(result.educationsWritten).toBe(1);
  });
});

describe("WorkerQualificationsRepository.loadForResume — the read", () => {
  async function load(rows: Rows = {}, workerId: string = WORKER) {
    const m = makeDb(rows);
    const result = await new WorkerQualificationsRepository(m.db).loadForResume(workerId);
    return { calls: m.calls, state: m.state, result };
  }

  it("reads BOTH tables outside any transaction", async () => {
    // A read-only pair of statements; wrapping them would hold a transaction open on the render
    // path for nothing.
    const { calls, state } = await load();
    expect(state.entered).toBe(0);
    expect(calls.map((c) => c.table)).toEqual([workerCertificates, workerEducations]);
  });

  it("binds THIS worker's id in the WHERE of both statements", async () => {
    // The only scoping there is — neither table is otherwise filtered, so an unbound or
    // mis-bound predicate prints someone else's credentials on this worker's sheet.
    const { calls } = await load({}, OTHER_WORKER);
    for (const table of [workerCertificates, workerEducations]) {
      const { sql, params } = compile(selectOn(calls, table)?.where);
      expect(sql).toContain('"worker_id"');
      expect(params).toEqual([OTHER_WORKER]);
    }
  });

  it("orders by sort_order ASCENDING, and never by year", async () => {
    // The schema's decision restated: `sort_order` is the worker's own order, and re-deriving it
    // from `year` reshuffles rows between renders. A `desc` regression would print the worker's
    // list upside down with nothing failing.
    const { calls } = await load();
    for (const table of [workerCertificates, workerEducations]) {
      const orderBy = selectOn(calls, table)?.orderBy;
      expect(orderBy).toHaveLength(1);
      const { sql } = compile(orderBy?.[0]);
      expect(sql).toMatch(/"sort_order" asc/i);
      expect(sql).not.toContain('"year"');
    }
  });

  it("projects exactly the columns the renderer prints — no ids, no worker_id, no timestamps", async () => {
    // Zone 5 composes from these and nothing else. An over-wide projection hands the render path
    // columns it has no business reading; a missing one blanks a segment silently.
    const { calls } = await load();
    expect(Object.keys(selectOn(calls, workerCertificates)!.projection).sort()).toEqual([
      "issuer",
      "name",
      "year",
    ]);
    expect(Object.keys(selectOn(calls, workerEducations)!.projection).sort()).toEqual([
      "council",
      "credential",
      "field",
      "institute",
      "year",
    ]);
  });

  it("returns each table's rows under its OWN key", async () => {
    // Both legs are the same chain against different tables, which is exactly the shape a
    // copy-paste leaves half-edited: two selects on worker_certificate would return certificates
    // under `educations` and the sheet would print a Certificates row twice.
    const { result } = await load({
      certificates: [{ name: "Wireman Licence", issuer: null, year: 2016 }],
      educations: [
        { credential: "iti", field: "Machinist", council: "ncvt", year: 2018, institute: null },
      ],
    });
    expect(result.certificates).toEqual([{ name: "Wireman Licence", issuer: null, year: 2016 }]);
    expect(result.educations).toEqual([
      { credential: "iti", field: "Machinist", council: "ncvt", year: 2018, institute: null },
    ]);
  });

  it("returns two empty lists for a worker with no credentials", async () => {
    // The ordinary case for every worker who has not opened the page. Absence must not be an
    // error, because Zone 5 is optional on the sheet.
    const { result } = await load();
    expect(result).toEqual({ certificates: [], educations: [] });
  });
});
