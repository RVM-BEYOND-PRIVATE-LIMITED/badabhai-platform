import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, HttpException } from "@nestjs/common";
import { eq, sql as dsql } from "drizzle-orm";
import { loadServerConfig } from "@badabhai/config";
import {
  approvedForRvmStudents,
  createDbClient,
  events,
  postingReviewContentHash,
  type Database,
  type DbClient,
  type JobPostingAudience,
} from "@badabhai/db";
import type { BadaBhaiEvent, EventName } from "@badabhai/event-schema";

import type { RequestContext } from "../common/request-context";
import { EventsRepository } from "../events/events.repository";
import { EventsService, type EmitParams } from "../events/events.service";
import { FeaturePilotRepository } from "../feature-rollout/feature-pilot.repository";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { PayerCreateJobPostingWithAudienceDto } from "../job-postings/job-postings.dto";
import { JobPostingsRepository } from "../job-postings/job-postings.repository";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { postingAudienceOver } from "../job-postings/posting-audience.test-support";
import { MatchConfigRepository } from "../match/match-config.repository";
import { MatchConfigService } from "../match/match-config.service";
import { MatchSkillsService } from "../match/match-skills.service";
import { PublishReachService } from "../match/publish-reach.service";
import { ReachWidenRepository } from "../match/reach-widen.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { defaultModeResolver } from "../payers/payer-tenant-scope.test-support";
import type { CampusCall } from "./campus-call";
import { CAMPUS_MAX_CLOCK_SKEW_MS } from "./campus-link.contract";
import { CampusPostingReviewRepository } from "./campus-posting-review.repository";
import {
  CampusPostingReviewService,
  type CampusReviewDecision,
} from "./campus-posting-review.service";
import { CampusTargetingOptionsRepository } from "./campus-targeting-options.repository";
import { CampusTargetingOptionsService } from "./campus-targeting-options.service";

/**
 * #2746 PR 5 — CAMPUS RECORDS THE PLACEMENT TEAM'S REVIEW, against a real Postgres.
 *
 * The real `CampusPostingReviewService` / `CampusTargetingOptionsService` over a migrated database,
 * beside PR 4's real company write path (`JobPostingsService` + `PostingAudienceService`). What only
 * Postgres can show:
 *
 *   - an approval stores `postingReviewContentHash` of the content as locked, and only when that is
 *     the hash the reviewer saw (409 `POSTING_CHANGED` otherwise, with nothing written);
 *   - the newest decision wins by `decided_at`: a late retry, a reversed delivery and an
 *     equal-time conflict are 409 `DECISION_SUPERSEDED` and store nothing; the same decision again
 *     is the replay; a time from BadaBhai's future is refused;
 *   - a company edit after approval reads `pending` through `approvedForRvmStudents`, whether or not
 *     a writer reset the row;
 *   - narrowing outside the posting's own targeting is refused;
 *   - in tenancy mode `on`, a Campus call writes no tenancy row for an owner without a membership;
 *   - `PUT targeting-options` retires what left the list, never deletes, and keeps the newest list
 *     by `as_of`;
 *   - THE LOCK ORDER, on two connections: a review and a company edit wait for each other at the
 *     POSTING row and never deadlock (no 40P01); two decisions serialise on the REVIEW row, and the
 *     second reports the first as its `previous_state`; two first decisions do not race an insert.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 DATABASE_URL=<a migrated LOCAL database> \
 *     pnpm --filter @badabhai/api run test campus-review.db
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

const CORRELATION = uuid(0x27465001);
const CTX: RequestContext = { correlationId: CORRELATION, requestId: "campus-review-db" };
const CALL: CampusCall = { ctx: CTX, callId: uuid(0x27465009) };
/** A company with no `payers` row (job_postings.payer_id has no FK). */
const COMPANY = uuid(0x27465002);
/** The pilot company: a real `payers` row, because `feature_pilot_payers` references it. */
const PILOT = uuid(0x27465003);
const REVIEWER = uuid(0x27465004);
const REVIEWER_2 = uuid(0x27465005);
const WORKER = uuid(0x27465006);
const HIDER = uuid(0x27465007);

const SKILL = "mskill_vmc_operator";
const INDUSTRY = "ind_industrial_manufacturing";
/** Fixture targeting options. Branch refs are digits (`rto_branch_ref_chk`); none is a real branch. */
const BRANCH_A = 274651;
const BRANCH_B = 274652;
const BRANCH_RETIRED = 274659;
const COURSE_A = "t2746r-cnc";
const COURSE_RETIRED = "t2746r-old";

const DTO = {
  org_label: "Review Fixture Works",
  role_title: "VMC Operator t2746r",
  vacancy_band: "1" as const,
  role_kind: "vmc_milling" as const,
  match_skill_ids: [SKILL],
};

const ON = { JOB_AUDIENCE_ROLLOUT: "on" };

/**
 * Campus's decision clock for this suite: each call is one second later than the last, all in the
 * past, so every fresh decision is newer than the one before it unless a test pins a time.
 */
let campusClock = Date.now() - 60 * 60_000;
function decidedNow(): string {
  campusClock += 1000;
  return new Date(campusClock).toISOString();
}

