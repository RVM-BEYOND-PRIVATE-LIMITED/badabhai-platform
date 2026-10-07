import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  CURRENT_PROFILE_ORDER,
  jobPostings,
  PROFILE_SOURCE_SESSION_ANSWERS,
  workerIndustryTenure,
  workerProfiles,
  workerSkills,
} from "@badabhai/db";
import type { Database } from "@badabhai/db";
import { MatchFeedRepository } from "./match-feed.repository";
import { WorkerSkillsRepository } from "./worker-skills.repository";

/**
 * STRUCTURAL tests for the Matching V1 supply repository (the reach.repository.test.ts
 * pattern): capture the Drizzle fluent chain / the raw `sql` template, compile it, and
 * assert on the TEXT and the BOUND PARAMETERS.
 *
 * This file is deliberately about the things that are properties of the STATEMENT rather
 * than of a TypeScript expression, because that is where this class's real decisions
 * live: which rows a prune is allowed to touch, whether a paused posting is in scope,
 * whether a skill array crosses the wire as ONE parameter, and whether tier is computed
 * against the POSTED skills or the wider reach set.
 *
 * WHAT IS NOT TESTED HERE, AND WHY. Nothing below asserts that Postgres AGREES with the
 * statement — that a `?|` probe hits the GIN index, that `MIN(CASE …)` really produces
 * best-tier-wins over real rows, or that the two statements in a transaction are
 * genuinely atomic. Those are database facts and they belong to the DB-gated suites
 * (`boost-fences.test.ts`, `rank-parity.test.ts`, `db:verify:match-v1`). `listSkillRows`
 * is a thin projection with one predicate and gets exactly one test — its scope — rather
 * than a mock-was-called ceremony.
 */

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);
const text = (cond: unknown) => compile(cond).sql;
const params = (cond: unknown) => compile(cond).params;

const WORKER = "11111111-1111-4111-8111-111111111111";
const POSTING = "22222222-2222-4222-8222-222222222222";
const MFG = "ind_industrial_manufacturing";

interface Captured {
  selection?: Record<string, unknown>;
  from?: unknown;
  where?: unknown;
  orderBy?: unknown[];
  limit?: number;
  updateTable?: unknown;
  updateSet?: Record<string, unknown>;
  updateReturning?: unknown;
  /** The UPDATE's WHERE, kept apart from `where` (which a later SELECT would overwrite). */
  updateWhere?: unknown;
  /** Every fluent SELECT, in order, with its executor, WHERE and row-lock mode. */
  selects: {
    on: "db" | "tx";
    selection: Record<string, unknown>;
    where?: unknown;
    lock?: string;
  }[];
  /** `select:tx` / `update:tx` / `execute:tx` …, in call order — statement ORDER is a property. */
  ops: string[];
  /** Every raw statement executed, in order, with the executor that ran it. */
  statements: { on: "db" | "tx"; sql: string; params: unknown[] }[];
  inserts: { on: "db" | "tx"; table: unknown; values: unknown; conflict?: unknown }[];
  deletes: { on: "db" | "tx"; table: unknown; where: unknown }[];
  /**
   * How many `db.transaction` calls the repository made. ONE is the whole point of the
   * wants-flip methods: a reconcile that opened its own transaction would be a second,
   * independent transaction — not atomic with the flip — and this counter is what fails.
   */
  transactions: number;
}

function makeDb(
  opts: {
    rows?: unknown[];
    /** Per-SELECT results, consumed in call order; `rows` answers once the queue is empty. */
    selectRows?: unknown[][];
    exec?: unknown[][];
    /**
     * What each UPDATE matched — handed back by `.returning()` AND by awaiting `.where()`.
     * Model Postgres faithfully: an UPDATE scoped only to the worker matches EVERY row he
     * holds, on every call, whatever `wants` already was.
     */
    updateRows?: unknown[][];
  } = {},
) {
  const captured: Captured = {
    statements: [],
    inserts: [],
    deletes: [],
    transactions: 0,
    selects: [],
    ops: [],
  };
  const execQueue = [...(opts.exec ?? [])];
  const updateQueue = [...(opts.updateRows ?? [])];
  const selectQueue = [...(opts.selectRows ?? [])];

  const selectNode = (rows: unknown[], entry: Captured["selects"][number]) => {
    const node: Record<string, unknown> = {
      from: (t: unknown) => {
        captured.from = t;
        return node;
      },
      where: (c: unknown) => {
        captured.where = c;
        entry.where = c;
        return node;
      },
      for: (mode: string) => {
        entry.lock = mode;
        return node;
      },
      orderBy: (...o: unknown[]) => {
        captured.orderBy = o;
        return node;
      },
      limit: (n: number) => {
        captured.limit = n;
        return node;
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return node;
  };

  const executor = (on: "db" | "tx") => ({
    select: (selection: Record<string, unknown>) => {
      captured.selection = selection;
      captured.ops.push(`select:${on}`);
      const entry: Captured["selects"][number] = { on, selection };
      captured.selects.push(entry);
      return selectNode(selectQueue.shift() ?? opts.rows ?? [], entry);
    },
    execute: (stmt: unknown) => {
      const q = compile(stmt);
      captured.statements.push({ on, sql: q.sql, params: q.params });
      captured.ops.push(`execute:${on}`);
      return Promise.resolve(execQueue.shift() ?? []);
    },
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const entry = { on, table, values } as Captured["inserts"][number];
        captured.inserts.push(entry);
        return {
          onConflictDoUpdate: (conflict: unknown) => {
            entry.conflict = conflict;
            return Promise.resolve();
          },
          then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: (where: unknown) => {
        captured.deletes.push({ on, table, where });
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        captured.updateTable = table;
        captured.updateSet = values;
        captured.ops.push(`update:${on}`);
        const node = {
          where: (c: unknown) => {
            captured.where = c;
            captured.updateWhere = c;
            return node;
          },
          returning: (selection: unknown) => {
            captured.updateReturning = selection;
            return Promise.resolve(updateQueue.shift() ?? []);
          },
          // Awaiting the UPDATE without `.returning()` still runs it against the same rows.
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(updateQueue.shift() ?? []).then(res, rej),
        };
        return node;
      },
    }),
  });

  const tx = executor("tx");
  const db = {
    ...executor("db"),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      captured.transactions += 1;
      return cb(tx);
    },
  } as unknown as Database;

  return { db, captured, repo: new WorkerSkillsRepository(db) };
}

