import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { eq, getTableColumns, sql as dsql } from "drizzle-orm";
import { loadServerConfig } from "@badabhai/config";
import {
  POSTING_REVIEW_CONTENT_COLUMNS,
  approvedForRvmStudents,
  createDbClient,
  events,
  jobPostings,
  materializeJobReachWithin,
  postingReviewContentHash,
  type Database,
  type DbClient,
  type JobPostingAudience,
} from "@badabhai/db";

import { AdminEntitiesRepository } from "../admin/admin-entities.repository";
import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { UpdateJobPostingSchema } from "../job-postings/job-postings.dto";
import { JobPostingsRepository } from "../job-postings/job-postings.repository";
import { JobPostingsService } from "../job-postings/job-postings.service";
import type { PostingAudienceService } from "../job-postings/posting-audience.service";
import { postingAudienceOver } from "../job-postings/posting-audience.test-support";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { MatchSkillsService } from "../match/match-skills.service";
import { PublishReachService } from "../match/publish-reach.service";
import { ReachWidenRepository } from "../match/reach-widen.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import {
  defaultModeResolver,
  ownScope,
  resolverOver,
} from "../payers/payer-tenant-scope.test-support";

/**
 * #2746 PR 4 — A COMPANY CHOOSES WHO SEES ITS JOB, against a real Postgres.
 *
 * The real `JobPostingsService` + `PostingAudienceService` + `PublishReachService` over a migrated
 * database. What only Postgres can show:
 *
 *   - the content hash (`postingReviewContentHash`, @badabhai/db) is the same for the same content,
 *     moves with EVERY field an RVM student sees and with nothing else;
 *   - the review row's lifecycle in the posting write's transaction: `pending` on an RVM audience,
 *     back to `pending` (every decision column cleared) on a student-visible edit, untouched by an
 *     unlisted-field edit, kept (never deleted) on a withdrawal, `updated_at` bumped on every
 *     audience change;
 *   - the live-hash rule: a decision on older content does not count, whoever changed the content;
 *   - an audience change on a live posting clears its reach (`rvm_students`) and rebuilds it;
 *   - a company with no credits publishes any audience with no payment step;
 *   - the switch: off ignores the fields and 404s the options; `pilot` admits exactly the listed
 *     company (a `feature_pilot_payers` row, `added_by` + `reason`).
 *
 * The agency refusal is the `PayerRoleGuard` 403 (`payer-job-postings-role-authz.test.ts`) plus
 * `job_postings_twin_audience_chk` (migration 0162's own test).
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test payer-job-audience.db
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

const CORRELATION = uuid(0x27464001);
const CTX: RequestContext = { correlationId: CORRELATION, requestId: "payer-job-audience-db" };
/** A company with no `payers` row, no credits and no plan (job_postings.payer_id has no FK). */
const COMPANY = uuid(0x27464002);
/** A second company, for the cross-tenant cases. */
const COMPANY_B = uuid(0x27464007);
/** A teammate of COMPANY under org tenancy `on` (the positive control: they DO see A's review). */
const MEMBER_OF_A = uuid(0x27464008);
/** The pilot company: a real `payers` row, because `feature_pilot_payers` references it. */
const PILOT = uuid(0x27464003);
const REVIEWER = uuid(0x27464004);
const WORKER = uuid(0x27464005);
const FIXTURE_POSTING = uuid(0x27464006);

const SKILL = "mskill_vmc_operator";
const INDUSTRY = "ind_industrial_manufacturing";
/** Fixture targeting options. Branch refs are digits (`rto_branch_ref_chk`); none is a real branch. */
const BRANCH_A = 274601;
const BRANCH_B = 274602;
const BRANCH_RETIRED = 274609;
const COURSE_A = "t2746a-cnc";
const COURSE_B = "t2746a-cad";
const COURSE_RETIRED = "t2746a-old";

const DTO = {
  org_label: "Audience Fixture Works",
  role_title: "VMC Operator t2746a",
  vacancy_band: "1" as const,
  role_kind: "vmc_milling" as const,
  match_skill_ids: [SKILL],
};