/**
 * `EventsService` that can HOLD its next emit: the caller's transaction then stays open, holding
 * every row lock it took, until released. Both write paths emit inside their transaction after
 * their row writes, so this freezes a real company edit or a real review at its most-locked point.
 * `entered` resolves with the HOLDER's backend pid, so a lock wait can be pinned to it.
 */
class GatedEvents extends EventsService {
  private held: { entered: (pid: number) => void; release: Promise<void> } | null = null;

  holdNext(): { entered: Promise<number>; release: () => void } {
    let entered!: (pid: number) => void;
    let release!: () => void;
    const enteredP = new Promise<number>((resolve) => (entered = resolve));
    const releaseP = new Promise<void>((resolve) => (release = resolve));
    this.held = { entered, release: releaseP };
    return { entered: enteredP, release };
  }

  override async emit<N extends EventName>(params: EmitParams<N>): Promise<BadaBhaiEvent<N>> {
    const held = this.held;
    this.held = null;
    if (held !== null) {
      const tx = params.tx;
      if (tx === undefined) throw new Error("GatedEvents: the held emit must run on a transaction");
      const rows = (await tx.execute(dsql`SELECT pg_backend_pid() AS pid`)) as unknown as {
        pid: number;
      }[];
      held.entered(rows[0]!.pid);
      await held.release;
    }
    return super.emit(params);
  }
}

/**
 * The holder's pid once the held call reaches its hold, or a fast failure if the held call settles
 * first (an error before the hold must not wait for the suite's timeout).
 */
async function reached(hold: Promise<number>, held: Promise<unknown>): Promise<number> {
  return Promise.race([
    hold,
    held.then((outcome) => {
      throw new Error(`the held call finished before its hold: ${String(outcome)}`);
    }),
  ]);
}

