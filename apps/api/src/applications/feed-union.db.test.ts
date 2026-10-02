import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, events, type DbClient } from "@badabhai/db";

import { AdminActionsRepository } from "../admin/admin-actions.repository";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { MatchApplyService } from "../match/match-apply.service";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { ApplicationsRepository } from "./applications.repository";
import { ApplicationsService } from "./applications.service";

/**
 * THE INTERIM UNION FEED, AGAINST A REAL POSTGRES (#1823, ADR-0049).
 *
 * The posting arm is one statement of four separate predicates plus two optional filters,
 * and the apply path lands on the V1 upsert. `applications.repository.test.ts` proves the
 * statement SAYS the right thing; only a database can prove it EVALUATES that way:
 *
 *   - status + `published_at` really exclude draft, paused, closed, suspended and unpublished
 *     rows, and the ADR-0037 suspension cascade really takes a posting off the deck;
 *   - the two applied anti-joins exclude applied and RE-SERVE skipped, in both arms, and the
 *     (3b) anti-join really hides a converted twin once the worker applied to its source;
 *   - the twin guard hides a posting only while its source job is OPEN;
 *   - the #1240 `?|` overlap binds ONE text[] (a bare array is `42846: cannot cast type
 *     record to text[]` — a RUNTIME error no statement test can see);
 *   - the cross-table merge orders by the one `posted_at` key;
 *   - a posting apply writes `job_posting_id` with `job_id` NULL through the real V1 upsert,
 *     is idempotent, and freezes a snapshot on a skip→apply flip ONLY when a reach row exists;
 *   - a suspended payer's posting is the neutral 404 on apply and skip, not only off the deck;
 *   - the ops applicants read finds a posting's applicants, and a closed job's, by id space.
 *
 * THE REAL STACK: the shipped repositories, the shipped events service (so every
 * `feed.shown` and `application.*` here is VALIDATED and persisted), and the shipped
 * `MatchApplyService`. Only `MatchFeedService` is absent — V1 is off throughout.
 *
 * FIXTURE DATES ARE IN 2099 so this file's cards sit at the top of a deck that also carries
 * whatever `db:seed:jobs` loaded, and every assertion can read the head of the page.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test feed-union.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it
 * EXECUTED rather than skipped.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Every event this file writes carries it, so cleanup removes exactly those. */
const CORRELATION = uuid(0x18230001);
const CTX: RequestContext = { correlationId: CORRELATION, requestId: "feed-union-db" };

/** Profiled: wants SKILL_A, and applied to J_SRC_APPLIED before the D4 conversion. */
const WORKER = uuid(0x18231001);
/** Unprofiled: no `worker_skill` rows, so the #1240 rule serves him every posting. */
const FRESH = uuid(0x18231002);

const PAYER = uuid(0x18232001);
/** A second owner, so the suspension cascade moves exactly one posting. */
const PAYER_SUSP = uuid(0x18232002);

const SKILL_A = "mskill_vmc_operator";
const SKILL_OTHER = "mskill_cnc_turner";
const INDUSTRY = "ind_industrial_manufacturing";

// ── Legacy `jobs` ─────────────────────────────────────────────────────────────
const J_OPEN = uuid(0x18233001);
const J_SRC_OPEN = uuid(0x18233002); // open source → its twin stays hidden
const J_SRC_CLOSED = uuid(0x18233003); // closed source → its twin is served
const J_SRC_APPLIED = uuid(0x18233004); // closed source WORKER applied to → twin hidden from him

// ── Company `job_postings` ────────────────────────────────────────────────────
const P_A = uuid(0x18234001); // open, published, reach A, Pune
const P_B = uuid(0x18234002); // open, published, reach OTHER, no city
const P_C = uuid(0x18234003); // open, published, reach A, Faridabad
const P_DRAFT = uuid(0x18234004);
const P_PAUSED = uuid(0x18234005);
const P_CLOSED = uuid(0x18234006);
const P_UNPUBLISHED = uuid(0x18234007); // open, but published_at NULL
const P_TWIN_OPEN_SRC = uuid(0x18234008);
const P_TWIN_CLOSED_SRC = uuid(0x18234009);
const P_TWIN_APPLIED = uuid(0x1823400a);
const P_SUSP = uuid(0x1823400b); // PAYER_SUSP's only posting