describe.skipIf(!RUN)("#2746 PR 4 — a company chooses who sees its job (Postgres)", () => {
  let client!: DbClient;
  let eventsService!: EventsService;
  let publish!: PublishReachService;
  let matchSkills!: MatchSkillsService;

  /** The real posting service with the `job_audience` switch at `env` (default: on). */
  function service(
    env: Record<string, string> = { JOB_AUDIENCE_ROLLOUT: "on" },
    // The default mode: the session payer is its own tenant (no `payers` row needed).
    tenancy: PayerTenantScopeService = defaultModeResolver(),
    audience: PostingAudienceService = postingAudienceOver(client.db, eventsService, env),
  ): JobPostingsService {
    return new JobPostingsService(
      new JobPostingsRepository(client.db),
      eventsService,
      {} as never, // AiService — no skill phrases, so canonicalization returns before any call
      {} as never, // AiCostRecorder — likewise
      {} as never, // AiTraceRecorder — likewise
      publish,
      matchSkills,
      {} as never, // PostingTradesService — no trade form is sent
      tenancy,
      audience,
    );
  }

  async function hashOf(id: string): Promise<string> {
    const rows = (await client.db.execute(
      dsql`SELECT ${postingReviewContentHash("jp")} AS h FROM job_postings jp WHERE jp.id = ${id}::uuid`,
    )) as unknown as { h: string }[];
    return rows[0]!.h;
  }

  async function approved(id: string): Promise<boolean> {
    const rows = (await client.db.execute(
      dsql`SELECT ${approvedForRvmStudents("jp")} AS ok FROM job_postings jp WHERE jp.id = ${id}::uuid`,
    )) as unknown as { ok: boolean }[];
    return rows[0]!.ok;
  }

  const at = (timestamp: string): number => Date.parse(timestamp);

  type ReviewRow = {
    state: string;
    reviewer_ref: string | null;
    reviewed_at: string | null;
    reason: string | null;
    content_hash: string | null;
    /** postgres.js returns this client's timestamps as text; compare through `at()`. */
    updated_at: string;
  };
  async function review(id: string): Promise<ReviewRow | undefined> {
    const rows = await client.sql<ReviewRow[]>`
      SELECT state, reviewer_ref, reviewed_at, reason, content_hash, updated_at
        FROM job_posting_institute_reviews
       WHERE job_posting_id = ${id}::uuid AND institute_code = 'rvm'`;
    return rows[0];
  }

  /**
   * What Campus will do on a decision (#2746 PR 5): store it with the hash of the content it saw,
   * computed by the shared expression itself.
   */
  async function decide(id: string, state: "approved" | "rejected", reason: string | null) {
    await client.db.execute(dsql`
      UPDATE job_posting_institute_reviews
         SET state = ${state}, reviewer_ref = ${REVIEWER}, reviewed_at = now(),
             reason = ${reason}, updated_at = now(),
             content_hash = (SELECT ${postingReviewContentHash("jp")} FROM job_postings jp
                              WHERE jp.id = ${id}::uuid)
       WHERE job_posting_id = ${id}::uuid AND institute_code = 'rvm'`);
  }

  async function reachRows(id: string): Promise<number> {
    const rows = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_reach WHERE job_posting_id = ${id}::uuid`;
    return rows[0]?.n ?? 0;
  }

  async function eventsFor(id: string, name: string): Promise<Record<string, unknown>[]> {
    const rows = await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
       WHERE subject_id = ${id}::uuid AND event_name = ${name} AND correlation_id = ${CORRELATION}::uuid
       ORDER BY occurred_at, id`;
    return rows.map((r) => r.payload);
  }

  async function storedAudience(id: string) {
    const rows = await client.sql<
      { audience: JobPostingAudience; rvm_branch_ids: number[]; rvm_course_ids: string[] }[]
    >`SELECT audience, rvm_branch_ids, rvm_course_ids FROM job_postings WHERE id = ${id}::uuid`;
    return rows[0]!;
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 2 });
    await cleanup(client);
    await seed(client);
    eventsService = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    const matchConfig = new MatchConfigService(new MatchConfigRepository(client.db));
    const workerSkills = new WorkerSkillsRepository(client.db);
    matchSkills = new MatchSkillsService(matchConfig, workerSkills);
    publish = new PublishReachService(
      matchSkills,
      workerSkills,
      eventsService,
      new ReachWidenRepository(client.db),
      matchConfig,
    );
  }, 60_000);

  afterAll(async () => {
    if (client !== undefined) {
      await cleanup(client);
      await client.sql.end({ timeout: 5 });
    }
  }, 60_000);

  // ── The content hash ────────────────────────────────────────────────────────

  it("the content hash is stable, and moves with every field a student sees", async () => {
    const before = await hashOf(FIXTURE_POSTING);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashOf(FIXTURE_POSTING)).toBe(before);
    // The unaliased drizzle form renders the same value.
    const unaliased = (await client.db.execute(
      dsql`SELECT ${postingReviewContentHash()} AS h FROM job_postings WHERE id = ${FIXTURE_POSTING}::uuid`,
    )) as unknown as { h: string }[];
    expect(unaliased[0]!.h).toBe(before);

    const VISIBLE: [string, string][] = [
      ["org_label", "'Renamed Works'"],
      ["role_title", "'Changed title'"],
      ["description", "'Changed description'"],
      ["location_label", "'Changed site'"],
      ["city", "'Nashik'"],
      ["state", "'Gujarat'"],
      ["area", "'Satpur'"],
      ["pay_min", "11000"],
      ["pay_max", "21000"],
      ["pay_type", "'ctc'"],
      ["vacancy_band", "'25+'"],
      ["shift", "'night'"],
      ["min_experience_years", "1"],
      ["max_experience_years", "3"],
      ["requirements", `'["ITI","Fanuc"]'::jsonb`],
      ["benefits", `'["PF","ESI","Canteen"]'::jsonb`],
      ["audience", "'both'"],
      ["rvm_branch_ids", `'[${BRANCH_B}]'::jsonb`],
      ["rvm_course_ids", `'["${COURSE_B}"]'::jsonb`],
    ];
    let previous = before;
    for (const [column, value] of VISIBLE) {
      await client.sql.unsafe(`UPDATE job_postings SET ${column} = ${value} WHERE id = $1`, [
        FIXTURE_POSTING,
      ]);
      const next = await hashOf(FIXTURE_POSTING);
      expect(next, column).not.toBe(previous);
      previous = next;
    }
  }, 30_000);

  it("the content hash is blind to every field a student does not see", async () => {
    const before = await hashOf(FIXTURE_POSTING);
    const HIDDEN: [string, string][] = [
      ["needed_by", "'soon'"],
      ["role_kind", "'cnc_turner'"],
      ["trade_level", "'setter'"],
      ["match_skill_ids", `'["mskill_cnc_turner"]'::jsonb`],
      ["reach_skill_ids", `'["mskill_cnc_turner"]'::jsonb`],
      ["skill_phrases", `'["fanuc"]'::jsonb`],
      ["status", "'paused'"],
      ["verification_status", "'verified'"],
      ["updated_at", "now() + interval '1 day'"],
    ];
    for (const [column, value] of HIDDEN) {
      await client.sql.unsafe(`UPDATE job_postings SET ${column} = ${value} WHERE id = $1`, [
        FIXTURE_POSTING,
      ]);
      expect(await hashOf(FIXTURE_POSTING), column).toBe(before);
    }
    // NULL and [] chip lists both render [] on Campus: no re-review for a change nobody sees.
    await client.sql`UPDATE job_postings SET benefits = NULL WHERE id = ${FIXTURE_POSTING}::uuid`;
    const asNull = await hashOf(FIXTURE_POSTING);
    await client.sql`UPDATE job_postings SET benefits = '[]'::jsonb WHERE id = ${FIXTURE_POSTING}::uuid`;
    expect(await hashOf(FIXTURE_POSTING)).toBe(asNull);
  }, 30_000);

  // ── Create + publish, every audience, no money ──────────────────────────────

  it.each<JobPostingAudience>(["badabhai_workers", "rvm_students", "both"])(
    "%s: a company with no credits posts and publishes it; it goes live with no payment step",
    async (audience) => {
      const svc = service();
      const created = await svc.createForPayer(COMPANY, { ...DTO, audience }, CTX);
      expect(created).toMatchObject({ status: "draft", audience });
      const live = await svc.updateForPayer(created.id, COMPANY, { status: "open" }, CTX);
      expect(live.status).toBe("open");
      expect((await storedAudience(created.id)).audience).toBe(audience);

      const rvm = audience !== "badabhai_workers";
      expect((await review(created.id))?.state).toBe(rvm ? "pending" : undefined);
      expect(live.rvm_review).toEqual(rvm ? { state: "pending" } : null);
      // One audience_set for a non-default create; none for the default.
      expect(await eventsFor(created.id, "job_posting.audience_set")).toHaveLength(rvm ? 1 : 0);
      // Reach: none for RVM students only, and no zero-reach alert for it (by design).
      if (audience === "rvm_students") {
        expect(await reachRows(created.id)).toBe(0);
        expect(await eventsFor(created.id, "job_posting.reach_alert")).toEqual([]);
      } else {
        expect(await reachRows(created.id)).toBeGreaterThanOrEqual(1);
      }

      // No credit, ledger or plan row exists for the company: nothing was charged or required.
      const [money] = await client.sql<{ credits: number; ledger: number; plans: number }[]>`
        SELECT (SELECT count(*)::int FROM payer_credits WHERE payer_id = ${COMPANY}::uuid) AS credits,
               (SELECT count(*)::int FROM credit_ledger WHERE payer_id = ${COMPANY}::uuid) AS ledger,
               (SELECT count(*)::int FROM posting_plans WHERE payer_id = ${COMPANY}::uuid) AS plans`;
      expect(money).toEqual({ credits: 0, ledger: 0, plans: 0 });
    },
    60_000,
  );

  // ── The review row's lifecycle ──────────────────────────────────────────────

  it("approval holds for the content it saw: an unlisted edit keeps it, a student-visible edit re-pends it", async () => {
    const svc = service();
    const posting = await svc.createForPayer(
      COMPANY,
      { ...DTO, audience: "rvm_students", rvm_branch_ids: [BRANCH_A] },
      CTX,
    );
    await decide(posting.id, "approved", "Fits the CNC batch");
    expect(await approved(posting.id)).toBe(true);
    const scope = await ownScope(COMPANY);
    const [read] = await svc.toPayerPostings(scope, [await svc.getOneInScope(posting.id, scope)]);
    expect(read?.rvm_review).toMatchObject({ state: "approved", reason: "Fits the CNC batch" });
    expect(read?.rvm_review?.reviewed_at).toBeInstanceOf(Date);

    // An edit to a field no student sees: the decision stands, row untouched.
    const decided = await review(posting.id);
    await svc.updateForPayer(posting.id, COMPANY, { needed_by: "soon" }, CTX);
    expect(await review(posting.id)).toEqual(decided);
    expect(await approved(posting.id)).toBe(true);

    // A student-visible edit: back to pending, every decision column cleared, row bumped.
    await svc.updateForPayer(posting.id, COMPANY, { description: "Day shift, Fanuc." }, CTX);
    const reset = await review(posting.id);
    expect(reset).toMatchObject({
      state: "pending",
      reviewer_ref: null,
      reviewed_at: null,
      reason: null,
      content_hash: null,
    });
    expect(at(reset!.updated_at)).toBeGreaterThan(at(decided!.updated_at));
    expect(await approved(posting.id)).toBe(false);
  }, 60_000);

  it("a rejection is shown to the company with the placement team's note, while it is for the content now", async () => {
    const svc = service();
    const posting = await svc.createForPayer(COMPANY, { ...DTO, audience: "both" }, CTX);
    await decide(posting.id, "rejected", "State the stipend for freshers");
    const scope = await ownScope(COMPANY);
    const [read] = await svc.toPayerPostings(scope, [await svc.getOneInScope(posting.id, scope)]);
    expect(read?.rvm_review).toMatchObject({
      state: "rejected",
      reason: "State the stipend for freshers",
    });
    expect(await approved(posting.id)).toBe(false);
    // The company answers it: a student-visible edit re-opens the review.
    await svc.updateForPayer(posting.id, COMPANY, { pay_min: 9000 }, CTX);
    expect((await review(posting.id))?.state).toBe("pending");
  }, 60_000);

  it("the live-hash rule: a decision on older content does not count, even when no writer reset it", async () => {
    const svc = service();
    const posting = await svc.createForPayer(COMPANY, { ...DTO, audience: "rvm_students" }, CTX);
    await decide(posting.id, "approved", null);
    // The OPS route edits a student-visible field and cannot touch the audience. It does not run
    // the company's reset — the read-side rule is what keeps students safe.
    const ops = UpdateJobPostingSchema.parse({
      description: "Edited by ops",
      audience: "badabhai_workers",
      rvm_branch_ids: [],
    });
    await svc.update(posting.id, ops, CTX);
    expect((await storedAudience(posting.id)).audience).toBe("rvm_students");
    expect((await review(posting.id))?.state).toBe("approved"); // stored, but stale
    expect(await approved(posting.id)).toBe(false);
    const scope = await ownScope(COMPANY);
    const [read] = await svc.toPayerPostings(scope, [await svc.getOneInScope(posting.id, scope)]);
    expect(read?.rvm_review).toEqual({ state: "pending" });
  }, 60_000);

  it("targeting and audience changes: validated, re-pending, bumping the row, kept on withdrawal", async () => {
    const svc = service();
    const posting = await svc.createForPayer(
      COMPANY,
      { ...DTO, audience: "both", rvm_course_ids: [COURSE_A] },
      CTX,
    );
    // A retired or unknown option is refused; nothing is written.
    await expect(
      svc.updateForPayer(posting.id, COMPANY, { rvm_branch_ids: [BRANCH_RETIRED] }, CTX),
    ).rejects.toThrow("not offered");
    await expect(
      svc.updateForPayer(posting.id, COMPANY, { rvm_course_ids: [COURSE_RETIRED] }, CTX),
    ).rejects.toThrow("not offered");
    expect((await storedAudience(posting.id)).rvm_course_ids).toEqual([COURSE_A]);

    // A pending row stays pending on a targeting change, but its updated_at moves (Campus feed).
    const pending = await review(posting.id);
    await svc.updateForPayer(posting.id, COMPANY, { rvm_branch_ids: [BRANCH_B, BRANCH_A] }, CTX);
    const bumped = await review(posting.id);
    expect(bumped?.state).toBe("pending");
    expect(at(bumped!.updated_at)).toBeGreaterThan(at(pending!.updated_at));
    expect((await storedAudience(posting.id)).rvm_branch_ids).toEqual([BRANCH_A, BRANCH_B]);

    // An approved posting whose targeting changes is re-pended.
    await decide(posting.id, "approved", null);
    await svc.updateForPayer(posting.id, COMPANY, { rvm_branch_ids: [BRANCH_A] }, CTX);
    expect((await review(posting.id))?.state).toBe("pending");

    // Withdrawal: targeting cleared, the row KEPT (Campus's feed), the company sees no review.
    const out = await svc.updateForPayer(
      posting.id,
      COMPANY,
      { audience: "badabhai_workers" },
      CTX,
    );
    expect(await storedAudience(posting.id)).toEqual({
      audience: "badabhai_workers",
      rvm_branch_ids: [],
      rvm_course_ids: [],
    });
    expect(await review(posting.id)).toBeDefined();
    expect(out.rvm_review).toBeNull();
    const set = await eventsFor(posting.id, "job_posting.audience_set");
    expect(set.at(-1)).toEqual({
      job_posting_id: posting.id,
      audience: "badabhai_workers",
      previous_audience: "both",
      branch_ids: [],
      course_ids: [],
      review_state: null,
    });
  }, 60_000);

  // ── Reach follows the audience ──────────────────────────────────────────────

  it("an audience change on a live posting clears its reach (RVM only) and rebuilds it (back)", async () => {
    const svc = service();
    const posting = await svc.createForPayer(COMPANY, { ...DTO, audience: "both" }, CTX);
    await svc.updateForPayer(posting.id, COMPANY, { status: "open" }, CTX);
    expect(await reachRows(posting.id)).toBeGreaterThanOrEqual(1);

    await svc.updateForPayer(posting.id, COMPANY, { audience: "rvm_students" }, CTX);
    expect(await reachRows(posting.id)).toBe(0);
    expect(await eventsFor(posting.id, "job_posting.reach_alert")).toEqual([]);

    await svc.updateForPayer(posting.id, COMPANY, { audience: "both" }, CTX);
    expect(await reachRows(posting.id)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("leaving the BadaBhai audience clears reach whatever the status: paused, and a draft holding stray rows", async () => {
    const svc = service();
    // A paused posting keeps its rows warm for a resume; moving it to RVM-only must drop them.
    const paused = await svc.createForPayer(COMPANY, { ...DTO, audience: "both" }, CTX);
    await svc.updateForPayer(paused.id, COMPANY, { status: "open" }, CTX);
    await svc.pauseForPayer(paused.id, COMPANY, CTX);
    expect(await reachRows(paused.id)).toBeGreaterThanOrEqual(1);
    await svc.updateForPayer(paused.id, COMPANY, { audience: "rvm_students" }, CTX);
    expect(await reachRows(paused.id)).toBe(0);

    // A non-live RVM-only posting with a leftover row (no D5 run visits it): any audience or
    // targeting write clears it through the one reach core.
    const draft = await svc.createForPayer(COMPANY, { ...DTO, audience: "rvm_students" }, CTX);
    await client.sql`
      INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      VALUES (${draft.id}::uuid, ${WORKER}::uuid, 1, ${SKILL})`;
    await svc.updateForPayer(draft.id, COMPANY, { rvm_course_ids: [COURSE_A] }, CTX);
    expect(await reachRows(draft.id)).toBe(0);
    // …and moving it back to a BadaBhai audience while it is a draft rebuilds nothing (live only).
    await svc.updateForPayer(draft.id, COMPANY, { audience: "both" }, CTX);
    expect(await reachRows(draft.id)).toBe(0);
  }, 60_000);

  // ── Tenancy: another company can neither write nor read A's audience ────────

  const TENANCY_MODES: [string, () => PayerTenantScopeService][] = [
    ["PAYER_ORG_TENANCY_MODE=off", () => defaultModeResolver()],
    [
      "PAYER_ORG_TENANCY_MODE=on",
      () =>
        resolverOver(loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" }), [
          { anchor: COMPANY, members: [MEMBER_OF_A] },
        ]),
    ],
  ];

  it.each(TENANCY_MODES)(
    "%s: company B's audience PATCH on A's posting is the neutral 404 and changes nothing",
    async (_mode, tenancy) => {
      const svc = service(undefined, tenancy());
      const a = await svc.createForPayer(
        COMPANY,
        { ...DTO, audience: "both", rvm_branch_ids: [BRANCH_A] },
        CTX,
      );
      await decide(a.id, "approved", "Note for company A only");
      const rowBefore = await storedAudience(a.id);
      const reviewBefore = await review(a.id);
      const setBefore = (await eventsFor(a.id, "job_posting.audience_set")).length;

      await expect(
        svc.updateForPayer(a.id, COMPANY_B, { audience: "rvm_students" }, CTX),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(await storedAudience(a.id)).toEqual(rowBefore);
      expect(await review(a.id)).toEqual(reviewBefore); // no new row, no reset, no bump
      expect(await eventsFor(a.id, "job_posting.audience_set")).toHaveLength(setBefore);
      const [byB] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM events
         WHERE actor_id = ${COMPANY_B}::uuid AND subject_id = ${a.id}::uuid`;
      expect(byB?.n).toBe(0);
    },
    60_000,
  );

  it.each(TENANCY_MODES)(
    "%s: B's list never carries A's review, and the review read ignores a foreign id",
    async (mode, tenancy) => {
      const resolver = tenancy();
      const svc = service(undefined, resolver);
      const a = await svc.createForPayer(COMPANY, { ...DTO, audience: "rvm_students" }, CTX);
      await decide(a.id, "rejected", "Secret note for company A");
      await svc.createForPayer(COMPANY_B, { ...DTO, audience: "both" }, CTX);

      const scopeB = await resolver.resolve(COMPANY_B);
      const listB = await svc.toPayerPostings(scopeB, await svc.listInScope(scopeB, {}));
      expect(listB.length).toBeGreaterThanOrEqual(1);
      expect(listB.map((p) => p.id)).not.toContain(a.id);
      expect(JSON.stringify(listB)).not.toContain("Secret note");

      // Even handed A's row directly, B's scope reads no review for it: the read is keyed on
      // B's tenant (ADR-0053), so the block falls back to `pending` with no note.
      const [aRow] = await svc.toPayerPostings(scopeB, [
        await svc.getOneInScope(a.id, await resolver.resolve(COMPANY)),
      ]);
      expect(aRow?.rvm_review).toEqual({ state: "pending" });

      // Positive control under `on`: A's teammate acts in A's org and sees A's decision.
      if (mode.endsWith("on")) {
        const scopeMember = await resolver.resolve(MEMBER_OF_A);
        const listMember = await svc.toPayerPostings(
          scopeMember,
          await svc.listInScope(scopeMember, {}),
        );
        expect(listMember.find((p) => p.id === a.id)?.rvm_review).toMatchObject({
          state: "rejected",
          reason: "Secret note for company A",
        });
      }
    },
    60_000,
  );

  // ── Locks: the audience write and the reach core on two connections ─────────

  it("a reach core on a second connection WAITS for an open audience write, then runs against the committed audience (no 40P01)", async () => {
    const second = createDbClient(DATABASE_URL, { max: 1 });
    try {
      const plain = service();
      const posting = await plain.createForPayer(COMPANY, { ...DTO, audience: "both" }, CTX);
      await plain.updateForPayer(posting.id, COMPANY, { status: "open" }, CTX);
      expect(await reachRows(posting.id)).toBeGreaterThanOrEqual(1);

      // Hold the company PATCH open INSIDE its transaction: after the posting row is locked and
      // updated, before the review row and the commit.
      const audience = postingAudienceOver(client.db, eventsService, {
        JOB_AUDIENCE_ROLLOUT: "on",
      });
      const original = audience.recordUpdateWithin.bind(audience);
      let atLock!: () => void;
      const locked = new Promise<void>((resolve) => (atLock = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      audience.recordUpdateWithin = async (...args: Parameters<typeof original>) => {
        atLock();
        await gate;
        return original(...args);
      };
      const svc = service(undefined, defaultModeResolver(), audience);
      const patch = svc.updateForPayer(posting.id, COMPANY, { audience: "rvm_students" }, CTX);
      await locked;

      // The reach core on its own transaction, another connection. A lock_timeout makes a broken
      // order fail loudly here instead of hanging the suite.
      let settled = false;
      const core = second.db
        .transaction(async (tx) => {
          await tx.execute(dsql`SET LOCAL lock_timeout = '20s'`);
          return materializeJobReachWithin(tx as unknown as Database, posting.id, [SKILL], [SKILL]);
        })
        .finally(() => {
          settled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled).toBe(false);
      const [waiting] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      expect(waiting?.n).toBeGreaterThanOrEqual(1);

      release();
      await patch;
      const counts = await core; // rejects on 40P01 / 55P03
      // It ran against the COMMITTED audience (rvm_students): nothing inserted or refreshed.
      expect(counts.upserted).toBe(0);
      expect(counts.inserted).toBe(0);
      expect(await reachRows(posting.id)).toBe(0);
      expect((await storedAudience(posting.id)).audience).toBe("rvm_students");
    } finally {
      await second.sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("the hashed columns' live types are the model's (the encoding cannot change under it)", async () => {
    const model = new Map(
      Object.values(getTableColumns(jobPostings)).map((c) => [c.name, c.getSQLType()]),
    );
    const live = await client.sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'job_postings'
         AND column_name IN ${client.sql([...POSTING_REVIEW_CONTENT_COLUMNS])}`;
    expect(live).toHaveLength(POSTING_REVIEW_CONTENT_COLUMNS.length);
    for (const { column_name, data_type } of live) {
      expect(data_type, column_name).toBe(model.get(column_name));
    }
  }, 30_000);

  // ── The switch ──────────────────────────────────────────────────────────────

  it("switch OFF: the fields are ignored (default stored, no review row) and audience-options is a 404", async () => {
    const svc = service({});
    const created = await svc.createForPayer(
      COMPANY,
      { ...DTO, audience: "rvm_students", rvm_branch_ids: [BRANCH_A] },
      CTX,
    );
    expect(await storedAudience(created.id)).toEqual({
      audience: "badabhai_workers",
      rvm_branch_ids: [],
      rvm_course_ids: [],
    });
    expect(await review(created.id)).toBeUndefined();
    expect(created).not.toHaveProperty("audience");
    await expect(svc.audienceOptionsForPayer(COMPANY)).rejects.toBeInstanceOf(NotFoundException);
  }, 60_000);

  // ── The admin console reads it (read-only) ──────────────────────────────────

  it("the admin posting list and detail show audience, targeting and the live review state", async () => {
    const svc = service();
    const posting = await svc.createForPayer(
      COMPANY,
      { ...DTO, audience: "both", rvm_branch_ids: [BRANCH_A] },
      CTX,
    );
    await decide(posting.id, "approved", "Fits the CNC batch");
    const admin = new AdminEntitiesRepository(client.db);

    const listed = (await admin.listJobPostings({ payerId: COMPANY }, null, 100)).find(
      (r) => r.id === posting.id,
    );
    expect(listed).toMatchObject({
      audience: "both",
      rvm_branch_ids: [BRANCH_A],
      rvm_course_ids: [],
      rvm_review: { state: "approved", reason: "Fits the CNC batch" },
    });
    // A BadaBhai-only posting in the same list carries no review.
    const plain = await svc.createForPayer(COMPANY, DTO, CTX);
    const plainRow = (await admin.listJobPostings({ payerId: COMPANY }, null, 100)).find(
      (r) => r.id === plain.id,
    );
    expect(plainRow).toMatchObject({ audience: "badabhai_workers", rvm_review: null });

    // The detail applies the live-hash rule too: content changed under the decision → pending.
    await client.sql`UPDATE job_postings SET role_title = 'Changed under review'
                      WHERE id = ${posting.id}::uuid`;
    expect((await admin.findJobPosting(posting.id))?.rvm_review).toEqual({ state: "pending" });
  }, 60_000);

  it("switch PILOT: the listed company gets the capability; an unlisted one does not", async () => {
    const svc = service({ JOB_AUDIENCE_ROLLOUT: "pilot" });

    const options = await svc.audienceOptionsForPayer(PILOT);
    const branches = options.branches.filter((b) =>
      [BRANCH_A, BRANCH_B, BRANCH_RETIRED].includes(b.id),
    );
    expect(branches.map((b) => b.id)).toEqual([BRANCH_A, BRANCH_B]); // sort_order; retired absent
    expect(options.courses.map((c) => c.id)).toEqual(expect.arrayContaining([COURSE_A, COURSE_B]));
    expect(options.courses.map((c) => c.id)).not.toContain(COURSE_RETIRED);

    const piloted = await svc.createForPayer(PILOT, { ...DTO, audience: "both" }, CTX);
    expect((await storedAudience(piloted.id)).audience).toBe("both");
    expect((await review(piloted.id))?.state).toBe("pending");

    await expect(svc.audienceOptionsForPayer(COMPANY)).rejects.toBeInstanceOf(NotFoundException);
    const unlisted = await svc.createForPayer(COMPANY, { ...DTO, audience: "both" }, CTX);
    expect((await storedAudience(unlisted.id)).audience).toBe("badabhai_workers");
  }, 60_000);
});

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`
    INSERT INTO skill (skill_id, label_en, source, status, kind, industry_id)
    VALUES (${SKILL}, 'VMC Operator', 'rvm', 'active', 'match_skill', ${INDUSTRY})
    ON CONFLICT (skill_id) DO NOTHING`;
  // Synthetic markers only — no real phone number, email or name exists in this fixture.
  await sql`
    INSERT INTO workers (id, phone_e164, phone_hash, status)
    VALUES (${WORKER}::uuid, 'enc:t2746a-audience', 'hash:t2746a-audience', 'active')
    ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
    VALUES (${WORKER}::uuid, ${SKILL}, ${INDUSTRY}, 48, true, 'derived_coarse')`;
  await sql`
    INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
    VALUES (${WORKER}::uuid, ${INDUSTRY}, 48)`;
  await sql`
    INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
    VALUES (${PILOT}::uuid, 'employer', 'enc:t2746a-pilot', 'hash:t2746a-pilot',
            'enc:org-t2746a-pilot', 'active')`;
  await sql`
    INSERT INTO feature_pilot_payers (feature, payer_id, added_by, reason)
    VALUES ('job_audience', ${PILOT}::uuid, 'test', '#2746 PR 4 DB test: the pilot company')`;
  await sql`
    INSERT INTO rvm_targeting_options (kind, ref, label, active, sort_order) VALUES
      ('branch', ${String(BRANCH_A)}, 'Fixture branch A', true, 1),
      ('branch', ${String(BRANCH_B)}, 'Fixture branch B', true, 2),
      ('branch', ${String(BRANCH_RETIRED)}, 'Fixture branch retired', false, 3),
      ('course', ${COURSE_A}, 'Fixture CNC course', true, 1),
      ('course', ${COURSE_B}, 'Fixture CAD course', true, 2),
      ('course', ${COURSE_RETIRED}, 'Fixture retired course', false, 3)`;
  // The hash fixture: every student-visible field set, an RVM audience with targeting.
  await sql`
    INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, description,
                              location_label, city, state, area, pay_min, pay_max, pay_type,
                              vacancy_band, shift, min_experience_years, max_experience_years,
                              requirements, benefits, audience, rvm_branch_ids, rvm_course_ids)
    VALUES (${FIXTURE_POSTING}::uuid, ${COMPANY}::uuid, ${COMPANY}::uuid, 'Hash Fixture Works',
            'CNC Operator', 'Run a lathe', 'Sector 24', 'Faridabad', 'Haryana', NULL, 10000,
            20000, 'in_hand', '2-5', 'day', 0, 2, '["ITI"]'::jsonb, '["PF"]'::jsonb,
            'rvm_students', ${JSON.stringify([BRANCH_A])}::jsonb,
            ${JSON.stringify([COURSE_A])}::jsonb)`;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM job_reach WHERE worker_id = ${WORKER}::uuid`;
  // Review rows cascade with their postings.
  await sql`
    DELETE FROM job_postings
     WHERE payer_id IN (${COMPANY}::uuid, ${COMPANY_B}::uuid, ${PILOT}::uuid)`;
  await sql`DELETE FROM job_postings WHERE id = ${FIXTURE_POSTING}::uuid`;
  await sql`
    DELETE FROM rvm_targeting_options
     WHERE (kind = 'branch' AND ref IN (${String(BRANCH_A)}, ${String(BRANCH_B)}, ${String(BRANCH_RETIRED)}))
        OR (kind = 'course' AND ref IN (${COURSE_A}, ${COURSE_B}, ${COURSE_RETIRED}))`;
  await sql`DELETE FROM payers WHERE id = ${PILOT}::uuid`; // its pilot row cascades
  await sql`DELETE FROM worker_skill WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
  await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
}