describe.skipIf(!RUN)("#2746 PR 5 — Campus records the RVM review (Postgres)", () => {
  let client!: DbClient;
  let eventsService!: EventsService;
  let publish!: PublishReachService;
  let matchSkills!: MatchSkillsService;

  /** PR 4's real company write path, the `job_audience` switch at `env` (default: on). */
  function companyService(
    env: Record<string, string> = ON,
    eventsImpl: EventsService = eventsService,
  ): JobPostingsService {
    return new JobPostingsService(
      new JobPostingsRepository(client.db),
      eventsImpl,
      {} as never, // AiService — no skill phrases, so canonicalization returns before any call
      {} as never, // AiCostRecorder — likewise
      {} as never, // AiTraceRecorder — likewise
      publish,
      matchSkills,
      {} as never, // PostingTradesService — no trade form is sent
      defaultModeResolver(),
      postingAudienceOver(client.db, eventsImpl, env),
    );
  }

  /** The real review service; `tenancy` defaults to the default mode (`off`) resolver. */
  function reviewService(
    env: Record<string, string> = ON,
    eventsImpl: EventsService = eventsService,
    tenancy: PayerTenantScopeService = defaultModeResolver(),
  ): CampusPostingReviewService {
    const config = loadServerConfig({ NODE_ENV: "test", ...env });
    return new CampusPostingReviewService(
      new CampusPostingReviewRepository(client.db),
      new PostingAudienceRepository(client.db),
      new FeatureRolloutService(config, new FeaturePilotRepository(client.db)),
      tenancy,
      eventsImpl,
    );
  }

  function decision(
    contentHash: string,
    over: Partial<CampusReviewDecision> = {},
  ): CampusReviewDecision {
    return {
      state: "approved",
      reviewer_ref: REVIEWER,
      content_hash: contentHash,
      decided_at: decidedNow(),
      ...over,
    };
  }

  /** A published posting for `owner` with an RVM audience. */
  async function openPosting(
    over: Partial<PayerCreateJobPostingWithAudienceDto> = {},
    owner = COMPANY,
  ): Promise<string> {
    const svc = companyService();
    const created = await svc.createForPayer(
      owner,
      { ...DTO, audience: "rvm_students", rvm_branch_ids: [BRANCH_A], ...over },
      CTX,
    );
    await svc.updateForPayer(created.id, owner, { status: "open" }, CTX);
    return created.id;
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

  type ReviewRow = {
    state: string;
    reviewer_ref: string | null;
    reviewed_at: string | null;
    reason: string | null;
    branch_ids: number[] | null;
    course_ids: string[] | null;
    content_hash: string | null;
    updated_at: string;
  };
  async function review(id: string): Promise<ReviewRow | undefined> {
    const rows = await client.sql<ReviewRow[]>`
      SELECT state, reviewer_ref, reviewed_at, reason, branch_ids, course_ids, content_hash, updated_at
        FROM job_posting_institute_reviews
       WHERE job_posting_id = ${id}::uuid AND institute_code = 'rvm'`;
    return rows[0];
  }

  async function reviewedEvents(id: string): Promise<Record<string, unknown>[]> {
    const rows = await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
       WHERE subject_id = ${id}::uuid AND event_name = 'job_posting.rvm_reviewed'
         AND correlation_id = ${CORRELATION}::uuid
       ORDER BY occurred_at, id`;
    return rows.map((r) => r.payload);
  }

  type AuditRow = { actor_type: string; actor_id: string; metadata: Record<string, unknown> };
  async function decisionAudits(id: string): Promise<AuditRow[]> {
    return client.sql<AuditRow[]>`
      SELECT actor_type, actor_id, metadata FROM audit_logs
       WHERE entity_type = 'job_posting' AND entity_id = ${id}::uuid
         AND action = 'campus_link.posting_reviewed'
       ORDER BY created_at, id`;
  }

  async function reachRows(id: string): Promise<number> {
    const rows = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_reach WHERE job_posting_id = ${id}::uuid`;
    return rows[0]?.n ?? 0;
  }

  /** The 4xx a call answered (`code` is the Campus `error.code`), or a failure if it succeeded. */
  async function refusal(call: Promise<unknown>): Promise<{ status: number; code: unknown }> {
    const err = await call.then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof HttpException)) throw err ?? new Error("expected a refusal");
    const body = err.getResponse();
    return {
      status: err.getStatus(),
      code: typeof body === "object" && body !== null ? (body as { code?: unknown }).code : null,
    };
  }

  /**
   * Waits until a backend BLOCKED BY `holderPid` is queued for a ROW lock on `relation` in `mode`,
   * or until `gaveUp()` (the call it watches has finished). True when the wait was seen.
   *
   * Scoped to the holder (`pg_blocking_pids`), so another session's lock can never satisfy it, and
   * read from `pg_locks`, not the statement text: `pg_stat_activity.query` is cut at
   * `track_activity_query_size` (1 kB by default), which the content-hash expression outgrows. A
   * row-lock waiter holds the heavyweight TUPLE lock of the row lock it wants while it waits:
   * `RowShareLock` for `FOR SHARE`, `ExclusiveLock` for `FOR NO KEY UPDATE` (a plain UPDATE),
   * `AccessExclusiveLock` for `FOR UPDATE`.
   */
  async function sawRowLockWait(
    holderPid: number,
    relation: string,
    mode: "RowShareLock" | "ExclusiveLock" | "AccessExclusiveLock",
    gaveUp: () => boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !gaveUp()) {
      const [row] = await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM pg_locks l
          JOIN pg_class c ON c.oid = l.relation
         WHERE l.locktype = 'tuple' AND c.relname = ${relation} AND l.mode = ${mode}
           AND ${holderPid}::int = ANY (pg_blocking_pids(l.pid))`;
      if ((row?.n ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  beforeAll(async () => {
    // Three connections are in use at once in the lock tests (holder, waiter, observer).
    client = createDbClient(DATABASE_URL, { max: 5 });
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

  // ── The decision stores the hash of the content it saw ──────────────────────

  it("an approval stores decided_at and the hash of the current content, evented and audited, reach untouched", async () => {
    const id = await openPosting({ audience: "both" });
    const reachBefore = await reachRows(id);
    expect(reachBefore).toBeGreaterThanOrEqual(1);
    const seen = await hashOf(id);
    expect(await approved(id)).toBe(false);

    const body = decision(seen, { branch_ids: [BRANCH_A] });
    const answer = await reviewService().review(id, body, CALL);

    expect(answer).toEqual({
      posting_id: id,
      review_state: "approved",
      reviewed_at: body.decided_at,
    });
    const row = await review(id);
    expect(row).toMatchObject({
      state: "approved",
      reviewer_ref: REVIEWER,
      branch_ids: [BRANCH_A],
      course_ids: null,
      reason: null,
      content_hash: seen,
    });
    // Campus's decision time is the review time.
    expect(Date.parse(row!.reviewed_at!)).toBe(Date.parse(body.decided_at));
    expect(await approved(id)).toBe(true);

    expect(await reviewedEvents(id)).toEqual([
      {
        job_posting_id: id,
        institute_code: "rvm",
        state: "approved",
        previous_state: "pending",
        reviewer_ref: REVIEWER,
        decided_at: body.decided_at,
        branch_ids: [BRANCH_A],
        course_ids: null,
        has_reason: false,
        content_hash: seen,
      },
    ]);
    const audits = await decisionAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_type: "campus_staff", actor_id: REVIEWER });
    expect(audits[0]!.metadata).toMatchObject({ state: "approved", campus_call_id: CALL.callId });
    // The RVM review does not change who among BadaBhai workers sees the posting.
    expect(await reachRows(id)).toBe(reachBefore);
  }, 60_000);

  it("a stale hash gets 409 POSTING_CHANGED and writes nothing", async () => {
    const id = await openPosting();
    const before = await review(id);

    const refused = await refusal(reviewService().review(id, decision("0".repeat(64)), CALL));

    expect(refused).toEqual({ status: 409, code: "POSTING_CHANGED" });
    expect(await review(id)).toEqual(before);
    expect(await reviewedEvents(id)).toEqual([]);
    expect(await decisionAudits(id)).toEqual([]);
  }, 60_000);

  it("the write statement itself stores nothing for a stale hash or an older time (defence in depth)", async () => {
    // The service refuses both before it writes; this is the statement's own guard, which holds
    // even for a caller that skipped those checks.
    const id = await openPosting();
    const repo = new CampusPostingReviewRepository(client.db);
    const write = (expectedContentHash: string, decidedAt: string, jobPostingId = id) =>
      repo.withTransaction((tx) =>
        repo.writeDecision(tx, {
          jobPostingId,
          state: "approved",
          reviewerRef: REVIEWER,
          reason: null,
          branchIds: null,
          courseIds: null,
          expectedContentHash,
          decidedAt,
        }),
      );
    const before = await review(id);
    const hash = await hashOf(id);

    expect(await write("0".repeat(64), decidedNow())).toEqual({
      outcome: "posting_changed",
      contentHash: hash,
    });
    expect(await review(id)).toEqual(before);
    expect(await write(hash, decidedNow(), uuid(0x2746500f))).toEqual({ outcome: "missing" });

    const t2 = decidedNow();
    expect(await write(hash, t2)).toEqual({ outcome: "written", contentHash: hash });
    // The same time, or an older one, is not applied.
    expect(await write(hash, t2)).toEqual({ outcome: "not_applied", contentHash: hash });
    expect(await write(hash, new Date(Date.parse(t2) - 1000).toISOString())).toEqual({
      outcome: "not_applied",
      contentHash: hash,
    });
  }, 60_000);

  it("a company edit between the reviewer's read and the PUT ends in 409; the fresh hash is accepted", async () => {
    const id = await openPosting();
    const seen = await hashOf(id);
    await companyService().updateForPayer(id, COMPANY, { description: "Night shift too." }, CTX);

    expect(await refusal(reviewService().review(id, decision(seen), CALL))).toEqual({
      status: 409,
      code: "POSTING_CHANGED",
    });
    expect((await review(id))?.state).toBe("pending");

    const fresh = await hashOf(id);
    expect(fresh).not.toBe(seen);
    await reviewService().review(id, decision(fresh), CALL);
    expect(await approved(id)).toBe(true);
  }, 60_000);

  it("a company edit after approval reads pending through approvedForRvmStudents", async () => {
    const id = await openPosting();
    await reviewService().review(id, decision(await hashOf(id)), CALL);
    expect(await approved(id)).toBe(true);

    // PR 4's write path resets the row in the edit's transaction.
    await companyService().updateForPayer(id, COMPANY, { role_title: "VMC Setter t2746r" }, CTX);
    expect(await review(id)).toMatchObject({ state: "pending", content_hash: null });
    expect(await approved(id)).toBe(false);

    // And a writer that resets nothing cannot leak an edit: the read compares the hash live.
    await reviewService().review(id, decision(await hashOf(id)), CALL);
    expect(await approved(id)).toBe(true);
    await client.sql`UPDATE job_postings SET pay_min = 9000 WHERE id = ${id}::uuid`;
    expect((await review(id))?.state).toBe("approved");
    expect(await approved(id)).toBe(false);
  }, 60_000);

  // ── The newest decision wins (decided_at) ───────────────────────────────────

  it("approve(t1), reject(t2), then a late replay of approve(t1): 409 DECISION_SUPERSEDED and the row stays rejected", async () => {
    const id = await openPosting();
    const seen = await hashOf(id);
    const svc = reviewService();
    const approveT1 = decision(seen, { branch_ids: [BRANCH_A], reason: "Fits the CNC batch" });
    const rejectT2 = decision(seen, { state: "rejected", reviewer_ref: REVIEWER_2 });

    await svc.review(id, approveT1, CALL);
    const rejected = await svc.review(id, rejectT2, CALL);
    const afterReject = await review(id);
    expect(afterReject).toMatchObject({
      state: "rejected",
      reviewer_ref: REVIEWER_2,
      reason: null,
      branch_ids: null,
      content_hash: seen,
    });

    expect(await refusal(svc.review(id, approveT1, CALL))).toEqual({
      status: 409,
      code: "DECISION_SUPERSEDED",
    });
    expect(await review(id)).toEqual(afterReject);
    expect(await approved(id)).toBe(false);

    // The replay of the decision the row holds is the 200 no-op, with its own time.
    expect(await svc.review(id, rejectT2, CALL)).toEqual(rejected);
    expect(await review(id)).toEqual(afterReject);

    const history = await reviewedEvents(id);
    expect(history.map((e) => [e.previous_state, e.state])).toEqual([
      ["pending", "approved"],
      ["approved", "rejected"],
    ]);
    expect(history.map((e) => e.has_reason)).toEqual([true, false]);
    expect(JSON.stringify(history)).not.toContain("Fits the CNC batch");
    expect(await decisionAudits(id)).toHaveLength(2);
  }, 60_000);

  it("two decisions delivered in reverse order: the newer one stands, the older is refused", async () => {
    const id = await openPosting();
    const seen = await hashOf(id);
    const svc = reviewService();
    const earlier = decision(seen); // approve at t1
    const later = decision(seen, { state: "rejected" }); // reject at t2 > t1

    await svc.review(id, later, CALL);
    expect(await refusal(svc.review(id, earlier, CALL))).toEqual({
      status: 409,
      code: "DECISION_SUPERSEDED",
    });
    expect((await review(id))?.state).toBe("rejected");
    expect(await reviewedEvents(id)).toHaveLength(1);
  }, 60_000);

  it("an equal-time conflict: the same decided_at with another decision is refused, nothing stored", async () => {
    const id = await openPosting();
    const seen = await hashOf(id);
    const svc = reviewService();
    const first = decision(seen);
    await svc.review(id, first, CALL);
    const held = await review(id);

    for (const clash of [
      { ...first, state: "rejected" as const },
      { ...first, reviewer_ref: REVIEWER_2 },
      { ...first, branch_ids: [BRANCH_A] },
      { ...first, reason: "A different note" },
    ]) {
      expect(await refusal(svc.review(id, clash, CALL))).toEqual({
        status: 409,
        code: "DECISION_SUPERSEDED",
      });
    }
    expect(await review(id)).toEqual(held);
    expect(await reviewedEvents(id)).toHaveLength(1);
  }, 60_000);

  it("a decided_at from BadaBhai's future is refused with 400, nothing stored", async () => {
    const id = await openPosting();
    const before = await review(id);
    const ahead = new Date(Date.now() + CAMPUS_MAX_CLOCK_SKEW_MS + 60_000).toISOString();

    expect(
      await refusal(
        reviewService().review(id, decision(await hashOf(id), { decided_at: ahead }), CALL),
      ),
    ).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    expect(await review(id)).toEqual(before);
    expect(await reviewedEvents(id)).toEqual([]);
  }, 60_000);

  // ── Narrowing, and which postings ───────────────────────────────────────────

  it("narrowing outside the posting's targeting is refused, and nothing is written", async () => {
    const targeted = await openPosting({ rvm_branch_ids: [BRANCH_A] });
    const before = await review(targeted);
    const err = await reviewService()
      .review(targeted, decision(await hashOf(targeted), { branch_ids: [BRANCH_B] }), CALL)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await review(targeted)).toEqual(before);

    // The posting targets every branch / course: each narrowed id must be an ACTIVE option.
    const everyone = await openPosting({ rvm_branch_ids: [], rvm_course_ids: [] });
    const hash = await hashOf(everyone);
    expect(
      await refusal(
        reviewService().review(everyone, decision(hash, { branch_ids: [BRANCH_RETIRED] }), CALL),
      ),
    ).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    expect(
      await refusal(
        reviewService().review(everyone, decision(hash, { course_ids: [COURSE_RETIRED] }), CALL),
      ),
    ).toEqual({ status: 400, code: "VALIDATION_FAILED" });
    await reviewService().review(
      everyone,
      decision(hash, { branch_ids: [BRANCH_B], course_ids: [COURSE_A] }),
      CALL,
    );
    expect(await review(everyone)).toMatchObject({
      branch_ids: [BRANCH_B],
      course_ids: [COURSE_A],
    });
  }, 60_000);

  it("which postings: 404 for a draft, a hidden posting and a company off the pilot; 409 closed / BadaBhai-only", async () => {
    const svc = reviewService();
    const company = companyService();

    const draft = await company.createForPayer(COMPANY, { ...DTO, audience: "rvm_students" }, CTX);
    expect(await refusal(svc.review(draft.id, decision(await hashOf(draft.id)), CALL))).toEqual({
      status: 404,
      code: undefined,
    });

    const hidden = await openPosting();
    await client.sql`
      UPDATE job_postings SET hidden_at = now(), hidden_by = ${HIDER}::uuid,
             hidden_reason_code = 'other', hidden_reason_text = 'fixture'
       WHERE id = ${hidden}::uuid`;
    expect((await refusal(svc.review(hidden, decision(await hashOf(hidden)), CALL))).status).toBe(
      404,
    );

    const closed = await openPosting();
    await company.closeForPayer(closed, COMPANY, CTX);
    expect(await refusal(svc.review(closed, decision(await hashOf(closed)), CALL))).toEqual({
      status: 409,
      code: "POSTING_NOT_OPEN",
    });

    const paused = await openPosting();
    await company.pauseForPayer(paused, COMPANY, CTX);
    await svc.review(paused, decision(await hashOf(paused)), CALL);
    expect((await review(paused))?.state).toBe("approved");

    const workersOnly = await openPosting({
      audience: "badabhai_workers" as JobPostingAudience,
      rvm_branch_ids: [],
    });
    expect(
      await refusal(svc.review(workersOnly, decision(await hashOf(workersOnly)), CALL)),
    ).toEqual({ status: 409, code: "AUDIENCE_EXCLUDES_RVM" });

    // `pilot`: the owner's tenant key must be on the list. COMPANY is not; PILOT is.
    const notListed = await openPosting();
    const pilotSvc = reviewService({ JOB_AUDIENCE_ROLLOUT: "pilot" });
    expect(
      (await refusal(pilotSvc.review(notListed, decision(await hashOf(notListed)), CALL))).status,
    ).toBe(404);
    const listed = await openPosting({}, PILOT);
    await pilotSvc.review(listed, decision(await hashOf(listed)), CALL);
    expect(await approved(listed)).toBe(true);

    // Off: every posting is the neutral 404.
    const offSvc = reviewService({ JOB_AUDIENCE_ROLLOUT: "off" });
    expect(
      (await refusal(offSvc.review(listed, decision(await hashOf(listed)), CALL))).status,
    ).toBe(404);
  }, 90_000);

  it("tenancy mode on: an owner with no membership is the neutral 404, and NO tenancy row is written", async () => {
    // PILOT has a `payers` row and no membership: the request path would heal it a solo org.
    const id = await openPosting({}, PILOT);
    const tenancyRows = async () => {
      const [row] = await client.sql<{ orgs: number; members: number }[]>`
        SELECT (SELECT count(*)::int FROM payer_orgs WHERE root_payer_id = ${PILOT}::uuid) AS orgs,
               (SELECT count(*)::int FROM payer_members WHERE member_payer_id = ${PILOT}::uuid) AS members`;
      return row!;
    };
    expect(await tenancyRows()).toEqual({ orgs: 0, members: 0 });
    const onMode = new PayerTenantScopeService(
      loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" }),
      new PayerOrgsRepository(client.db),
    );

    const refused = await refusal(
      reviewService(ON, eventsService, onMode).review(id, decision(await hashOf(id)), CALL),
    );

    expect(refused.status).toBe(404);
    expect(await tenancyRows()).toEqual({ orgs: 0, members: 0 });
    expect((await review(id))?.state).toBe("pending");
  }, 60_000);

  // ── The lock order, on two connections ──────────────────────────────────────

  it("a review sent while a company edit holds the posting waits at the posting, then answers 409 (no deadlock)", async () => {
    const id = await openPosting();
    // An approved row, so the edit also locks the REVIEW row (its reset) before it is held.
    await reviewService().review(id, decision(await hashOf(id)), CALL);
    const seen = await hashOf(id);
    const eventsBefore = (await reviewedEvents(id)).length;

    const gated = new GatedEvents(new EventsRepository(client.db), { NODE_ENV: "test" } as never);
    const hold = gated.holdNext();
    const editing = companyService(ON, gated)
      .updateForPayer(id, COMPANY, { rvm_branch_ids: [BRANCH_A, BRANCH_B] }, CTX)
      .then(
        () => null,
        (e: unknown) => e,
      );
    // The edit's transaction now holds the posting (FOR NO KEY UPDATE + UPDATE) and the review row.
    const holder = await reached(hold.entered, editing);

    let settled = false;
    const reviewing = reviewService(ON, eventsService)
      .review(id, decision(seen, { reviewer_ref: REVIEWER_2 }), CALL)
      .then(
        () => null,
        (e: unknown) => e,
      )
      .finally(() => {
        settled = true;
      });

    try {
      // It waits at the POSTING row (`FOR SHARE`), the first lock of the house order — not at the
      // review row, which the edit also holds.
      expect(await sawRowLockWait(holder, "job_postings", "RowShareLock", () => settled)).toBe(
        true,
      );
      expect(settled).toBe(false);
    } finally {
      hold.release();
    }
    expect(await editing).toBeNull(); // the edit committed: no 40P01, no error at all
    const err = await reviewing;
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({ code: "POSTING_CHANGED" });

    // Nothing of the review was stored: the edit's reset stands.
    expect(await review(id)).toMatchObject({ state: "pending", reviewer_ref: null });
    expect(await reviewedEvents(id)).toHaveLength(eventsBefore);
    expect(await approved(id)).toBe(false);
  }, 60_000);

  it("a company edit sent while a review holds the posting waits at the posting, then un-approves it", async () => {
    const id = await openPosting();
    const seen = await hashOf(id);

    const gated = new GatedEvents(new EventsRepository(client.db), { NODE_ENV: "test" } as never);
    const hold = gated.holdNext();
    const reviewing = reviewService(ON, gated)
      .review(id, decision(seen), CALL)
      .then(
        (answer) => answer,
        (e: unknown) => e,
      );
    // The review's transaction holds the posting (FOR SHARE) and its written review row.
    const holder = await reached(hold.entered, reviewing);

    let settled = false;
    const editing = companyService()
      .updateForPayer(id, COMPANY, { description: "Edited while under review." }, CTX)
      .then(
        () => null,
        (e: unknown) => e,
      )
      .finally(() => {
        settled = true;
      });

    try {
      // The edit's UPDATE waits at the POSTING row, not at the review row: one order, no cycle.
      expect(await sawRowLockWait(holder, "job_postings", "ExclusiveLock", () => settled)).toBe(
        true,
      );
      expect(settled).toBe(false);
    } finally {
      hold.release();
    }
    expect(await reviewing).toMatchObject({ posting_id: id, review_state: "approved" });
    expect(await editing).toBeNull();

    // The approval was for the content the reviewer saw; the edit that followed un-approved it.
    expect(await review(id)).toMatchObject({ state: "pending", content_hash: null });
    expect(await approved(id)).toBe(false);
    expect(await reviewedEvents(id)).toHaveLength(1);
  }, 60_000);

  it("two decisions race: the second waits on the REVIEW row, then reports the first as its previous_state", async () => {
    const id = await openPosting();
    const seen = await hashOf(id);
    const a = decision(seen); // approve at t1
    const b = decision(seen, { state: "rejected", reviewer_ref: REVIEWER_2 }); // reject at t2

    const gated = new GatedEvents(new EventsRepository(client.db), { NODE_ENV: "test" } as never);
    const hold = gated.holdNext();
    const first = reviewService(ON, gated)
      .review(id, a, CALL)
      .then(
        (answer) => answer,
        (e: unknown) => e,
      );
    // A holds the posting FOR SHARE and its written review row.
    const holder = await reached(hold.entered, first);

    let settled = false;
    const second = reviewService()
      .review(id, b, CALL)
      .then(
        (answer) => answer,
        (e: unknown) => e,
      )
      .finally(() => {
        settled = true;
      });

    try {
      // B shares the posting lock and queues on the REVIEW row's FOR UPDATE.
      expect(
        await sawRowLockWait(
          holder,
          "job_posting_institute_reviews",
          "AccessExclusiveLock",
          () => settled,
        ),
      ).toBe(true);
      expect(settled).toBe(false);
    } finally {
      hold.release();
    }
    expect(await first).toMatchObject({ review_state: "approved" });
    expect(await second).toMatchObject({ review_state: "rejected" });

    const history = await reviewedEvents(id);
    expect(history.map((e) => [e.previous_state, e.state])).toEqual([
      ["pending", "approved"],
      // B read the state AFTER its row lock, in its own statement: A's approval, not "pending".
      ["approved", "rejected"],
    ]);
    expect((await review(id))?.state).toBe("rejected");
  }, 60_000);

  it("two identical first decisions on a posting with NO review row: one is written, the other is the replay", async () => {
    const id = await openPosting();
    await client.sql`DELETE FROM job_posting_institute_reviews WHERE job_posting_id = ${id}::uuid`;
    const body = decision(await hashOf(id));

    const [one, two] = await Promise.all([
      reviewService().review(id, body, CALL),
      reviewService().review(id, body, CALL),
    ]);

    expect(one).toEqual({ posting_id: id, review_state: "approved", reviewed_at: body.decided_at });
    expect(two).toEqual(one);
    const history = await reviewedEvents(id);
    expect(history).toHaveLength(1);
    // The row was created pending in the decision's transaction: never a null previous state.
    expect(history[0]!.previous_state).toBe("pending");
    expect(await decisionAudits(id)).toHaveLength(1);
    expect(await approved(id)).toBe(true);
  }, 60_000);

  // ── PUT targeting-options ───────────────────────────────────────────────────

  it("targeting options: upserts labels and order, retires what left the list, never deletes, keeps the newest list", async () => {
    // Inside a transaction that is rolled back, because the replacement is GLOBAL: it retires
    // every option not listed, including any the database already held.
    const ROLLBACK = new Error("rollback: the targeting suite leaves no trace");
    await client.db
      .transaction(async (outer) => {
        const db = outer as unknown as Database;
        const svc = new CampusTargetingOptionsService(
          new CampusTargetingOptionsRepository(db),
          new EventsService(new EventsRepository(db), { NODE_ENV: "test" } as never),
        );
        const rows = async () =>
          (await db.execute(dsql`
            SELECT kind, ref, label, active, sort_order FROM rvm_targeting_options
             WHERE ref LIKE '27465%' OR ref LIKE 't2746r-%' ORDER BY kind, ref`)) as unknown as {
            kind: string;
            ref: string;
            label: string;
            active: boolean;
            sort_order: number;
          }[];
        const total = async () =>
          (
            (await db.execute(
              dsql`SELECT count(*)::int AS n FROM rvm_targeting_options`,
            )) as unknown as {
              n: number;
            }[]
          )[0]!.n;
        const highWater = async () =>
          (
            (await db.execute(
              dsql`SELECT count(DISTINCT updated_at)::int AS stamps, max(updated_at) AS hw FROM rvm_targeting_options`,
            )) as unknown as { stamps: number; hw: string }[]
          )[0]!;
        const optionEvents = async () =>
          (
            (await db.execute(dsql`
            SELECT payload FROM events
             WHERE event_name = 'job_posting.rvm_targeting_options_set'
               AND correlation_id = ${CORRELATION}::uuid`)) as unknown as {
              payload: Record<string, unknown>;
            }[]
          ).map((r) => r.payload);

        const totalBefore = await total();
        // Now, by BadaBhai's clock: newer than the seeded rows' stamp (their insert time).
        const asOf1 = new Date().toISOString();
        const list1 = {
          as_of: asOf1,
          branches: [
            { id: BRANCH_B, name: "Fixture branch B, renamed" },
            { id: BRANCH_A, name: "Fixture branch A" },
            { id: BRANCH_RETIRED, name: "Fixture branch back" },
          ],
          courses: [{ id: "t2746r-new", name: "Fixture new course" }],
        };
        const counts = await svc.replace(list1, CALL);

        expect(counts.branches).toMatchObject({ listed: 3, added: 0 });
        expect(counts.courses).toMatchObject({ listed: 1, added: 1 });
        expect(await rows()).toEqual([
          {
            kind: "branch",
            ref: String(BRANCH_A),
            label: "Fixture branch A",
            active: true,
            sort_order: 1,
          },
          {
            kind: "branch",
            ref: String(BRANCH_B),
            label: "Fixture branch B, renamed",
            active: true,
            sort_order: 0,
          },
          {
            kind: "branch",
            ref: String(BRANCH_RETIRED),
            label: "Fixture branch back",
            active: true,
            sort_order: 2,
          },
          {
            kind: "course",
            ref: COURSE_A,
            label: "Fixture CNC course",
            active: false,
            sort_order: 1,
          },
          {
            kind: "course",
            ref: "t2746r-new",
            label: "Fixture new course",
            active: true,
            sort_order: 0,
          },
          {
            kind: "course",
            ref: COURSE_RETIRED,
            label: "Fixture retired course",
            active: false,
            sort_order: 3,
          },
        ]);
        // Nothing deleted: one row more (the new course), every retired option still there.
        expect(await total()).toBe(totalBefore + 1);
        // Every row, listed or retired, carries the applied list's as_of: the high-water mark.
        const mark = await highWater();
        expect(mark.stamps).toBe(1);
        expect(Date.parse(mark.hw)).toBe(Date.parse(asOf1));
        expect(await optionEvents()).toEqual([
          expect.objectContaining({ as_of: asOf1, institute_code: "rvm" }),
        ]);
        const [audit] = (await db.execute(dsql`
          SELECT actor_type, entity_type, metadata FROM audit_logs
           WHERE action = 'campus_link.targeting_options_set' AND entity_id = ${CALL.callId}::uuid`)) as unknown as {
          actor_type: string;
          entity_type: string;
          metadata: Record<string, unknown>;
        }[];
        expect(audit).toMatchObject({
          actor_type: "campus_service",
          entity_type: "rvm_targeting_options",
        });

        // The same list again (same as_of): the replay, nothing changes, nothing is emitted.
        const again = await svc.replace(list1, CALL);
        expect(again.branches).toEqual({ listed: 3, added: 0, updated: 0, deactivated: 0 });
        expect(again.courses).toEqual({ listed: 1, added: 0, updated: 0, deactivated: 0 });
        expect(await optionEvents()).toHaveLength(1);

        // A late list (older as_of) that differs: refused, nothing written.
        const before = await rows();
        const late = await svc
          .replace(
            { ...list1, as_of: new Date(Date.parse(asOf1) - 60_000).toISOString(), courses: [] },
            CALL,
          )
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(late).toBeInstanceOf(ConflictException);
        expect((late as ConflictException).getResponse()).toEqual({ code: "DECISION_SUPERSEDED" });
        // The same instant with a different list: refused too.
        const clash = await svc.replace({ ...list1, courses: [] }, CALL).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect((clash as ConflictException).getResponse()).toEqual({ code: "DECISION_SUPERSEDED" });
        expect(await rows()).toEqual(before);
        expect(Date.parse((await highWater()).hw)).toBe(Date.parse(asOf1));

        // A newer list applies and moves the mark.
        const asOf2 = new Date(Date.parse(asOf1) + 1000).toISOString();
        await svc.replace({ ...list1, as_of: asOf2, courses: [] }, CALL);
        expect((await rows()).find((r) => r.ref === "t2746r-new")?.active).toBe(false);
        expect(Date.parse((await highWater()).hw)).toBe(Date.parse(asOf2));
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
      });
    // Rolled back: the fixture options are as seeded.
    const [course] = await client.sql<{ active: boolean }[]>`
      SELECT active FROM rvm_targeting_options WHERE kind = 'course' AND ref = ${COURSE_A}`;
    expect(course?.active).toBe(true);
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
    VALUES (${WORKER}::uuid, 'enc:t2746r-review', 'hash:t2746r-review', 'active')
    ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
    VALUES (${WORKER}::uuid, ${SKILL}, ${INDUSTRY}, 48, true, 'derived_coarse')`;
  await sql`
    INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
    VALUES (${WORKER}::uuid, ${INDUSTRY}, 48)`;
  await sql`
    INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
    VALUES (${PILOT}::uuid, 'employer', 'enc:t2746r-pilot', 'hash:t2746r-pilot',
            'enc:org-t2746r-pilot', 'active')`;
  await sql`
    INSERT INTO feature_pilot_payers (feature, payer_id, added_by, reason)
    VALUES ('job_audience', ${PILOT}::uuid, 'test', '#2746 PR 5 DB test: the pilot company')`;
  await sql`
    INSERT INTO rvm_targeting_options (kind, ref, label, active, sort_order) VALUES
      ('branch', ${String(BRANCH_A)}, 'Fixture branch A', true, 1),
      ('branch', ${String(BRANCH_B)}, 'Fixture branch B', true, 2),
      ('branch', ${String(BRANCH_RETIRED)}, 'Fixture branch retired', false, 3),
      ('course', ${COURSE_A}, 'Fixture CNC course', true, 1),
      ('course', ${COURSE_RETIRED}, 'Fixture retired course', false, 3)`;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM job_reach WHERE worker_id = ${WORKER}::uuid`;
  await sql`
    DELETE FROM audit_logs
     WHERE action = 'campus_link.posting_reviewed'
       AND actor_id IN (${REVIEWER}::uuid, ${REVIEWER_2}::uuid)`;
  // Review rows cascade with their postings.
  await sql`DELETE FROM job_postings WHERE payer_id IN (${COMPANY}::uuid, ${PILOT}::uuid)`;
  await sql`
    DELETE FROM rvm_targeting_options
     WHERE (kind = 'branch' AND ref IN (${String(BRANCH_A)}, ${String(BRANCH_B)}, ${String(BRANCH_RETIRED)}))
        OR (kind = 'course' AND ref IN (${COURSE_A}, ${COURSE_RETIRED}, 't2746r-new'))`;
  // Only a broken read-only resolve would have written these; remove them before the payer.
  await sql`DELETE FROM payer_members WHERE member_payer_id = ${PILOT}::uuid`;
  await sql`DELETE FROM payer_orgs WHERE root_payer_id = ${PILOT}::uuid`;
  await sql`DELETE FROM payers WHERE id = ${PILOT}::uuid`; // its pilot row cascades
  await sql`DELETE FROM worker_skill WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ${WORKER}::uuid`;
  await sql`DELETE FROM workers WHERE id = ${WORKER}::uuid`;
  await client.db.delete(events).where(eq(events.correlationId, CORRELATION));
}