const ALL_JOBS = [J_OPEN, J_SRC_OPEN, J_SRC_CLOSED, J_SRC_APPLIED];
const ALL_POSTINGS = [
  P_A,
  P_B,
  P_C,
  P_DRAFT,
  P_PAUSED,
  P_CLOSED,
  P_UNPUBLISHED,
  P_TWIN_OPEN_SRC,
  P_TWIN_CLOSED_SRC,
  P_TWIN_APPLIED,
  P_SUSP,
];
const FIXTURE_IDS = new Set([...ALL_JOBS, ...ALL_POSTINGS]);

const at = (day: string) => `2099-01-${day}Z`;

describe.skipIf(!RUN)(
  "#1823 interim union feed — the posting arm and its apply, against Postgres",
  () => {
    let client!: DbClient;
    let repo!: ApplicationsRepository;
    let service!: ApplicationsService;
    let admin!: AdminActionsRepository;

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL, { max: 1 });
      await cleanup(client);
      await seed(client);
      repo = new ApplicationsRepository(client.db);
      admin = new AdminActionsRepository(client.db);
      const workerSkills = new WorkerSkillsRepository(client.db);
      const matchApply = new MatchApplyService(
        client.db,
        workerSkills,
        new MatchConfigService(new MatchConfigRepository(client.db)),
      );
      service = new ApplicationsService(
        repo,
        new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never),
        {} as never, // MatchFeedService — V1 is off, so it is never reached
        matchApply,
        { MATCH_V1_ENABLED: false, FEED_POSTINGS_UNION_ENABLED: true } as never,
        workerSkills,
      );
    }, 60_000);

    afterAll(async () => {
      if (client !== undefined) {
        await cleanup(client);
        await client.sql.end({ timeout: 5 });
      }
    });

    // Every case starts from the same decisions: only WORKER's pre-conversion apply on
    // J_SRC_APPLIED. No reach rows, no events from an earlier case.
    beforeEach(async () => {
      await resetDecisions(client);
    });

    /** The posting arm for one worker, narrowed to this file's fixtures. */
    async function postingArm(
      workerId: string,
      filters: { city?: string; wantedSkillIds: string[] },
    ): Promise<string[]> {
      const rows = await repo.findOpenPostingsForFeed(workerId, 500, filters);
      return rows.map((r) => r.id).filter((id) => FIXTURE_IDS.has(id));
    }

    /** The served deck's ids, narrowed to this file's fixtures, in served order. */
    async function deck(workerId: string): Promise<string[]> {
      const out = await service.getFeed(workerId, 50, {}, CTX);
      return out.jobs.map((j) => j.job_id).filter((id) => FIXTURE_IDS.has(id));
    }

    it("serves only OPEN and PUBLISHED postings — draft, paused, closed, unpublished never", async () => {
      const served = await postingArm(FRESH, { wantedSkillIds: [] });
      expect(new Set(served)).toEqual(
        new Set([P_A, P_B, P_C, P_TWIN_CLOSED_SRC, P_TWIN_APPLIED, P_SUSP]),
      );
      for (const hidden of [P_DRAFT, P_PAUSED, P_CLOSED, P_UNPUBLISHED]) {
        expect(served, hidden).not.toContain(hidden);
      }
    });

    it("the ADR-0037 suspension cascade takes a posting off the deck AND out of apply/skip, and reinstatement returns it", async () => {
      expect(await postingArm(FRESH, { wantedSkillIds: [] })).toContain(P_SUSP);
      try {
        const moved = await admin.suspendPayerInventory(PAYER_SUSP);
        expect(moved.postings).toBe(1);
        expect(await postingArm(FRESH, { wantedSkillIds: [] })).not.toContain(P_SUSP);
        // The decision gate reads the same status the cascade moved: a suspended payer's
        // posting is the identical neutral 404 on apply AND skip, and nothing is written.
        await expect(
          service.apply(FRESH, P_SUSP, { rank: 1, source_surface: "feed" }, CTX),
        ).rejects.toThrow("Job not found");
        await expect(service.skip(FRESH, P_SUSP, { reason: "too_far" }, CTX)).rejects.toThrow(
          "Job not found",
        );
        const written = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM applications
         WHERE worker_id = ${FRESH}::uuid AND job_posting_id = ${P_SUSP}::uuid`;
        expect(written[0]!.n).toBe(0);
      } finally {
        await admin.reinstatePayerInventory(PAYER_SUSP);
      }
      expect(await postingArm(FRESH, { wantedSkillIds: [] })).toContain(P_SUSP);
    });

    it("an OPEN source job hides its converted twin; once the source closes, the twin is served", async () => {
      // The vacancy is on the deck exactly once: as the open job, never also as its twin.
      expect(await deck(FRESH)).toContain(J_SRC_OPEN);
      expect(await postingArm(FRESH, { wantedSkillIds: [] })).not.toContain(P_TWIN_OPEN_SRC);
      try {
        await client.sql`UPDATE jobs SET status = 'closed' WHERE id = ${J_SRC_OPEN}::uuid`;
        expect(await postingArm(FRESH, { wantedSkillIds: [] })).toContain(P_TWIN_OPEN_SRC);
      } finally {
        await client.sql`UPDATE jobs SET status = 'open' WHERE id = ${J_SRC_OPEN}::uuid`;
      }
    });

    it("applied to the legacy SOURCE → the converted twin is not served to him (3b)", async () => {
      // Vacuity guard: the twin IS servable — a worker who never applied to the source sees it.
      expect(await postingArm(FRESH, { wantedSkillIds: [] })).toContain(P_TWIN_APPLIED);
      expect(await postingArm(WORKER, { wantedSkillIds: [] })).not.toContain(P_TWIN_APPLIED);
      // A closed source he did NOT apply to does not hide its twin from him.
      expect(await postingArm(WORKER, { wantedSkillIds: [] })).toContain(P_TWIN_CLOSED_SRC);
    });

    it("the #1240 `?|` gate narrows a profiled worker and passes everyone with none (no 42846)", async () => {
      // EXECUTED with a real array: a bare JS array here is a runtime 42846, not a wrong answer.
      const profiled = await postingArm(WORKER, { wantedSkillIds: [SKILL_A] });
      expect(new Set(profiled)).toEqual(new Set([P_A, P_C, P_TWIN_CLOSED_SRC, P_SUSP]));
      expect(profiled).not.toContain(P_B); // reach is SKILL_OTHER only

      const twoSkills = await postingArm(WORKER, { wantedSkillIds: [SKILL_A, SKILL_OTHER] });
      expect(twoSkills).toContain(P_B); // ANY overlap, not ALL

      const unprofiled = await postingArm(WORKER, { wantedSkillIds: [] });
      expect(unprofiled).toContain(P_B);
    });

    it("the SERVICE reads the worker's own wanted skills from worker_skill", async () => {
      const profiledDeck = await deck(WORKER);
      expect(profiledDeck).toContain(P_A);
      expect(profiledDeck).not.toContain(P_B);
      expect(await deck(FRESH)).toContain(P_B);
    });

    it("city is NULL-tolerant and case-insensitive", async () => {
      const served = await postingArm(FRESH, { wantedSkillIds: [], city: "pune" });
      expect(served).toContain(P_A); // "Pune" matches "pune"
      expect(served).toContain(P_B); // no city bucket matches every city
      expect(served).not.toContain(P_C); // Faridabad
    });

    it("merges both tables by the one posted_at key, ranks 1..n, and subjects each feed.shown by table", async () => {
      await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
      const out = await service.getFeed(FRESH, 50, {}, CTX);
      const head = out.jobs.slice(0, 8);

      expect(head.map((j) => j.job_id)).toEqual([
        P_A, // 2099-01-06
        J_OPEN, // 2099-01-05
        P_B, // 2099-01-04
        J_SRC_OPEN, // 2099-01-03 (its twin is hidden)
        P_C, // 2099-01-02
        P_SUSP, // 2099-01-01 03:00
        P_TWIN_APPLIED, // 2099-01-01 02:00
        P_TWIN_CLOSED_SRC, // 2099-01-01 01:00
      ]);
      expect(head.map((j) => j.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const pa = head[0]!;
      expect(pa.trade_key).toBe("");
      expect(pa.posted_at).toBe("2099-01-06T00:00:00.000Z");
      expect(head[2]!.city).toBe(""); // P_B has no city bucket

      const shown = await client.db
        .select({
          subjectType: events.subjectType,
          subjectId: events.subjectId,
          name: events.eventName,
        })
        .from(events)
        .where(and(eq(events.correlationId, CORRELATION), eq(events.eventName, "feed.shown")));
      const subjectOf = new Map(shown.map((e) => [e.subjectId, e.subjectType]));
      expect(subjectOf.get(P_A)).toBe("job_posting");
      expect(subjectOf.get(J_OPEN)).toBe("job");
      expect(shown).toHaveLength(out.jobs.length);
    });

    it("applied is excluded and skipped is RE-SERVED, in both arms (TD73, O4)", async () => {
      for (const id of [J_OPEN, P_A]) {
        await service.skip(FRESH, id, { reason: "too_far" }, CTX);
        expect(await deck(FRESH), `skipped ${id}`).toContain(id);
        await service.apply(FRESH, id, { rank: 1, source_surface: "feed" }, CTX);
        expect(await deck(FRESH), `applied ${id}`).not.toContain(id);
      }
    });

    it("a posting apply writes job_posting_id with job_id NULL, and a repeat is the same row", async () => {
      const first = await service.apply(FRESH, P_B, { rank: 3, source_surface: "feed" }, CTX);
      const again = await service.apply(FRESH, P_B, { rank: 3, source_surface: "feed" }, CTX);
      expect(again.application_id).toBe(first.application_id);

      const rows = await client.sql<
        {
          job_id: string | null;
          job_posting_id: string | null;
          action: string;
          match_tier: number | null;
        }[]
      >`SELECT job_id, job_posting_id, action, match_tier FROM applications
       WHERE worker_id = ${FRESH}::uuid AND job_posting_id = ${P_B}::uuid`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        job_id: null,
        job_posting_id: P_B,
        action: "applied",
        match_tier: null,
      });

      // One logical event: the key is V1's, so the repeat deduped.
      const submitted = await client.db
        .select({ subjectType: events.subjectType })
        .from(events)
        .where(eq(events.idempotencyKey, `application.submitted:${FRESH}:${P_B}`));
      expect(submitted).toEqual([{ subjectType: "job_posting" }]);
    });

    it("a skip→apply flip freezes a snapshot ONLY when a reach row exists (S3)", async () => {
      // WITH a reach row: the flip writes the real tier and engine version.
      await client.sql`
      INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      VALUES (${P_A}::uuid, ${WORKER}::uuid, 1, ${SKILL_A})
    `;
      await service.skip(WORKER, P_A, { reason: "too_far" }, CTX);
      expect(await snapshotOf(WORKER, P_A)).toEqual({
        action: "skipped",
        match_tier: null,
        engine_version: null,
      });
      await service.apply(WORKER, P_A, { rank: 1, source_surface: "feed" }, CTX);
      const frozen = await snapshotOf(WORKER, P_A);
      expect(frozen.action).toBe("applied");
      expect(frozen.match_tier).toBe(1);
      expect(frozen.engine_version).not.toBeNull();

      // WITHOUT one: the same flip leaves the snapshot NULL — never a fabricated tier.
      await service.skip(FRESH, P_C, { reason: "too_far" }, CTX);
      await service.apply(FRESH, P_C, { rank: 1, source_surface: "feed" }, CTX);
      expect(await snapshotOf(FRESH, P_C)).toEqual({
        action: "applied",
        match_tier: null,
        engine_version: null,
      });
    });

    it("the ops applicants read resolves each id space against real rows — open job, CLOSED job, posting", async () => {
      await service.apply(FRESH, J_OPEN, { rank: 1, source_surface: "feed" }, CTX);
      await service.apply(FRESH, P_B, { rank: 2, source_surface: "feed" }, CTX);

      const byJob = await service.applicantsForJob(J_OPEN);
      expect(byJob.applicants.map((a) => a.worker_id)).toEqual([FRESH]);
      const byPosting = await service.applicantsForJob(P_B);
      expect(byPosting.applicants.map((a) => [a.worker_id, a.action])).toEqual([
        [FRESH, "applied"],
      ]);
      // A CLOSED job is still a `jobs` id: its pre-conversion applicant is read by job_id,
      // and the open twin that job became has none of its own.
      const closed = await service.applicantsForJob(J_SRC_APPLIED);
      expect(closed.applicants.map((a) => a.worker_id)).toEqual([WORKER]);
      expect((await service.applicantsForJob(P_TWIN_APPLIED)).applicants).toEqual([]);
    });

    it("a non-open posting id is the neutral 404, with no row written", async () => {
      for (const id of [P_DRAFT, P_PAUSED, P_CLOSED]) {
        await expect(
          service.apply(FRESH, id, { rank: 1, source_surface: "feed" }, CTX),
        ).rejects.toThrow("Job not found");
      }
      const written = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM applications
       WHERE worker_id = ${FRESH}::uuid
         AND job_posting_id IN (${P_DRAFT}::uuid, ${P_PAUSED}::uuid, ${P_CLOSED}::uuid)`;
      expect(written[0]!.n).toBe(0);
    });

    async function snapshotOf(
      workerId: string,
      postingId: string,
    ): Promise<{ action: string; match_tier: number | null; engine_version: string | null }> {
      const rows = await client.sql<
        { action: string; match_tier: number | null; engine_version: string | null }[]
      >`SELECT action, match_tier, engine_version FROM applications
       WHERE worker_id = ${workerId}::uuid AND job_posting_id = ${postingId}::uuid`;
      return rows[0]!;
    }
  },
);

