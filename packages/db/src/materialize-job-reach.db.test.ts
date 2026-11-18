import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq, inArray, sql as dsql } from "drizzle-orm";

import { materializeJobReachWithin } from "./agency-twin";
import { createDbClient, type DbClient } from "./client";
import {
  materializePostingReach,
  runMaterializeJobReach,
  selectPostingIds,
} from "./materialize-job-reach";
import { hostClass } from "./ops-guard";
import {
  jobPostings,
  jobReach,
  jobReachWiden,
  skillRelated,
  skills,
  workerSkills,
  workers,
} from "./schema";

/**
 * #1904 — D5 against a REAL Postgres: it materializes the posting's STORED `reach_skill_ids`
 * and never re-derives or rewrites it.
 *
 * What only a database can show: that an honoured UNTICK (0121) and an active ops WIDEN (0090)
 * both survive a rebuild; that an expired-but-unswept widen is left for the sweep; that a
 * `skill_related` edit after publish does not leak into the posting (Policy 23); that a worker
 * who newly qualifies through the stored set is still ADDED; that a stale row is removed; that
 * the dry run's counts match what `--apply` then does and the dry run writes nothing; that an
 * untrustworthy stored set is skipped without touching its rows; and that `--job-posting-id`
 * acts only on a live (open/paused) posting.
 *
 * ── CI DOES NOT RUN THIS FILE (the DB-backed gate in ci.yml runs a fixed list of apps/api
 *    suites). Run it by hand before changing D5.
 *
 * ── IT RUNS D5 OVER EVERY OPEN POSTING, so it refuses any database that is not local and any
 *    whose `job_postings` already holds rows. Point it at a scratch database, migrated from empty:
 *
 *   docker exec badabhai-postgres psql -U badabhai -d postgres -c "CREATE DATABASE bb_scratch_1904"
 *   DATABASE_URL=postgresql://badabhai:badabhai@localhost:5432/bb_scratch_1904 \
 *     pnpm --filter @badabhai/db db:migrate
 *   RUN_DB_TESTS=1 \
 *   MATERIALIZE_REACH_DATABASE_URL=postgresql://badabhai:badabhai@localhost:5432/bb_scratch_1904 \
 *     pnpm --filter @badabhai/db exec vitest run materialize-job-reach.db
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL = process.env.MATERIALIZE_REACH_DATABASE_URL ?? "";

const tag = randomBytes(4).toString("hex");
const S = {
  posted: `mskill_t1904_posted_${tag}`,
  related: `mskill_t1904_related_${tag}`,
  unticked: `mskill_t1904_unticked_${tag}`,
  widened: `mskill_t1904_widened_${tag}`,
  expiredWiden: `mskill_t1904_expired_${tag}`,
  relatedAfterPublish: `mskill_t1904_late_${tag}`,
};

describe.skipIf(!RUN)(
  "D5 materializes the stored reach set against a real database (#1904)",
  () => {
    let client: DbClient;
    const w: Record<string, string> = {};
    const p: Record<string, string> = {};

    async function insertWorker(): Promise<string> {
      const [row] = await client.db
        .insert(workers)
        .values({
          phoneE164: `+9198${Date.now() % 1e8}`,
          phoneHash: randomBytes(32).toString("hex"),
        })
        .returning({ id: workers.id });
      return row!.id;
    }

    async function insertPosting(
      status: "open" | "paused" | "closed",
      matchSkillIds: string[],
      reachSkillIds: string[],
      untickedRelatedIds: string[] = [],
    ): Promise<string> {
      const [row] = await client.db
        .insert(jobPostings)
        .values({
          createdBy: randomUUID(),
          orgLabel: "t1904",
          roleTitle: "t1904",
          vacancyBand: "1",
          status,
          matchSkillIds,
          reachSkillIds,
          untickedRelatedIds,
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ id: jobPostings.id });
      return row!.id;
    }

    async function reachRows(jobPostingId: string) {
      const rows = await client.db
        .select({
          workerId: jobReach.workerId,
          tier: jobReach.matchTier,
          skill: jobReach.matchedSkillId,
        })
        .from(jobReach)
        .where(eq(jobReach.jobPostingId, jobPostingId));
      return new Map(rows.map((r) => [r.workerId, r]));
    }

    async function snapshotPostings() {
      return client.db
        .select({
          id: jobPostings.id,
          reach: jobPostings.reachSkillIds,
          match: jobPostings.matchSkillIds,
          updatedAt: jobPostings.updatedAt,
        })
        .from(jobPostings)
        .orderBy(jobPostings.id);
    }

    beforeAll(async () => {
      expect(DATABASE_URL, "set MATERIALIZE_REACH_DATABASE_URL to a scratch database").not.toBe("");
      expect(hostClass(DATABASE_URL), "refusing a non-local database").toBe("LOCAL DOCKER");
      client = createDbClient(DATABASE_URL, { max: 1 });
      const [{ n }] = (await client.db.select({ n: count() }).from(jobPostings)) as [{ n: number }];
      expect(n, "refusing a database whose job_postings already holds rows").toBe(0);

      await client.db.insert(skills).values(
        Object.values(S).map((skillId) => ({
          skillId,
          labelEn: skillId,
          source: "rvm" as const,
          status: "active" as const,
          kind: "match_skill" as const,
        })),
      );
      // The CURRENT related map — what a re-derivation would read. `unticked` was dropped by the
      // poster and `relatedAfterPublish` was added after publish; neither is in the stored set.
      await client.db.insert(skillRelated).values([
        { skillId: S.posted, relatedSkillId: S.related },
        { skillId: S.posted, relatedSkillId: S.unticked },
        { skillId: S.posted, relatedSkillId: S.relatedAfterPublish },
      ]);

      for (const k of [
        "posted",
        "related",
        "unticked",
        "widened",
        "expiredWiden",
        "late",
        "stale",
      ]) {
        w[k] = await insertWorker();
      }
      const ws = (workerId: string, skillId: string, wants = true) => ({
        workerId,
        skillId,
        industryId: "ind_industrial_manufacturing",
        monthsBucketed: 12,
        wants,
        source: "ops" as const,
      });
      await client.db.insert(workerSkills).values([
        ws(w.posted!, S.posted),
        ws(w.related!, S.related),
        ws(w.unticked!, S.unticked),
        ws(w.widened!, S.widened),
        ws(w.expiredWiden!, S.expiredWiden),
        ws(w.late!, S.relatedAfterPublish),
        // Used to qualify, has since turned `wants` off → stale.
        ws(w.stale!, S.posted, false),
      ]);

      // THE POSTING UNDER TEST. Stored set = posted + related (unticked dropped) + an active
      // widen + an expired-but-unswept widen.
      p.main = await insertPosting(
        "open",
        [S.posted],
        [S.posted, S.related, S.widened, S.expiredWiden],
        [S.unticked],
      );
      const opsActorId = randomUUID();
      await client.db.insert(jobReachWiden).values([
        {
          jobPostingId: p.main,
          addedSkillIds: [S.widened],
          expiresAt: new Date(Date.now() + 86_400_000),
          opsActorId,
        },
        {
          jobPostingId: p.main,
          addedSkillIds: [S.expiredWiden],
          expiresAt: new Date(Date.now() - 86_400_000),
          opsActorId,
        },
      ]);
      // What publish + the two widens materialized. `related`'s worker has qualified since
      // (not yet in job_reach); `stale` has not qualified since.
      await client.db.insert(jobReach).values([
        { jobPostingId: p.main, workerId: w.posted!, matchTier: 1, matchedSkillId: S.posted },
        { jobPostingId: p.main, workerId: w.widened!, matchTier: 2, matchedSkillId: S.widened },
        {
          jobPostingId: p.main,
          workerId: w.expiredWiden!,
          matchTier: 2,
          matchedSkillId: S.expiredWiden,
        },
        { jobPostingId: p.main, workerId: w.stale!, matchTier: 1, matchedSkillId: S.posted },
      ]);

      // Untrustworthy stored sets — skipped, rows untouched.
      p.emptyReach = await insertPosting("open", [S.posted], []);
      p.missingPosted = await insertPosting("open", [S.posted, S.widened], [S.widened, S.related]);
      await client.db.insert(jobReach).values([
        { jobPostingId: p.emptyReach, workerId: w.posted!, matchTier: 1, matchedSkillId: S.posted },
        {
          jobPostingId: p.missingPosted,
          workerId: w.stale!,
          matchTier: 1,
          matchedSkillId: S.posted,
        },
      ]);

      // Not part of the default (open-only) run.
      p.paused = await insertPosting("paused", [S.posted], [S.posted]);
      p.closed = await insertPosting("closed", [S.posted], [S.posted]);
    });

    afterAll(async () => {
      if (client === undefined) return;
      const postingIds = Object.values(p);
      if (postingIds.length > 0)
        await client.db.delete(jobPostings).where(inArray(jobPostings.id, postingIds));
      const workerIds = Object.values(w);
      if (workerIds.length > 0)
        await client.db.delete(workers).where(inArray(workers.id, workerIds));
      await client.db.delete(skillRelated).where(inArray(skillRelated.skillId, Object.values(S)));
      await client.db.delete(skills).where(inArray(skills.skillId, Object.values(S)));
      await client.sql.end({ timeout: 5 });
    });

    it("dry run reports the planned counts and writes nothing", async () => {
      const postingsBefore = await snapshotPostings();
      const reachBefore = await client.db
        .select()
        .from(jobReach)
        .orderBy(jobReach.jobPostingId, jobReach.workerId);

      const summary = await runMaterializeJobReach(client.db, { apply: false });

      expect(summary.postingsProcessed).toBe(3); // the three OPEN postings
      expect(summary.postingsMaterialized).toBe(1);
      // main: reachable = posted, related, widened, expiredWiden → 1 new (related), 3 refreshed;
      // stale is the one row that would go.
      expect(summary.rowsInserted).toBe(1);
      expect(summary.rowsUpdated).toBe(3);
      expect(summary.rowsDeleted).toBe(1);
      expect(summary.skipped.map((s) => [s.jobPostingId, s.reason]).sort()).toEqual(
        [
          [p.emptyReach, "empty_reach_skill_ids"],
          [p.missingPosted, "reach_missing_match_skill_ids"],
        ].sort(),
      );
      expect(
        summary.skipped.find((s) => s.jobPostingId === p.missingPosted)?.missingMatchSkillIds,
      ).toEqual([S.posted]);
      expect(summary.zeroReachIds).toEqual([]);

      expect(await snapshotPostings()).toEqual(postingsBefore);
      expect(
        await client.db.select().from(jobReach).orderBy(jobReach.jobPostingId, jobReach.workerId),
      ).toEqual(reachBefore);
    });

    it("apply materializes the stored set: untick and widens survive, new rows are added, stale goes", async () => {
      const postingsBefore = await snapshotPostings();

      const summary = await runMaterializeJobReach(client.db, { apply: true });

      // Apply does exactly what the dry run planned.
      expect(summary.rowsInserted).toBe(1);
      expect(summary.rowsUpdated).toBe(3);
      expect(summary.rowsDeleted).toBe(1);
      expect(summary.skipped).toHaveLength(2);

      const rows = await reachRows(p.main!);
      expect([...rows.keys()].sort()).toEqual(
        [w.posted!, w.related!, w.widened!, w.expiredWiden!].sort(),
      );
      expect(rows.get(w.posted!)).toMatchObject({ tier: 1, skill: S.posted });
      // NEW reach row through the stored set.
      expect(rows.get(w.related!)).toMatchObject({ tier: 2, skill: S.related });
      // Active ops widen survives the rebuild (Q3).
      expect(rows.get(w.widened!)).toMatchObject({ tier: 2, skill: S.widened });
      // Expired-but-unswept widen is left for the sweep to retract, evented (Q5).
      expect(rows.has(w.expiredWiden!)).toBe(true);
      // The untick survives: the unticked worker is NOT reached even though `skill_related` still
      // lists the skill.
      expect(rows.has(w.unticked!)).toBe(false);
      // A related-map change after publish does not propagate (Q4).
      expect(rows.has(w.late!)).toBe(false);
      expect(rows.has(w.stale!)).toBe(false);

      // The stored sets are never rewritten — not even `updated_at` moves.
      expect(await snapshotPostings()).toEqual(postingsBefore);
      const [widen] = await client.db
        .select({ n: count() })
        .from(jobReachWiden)
        .where(
          dsql`${jobReachWiden.jobPostingId} = ${p.main} AND ${jobReachWiden.retractedAt} IS NULL`,
        );
      expect(widen!.n).toBe(2);

      // Skipped postings' rows are untouched.
      expect([...(await reachRows(p.emptyReach!)).keys()]).toEqual([w.posted]);
      expect([...(await reachRows(p.missingPosted!)).keys()]).toEqual([w.stale]);
    });

    it("a re-run is idempotent", async () => {
      const before = await reachRows(p.main!);
      const summary = await runMaterializeJobReach(client.db, { apply: true });
      expect(summary.rowsInserted).toBe(0);
      expect(summary.rowsDeleted).toBe(0);
      expect(summary.rowsUpdated).toBe(4);
      expect(await reachRows(p.main!)).toEqual(before);
    });

    it("--job-posting-id acts on a paused posting but never on a closed one", async () => {
      expect(await selectPostingIds(client.db, p.paused)).toEqual([p.paused]);
      expect(await selectPostingIds(client.db, p.closed)).toEqual([]);

      const paused = await runMaterializeJobReach(client.db, {
        apply: true,
        onlyPostingId: p.paused,
      });
      expect(paused.postingsMaterialized).toBe(1);
      expect([...(await reachRows(p.paused!)).keys()]).toEqual([w.posted]);

      const closed = await runMaterializeJobReach(client.db, {
        apply: true,
        onlyPostingId: p.closed,
      });
      expect(closed.postingsProcessed).toBe(0);
      expect((await reachRows(p.closed!)).size).toBe(0);

      // The per-posting function refuses a non-live posting on its own, too.
      expect(await materializePostingReach(client.db, p.closed!, { apply: true })).toMatchObject({
        kind: "skipped",
        reason: "not_live",
      });
    });
  },
);

/**
 * #2746 — THE REACH LOCK, on the CLI path and on the shared core the API publish path calls.
 *
 * An `rvm_students` posting reaches no BadaBhai worker: D5 CLEARS it (every row deleted, none
 * written — even when its stored set would fail the stored-set gate), a full run visits it so a
 * leftover row is repaired, and `materializeJobReachWithin` itself — the one statement publish,
 * unpause, edit, ops widen and the agency-twin sync all run — writes nothing for it even when
 * handed the posting's full stored set. `both` and `badabhai_workers` materialize exactly as
 * before. Runs after the suite above, on the same empty-database guard (it removes its rows).
 */
