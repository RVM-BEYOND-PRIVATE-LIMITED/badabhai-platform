import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { materializeJobReachWithin, type Database } from "@badabhai/db";
import { candidateSearchStatement, type CandidatePoolQuery } from "../candidates/candidate-search.repository";
import { PrePayFactsRepository } from "../match/pre-pay-facts.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import type { TenantKey } from "../payers/payer-tenant-scope";

/**
 * #2887 — the hidden-student SQL. What these pin:
 *   - REACH keys on the table, never on a switch (#2746 M2): before the migration no reach
 *     statement names `student_visibility`; once it exists, the upsert skips hidden students and
 *     the purge removes them.
 *   - SEARCH and PRE-PAY key on STUDENT_MOVE_ENABLED: off, today's statements exactly; on, the
 *     pool drops hidden students and lets VISIBLE linked ones in, and pre-pay skips visible ones
 *     (with the table missing, today's read).
 */

const dialect = new PgDialect();
const render = (statement: SQL) => dialect.sqlToQuery(statement).sql;
const POSTING = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";

/** A database that records every statement and answers what each reader expects. */
function recordingDb(opts: { tablePresent?: boolean } = {}) {
  const executed: string[] = [];
  const db = {
    execute: async (statement: SQL) => {
      const text = render(statement);
      executed.push(text);
      if (text.includes("to_regclass")) return [{ present: opts.tablePresent ?? true }];
      if (text.includes("count(*)::int AS upserted")) return [{ upserted: 0, inserted: 0 }];
      if (text.includes("AS deleted")) return [{ deleted: 0 }];
      if (text.includes("AS n")) return [{ n: 0 }];
      return [];
    },
    transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(db),
  };
  return { db: db as unknown as Database, executed };
}

const named = (executed: string[]) => executed.filter((s) => s.includes("student_visibility"));

describe("job_reach materialization — the hidden-student filter (keyed on the table)", () => {
  it("before the migration (no table): no statement names student_visibility", async () => {
    const { db, executed } = recordingDb({ tablePresent: false });
    await materializeJobReachWithin(db, POSTING, ["mskill_designer"], ["mskill_designer"]);
    expect(named(executed).filter((s) => !s.includes("to_regclass"))).toEqual([]);
    const upsert = executed.find((s) => s.includes("INSERT INTO job_reach"))!;
    expect(upsert).toContain("AND ws.wants\n          AND EXISTS (");
  });

  it("once the table exists: the upsert skips hidden students and the purge removes their rows", async () => {
    const { db, executed } = recordingDb({ tablePresent: true });
    await materializeJobReachWithin(db, POSTING, ["mskill_designer"], ["mskill_designer"]);
    const upsert = executed.find((s) => s.includes("INSERT INTO job_reach"))!;
    const purge = executed.find((s) => s.includes("DELETE FROM job_reach jr"))!;
    expect(upsert).toContain("NOT EXISTS (\n            SELECT 1 FROM student_visibility sv");
    expect(upsert).toContain("sv.worker_id = ws.worker_id AND NOT sv.visible");
    expect(purge).toContain("OR EXISTS (\n            SELECT 1 FROM student_visibility sv");
    expect(purge).toContain("sv.worker_id = jr.worker_id AND NOT sv.visible");
  });

  it("a posting cleared to an empty reach set never asks", async () => {
    const { db, executed } = recordingDb();
    await materializeJobReachWithin(db, POSTING, [], []);
    expect(named(executed)).toEqual([]);
  });
});