/* ════════════════════════════════════════════════════════════════════════════
 * findLatestProfileSignals — the ONLY place the coarse derivation gets its input.
 * Every mapping bug here is silent: it produces a plausible worker with the wrong
 * months, or with no skills at all, and nothing errors.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("findLatestProfileSignals — reads the LATEST profile, by the backfill's order", () => {
  it("scopes to the worker and takes exactly one row, newest first with an id tiebreak", async () => {
    const { repo, captured } = makeDb({ rows: [] });
    await repo.findLatestProfileSignals(WORKER);
    expect(captured.from).toBe(workerProfiles);
    expect(text(captured.where)).toBe('"worker_profiles"."worker_id" = $1');
    expect(params(captured.where)).toEqual([WORKER]);
    expect(captured.limit).toBe(1);
    // The tiebreak is not decoration: `db:backfill:worker-skills` uses the SAME total
    // order, and if the two disagree about which row is "latest" the batch runner
    // silently overwrites the live path's rows with an older profile's skills. They used to
    // agree by COPY — two hand-written arrays that happened to match — which is why this now
    // asserts identity against the one exported definition both import (B-8b).
    expect(captured.orderBy).toEqual([...CURRENT_PROFILE_ORDER]);
    // …and that definition leads with the content leg, so an empty AI-down extraction cannot
    // rebuild this worker's derived skills from nothing.
    expect(text(captured.orderBy![0])).toContain("profile_status");
  });

  it("reads only faceless signal columns — never a name, phone or raw profile", async () => {
    const { repo, captured } = makeDb({ rows: [] });
    await repo.findLatestProfileSignals(WORKER);
    expect(Object.keys(captured.selection!).sort()).toEqual([
      "canonicalRoleId",
      "experience",
      "skills",
      "sourceSession",
    ]);
  });

  it("#2075 — reads the profile's source session through the ONE shared fragment", async () => {
    const { repo, captured } = makeDb({ rows: [] });
    await repo.findLatestProfileSignals(WORKER);
    // Identity, not a copy: `db:backfill:worker-skills` selects the same constant.
    expect(captured.selection!.sourceSession).toBe(PROFILE_SOURCE_SESSION_ANSWERS);
    // Render the REPOSITORY'S OWN selection the way Drizzle renders it in production: inside a
    // single-table `worker_profiles` select. Compiling the fragment standalone qualifies columns
    // that the real query does NOT, which is how an unqualified, mis-correlated subquery
    // (`"worker_id" = "worker_id"`) once passed this test and failed in Postgres.
    const sql = new QueryBuilder()
      .select(captured.selection as Record<string, SQL>)
      .from(workerProfiles)
      .orderBy(...CURRENT_PROFILE_ORDER)
      .limit(1)
      .toSQL().sql;
    // The chain: the profile's own extraction job → the session it names → that session's
    // state, scoped to the profile's own worker, every column qualified.
    expect(sql).toContain('from "ai_jobs" as "src_aj"');
    expect(sql).toContain('inner join "chat_sessions" as "src_cs"');
    expect(sql).toContain('"src_aj"."id" = "worker_profiles"."ai_job_id"');
    expect(sql).toContain(`"src_aj"."job_type" = 'profile_extraction'`);
    expect(sql).toContain('"src_cs"."worker_id" = "worker_profiles"."worker_id"');
    // TEXT comparison: a malformed `input_ref.session_id` matches nothing, never a cast error.
    expect(sql).toContain(`"src_cs"."id"::text = "src_aj"."input_ref" ->> 'session_id'`);
    // Four keys, never the whole envelope.
    for (const key of ["pack_id", "answer_map", "llm_led_turns", "llm_draft_settled"]) {
      expect(sql).toContain(`'${key}', "src_cs"."conversation_state" -> '${key}'`);
    }
    expect(sql.match(/conversation_state/g)).toHaveLength(4);
    expect(sql).not.toMatch(/"worker_id" = "worker_id"|"id" = "ai_job_id"/);
  });

  it("returns undefined when the worker has no profile (not an empty signal object)", async () => {
    const { repo } = makeDb({ rows: [] });
    // An empty object would derive [] and then PRUNE every skill row the worker has —
    // "no profile yet" and "a profile that lists nothing" must not look the same.
    expect(await repo.findLatestProfileSignals(WORKER)).toBeUndefined();
  });

  it("maps a well-formed row to its signals (no source session → null)", async () => {
    const { repo } = makeDb({
      rows: [
        {
          canonicalRoleId: "role_vmc_operator",
          skills: ["skill_turning", "skill_milling"],
          experience: { total_years: 7.5, employers: ["ACME"] },
        },
      ],
    });
    expect(await repo.findLatestProfileSignals(WORKER)).toEqual({
      canonicalRoleId: "role_vmc_operator",
      profileSkills: ["skill_turning", "skill_milling"],
      totalYears: 7.5,
      sourceSession: null,
    });
  });

  it("takes total_years ONLY when it is a finite number", async () => {
    // A "5" from a loosely-typed extraction would multiply by 12 into "512" months as a
    // string somewhere downstream, or NaN the bucket. Both rank a man on nonsense.
    const cases: [unknown, number | null][] = [
      [{ total_years: 5 }, 5],
      [{ total_years: 0 }, 0],
      [{ total_years: "5" }, null],
      [{ total_years: Number.NaN }, null],
      [{ total_years: Number.POSITIVE_INFINITY }, null],
      [{ total_years: null }, null],
      [{}, null],
      [null, null],
      [["total_years", 5], null], // an array is not a record
      ["5 years", null],
    ];
    for (const [experience, expected] of cases) {
      const { repo } = makeDb({ rows: [{ canonicalRoleId: null, skills: [], experience }] });
      const out = await repo.findLatestProfileSignals(WORKER);
      expect(out!.totalYears, JSON.stringify(experience)).toBe(expected);
    }
  });

  it("keeps only string skill ids, and treats a non-array `skills` as none", async () => {
    const { repo } = makeDb({
      rows: [
        { canonicalRoleId: null, skills: ["skill_turning", 42, null, "skill_cmm"], experience: {} },
      ],
    });
    expect((await repo.findLatestProfileSignals(WORKER))!.profileSkills).toEqual([
      "skill_turning",
      "skill_cmm",
    ]);

    const { repo: repo2 } = makeDb({
      rows: [{ canonicalRoleId: null, skills: { a: 1 }, experience: {} }],
    });
    expect((await repo2.findLatestProfileSignals(WORKER))!.profileSkills).toEqual([]);
  });

  it("passes a null canonical role through as null (a worker may have only attributes)", async () => {
    const { repo } = makeDb({ rows: [{ canonicalRoleId: null, skills: [], experience: {} }] });
    expect((await repo.findLatestProfileSignals(WORKER))!.canonicalRoleId).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * replaceDerivedSkillsAndTenure — THE OWNERSHIP RULE. This writer owns
 * `derived_coarse` rows and nothing else; an `interview`/`ops` row a human authored
 * must survive every re-derivation, forever.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("replaceDerivedSkillsAndTenure — the derived writer may only touch its own rows", () => {
  const NOW = new Date("2026-07-31T10:00:00.000Z");
  const ROWS = [
    { skillId: "mskill_vmc_operator", industryId: MFG, monthsBucketed: 36 },
    { skillId: "mskill_cnc_turner", industryId: MFG, monthsBucketed: 36 },
  ];

  it("stamps every inserted row `derived_coarse`, `wants: true`, and NO stint dates", async () => {
    const { repo, captured } = makeDb();
    await repo.replaceDerivedSkillsAndTenure(WORKER, ROWS, [], NOW);
    const values = captured.inserts.map((i) => i.values as Record<string, unknown>);
    expect(values).toHaveLength(2);
    expect(values[0]).toEqual({
      workerId: WORKER,
      skillId: "mskill_vmc_operator",
      industryId: MFG,
      monthsBucketed: 36,
      wants: true, // the launch default (spec Part 6 moment ①)
      source: "derived_coarse",
      updatedAt: NOW,
    });
    // Coarse history: no started_at/ended_at is CLAIMED, so the columns keep their nulls
    // rather than being back-filled with a date the worker never gave us.
    expect(Object.keys(values[1]!)).not.toContain("startedAt");
    expect(Object.keys(values[1]!)).not.toContain("endedAt");
  });

  it("on conflict updates ONLY industry/months/updated_at — never `wants`, never `source`", async () => {
    const { repo, captured } = makeDb();
    await repo.replaceDerivedSkillsAndTenure(WORKER, ROWS, [], NOW);
    const conflict = captured.inserts[0]!.conflict as {
      set: Record<string, unknown>;
      setWhere: unknown;
    };
    // Re-deriving must not resurrect a `wants: false` a worker set deliberately.
    expect(Object.keys(conflict.set).sort()).toEqual(["industryId", "monthsBucketed", "updatedAt"]);
    // ...and it must not reach a row a human authored at all.
    expect(text(conflict.setWhere)).toBe('"worker_skill"."source" = $1');
    expect(params(conflict.setWhere)).toEqual(["derived_coarse"]);
  });

  it("prunes ONLY this worker's derived rows whose skill left the set", async () => {
    const { repo, captured } = makeDb();
    await repo.replaceDerivedSkillsAndTenure(WORKER, ROWS, [], NOW);
    const prune = captured.deletes.find((d) => d.table === workerSkills)!;
    const q = compile(prune.where);
    // Three conditions, all mandatory: drop the worker scope and one profile write wipes
    // the platform's derived rows; drop the source scope and it deletes what a human said.
    expect(q.sql).toContain('"worker_skill"."worker_id" = $1');
    expect(q.sql).toContain('"worker_skill"."source" = $2');
    expect(q.sql).toContain("not in");
    expect(q.params).toEqual([
      WORKER,
      "derived_coarse",
      "mskill_vmc_operator",
      "mskill_cnc_turner",
    ]);
  });

  it("with an EMPTY derivation, prunes every derived row (and still spares interview/ops rows)", async () => {
    // `notInArray(col, [])` is invalid SQL, so the empty case drops the NOT IN clause —
    // the worker legitimately ends up with no derived rows, and only derived rows.
    const { repo, captured } = makeDb();
    await repo.replaceDerivedSkillsAndTenure(WORKER, [], [], NOW);
    const prune = captured.deletes.find((d) => d.table === workerSkills)!;
    const q = compile(prune.where);
    expect(q.sql).not.toContain("not in");
    expect(q.params).toEqual([WORKER, "derived_coarse"]);
    expect(captured.inserts).toHaveLength(0);
  });

  it("rebuilds tenure delete-then-insert so a vacated industry cannot linger", async () => {
    const { repo, captured } = makeDb();
    await repo.replaceDerivedSkillsAndTenure(
      WORKER,
      ROWS,
      [{ industryId: MFG, calendarMonths: 36 }],
      NOW,
    );
    const wipe = captured.deletes.find((d) => d.table === workerIndustryTenure)!;
    expect(text(wipe.where)).toBe('"worker_industry_tenure"."worker_id" = $1');
    expect(params(wipe.where)).toEqual([WORKER]);
    const tenureInsert = captured.inserts.find((i) => i.table === workerIndustryTenure)!;
    expect(tenureInsert.values).toEqual([
      { workerId: WORKER, industryId: MFG, calendarMonths: 36, computedAt: NOW },
    ]);
  });

  it("skips the tenure INSERT entirely when there is no tenure (an empty VALUES is a runtime error)", async () => {
    const { repo, captured } = makeDb();
    await repo.replaceDerivedSkillsAndTenure(WORKER, ROWS, [], NOW);
    expect(captured.inserts.filter((i) => i.table === workerIndustryTenure)).toHaveLength(0);
    // The wipe still happens: a worker who lost his last skill loses his tenure row too.
    expect(captured.deletes.some((d) => d.table === workerIndustryTenure)).toBe(true);
  });

  it("runs every statement on the TRANSACTION, so no reader sees half a rebuild", async () => {
    const { repo, captured } = makeDb();
    await repo.replaceDerivedSkillsAndTenure(
      WORKER,
      ROWS,
      [{ industryId: MFG, calendarMonths: 36 }],
      NOW,
    );
    expect(captured.inserts.every((i) => i.on === "tx")).toBe(true);
    expect(captured.deletes.every((d) => d.on === "tx")).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * listWantedSkillIds — the reach driver's input set.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("listWantedSkillIds — opt-in supply only", () => {
  it("filters on `wants` as well as the worker (a declined skill must not drive reach)", async () => {
    const { repo, captured } = makeDb({ rows: [] });
    await repo.listWantedSkillIds(WORKER);
    const q = compile(captured.where);
    expect(q.sql).toContain('"worker_skill"."worker_id" = $1');
    expect(q.sql).toContain('"worker_skill"."wants" = $2');
    expect(q.params).toEqual([WORKER, true]);
  });

  it("returns the ids, and an empty list when he wants nothing", async () => {
    const { repo } = makeDb({
      rows: [{ skillId: "mskill_fitter" }, { skillId: "mskill_plumber" }],
    });
    expect(await repo.listWantedSkillIds(WORKER)).toEqual(["mskill_fitter", "mskill_plumber"]);
    const { repo: empty } = makeDb({ rows: [] });
    expect(await empty.listWantedSkillIds(WORKER)).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * reconcileReachForWorker — the moment ①② tail. Without it the feed rots silently.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("reconcileReachForWorker — the per-worker job_reach rebuild", () => {
  const SKILLS = ["mskill_vmc_operator", "mskill_cnc_turner"];

  it("clears his rows on OPEN and PAUSED postings — a pause is reversible", async () => {
    const { repo, captured } = makeDb();
    await repo.reconcileReachForWorker(WORKER, SKILLS);
    const del = captured.statements[0]!;
    expect(del.sql).toContain("DELETE FROM job_reach");
    expect(del.sql).toContain("'open'");
    // Excluding paused postings would leave a resumed posting serving a stale reach set —
    // workers who no longer match, and missing the ones who now do.
    expect(del.sql).toContain("'paused'");
    expect(del.params).toEqual([WORKER]);
  });

  it("stops after the DELETE when he wants nothing — he reaches nobody", async () => {
    const { repo, captured } = makeDb();
    await repo.reconcileReachForWorker(WORKER, []);
    expect(captured.statements).toHaveLength(1);
    expect(captured.statements[0]!.sql).toContain("DELETE FROM job_reach");
  });

  it("sends the skill list as ONE array parameter, never an expanded record", async () => {
    // Drizzle expands a bare JS array into a comma-separated placeholder list, and
    // `${skills}::text[]` then fails at runtime with 42846 (cannot cast record to
    // text[]) — the exact bug the `dsql.param()` note in the source is about. Compiling
    // is how we detect it without a database: ONE param that IS the array.
    const { repo, captured } = makeDb();
    await repo.reconcileReachForWorker(WORKER, SKILLS);
    const insert = captured.statements[1]!;
    // The worker id is bound twice (the projected column and the join predicate); the
    // skill list is bound ONCE, as the array itself.
    expect(insert.params).toEqual([WORKER, WORKER, SKILLS]);
    expect(insert.sql).toContain("?|");
  });

  it("computes the tier against the POSTED skills and membership against the REACH set", async () => {
    // If the tier CASE read `reach_skill_ids`, every related-skill candidate would be
    // tier 1 and the whole two-tier gate would collapse into one tier.
    const { repo, captured } = makeDb();
    await repo.reconcileReachForWorker(WORKER, SKILLS);
    const insert = captured.statements[1]!;
    expect(insert.sql).toContain(
      "MIN(CASE WHEN jp.match_skill_ids @> to_jsonb(ws.skill_id) THEN 1 ELSE 2 END)",
    );
    expect(insert.sql).toContain("jp.reach_skill_ids @> to_jsonb(ws.skill_id)");
    // ...and the join only counts skills he WANTS.
    expect(insert.sql).toContain("ws.wants");
  });

  it("re-inserts only for live postings and upserts rather than duplicating", async () => {
    const { repo, captured } = makeDb();
    await repo.reconcileReachForWorker(WORKER, SKILLS);
    const insert = captured.statements[1]!;
    expect(insert.sql).toContain("jp.status IN ('open', 'paused')");
    expect(insert.sql).toContain("ON CONFLICT (job_posting_id, worker_id) DO UPDATE");
  });

  it("runs both statements on the TRANSACTION (never a delete that outlives its insert)", async () => {
    const { repo, captured } = makeDb();
    await repo.reconcileReachForWorker(WORKER, SKILLS);
    expect(captured.statements.map((s) => s.on)).toEqual(["tx", "tx"]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * setWantsAndReconcile — THE PHASE'S INVARIANT. The flip and the reach reconcile are
 * ONE transaction, the wanted set is READ BACK from the database, and the row is
 * stamped `source='interview'` so no future re-derivation may re-propose it.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("setWantsAndReconcile — the flip and the reach reconcile commit together", () => {
  const SKILL = "mskill_vmc_operator";
  const NOW = new Date("2026-09-29T10:00:00.000Z");

  it("runs the UPDATE and the reconcile in exactly ONE transaction", async () => {
    // The invariant E4 exists to make true. Two `db.transaction` calls would be two
    // independent commits: a crash between them leaves the worker reachable through a skill
    // he just declined, and no reader could tell the state was half-applied.
    const { repo, captured } = makeDb({
      updateRows: [[{ skillId: SKILL }]],
      rows: [{ skillId: "mskill_fitter" }],
    });
    await repo.setWantsAndReconcile(WORKER, SKILL, false, NOW);
    expect(captured.transactions).toBe(1);
  });

  it("writes `wants`, `source='interview'` and the timestamp on the (worker, skill) row", async () => {
    const { repo, captured } = makeDb({ updateRows: [[{ skillId: SKILL }]] });
    await repo.setWantsAndReconcile(WORKER, SKILL, false, NOW);
    expect(captured.updateTable).toBe(workerSkills);
    // `interview` is the one source the coarse re-derivation may not overwrite
    // (packages/db/src/schema/match.ts:26-30); `derived_coarse` here would make the toggle
    // undo itself on the next profile write.
    expect(captured.updateSet).toEqual({ wants: false, source: "interview", updatedAt: NOW });
    const q = compile(captured.updateWhere);
    expect(q.sql).toContain('"worker_skill"."worker_id" = $1');
    expect(q.sql).toContain('"worker_skill"."skill_id" = $2');
    expect(q.params).toEqual([WORKER, SKILL]);
  });

  it("reconciles against the wanted set READ BACK from the database, not the flip", async () => {
    // The worker holds several rows; flipping one must reconcile the whole set as the DB now
    // holds it. `mskill_fitter` is what the read-back returns.
    const { repo, captured } = makeDb({
      updateRows: [[{ skillId: SKILL }]],
      rows: [{ skillId: "mskill_fitter" }],
    });
    await repo.setWantsAndReconcile(WORKER, SKILL, false, NOW);
    expect(captured.statements).toHaveLength(2);
    expect(captured.statements[0]!.sql).toContain("DELETE FROM job_reach");
    expect(captured.statements[1]!.sql).toContain("INSERT INTO job_reach");
    // The skill list crosses as ONE array parameter — the read-back set, not a computed one.
    expect(captured.statements[1]!.params).toEqual([WORKER, WORKER, ["mskill_fitter"]]);
  });

  it("runs the UPDATE, the read-back and the reconcile all on the TRANSACTION", async () => {
    const { repo, captured } = makeDb({
      updateRows: [[{ skillId: SKILL }]],
      rows: [{ skillId: "mskill_fitter" }],
    });
    await repo.setWantsAndReconcile(WORKER, SKILL, false, NOW);
    expect(captured.statements.every((s) => s.on === "tx")).toBe(true);
  });

  it("reconciles with an EMPTY set after the LAST wanted skill is turned off", async () => {
    // He must leave every reach set; the DELETE still runs (he reaches nobody).
    const { repo, captured } = makeDb({ updateRows: [[{ skillId: SKILL }]], rows: [] });
    await repo.setWantsAndReconcile(WORKER, SKILL, false, NOW);
    expect(captured.statements).toHaveLength(1);
    expect(captured.statements[0]!.sql).toContain("DELETE FROM job_reach");
  });

  it("answers false and touches NOTHING when the worker holds no such row", async () => {
    // The caller 404s on false; reconciling anyway would churn `job_reach` for a request
    // that changed no state.
    const { repo, captured } = makeDb({ updateRows: [[]] });
    expect(await repo.setWantsAndReconcile(WORKER, SKILL, false, NOW)).toBe(false);
    expect(captured.transactions).toBe(1);
    expect(captured.statements).toHaveLength(0);
  });

  it("answers true when the row existed (the caller may emit)", async () => {
    const { repo } = makeDb({ updateRows: [[{ skillId: SKILL }]], rows: [] });
    expect(await repo.setWantsAndReconcile(WORKER, SKILL, true, NOW)).toBe(true);
  });

  it("sets wants TRUE to turn a skill back on — the toggle is a state, never a deletion", async () => {
    const { repo, captured } = makeDb({
      updateRows: [[{ skillId: SKILL }]],
      rows: [{ skillId: SKILL }],
    });
    await repo.setWantsAndReconcile(WORKER, SKILL, true, NOW);
    expect(captured.updateSet!.wants).toBe(true);
    expect(captured.updateSet!.source).toBe("interview");
    expect(captured.statements[1]!.params).toEqual([WORKER, WORKER, [SKILL]]);
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * clearAllWantsAndReconcile — the E4 exit. EVERY row declined in one transaction,
 * stamped `interview` so the next re-derivation cannot resurrect it, reconciled once.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("clearAllWantsAndReconcile — one call, every row off, one reconcile", () => {
  const NOW = new Date("2026-09-29T10:00:00.000Z");

  // ONE worker, three rows, modelled the way Postgres actually holds them (#1850): a match skill
  // he wants, a match skill he already turned off, and a row outside the closed `mskill_*`
  // vocabulary that is still `wants = true`.
  const ON_MSKILL = "mskill_cnc_turner";
  const OFF_MSKILL = "mskill_vmc_operator";
  const ON_OUT_OF_VOCAB = "skill_turning";
  /** The UPDATE has no `wants` predicate, so it matches ALL of them — on EVERY call. */
  const EVERY_ROW = [{ skillId: ON_MSKILL }, { skillId: OFF_MSKILL }, { skillId: ON_OUT_OF_VOCAB }];
  const FIRST_CALL_STATE = [
    { skillId: ON_MSKILL, wants: true },
    { skillId: OFF_MSKILL, wants: false },
    { skillId: ON_OUT_OF_VOCAB, wants: true },
  ];
  const AFTER_CLEAR_STATE = FIRST_CALL_STATE.map((row) => ({ ...row, wants: false }));

  /** A DB whose pre-read sees `state`, whose UPDATE matches every row, and wants nothing after. */
  const dbHolding = (state: { skillId: string; wants: boolean }[]) =>
    makeDb({ selectRows: [state, []], updateRows: [state.map(({ skillId }) => ({ skillId }))] });

  it("returns exactly the ids that were ON — not every row the UPDATE matched", async () => {
    const { repo } = makeDb({ selectRows: [FIRST_CALL_STATE, []], updateRows: [EVERY_ROW] });
    // The already-off row is NOT in it: this call did not switch it off. The out-of-vocabulary
    // row IS — it really was on — and dropping it is the service's closed-set rule, not a query's.
    expect(await repo.clearAllWantsAndReconcile(WORKER, NOW)).toEqual([ON_MSKILL, ON_OUT_OF_VOCAB]);
  });

  it("a REPEAT call returns [] even though the UPDATE still matches every row", async () => {
    // The pre-#1850 defect: the count came from the UPDATE's RETURNING, which real Postgres
    // fills with every row he holds on every call, so a second tap reported the same N.
    const { repo, captured } = makeDb({
      selectRows: [AFTER_CLEAR_STATE, []],
      updateRows: [EVERY_ROW],
    });
    expect(await repo.clearAllWantsAndReconcile(WORKER, NOW)).toEqual([]);
    // …and the repeat STILL re-stamps and STILL reconciles: a worker already cleared must lose
    // any stale reach rows, so returning early on "nothing was on" would be the wrong fix.
    expect(captured.ops).toContain("update:tx");
    expect(captured.statements).toHaveLength(1);
    expect(captured.statements[0]!.sql).toContain("DELETE FROM job_reach");
  });

  it("a worker with NO rows gets [] and still reconciles", async () => {
    const { repo, captured } = dbHolding([]);
    expect(await repo.clearAllWantsAndReconcile(WORKER, NOW)).toEqual([]);
    expect(captured.statements).toHaveLength(1);
    expect(captured.statements[0]!.sql).toContain("DELETE FROM job_reach");
  });

  it("re-stamps EVERY row of THIS worker — wants=false, source interview, no wants predicate", async () => {
    const { repo, captured } = dbHolding(FIRST_CALL_STATE);
    await repo.clearAllWantsAndReconcile(WORKER, NOW);
    expect(captured.updateTable).toBe(workerSkills);
    expect(captured.updateSet).toEqual({ wants: false, source: "interview", updatedAt: NOW });
    // The scope is the worker and NOTHING else. No `wants` predicate: an already-declined
    // `derived_coarse` row must still become `interview`, or a re-derivation could turn it back
    // on. No source predicate either, for the same reason. The honest count must come from the
    // pre-read, never from narrowing this statement.
    expect(text(captured.updateWhere)).toBe('"worker_skill"."worker_id" = $1');
    expect(text(captured.updateWhere)).not.toContain("wants");
    expect(params(captured.updateWhere)).toEqual([WORKER]);
  });

  it("pre-reads EVERY row of this worker FOR UPDATE, on the transaction, BEFORE the UPDATE", async () => {
    const { repo, captured } = dbHolding(FIRST_CALL_STATE);
    await repo.clearAllWantsAndReconcile(WORKER, NOW);
    const pre = captured.selects[0]!;
    expect(pre.on).toBe("tx");
    expect(Object.keys(pre.selection).sort()).toEqual(["skillId", "wants"]);
    // Every row, not only the wanted ones: an OFF row a concurrent toggle turns ON between the
    // read and the UPDATE would otherwise be switched off by this call and missing from its answer.
    expect(text(pre.where)).toBe('"worker_skill"."worker_id" = $1');
    expect(params(pre.where)).toEqual([WORKER]);
    expect(pre.lock).toBe("update");
    // Read → write → read-back → reconcile. A pre-read AFTER the UPDATE would see nothing on.
    expect(captured.ops).toEqual(["select:tx", "update:tx", "select:tx", "execute:tx"]);
  });

  it("reconciles ONCE, with the empty set read back, in the SAME transaction", async () => {
    const { repo, captured } = dbHolding(FIRST_CALL_STATE);
    await repo.clearAllWantsAndReconcile(WORKER, NOW);
    expect(captured.transactions).toBe(1);
    // The read-back (second SELECT) is the wanted set AFTER the UPDATE — `wants` scoped.
    const readBack = compile(captured.selects[1]!.where);
    expect(readBack.sql).toContain('"worker_skill"."wants" = $2');
    expect(readBack.params).toEqual([WORKER, true]);
    expect(captured.statements).toHaveLength(1);
    expect(captured.statements[0]!.sql).toContain("DELETE FROM job_reach");
    expect(captured.statements[0]!.on).toBe("tx");
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The counters — the posting form's live reach number and the E13 zero-reach gate.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("countWorkersReachedBy — the live 'reaches N workers' counter", () => {
  it("answers 0 for an empty skill set WITHOUT querying (an empty ANY() matches nothing anyway)", async () => {
    const { repo, captured } = makeDb();
    expect(await repo.countWorkersReachedBy([])).toBe(0);
    expect(captured.statements).toHaveLength(0);
  });

  it("counts DISTINCT wanting workers, with the ids as one array parameter", async () => {
    const { repo, captured } = makeDb({ exec: [[{ n: 61 }]] });
    expect(await repo.countWorkersReachedBy(["mskill_vmc_operator"])).toBe(61);
    const q = captured.statements[0]!;
    expect(q.params).toEqual([["mskill_vmc_operator"]]);
    // DISTINCT because one worker can hold several of the reach skills; counting rows
    // would inflate the number a payer sees before paying.
    expect(q.sql).toContain("count(DISTINCT ws.worker_id)");
    expect(q.sql).toContain("ws.wants");
  });

  it("returns 0 when the count comes back empty (never undefined into the E13 gate)", async () => {
    const { repo } = makeDb({ exec: [[]] });
    expect(await repo.countWorkersReachedBy(["mskill_fitter"])).toBe(0);
  });
});