async function resetDecisions(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const id of [WORKER, FRESH]) {
    await sql`DELETE FROM applications WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM job_reach WHERE worker_id = ${id}::uuid`;
  }
  // The pre-conversion decision the (3b) anti-join is about.
  await sql`
    INSERT INTO applications (worker_id, job_id, action, source_surface)
    VALUES (${WORKER}::uuid, ${J_SRC_APPLIED}::uuid, 'applied', 'feed')
  `;
}

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;

  // `worker_skill.skill_id` and `job_reach.matched_skill_id` both FK to `skill`. Present on a
  // database where D1 ran; the upsert keeps the fixture self-sufficient on a bare migrated one.
  for (const [skillId, label] of [
    [SKILL_A, "VMC Operator"],
    [SKILL_OTHER, "CNC Turner"],
  ] as const) {
    await sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${skillId}, ${label}, 'cnc-machining', 'rvm', 'active', 'match_skill', ${INDUSTRY})
      ON CONFLICT (skill_id) DO NOTHING
    `;
  }

  // Synthetic markers only — no real phone number exists in this fixture.
  for (const [id, tag] of [
    [WORKER, "w"],
    [FRESH, "f"],
  ] as const) {
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${`enc:feed-union-${tag}`}, ${`hash:feed-union-${tag}`}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;
  }
  await sql`
    INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
    VALUES (${WORKER}::uuid, ${SKILL_A}, ${INDUSTRY}, 48, true, 'derived_coarse')
  `;
  await sql`
    INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
    VALUES (${WORKER}::uuid, ${INDUSTRY}, 48)
  `;

  for (const [id, status, created] of [
    [J_OPEN, "open", at("05T00:00:00")],
    [J_SRC_OPEN, "open", at("03T00:00:00")],
    [J_SRC_CLOSED, "closed", at("01T01:00:00")],
    [J_SRC_APPLIED, "closed", at("01T02:00:00")],
  ] as const) {
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, created_at)
      VALUES (${id}::uuid, 'fitter', 'Fitter — Feed Union Fixture', 'Pune', ${status}, ${created}::timestamptz)
    `;
  }

  const posting = async (p: {
    id: string;
    status: string;
    published: string | null;
    reach: string[];
    city?: string | null;
    source?: string | null;
    payer?: string;
  }) => {
    const owner = p.payer ?? PAYER;
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, match_skill_ids, reach_skill_ids, published_at, city,
                                source_job_id)
      VALUES (${p.id}::uuid, ${owner}::uuid, ${owner}::uuid, 'Feed Union Fixture',
              'VMC Operator', '1', ${p.status}, ${JSON.stringify(p.reach)}::jsonb,
              ${JSON.stringify(p.reach)}::jsonb, ${p.published}::timestamptz, ${p.city ?? null},
              ${p.source ?? null}::uuid)
    `;
  };

  await posting({
    id: P_A,
    status: "open",
    published: at("06T00:00:00"),
    reach: [SKILL_A],
    city: "Pune",
  });
  await posting({ id: P_B, status: "open", published: at("04T00:00:00"), reach: [SKILL_OTHER] });
  await posting({
    id: P_C,
    status: "open",
    published: at("02T00:00:00"),
    reach: [SKILL_A],
    city: "Faridabad",
  });
  await posting({ id: P_DRAFT, status: "draft", published: null, reach: [SKILL_A] });
  await posting({ id: P_PAUSED, status: "paused", published: at("07T00:00:00"), reach: [SKILL_A] });
  await posting({ id: P_CLOSED, status: "closed", published: at("07T00:00:00"), reach: [SKILL_A] });
  await posting({ id: P_UNPUBLISHED, status: "open", published: null, reach: [SKILL_A] });
  // D4 twins carry their source's `created_at` as `published_at`, so a converted job keeps
  // its place in the deck.
  await posting({
    id: P_TWIN_OPEN_SRC,
    status: "open",
    published: at("03T00:00:00"),
    reach: [SKILL_A],
    source: J_SRC_OPEN,
  });
  await posting({
    id: P_TWIN_CLOSED_SRC,
    status: "open",
    published: at("01T01:00:00"),
    reach: [SKILL_A],
    source: J_SRC_CLOSED,
  });
  await posting({
    id: P_TWIN_APPLIED,
    status: "open",
    published: at("01T02:00:00"),
    reach: [SKILL_A],
    source: J_SRC_APPLIED,
  });
  await posting({
    id: P_SUSP,
    status: "open",
    published: at("01T03:00:00"),
    reach: [SKILL_A],
    payer: PAYER_SUSP,
  });
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  for (const id of [WORKER, FRESH]) {
    await sql`DELETE FROM applications WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM job_reach WHERE worker_id = ${id}::uuid`;
  }
  // Postings before jobs: `source_job_id` references `jobs`.
  for (const id of ALL_POSTINGS) await sql`DELETE FROM job_postings WHERE id = ${id}::uuid`;
  for (const id of ALL_JOBS) await sql`DELETE FROM jobs WHERE id = ${id}::uuid`;
  for (const id of [WORKER, FRESH]) {
    await sql`DELETE FROM worker_skill WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM workers WHERE id = ${id}::uuid`;
  }
  await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
}
