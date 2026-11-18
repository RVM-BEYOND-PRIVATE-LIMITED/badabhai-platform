import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, events, type DbClient } from "@badabhai/db";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";

import { AdminPostingWorkerVisibilityRepository } from "../admin-postings/admin-posting-worker-visibility.repository";
import { AdminPostingWorkerVisibilityService } from "../admin-postings/admin-posting-worker-visibility.service";
import { AdminPostingsRepository } from "../admin-postings/admin-postings.repository";
import { ApplicationsRepository } from "../applications/applications.repository";
import { ApplicationsService } from "../applications/applications.service";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import type { JobPostingsService } from "../job-postings/job-postings.service";
import { JobsRepository } from "../jobs/jobs.repository";
import { MatchApplyService } from "./match-apply.service";
import { MatchConfigRepository } from "./match-config.repository";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository } from "./match-feed.repository";
import { MatchFeedService } from "./match-feed.service";
import { MatchSkillsService } from "./match-skills.service";
import { PublishReachService } from "./publish-reach.service";
import { ReachWidenRepository } from "./reach-widen.repository";
import { WorkerSkillsRepository } from "./worker-skills.repository";

/**
 * #2746 — AN `rvm_students` POSTING NEVER REACHES A BADABHAI WORKER, against a real Postgres.
 *
 * Two locks, and this file executes both on every worker path:
 *
 *   REACH (the write lock) — the publish path (`PublishReachService.materialize` →
 *     `materializeJobReachWithin`) and the worker-side reconcile write no `job_reach` row for an
 *     RVM-only posting and delete the rows it holds.
 *   READ (the second lock) — a reach row that exists anyway (left over from before an audience
 *     change, or a publish that raced one) still opens nothing: the V1 feed, the legacy union arm,
 *     search (and the ADR-0044 companion read), detail, the V1 apply gate (`findReachRow`), the
 *     union decision target (`findOpenPostingRef`) and reach reconciliation's counter
 *     (`listPostingIdsReaching`) all test the audience beside `hidden_at`.
 *
 * `both` and `badabhai_workers` (the column default) are served exactly as before on every path.
 *
 * NO SWITCH (security review of PR 2, M2): the rule is unconditional. The last block builds the
 * real `ApplicationsService` from `loadServerConfig` — the defaults, and every combination of the
 * `JOB_AUDIENCE_ROLLOUT` switch (off / pilot / on, with the owning company ON the pilot list) and
 * the three feed modes — and the RVM-only posting is excluded in every one: no switch is consulted,
 * so none can re-expose it. (`job-visibility.static.test.ts` in @badabhai/db pins the same thing
 * structurally, for the repositories and for the services that choose between them.)
 *
 * FIXTURE DATES ARE IN 2099 so these cards head any deck a shared database also carries.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test job-audience-visibility.db
 *
 * Runs in CI as one of the DB-backed gates in `ci.yml`, which asserts per-file that it EXECUTED.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const CORRELATION = uuid(0x27460001);
const CTX: RequestContext = { correlationId: CORRELATION, requestId: "job-audience-visibility-db" };
const OPS_ACTOR = uuid(0x27460002);
const CREATED_BY = uuid(0x27460003);
/** The company that owns every fixture posting — and sits on the `job_audience` pilot list. */
const PAYER = uuid(0x27460004);

/** Wants SKILL; holds a reach row on all three served-shape postings. */
const WORKER = uuid(0x27461001);

const SKILL = "mskill_vmc_operator";
const INDUSTRY = "ind_industrial_manufacturing";
/** One search token no other posting carries. */
const TITLE_TOKEN = "t2746vis";

const P_RVM = uuid(0x27462001);
const P_BOTH = uuid(0x27462002);
const P_WORKERS = uuid(0x27462003);
/** Publish-path fixtures: live, sets empty until `PublishReachService.materialize` resolves them. */
const P_PUB_RVM = uuid(0x27462004);
const P_PUB_BOTH = uuid(0x27462005);
/**
 * #2891 — Campus-origin postings: audience `both`, with a `job_posting_worker_visibility` row.
 * HELD (`off`, never decided) must behave exactly as P_RVM on every path; OPENED (`on`) exactly as
 * P_BOTH. FLIP starts held and is turned on and off again through the admin service below.
 */