describe("countReachForPosting — total vs tier-1 supply", () => {
  it("maps the row to {total, tier1}", async () => {
    const { repo } = makeDb({ exec: [[{ total: 40, tier1: 12 }]] });
    expect(await repo.countReachForPosting(POSTING)).toEqual({ total: 40, tier1: 12 });
  });

  it("counts tier-1 as a FILTERed subset of the same scan, scoped to the posting", async () => {
    const { repo, captured } = makeDb({ exec: [[{ total: 0, tier1: 0 }]] });
    await repo.countReachForPosting(POSTING);
    const q = captured.statements[0]!;
    expect(q.sql).toContain("FILTER (WHERE match_tier = 1)");
    expect(q.params).toEqual([POSTING]);
  });

  it("returns zeros — not undefined — when the posting has no reach rows (E13's input)", async () => {
    // The zero-reach warning is "never take money for a posting into a void". If this
    // returned undefined the gate would compare undefined and let the sale through.
    const { repo } = makeDb({ exec: [[]] });
    expect(await repo.countReachForPosting(POSTING)).toEqual({ total: 0, tier1: 0 });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * materializeReachForPosting — moment ③.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("materializeReachForPosting — publish-time reach set", () => {
  const POSTED = ["mskill_vmc_operator"];
  const REACH = ["mskill_vmc_operator", "mskill_cnc_turner", "mskill_hmc_operator"];

  it("with NO reach skills, clears the set and inserts nothing", async () => {
    // A posting that LOST its skills must stop serving the workers it no longer matches;
    // returning early without the delete would leave it reaching them forever.
    const { repo, captured } = makeDb();
    await repo.materializeReachForPosting(POSTING, [], []);
    expect(captured.statements).toHaveLength(1);
    expect(captured.statements[0]!.sql).toContain("DELETE FROM job_reach");
    expect(captured.statements[0]!.params).toEqual([POSTING]);
  });

  it("inserts the reach set, then prunes stale rows in the SAME transaction", async () => {
    const { repo, captured } = makeDb();
    await repo.materializeReachForPosting(POSTING, POSTED, REACH);
    expect(captured.statements.map((s) => s.on)).toEqual(["tx", "tx"]);
    expect(captured.statements[0]!.sql).toContain("INSERT INTO job_reach");
    expect(captured.statements[1]!.sql).toContain("DELETE FROM job_reach jr");
    // Insert-then-delete inside one transaction is what stops the set over-claiming
    // after an edit that narrowed the skills.
    expect(captured.statements[1]!.sql).toContain("NOT EXISTS");
  });

  it("binds posted and reach as two separate array parameters (tier vs membership)", async () => {
    const { repo, captured } = makeDb();
    await repo.materializeReachForPosting(POSTING, POSTED, REACH);
    // Order: the posting id, then posted (twice — the CASE and the ARRAY_AGG order),
    // then reach. If posted and reach were the same binding, a related-skill worker
    // would be materialized as tier 1.
    expect(captured.statements[0]!.params).toEqual([POSTING, POSTED, POSTED, REACH]);
    expect(captured.statements[0]!.sql).toContain(
      "MIN(CASE WHEN ws.skill_id = ANY($2::text[]) THEN 1 ELSE 2 END)",
    );
    expect(captured.statements[0]!.sql).toContain("ws.skill_id = ANY($4::text[]) AND ws.wants");
  });

  it("upserts, so re-publishing a posting cannot duplicate a worker's reach row", async () => {
    const { repo, captured } = makeDb();
    await repo.materializeReachForPosting(POSTING, POSTED, REACH);
    expect(captured.statements[0]!.sql).toContain(
      "ON CONFLICT (job_posting_id, worker_id) DO UPDATE",
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * setPostingSkillSets / findPostingSkillSets.
 * ══════════════════════════════════════════════════════════════════════════ */
describe("setPostingSkillSets — FIRST OPEN ONLY", () => {
  it("does NOT touch published_at when the caller passes null (an unpause must not restamp it)", async () => {
    // Restamping would let a posting pause/resume its way back to the top of the
    // newest-first feed for free — a boost bought with a toggle.
    const { repo, captured } = makeDb();
    await repo.setPostingSkillSets(
      POSTING,
      ["mskill_fitter"],
      ["mskill_fitter", "mskill_plumber"],
      null,
    );
    expect(Object.keys(captured.updateSet!).sort()).toEqual([
      "matchSkillIds",
      "reachSkillIds",
      "updatedAt",
    ]);
  });

  it("stamps published_at on the FIRST open", async () => {
    const at = new Date("2026-07-31T09:00:00.000Z");
    const { repo, captured } = makeDb();
    await repo.setPostingSkillSets(POSTING, ["mskill_fitter"], ["mskill_fitter"], at);
    expect(captured.updateSet!.publishedAt).toBe(at);
  });

  it("writes both id arrays to the right posting", async () => {
    const { repo, captured } = makeDb();
    await repo.setPostingSkillSets(
      POSTING,
      ["mskill_fitter"],
      ["mskill_fitter", "mskill_plumber"],
      null,
    );
    expect(captured.updateTable).toBe(jobPostings);
    expect(captured.updateSet!.matchSkillIds).toEqual(["mskill_fitter"]);
    expect(captured.updateSet!.reachSkillIds).toEqual(["mskill_fitter", "mskill_plumber"]);
    expect(text(captured.where)).toBe('"job_postings"."id" = $1');
    expect(params(captured.where)).toEqual([POSTING]);
  });
});

describe("findPostingSkillSets", () => {
  it("returns undefined for a posting that does not exist", async () => {
    const { repo } = makeDb({ rows: [] });
    expect(await repo.findPostingSkillSets(POSTING)).toBeUndefined();
  });

  it("normalises a null/garbage id array to [] rather than propagating it", async () => {
    // A null `reach_skill_ids` reaching the reach resolver as null would throw mid-
    // publish; as [] the posting honestly reaches nobody until it is re-resolved.
    const { repo } = makeDb({
      rows: [
        {
          matchSkillIds: null,
          reachSkillIds: ["mskill_fitter", 7, null],
          publishedAt: null,
          payerId: null,
          createdBy: "ops",
        },
      ],
    });
    expect(await repo.findPostingSkillSets(POSTING)).toEqual({
      matchSkillIds: [],
      reachSkillIds: ["mskill_fitter"],
      publishedAt: null,
      payerId: null,
      createdBy: "ops",
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * The apply-gate reads (moment ⑤).
 * ══════════════════════════════════════════════════════════════════════════ */
describe("findReachRow — the apply gate", () => {
  it("returns undefined when the worker has no reach row (he was never shown the job)", async () => {
    const { repo } = makeDb({ exec: [[]] });
    expect(await repo.findReachRow(WORKER, POSTING)).toBeUndefined();
  });

  it("scopes to the (worker, posting) pair", async () => {
    const { repo, captured } = makeDb({ exec: [[]] });
    await repo.findReachRow(WORKER, POSTING);
    expect(captured.statements[0]!.params).toEqual([WORKER, POSTING]);
  });

  it("counts a reach row ONLY on an OPEN posting (#1904)", async () => {
    const { repo, captured } = makeDb({ exec: [[]] });
    await repo.findReachRow(WORKER, POSTING);
    const { sql } = captured.statements[0]!;
    // `job_reach` rows survive a pause, a close and the suspension cascade. Without this join
    // and predicate a worker holding an id could apply to a posting no feed would serve him.
    expect(sql).toContain("JOIN job_postings jp ON jp.id = jr.job_posting_id");
    expect(sql).toContain("jp.status = 'open'");
    // NOT the reconcile's ('open', 'paused') scope: a paused posting is on no feed.
    expect(sql).not.toContain("paused");
  });

  it("uses the V1 FEED's open-status predicate verbatim — the gate and the feed cannot drift", async () => {
    const statusPredicates = (sql: string) =>
      sql.match(/jp\.status\s*(?:=\s*'[^']*'|IN\s*\([^)]*\))/g) ?? [];

    const feedStatements: string[] = [];
    const feed = new MatchFeedRepository({
      execute: (stmt: unknown) => {
        feedStatements.push(compile(stmt).sql);
        return Promise.resolve([]);
      },
    } as unknown as Database);
    await feed.listFeed(WORKER, 10, {});

    const { repo, captured } = makeDb({ exec: [[]] });
    await repo.findReachRow(WORKER, POSTING);

    // What a worker can SEE and what he can APPLY TO are one rule. If either side widens
    // (say, to `IN ('open','paused')`) without the other, this fails.
    const gate = statusPredicates(captured.statements[0]!.sql);
    expect(gate).toEqual(["jp.status = 'open'"]);
    expect(statusPredicates(feedStatements[0]!)).toEqual(gate);
  });

  it("normalises the tier to the closed set {1,2} — only an exact 1 is tier 1", async () => {
    // The column is an integer. Anything that is not 1 is "reached through a related
    // skill", and a stray 0/3 must never be handed to the rank key as a new best tier
    // that sorts ABOVE the posted-skill workers.
    for (const [stored, expected] of [
      [1, 1],
      [2, 2],
      [3, 2],
      [0, 2],
    ] as const) {
      const { repo } = makeDb({
        exec: [[{ match_tier: stored, matched_skill_id: "mskill_fitter" }]],
      });
      expect((await repo.findReachRow(WORKER, POSTING))!.matchTier).toBe(expected);
    }
  });

  it("carries the matched skill id through — tier and skill must agree", async () => {
    const { repo } = makeDb({
      exec: [[{ match_tier: 2, matched_skill_id: "mskill_cnc_turner" }]],
    });
    expect(await repo.findReachRow(WORKER, POSTING)).toEqual({
      matchTier: 2,
      matchedSkillId: "mskill_cnc_turner",
    });
  });
});

describe("listSkillRows — a thin projection with one predicate that matters", () => {
  it("is scoped to ONE worker", async () => {
    // This feeds `skillMonthsFor` at apply time. An unscoped read would snapshot another
    // man's months onto this application, permanently (the snapshot is frozen, E16).
    const { repo, captured } = makeDb({ rows: [] });
    await repo.listSkillRows(WORKER);
    expect(captured.from).toBe(workerSkills);
    expect(text(captured.where)).toBe('"worker_skill"."worker_id" = $1');
    expect(params(captured.where)).toEqual([WORKER]);
    expect(Object.keys(captured.selection!).sort()).toEqual([
      "industryId",
      "monthsBucketed",
      "skillId",
      "wants",
    ]);
  });
});

describe("findIndustryMonths", () => {
  it("is 0 when the worker has no history in that industry (never undefined into the rank key)", async () => {
    const { repo } = makeDb({ rows: [] });
    expect(await repo.findIndustryMonths(WORKER, MFG)).toBe(0);
  });

  it("returns the stored calendar months for the (worker, industry) pair", async () => {
    const { repo, captured } = makeDb({ rows: [{ calendarMonths: 96 }] });
    expect(await repo.findIndustryMonths(WORKER, MFG)).toBe(96);
    const q = compile(captured.where);
    expect(q.sql).toContain('"worker_industry_tenure"."worker_id" = $1');
    expect(q.sql).toContain('"worker_industry_tenure"."industry_id" = $2');
    expect(q.params).toEqual([WORKER, MFG]);
  });
});

describe("listPostingIdsReaching", () => {
  it("answers [] for an empty skill set WITHOUT querying", async () => {
    const { repo, captured } = makeDb();
    expect(await repo.listPostingIdsReaching([])).toEqual([]);
    expect(captured.where).toBeUndefined();
  });

  it("probes open AND paused postings with the skills as one array parameter", async () => {
    const { repo, captured } = makeDb({ rows: [{ id: POSTING }] });
    expect(await repo.listPostingIdsReaching(["mskill_fitter"])).toEqual([POSTING]);
    const q = compile(captured.where);
    expect(q.sql).toContain("?|");
    // `?|` is the jsonb key-existence operator the reach GIN index is built for; the
    // status pair keeps a paused posting countable, matching the reconcile scope.
    expect(q.params).toEqual(["open", "paused", ["mskill_fitter"]]);
  });
});