describe("WorkerSkillsRepository — the worker side of reach and the reach counter", () => {
  it("no table: the counter and the reconcile never name student_visibility", async () => {
    const { db, executed } = recordingDb({ tablePresent: false });
    const repo = new WorkerSkillsRepository(db);
    await repo.countWorkersReachedBy(["mskill_designer"]);
    await repo.reconcileReachForWorker(WORKER, ["mskill_designer"]);
    expect(named(executed).filter((s) => !s.includes("to_regclass"))).toEqual([]);
  });

  it("with the table: the counter leaves hidden students out", async () => {
    const { db, executed } = recordingDb({ tablePresent: true });
    await new WorkerSkillsRepository(db).countWorkersReachedBy(["mskill_designer"]);
    expect(executed.find((s) => s.includes("count(DISTINCT ws.worker_id)"))).toContain(
      "AND NOT EXISTS (\n            SELECT 1 FROM student_visibility sv",
    );
  });

  it("a hidden student's reconcile clears his rows and inserts none", async () => {
    const executed: string[] = [];
    const db = {
      execute: async (statement: SQL) => {
        const text = render(statement);
        executed.push(text);
        if (text.includes("to_regclass")) return [{ present: true }];
        if (text.includes("AS hidden")) return [{ hidden: 1 }];
        return [];
      },
      transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(db),
    };
    await new WorkerSkillsRepository(db as unknown as Database).reconcileReachForWorker(WORKER, [
      "mskill_designer",
    ]);
    expect(executed.some((s) => s.startsWith("\n      DELETE FROM job_reach jr"))).toBe(true);
    expect(executed.some((s) => s.includes("INSERT INTO job_reach"))).toBe(false);
  });
});

function poolQuery(over: Partial<CandidatePoolQuery> = {}): CandidatePoolQuery {
  return {
    skillIds: [],
    relatedSkillIds: [],
    experience: null,
    industryId: null,
    industryExperience: null,
    city: null,
    tierFloorMonths: 36,
    strict: false,
    after: null,
    limit: 21,
    tenant: "33333333-3333-4333-8333-333333333333" as TenantKey,
    ...over,
  };
}

describe("company search pool — #2752's rule for moved students", () => {
  it("off: today's statement exactly (the active-link exclusion, no visibility table)", () => {
    const off = render(candidateSearchStatement(poolQuery()));
    expect(render(candidateSearchStatement(poolQuery({ studentMove: false })))).toBe(off);
    expect(off).not.toContain("student_visibility");
    expect(off).toContain(
      "          AND NOT EXISTS (\n            SELECT 1 FROM worker_institute_links il\n            WHERE il.worker_id = w.id AND il.status = 'active'\n          )\n        )",
    );
  });

  it("on: a linked student is in only when visible, and a hidden one is out with or without a link", () => {
    const on = render(candidateSearchStatement(poolQuery({ studentMove: true })));
    expect(on).toContain("OR EXISTS (\n            SELECT 1 FROM student_visibility sv");
    expect(on).toContain("sv.worker_id = w.id AND sv.visible");
    expect(on).toContain("AND NOT EXISTS (\n            SELECT 1 FROM student_visibility sv");
    expect(on).toContain("sv.worker_id = w.id AND NOT sv.visible");
  });
});

describe("pre-pay facts — a visible moved student is a BadaBhai worker", () => {
  it("off: the link read never names student_visibility", async () => {
    const { db, executed } = recordingDb();
    await new PrePayFactsRepository(db).listActiveInstituteLinks([WORKER]);
    expect(named(executed)).toEqual([]);
  });

  it("on: visible students are left out of the active-link read", async () => {
    const { db, executed } = recordingDb({ tablePresent: true });
    await new PrePayFactsRepository(db, { STUDENT_MOVE_ENABLED: true }).listActiveInstituteLinks([
      WORKER,
    ]);
    const read = executed.find((s) => s.includes("FROM worker_institute_links il"))!;
    expect(read).toContain("AND NOT EXISTS (\n            SELECT 1 FROM student_visibility sv");
    expect(read).toContain("sv.worker_id = il.worker_id AND sv.visible");
  });

  it("on with the table missing: today's read", async () => {
    const { db, executed } = recordingDb({ tablePresent: false });
    await new PrePayFactsRepository(db, { STUDENT_MOVE_ENABLED: true }).listActiveInstituteLinks([
      WORKER,
    ]);
    const read = executed.find((s) => s.includes("FROM worker_institute_links il"))!;
    expect(read).not.toContain("student_visibility");
  });
});
