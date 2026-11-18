import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "@badabhai/db";
import { markWorkerEditedWithin, WorkerFieldSourcesRepository } from "./worker-field-sources";

/**
 * #2887 — the per-field source marker: the worker's own edit makes a field his (always wins), the
 * import writes only fields still its own, and nothing is written when the table is missing.
 */

const dialect = new PgDialect();
const WORKER = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";

function recordingDb(opts: { present?: boolean; workerOwned?: string[] } = {}) {
  const executed: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (statement: SQL) => {
      const q = dialect.sqlToQuery(statement);
      executed.push(q);
      if (q.sql.includes("to_regclass")) return [{ present: opts.present ?? true }];
      if (q.sql.includes("SELECT field_key")) {
        return (opts.workerOwned ?? []).map((field_key) => ({ field_key }));
      }
      return [];
    },
  };
  return { db: db as unknown as Database, executed };
}

describe("markWorkerEditedWithin — the worker's own edit", () => {
  it("upserts each key as the worker's, overriding an imported marker", async () => {
    const { db, executed } = recordingDb();
    await markWorkerEditedWithin(db, WORKER, ["skills", "experience", "skills"]);
    const write = executed.find((q) => q.sql.includes("INSERT INTO worker_field_sources"))!;
    expect(write.sql).toContain("'worker'");
    expect(write.sql).toContain("SET source = 'worker', batch_id = NULL");
    expect(write.params).toContainEqual(["skills", "experience"]);
  });

  it("writes nothing when the table is missing (the worker's edit must not fail)", async () => {
    const { db, executed } = recordingDb({ present: false });
    await markWorkerEditedWithin(db, WORKER, ["skills"]);
    expect(executed.some((q) => q.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("no keys: no statement at all", async () => {
    const { db, executed } = recordingDb();
    await markWorkerEditedWithin(db, WORKER, []);
    expect(executed).toEqual([]);
  });

  it("refuses a malformed key", async () => {
    const { db } = recordingDb();
    await expect(markWorkerEditedWithin(db, WORKER, ["Skills; DROP"])).rejects.toThrow();
  });
});

describe("WorkerFieldSourcesRepository — the import side", () => {
  it("a field the worker edited is not importable; the rest are", async () => {
    const { db } = recordingDb({ workerOwned: ["skills"] });
    const repo = new WorkerFieldSourcesRepository(db);
    expect([...(await repo.importableFields(WORKER, ["skills", "experience"]))]).toEqual([
      "experience",
    ]);
    expect(await repo.canImportField(WORKER, "skills")).toBe(false);
  });

  it("marks imported fields, never taking one back from the worker", async () => {
    const { db, executed } = recordingDb();
    await new WorkerFieldSourcesRepository(db).markImported(db, WORKER, ["experience"], BATCH);
    const write = executed.find((q) => q.sql.includes("INSERT INTO worker_field_sources"))!;
    expect(write.sql).toContain("'campus_import'");
    expect(write.sql).toContain("WHERE worker_field_sources.source = 'campus_import'");
    expect(write.params).toContain(BATCH);
  });
});