describe.skipIf(!RUN)("#2746 D5 and the shared core never reach for an RVM-only posting", () => {
  let client: DbClient;
  const skill = `mskill_t2746_posted_${tag}`;
  const w: Record<string, string> = {};
  const p: Record<string, string> = {};

  async function insertPosting(
    audience: "badabhai_workers" | "rvm_students" | "both",
    status: "open" | "paused",
    reachSkillIds: string[],
  ): Promise<string> {
    const [row] = await client.db
      .insert(jobPostings)
      .values({
        createdBy: randomUUID(),
        orgLabel: "t2746",
        roleTitle: "t2746",
        vacancyBand: "1",
        status,
        audience,
        matchSkillIds: [skill],
        reachSkillIds,
      })
      .returning({ id: jobPostings.id });
    return row!.id;
  }

  async function workersReached(jobPostingId: string): Promise<string[]> {
    const rows = await client.db
      .select({ workerId: jobReach.workerId })
      .from(jobReach)
      .where(eq(jobReach.jobPostingId, jobPostingId));
    return rows.map((r) => r.workerId).sort();
  }

  beforeAll(async () => {
    expect(DATABASE_URL, "set MATERIALIZE_REACH_DATABASE_URL to a scratch database").not.toBe("");
    expect(hostClass(DATABASE_URL), "refusing a non-local database").toBe("LOCAL DOCKER");
    client = createDbClient(DATABASE_URL, { max: 1 });
    const [{ n }] = (await client.db.select({ n: count() }).from(jobPostings)) as [{ n: number }];
    expect(n, "refusing a database whose job_postings already holds rows").toBe(0);

    await client.db.insert(skills).values({
      skillId: skill,
      labelEn: skill,
      source: "rvm" as const,
      status: "active" as const,
      kind: "match_skill" as const,
    });
    for (const k of ["a", "b"]) {
      const [row] = await client.db
        .insert(workers)
        .values({
          phoneE164: `+9197${Date.now() % 1e8}${k === "a" ? 1 : 2}`,
          phoneHash: randomBytes(32).toString("hex"),
        })
        .returning({ id: workers.id });
      w[k] = row!.id;
    }
    await client.db.insert(workerSkills).values(
      [w.a!, w.b!].map((workerId) => ({
        workerId,
        skillId: skill,
        industryId: "ind_industrial_manufacturing",
        monthsBucketed: 12,
        wants: true,
        source: "ops" as const,
      })),
    );

    p.rvm = await insertPosting("rvm_students", "open", [skill]);
    // An RVM-only posting whose stored set would be SKIPPED by the stored-set gate: the audience
    // rule must still clear it rather than leave its rows untouched.
    p.rvmBadSet = await insertPosting("rvm_students", "open", []);
    p.rvmPaused = await insertPosting("rvm_students", "paused", [skill]);
    p.both = await insertPosting("both", "open", [skill]);
    p.workers = await insertPosting("badabhai_workers", "open", [skill]);
    // Rows left over from before the audience change (or a publish that raced it).
    await client.db.insert(jobReach).values(
      [p.rvm, p.rvmBadSet, p.rvmPaused].map((jobPostingId) => ({
        jobPostingId: jobPostingId!,
        workerId: w.a!,
        matchTier: 1,
        matchedSkillId: skill,
      })),
    );
  }, 60_000);

  afterAll(async () => {
    if (client === undefined) return;
    const postingIds = Object.values(p);
    if (postingIds.length > 0)
      await client.db.delete(jobPostings).where(inArray(jobPostings.id, postingIds));
    const workerIds = Object.values(w);
    if (workerIds.length > 0) await client.db.delete(workers).where(inArray(workers.id, workerIds));
    await client.db.delete(skills).where(eq(skills.skillId, skill));
    await client.sql.end({ timeout: 5 });
  });

  it("dry run plans to clear the RVM-only postings and materialize the others, writing nothing", async () => {
    const before = await client.db
      .select()
      .from(jobReach)
      .orderBy(jobReach.jobPostingId, jobReach.workerId);

    const summary = await runMaterializeJobReach(client.db, { apply: false });

    // Every OPEN posting is visited, whatever its audience — paused is not in a full run.
    expect(summary.postingsProcessed).toBe(4);
    expect([...summary.clearedIds].sort()).toEqual([p.rvm!, p.rvmBadSet!].sort());
    expect(summary.postingsMaterialized).toBe(2);
    expect(summary.skipped).toEqual([]);
    expect(summary.rowsInserted).toBe(4); // a + b on `both` and on `badabhai_workers`
    expect(summary.rowsDeleted).toBe(2); // the two leftover rows on the open RVM-only postings
    expect(summary.zeroReachIds).toEqual([]);
    expect(
      await client.db.select().from(jobReach).orderBy(jobReach.jobPostingId, jobReach.workerId),
    ).toEqual(before);
  }, 30_000);

  it("apply clears the RVM-only postings and reaches both workers through `both` and `badabhai_workers`", async () => {
    const summary = await runMaterializeJobReach(client.db, { apply: true });
    expect(summary.rowsInserted).toBe(4);
    expect(summary.rowsDeleted).toBe(2);

    expect(await workersReached(p.rvm!)).toEqual([]);
    expect(await workersReached(p.rvmBadSet!)).toEqual([]);
    expect(await workersReached(p.both!)).toEqual([w.a!, w.b!].sort());
    expect(await workersReached(p.workers!)).toEqual([w.a!, w.b!].sort());

    // The stored sets are not touched: a later change back to a BadaBhai audience can rebuild.
    const [rvm] = await client.db
      .select({ reach: jobPostings.reachSkillIds })
      .from(jobPostings)
      .where(eq(jobPostings.id, p.rvm!));
    expect(rvm!.reach).toEqual([skill]);
  }, 30_000);

  it("a re-run is idempotent: the RVM-only postings stay at zero", async () => {
    const summary = await runMaterializeJobReach(client.db, { apply: true });
    expect(summary.rowsInserted).toBe(0);
    expect(summary.rowsDeleted).toBe(0);
    expect([...summary.clearedIds].sort()).toEqual([p.rvm!, p.rvmBadSet!].sort());
    expect(await workersReached(p.rvm!)).toEqual([]);
  }, 30_000);

  it("--job-posting-id clears a PAUSED RVM-only posting", async () => {
    expect(await selectPostingIds(client.db, p.rvmPaused)).toEqual([p.rvmPaused]);
    expect(await materializePostingReach(client.db, p.rvmPaused!, { apply: true })).toEqual({
      kind: "cleared",
      jobPostingId: p.rvmPaused,
      rowsDeleted: 1,
    });
    expect(await workersReached(p.rvmPaused!)).toEqual([]);
  }, 30_000);

  it("the shared core (the API publish path's statement) writes nothing for an RVM-only posting, even handed its stored set", async () => {
    // Exactly what `WorkerSkillsRepository.materializeReachForPosting` runs on publish/edit.
    const rvm = await client.db.transaction((tx) =>
      materializeJobReachWithin(tx as unknown as DbClient["db"], p.rvm!, [skill], [skill]),
    );
    expect(rvm).toEqual({ upserted: 0, inserted: 0, deleted: 0 });
    expect(await workersReached(p.rvm!)).toEqual([]);

    // A row slipped in behind it (an audience change racing a publish) is purged by the next call.
    await client.db
      .insert(jobReach)
      .values({ jobPostingId: p.rvm!, workerId: w.b!, matchTier: 1, matchedSkillId: skill });
    const purged = await client.db.transaction((tx) =>
      materializeJobReachWithin(tx as unknown as DbClient["db"], p.rvm!, [skill], [skill]),
    );
    expect(purged).toEqual({ upserted: 0, inserted: 0, deleted: 1 });
    expect(await workersReached(p.rvm!)).toEqual([]);

    // The same call on a `both` posting refreshes both rows in place.
    const both = await client.db.transaction((tx) =>
      materializeJobReachWithin(tx as unknown as DbClient["db"], p.both!, [skill], [skill]),
    );
    expect(both).toEqual({ upserted: 2, inserted: 0, deleted: 0 });
  }, 30_000);
});