const P_CAMPUS_HELD = uuid(0x28912001);
const P_CAMPUS_OPENED = uuid(0x28912002);
const P_CAMPUS_FLIP = uuid(0x28912003);
const ALL_POSTINGS = [
  P_RVM,
  P_BOTH,
  P_WORKERS,
  P_PUB_RVM,
  P_PUB_BOTH,
  P_CAMPUS_HELD,
  P_CAMPUS_OPENED,
  P_CAMPUS_FLIP,
];
const FIXTURES = new Set(ALL_POSTINGS);
const SERVED = [P_BOTH, P_WORKERS, P_CAMPUS_OPENED].sort();
/** The admin who decides in the #2891 block (audit_logs.actor_id has no FK). */
const ADMIN = uuid(0x28913001);

const only = (ids: readonly string[]): string[] => ids.filter((id) => FIXTURES.has(id)).sort();

describe.skipIf(!RUN)("#2746 an RVM-only posting reaches no BadaBhai worker, on every path", () => {
  let client!: DbClient;
  let applications!: ApplicationsRepository;
  let jobs!: JobsRepository;
  let matchFeed!: MatchFeedRepository;
  let workerSkills!: WorkerSkillsRepository;
  let eventsService!: EventsService;
  let matchConfig!: MatchConfigService;

  async function reachedPostings(workerId: string): Promise<string[]> {
    const rows = await client.sql<{ id: string }[]>`
      SELECT job_posting_id::text AS id FROM job_reach WHERE worker_id = ${workerId}::uuid`;
    return only(rows.map((r) => r.id));
  }

  async function seedReachRows(): Promise<void> {
    for (const id of [P_RVM, P_BOTH, P_WORKERS, P_CAMPUS_HELD, P_CAMPUS_OPENED]) {
      await client.sql`
        INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
        VALUES (${id}::uuid, ${WORKER}::uuid, 1, ${SKILL})
        ON CONFLICT (job_posting_id, worker_id) DO NOTHING`;
    }
  }

  function applicationsService(config: ServerConfig): ApplicationsService {
    return new ApplicationsService(
      applications,
      eventsService,
      new MatchFeedService(matchFeed, matchConfig, eventsService),
      new MatchApplyService(client.db, workerSkills, matchConfig),
      config,
      workerSkills,
    );
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    await cleanup(client);
    await seed(client);
    applications = new ApplicationsRepository(client.db);
    jobs = new JobsRepository(client.db);
    matchFeed = new MatchFeedRepository(client.db);
    workerSkills = new WorkerSkillsRepository(client.db);
    eventsService = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    matchConfig = new MatchConfigService(new MatchConfigRepository(client.db));
    await seedReachRows();
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  }, 60_000);

  // ── The read lock, one worker path at a time ────────────────────────────────

  it("V1 feed (`MatchFeedRepository.listFeed`): a leftover reach row on an RVM-only posting serves nothing", async () => {
    expect(await reachedPostings(WORKER)).toContain(P_RVM); // the row IS there
    const rows = await matchFeed.listFeed(WORKER, 50, {});
    expect(only(rows.map((r) => r.jobPostingId))).toEqual(SERVED);
  }, 30_000);

  it("legacy union arm (`findOpenPostingsForFeed`): excluded for a profiled AND an unprofiled worker", async () => {
    for (const wantedSkillIds of [[SKILL], []]) {
      const rows = await applications.findOpenPostingsForFeed(WORKER, 500, { wantedSkillIds });
      expect(only(rows.map((r) => r.id)), JSON.stringify(wantedSkillIds)).toEqual(SERVED);
    }
  }, 30_000);

  it("search (`searchOpenPostings`): excluded for a typed term, the profile fallback and the companion window", async () => {
    const base = { workerId: WORKER, city: null, state: null, limit: 200, offset: 0 };
    const typed = await jobs.searchOpenPostings({ ...base, q: TITLE_TOKEN, profileSkillIds: [] });
    expect(only(typed.rows.map((r) => r.id))).toEqual(SERVED);
    const profile = await jobs.searchOpenPostings({ ...base, q: null, profileSkillIds: [SKILL] });
    expect(only(profile.rows.map((r) => r.id))).toEqual(SERVED);
    // ADR-0044 — the chat companion's "new jobs" read is this method with a published window.
    const companion = await jobs.searchOpenPostings({
      ...base,
      q: null,
      profileSkillIds: [SKILL],
      publishedAfter: new Date("2098-12-31T00:00:00Z"),
    });
    expect(only(companion.rows.map((r) => r.id))).toEqual(SERVED);
  }, 30_000);

  it("detail (`findWorkerVisibleJobById`): an RVM-only posting is the neutral miss", async () => {
    expect(await jobs.findWorkerVisibleJobById(P_RVM)).toBeUndefined();
    // #2891 — a held Campus posting is the same miss (share links open this read); an opened one is served.
    expect(await jobs.findWorkerVisibleJobById(P_CAMPUS_HELD)).toBeUndefined();
    expect((await jobs.findWorkerVisibleJobById(P_CAMPUS_OPENED))?.id).toBe(P_CAMPUS_OPENED);
    expect((await jobs.findWorkerVisibleJobById(P_BOTH))?.id).toBe(P_BOTH);
    expect((await jobs.findWorkerVisibleJobById(P_WORKERS))?.id).toBe(P_WORKERS);
  }, 30_000);

  it("V1 apply gate (`findReachRow`): the reach row exists, the gate stays shut", async () => {
    expect(await workerSkills.findReachRow(WORKER, P_RVM)).toBeUndefined();
    expect(await workerSkills.findReachRow(WORKER, P_CAMPUS_HELD)).toBeUndefined();
    expect(await workerSkills.findReachRow(WORKER, P_CAMPUS_OPENED)).toBeDefined();
    expect(await workerSkills.findReachRow(WORKER, P_BOTH)).toEqual({
      matchTier: 1,
      matchedSkillId: SKILL,
    });
    expect(await workerSkills.findReachRow(WORKER, P_WORKERS)).toBeDefined();
  }, 30_000);

  it("union decision target (`findOpenPostingRef`): an RVM-only posting is not a target", async () => {
    expect(await applications.findOpenPostingRef(P_RVM)).toBeUndefined();
    expect(await applications.findOpenPostingRef(P_CAMPUS_HELD)).toBeUndefined();
    expect(await applications.findOpenPostingRef(P_CAMPUS_OPENED)).toEqual({ id: P_CAMPUS_OPENED });
    expect(await applications.findOpenPostingRef(P_BOTH)).toEqual({ id: P_BOTH });
    expect(await applications.findOpenPostingRef(P_WORKERS)).toEqual({ id: P_WORKERS });
  }, 30_000);

  it("reconciliation counter (`listPostingIdsReaching`): counts only what the reconcile writes", async () => {
    expect(only(await workerSkills.listPostingIdsReaching([SKILL]))).toEqual(SERVED);
  }, 30_000);

  // ── The reach lock ──────────────────────────────────────────────────────────

  it("worker-side reconcile (`reconcileReachForWorker`): drops the RVM-only row and never re-inserts it", async () => {
    await workerSkills.reconcileReachForWorker(WORKER, [SKILL]);
    expect(await reachedPostings(WORKER)).toEqual(SERVED);
    await seedReachRows(); // restore the leftover row for the cases below
  }, 30_000);

  it("publish path (`PublishReachService.materialize`): an RVM-only posting materializes zero rows; `both` reaches the worker", async () => {
    const publish = new PublishReachService(
      new MatchSkillsService(matchConfig, workerSkills),
      workerSkills,
      eventsService,
      new ReachWidenRepository(client.db),
      matchConfig,
    );
    const input = {
      matchSkillIds: [SKILL],
      untickedIds: [],
      trigger: "publish" as const,
      actor: { actor_type: "ops" as const, actor_id: OPS_ACTOR },
    };

    // draft → open, as `JobPostingsService` does before it calls materialize. A row from before
    // the audience was set must go too.
    await client.sql`
      UPDATE job_postings SET status = 'open'
       WHERE id IN (${P_PUB_RVM}::uuid, ${P_PUB_BOTH}::uuid)`;
    await client.sql`
      INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      VALUES (${P_PUB_RVM}::uuid, ${WORKER}::uuid, 1, ${SKILL})`;
    const rvm = await publish.materialize(P_PUB_RVM, input, CTX);
    expect(rvm.reachTotal).toBe(0);
    // #2746 PR 4 — empty by design, so not the E13 void (and no zero_reach alert).
    expect(rvm.zeroReach).toBe(false);
    const rows = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_reach WHERE job_posting_id = ${P_PUB_RVM}::uuid`;
    expect(rows[0]?.n).toBe(0);
    // The resolved set is still stored, so a later change to a BadaBhai audience can rebuild.
    expect(rvm.reachSkillIds).toContain(SKILL);
    const [stored] = await client.sql<{ reach: string[] }[]>`
      SELECT reach_skill_ids AS reach FROM job_postings WHERE id = ${P_PUB_RVM}::uuid`;
    expect(stored!.reach).toContain(SKILL);

    const both = await publish.materialize(P_PUB_BOTH, input, CTX);
    expect(both.reachTotal).toBeGreaterThanOrEqual(1);
    expect(await reachedPostings(WORKER)).toContain(P_PUB_BOTH);
    expect(await reachedPostings(WORKER)).not.toContain(P_PUB_RVM);
  }, 60_000);

  // ── #2891: an admin opens a held Campus posting, then holds it again ────────

  it("#2891 admin: on builds reach and opens the worker paths; a bulk off clears reach and closes them", async () => {
    const publish = new PublishReachService(
      new MatchSkillsService(matchConfig, workerSkills),
      workerSkills,
      eventsService,
      new ReachWidenRepository(client.db),
      matchConfig,
    );
    const input = {
      matchSkillIds: [SKILL],
      untickedIds: [],
      trigger: "publish" as const,
      actor: { actor_type: "admin" as const, actor_id: ADMIN },
    };
    // The real service, with the post-commit rebuild standing in for
    // `JobPostingsService.materializeAfterWorkerVisibility` (a publish through the same core).
    const jobPostings = {
      materializeAfterWorkerVisibility: async (id: string) => {
        await publish.materialize(id, input, CTX);
        return true;
      },
    } as unknown as JobPostingsService;
    const service = new AdminPostingWorkerVisibilityService(
      new AdminPostingWorkerVisibilityRepository(client.db),
      new AdminPostingsRepository(client.db),
      jobPostings,
      eventsService,
    );
    const reason = {
      reason_code: "other" as const,
      reason_text: "Campus job checked against the company record",
    };
    const ids = (page: { postings: { posting_id: string }[] }) =>
      page.postings.map((p) => p.posting_id);

    // HELD: a publish writes no reach row for it, and detail misses it.
    const held = await publish.materialize(P_CAMPUS_FLIP, input, CTX);
    expect(held.reachTotal).toBe(0);
    expect(held.zeroReach).toBe(false); // empty by design, not the E13 void
    expect(await reachedPostings(WORKER)).not.toContain(P_CAMPUS_FLIP);
    expect(await jobs.findWorkerVisibleJobById(P_CAMPUS_FLIP)).toBeUndefined();
    const waiting = await service.list({ filter: "waiting", limit: 200 });
    expect(ids(waiting)).toEqual(expect.arrayContaining([P_CAMPUS_HELD, P_CAMPUS_FLIP]));
    expect(ids(waiting)).not.toContain(P_CAMPUS_OPENED);
    expect(ids(waiting)).not.toContain(P_BOTH); // not Campus-origin: never on this list
    const row = waiting.postings.find((p) => p.posting_id === P_CAMPUS_FLIP)!;
    expect(row).toMatchObject({ audience: "both", origin: "campus_imported", worker_visibility: "off" });

    // #2635 — no trade, no worker surface: `on` is refused, nothing written, nothing reached.
    expect(row).toMatchObject({ role_kind: null, trade_ready: false });
    expect(await service.set(ADMIN, P_CAMPUS_FLIP, { state: "on", ...reason }, CTX)).toEqual({
      posting_id: P_CAMPUS_FLIP,
      outcome: "trade_required",
      state: "off",
    });
    expect(await reachedPostings(WORKER)).not.toContain(P_CAMPUS_FLIP);
    // The admin names its trade (the #2566 edit route writes this column), then turns it on.
    await client.sql`UPDATE job_postings SET role_kind = 'cad_draughtsman' WHERE id = ${P_CAMPUS_FLIP}::uuid`;

    // ON: reach is built and every read serves it.
    expect(await service.set(ADMIN, P_CAMPUS_FLIP, { state: "on", ...reason }, CTX)).toEqual({
      posting_id: P_CAMPUS_FLIP,
      outcome: "changed",
      state: "on",
    });
    expect(await reachedPostings(WORKER)).toContain(P_CAMPUS_FLIP);
    expect((await jobs.findWorkerVisibleJobById(P_CAMPUS_FLIP))?.id).toBe(P_CAMPUS_FLIP);
    const feed = await matchFeed.listFeed(WORKER, 50, {});
    expect(only(feed.map((r) => r.jobPostingId))).toContain(P_CAMPUS_FLIP);
    expect(ids(await service.list({ filter: "on", limit: 200 }))).toContain(P_CAMPUS_FLIP);
    // The same decision again writes nothing.
    expect((await service.set(ADMIN, P_CAMPUS_FLIP, { state: "on", ...reason }, CTX)).outcome).toBe(
      "unchanged",
    );

    // BULK OFF: the Campus posting is held again and loses its reach; a non-Campus posting is
    // refused, never given a row.
    const off = await service.setMany(
      ADMIN,
      { posting_ids: [P_CAMPUS_FLIP, P_BOTH], state: "off", ...reason },
      CTX,
    );
    expect(off.results).toEqual([
      { posting_id: P_CAMPUS_FLIP, outcome: "changed", state: "off" },
      { posting_id: P_BOTH, outcome: "not_campus_origin", state: null },
    ]);
    expect(await reachedPostings(WORKER)).not.toContain(P_CAMPUS_FLIP);
    expect(await jobs.findWorkerVisibleJobById(P_CAMPUS_FLIP)).toBeUndefined();
    expect(await workerSkills.findReachRow(WORKER, P_CAMPUS_FLIP)).toBeUndefined();
    expect(ids(await service.list({ filter: "off", limit: 200 }))).toContain(P_CAMPUS_FLIP);
    expect(ids(await service.list({ filter: "waiting", limit: 200 }))).not.toContain(P_CAMPUS_FLIP);
    const noRow = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_posting_worker_visibility WHERE job_posting_id = ${P_BOTH}::uuid`;
    expect(noRow[0]?.n).toBe(0);

    // Every decision is in audit_logs, with the admin's reason.
    const audits = await client.sql<{ action: string; metadata: Record<string, unknown> }[]>`
      SELECT action, metadata FROM audit_logs
       WHERE actor_id = ${ADMIN}::uuid AND entity_id = ${P_CAMPUS_FLIP}::uuid
       ORDER BY created_at, id`;
    expect(audits.map((a) => a.action)).toEqual([
      "posting_worker_visibility_on",
      "posting_worker_visibility_off",
    ]);
    expect(audits[0]!.metadata).toMatchObject({
      reason_code: "other",
      reason_text: reason.reason_text,
      worker_visibility_before: "off",
      worker_visibility_after: "on",
      first_decision: true,
    });
  }, 60_000);

  // ── M2: no switch is involved ───────────────────────────────────────────────

  describe("with the API config at its DEFAULTS, and every rollout switch x feed mode", () => {
    // Each mode goes through the REAL parser, so a switch value is exactly what production would
    // hold. `pilot` is exercised with the owning company ON the `job_audience` pilot list (seeded).
    const FEED_MODES: [string, Record<string, string>][] = [
      ["legacy", {}],
      ["union", { FEED_POSTINGS_UNION_ENABLED: "true" }],
      ["V1", { MATCH_V1_ENABLED: "true" }],
    ];
    const ROLLOUTS = ["(default)", "off", "pilot", "on"] as const;
    const modes: [string, ServerConfig][] = ROLLOUTS.flatMap((rollout) =>
      FEED_MODES.map(([feed, env]): [string, ServerConfig] => [
        `JOB_AUDIENCE_ROLLOUT=${rollout}, ${feed} feed`,
        loadServerConfig({
          NODE_ENV: "test",
          ...env,
          ...(rollout === "(default)" ? {} : { JOB_AUDIENCE_ROLLOUT: rollout }),
        }),
      ]),
    );
    const defaults = loadServerConfig({ NODE_ENV: "test" });

    it("the modes are what they say: the default switch is off, and pilot/on parse as set", () => {
      expect(defaults.JOB_AUDIENCE_ROLLOUT).toBe("off");
      expect(modes.map(([, c]) => c.JOB_AUDIENCE_ROLLOUT)).toEqual([
        ...Array<string>(6).fill("off"),
        ...Array<string>(3).fill("pilot"),
        ...Array<string>(3).fill("on"),
      ]);
    });

    it.each(modes)(
      "%s: the feed never serves the RVM-only posting",
      async (_label, config) => {
        const page = await applicationsService(config).getFeed(WORKER, 50, {}, CTX);
        const served = only(page.jobs.map((j) => j.job_id));
        expect(served).not.toContain(P_RVM);
        expect(served).not.toContain(P_PUB_RVM); // published above, still RVM-only
        expect(served).not.toContain(P_CAMPUS_HELD); // #2891 — held from workers
        // A posting mode serves the BadaBhai-visible postings, so the exclusion is not vacuous.
        if (config.MATCH_V1_ENABLED || config.FEED_POSTINGS_UNION_ENABLED) {
          expect(served).toEqual(expect.arrayContaining(SERVED));
        }
      },
      30_000,
    );

    it.each(modes)(
      "%s: apply and skip on the RVM-only posting are the neutral 404",
      async (_label, config) => {
        const service = applicationsService(config);
        await expect(
          service.apply(WORKER, P_RVM, { rank: 1, source_surface: "feed" }, CTX),
        ).rejects.toThrow("Job not found");
        await expect(service.skip(WORKER, P_RVM, { reason: "too_far" }, CTX)).rejects.toThrow(
          "Job not found",
        );
        // #2891 — a held Campus posting is the same 404.
        await expect(
          service.apply(WORKER, P_CAMPUS_HELD, { rank: 1, source_surface: "feed" }, CTX),
        ).rejects.toThrow("Job not found");
        const written = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM applications
         WHERE worker_id = ${WORKER}::uuid
           AND job_posting_id IN (${P_RVM}::uuid, ${P_CAMPUS_HELD}::uuid)`;
        expect(written[0]?.n).toBe(0);
      },
      30_000,
    );

    it("switch on + V1: the `both` posting still takes the apply — only the RVM part is gated", async () => {
      const service = applicationsService(
        loadServerConfig({
          NODE_ENV: "test",
          MATCH_V1_ENABLED: "true",
          JOB_AUDIENCE_ROLLOUT: "on",
        }),
      );
      const out = await service.apply(WORKER, P_BOTH, { rank: 1, source_surface: "feed" }, CTX);
      expect(out.action).toBe("applied");
    }, 30_000);
  });
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  // `worker_skill.skill_id` and `job_reach.matched_skill_id` FK to `skill`. Present where D1 ran;
  // the upsert keeps the fixture self-sufficient on a bare migrated database.
  await sql`
    INSERT INTO skill (skill_id, label_en, source, status, kind, industry_id)
    VALUES (${SKILL}, 'VMC Operator', 'rvm', 'active', 'match_skill', ${INDUSTRY})
    ON CONFLICT (skill_id) DO NOTHING
  `;
  // Synthetic markers only — no real phone number exists in this fixture.
  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${WORKER}::uuid, 'enc:t2746-visibility', 'hash:t2746-visibility', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
    VALUES (${WORKER}::uuid, ${SKILL}, ${INDUSTRY}, 48, true, 'derived_coarse')
  `;
  await sql`
    INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
    VALUES (${WORKER}::uuid, ${INDUSTRY}, 48)
  `;
  // The owning company, on the `job_audience` pilot list: the `pilot` modes below then switch the
  // capability ON for exactly the company whose RVM-only posting must stay off worker paths.
  await sql`
    INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
    VALUES (${PAYER}::uuid, 'employer', 'enc:t2746-visibility', 'hash:t2746-visibility',
            'enc:org-t2746-visibility', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO feature_pilot_payers (feature, payer_id, added_by, reason)
    VALUES ('job_audience', ${PAYER}::uuid, 'test:job-audience-visibility.db',
            'M2 proof: a pilot company with an RVM-only posting')
    ON CONFLICT DO NOTHING
  `;

  const posting = async (
    id: string,
    audience: "badabhai_workers" | "rvm_students" | "both",
    status: "open" | "draft",
    skills: string[],
    published: string | null,
  ) => {
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                                status, audience, match_skill_ids, reach_skill_ids, published_at,
                                city)
      VALUES (${id}::uuid, ${CREATED_BY}::uuid, ${PAYER}::uuid, 'Audience Fixture',
              ${`${TITLE_TOKEN} VMC Operator`}, '1', ${status}, ${audience},
              ${JSON.stringify(skills)}::jsonb, ${JSON.stringify(skills)}::jsonb,
              ${published}::timestamptz, 'Pune')
    `;
  };
  await posting(P_RVM, "rvm_students", "open", [SKILL], "2099-03-03T00:00:00Z");
  await posting(P_BOTH, "both", "open", [SKILL], "2099-03-02T00:00:00Z");
  await posting(P_WORKERS, "badabhai_workers", "open", [SKILL], "2099-03-01T00:00:00Z");
  // Drafts until the publish case opens them — a draft is on no worker path, so they cannot
  // muddy the read cases that run first.
  await posting(P_PUB_RVM, "rvm_students", "draft", [], null);
  await posting(P_PUB_BOTH, "both", "draft", [], null);

  // #2891 — Campus-origin postings, held as the Campus route holds them.
  await posting(P_CAMPUS_HELD, "both", "open", [SKILL], "2099-03-04T00:00:00Z");
  await posting(P_CAMPUS_OPENED, "both", "open", [SKILL], "2099-03-05T00:00:00Z");
  await posting(P_CAMPUS_FLIP, "both", "open", [SKILL], "2099-03-06T00:00:00Z");
  await sql`
    INSERT INTO job_posting_worker_visibility (job_posting_id, state, origin)
    VALUES (${P_CAMPUS_HELD}::uuid, 'off', 'campus_posted'),
           (${P_CAMPUS_FLIP}::uuid, 'off', 'campus_imported')
  `;
  await sql`
    INSERT INTO job_posting_worker_visibility
      (job_posting_id, state, origin, decided_by_admin_id, decided_at)
    VALUES (${P_CAMPUS_OPENED}::uuid, 'on', 'campus_posted', ${ADMIN}::uuid, now())
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM applications WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM job_reach WHERE worker_id = ${WORKER}::uuid`;
  // #2891 — the visibility rows cascade with their postings; the admin's audit rows do not.
  await sql`DELETE FROM audit_logs WHERE actor_id = ${ADMIN}::uuid`;
  for (const id of ALL_POSTINGS) await sql`DELETE FROM job_postings WHERE id = ${id}::uuid`;
  await sql`DELETE FROM worker_skill WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
  // The pilot row cascades with its payer.
  await sql`DELETE FROM payers WHERE id = ${PAYER}::uuid`;
  await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
}
