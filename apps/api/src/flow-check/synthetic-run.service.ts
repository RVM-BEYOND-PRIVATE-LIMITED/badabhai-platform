import { randomInt, randomUUID } from "node:crypto";
import { HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { ServerConfig } from "@badabhai/config";
import { grantCreditsWithinTx, type Database, type DbClient } from "@badabhai/db";
import {
  FLOW_SYNTHETIC_STEPS,
  type FlowCheckSyntheticRunRecordedPayload,
  type FlowSyntheticFailure,
  type FlowSyntheticStep,
} from "@badabhai/event-schema";
import {
  LIVE_POSTING_TRADE_KINDS,
  POSTING_TRADES,
  postingTradeFor,
  type PostingTrade,
} from "@badabhai/taxonomy";
import { SERVER_CONFIG } from "../config/config.module";
import { DATABASE, DB_CLIENT } from "../database/database.module";
import { runRolledBack, type SyntheticStudent } from "../database/synthetic-scope";
import { EventsService } from "../events/events.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { AdminPostingAudienceService } from "../admin-postings/admin-posting-audience.service";
import { CampusPostingsService } from "../campus-link/campus-postings.service";
import { CampusApplicationsService } from "../campus-link/campus-applications.service";
import { RvmStudentApiUnavailableError } from "../campus-link/rvm-student-api.client";
import { StudentNotAvailableError } from "../campus-link/institute-link.service";
import { ApplicationsService } from "../applications/applications.service";
import { PayerApplicantsService } from "../payer-portal/payer-applicants.service";
import { TradeReleaseService } from "../trade-release/trade-release.service";
import { UnlockService } from "../unlocks/unlocks.service";
import { flowCheckDay } from "./flow-check.service";

/** The opaque admin id the run's audience decision is recorded under (no admin row; no FK). */
export const SYNTHETIC_ADMIN_ID = "00000000-0000-4000-8000-0000000f1c4e";

/** One run's outcome, step by step. Closed codes only; the error text goes to the log. */
export interface SyntheticRunResult {
  readonly passed: boolean;
  readonly stepsPassed: number;
  readonly failedStep: FlowSyntheticStep | null;
  readonly failure: FlowSyntheticFailure | null;
  readonly durationMs: number;
}

/** A step's own refusal: it answered, but not what the flow needs. */
export class SyntheticStepRefused extends Error {
  constructor(
    readonly code: FlowSyntheticFailure,
    detail: string,
  ) {
    super(detail);
    this.name = "SyntheticStepRefused";
  }
}

/** Map what a step threw to the closed failure code. */
export function failureCodeOf(err: unknown): FlowSyntheticFailure {
  if (err instanceof SyntheticStepRefused) return err.code;
  if (err instanceof StudentNotAvailableError) return "refused";
  if (err instanceof RvmStudentApiUnavailableError) return "unavailable";
  const state = sqlStateOf(err);
  if (state === "57014" || state === "55P03") return "timeout";
  if (err instanceof HttpException) {
    const status = err.getStatus();
    if (status === 404) return "not_found";
    if (status === 409) return "conflict";
    if (status === 400 || status === 422) return "invalid";
    if (status === 503) return "unavailable";
  }
  return "error";
}

/**
 * The run's Campus trade: the first trade on the Campus list that a company may post NOW, in key
 * order. #3025: the catalogue declares trades that are switched off for companies, and the run's
 * publish step would refuse one (`isPostableNow`), so `postableNow` is the same answer the publish
 * gate gives: the live trades, plus every trade whose release switch is on.
 */
export function pickTrade(
  campusTradeKeys: readonly string[],
  postableNow: ReadonlySet<string>,
): {
  trade: PostingTrade;
  onCampusList: boolean;
} {
  for (const key of [...campusTradeKeys].sort()) {
    const trade = postingTradeFor(key);
    if (trade && postableNow.has(trade.roleKind)) return { trade, onCampusList: true };
  }
  // No Campus trade: still walk the BadaBhai half on the first postable trade; the audience step
  // then fails with `no_campus_trade`, which is the finding.
  return { trade: POSTING_TRADES[0]!, onCampusList: false };
}

/**
 * #2967 (#2890 item 4) — THE DAILY SYNTHETIC RUN of the posting → application flow.
 *
 * It walks the flow through the REAL services, in-process, on a company, a worker and an RVM student
 * it makes for the run, and asserts each step:
 *
 *   setup → posted → published → rvm_audience → reached → campus_listed → worker_applied →
 *   campus_applied → applicants_listed → contact_opened
 *
 * EVERYTHING RUNS IN ONE TRANSACTION THAT IS ALWAYS ROLLED BACK (`runRolledBack`): the services'
 * queries join it through the `DATABASE` proxy, so nothing the run writes (the accounts, the job,
 * its reach rows, the review, the applications, the credits, the unlock, every event) is ever seen
 * by anyone else or kept. No real worker is reached, Campus never lists the job, and nothing needs
 * cleaning up. RVM's Student API is never called: the run's student is answered from the run's
 * scope. No notification is on this path (no push, SMS, WhatsApp or email); the one queued job (the
 * referral re-check after an unlock) finds no worker and does nothing.
 *
 * WHAT IT DOES NOT COVER: the HTTP layer (guards, pipes) and Campus's own side (its mirror, its
 * outbox, its dispatcher), which Campus's nightly report covers (#2890).
 *
 * What is kept: one `flow_check.synthetic_run_recorded` per run and, on a failure, ONE
 * `flow_check.synthetic_run_failed` per IST day (the admin breach counter), both counts only.
 * OFF BY DEFAULT (`FLOW_SYNTHETIC_RUN_ENABLED`).
 */
@Injectable()
export class SyntheticRunService {
  private readonly logger = new Logger(SyntheticRunService.name);

  constructor(
    @Inject(DB_CLIENT) private readonly client: DbClient,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    private readonly postings: JobPostingsService,
    private readonly audience: AdminPostingAudienceService,
    private readonly campusPostings: CampusPostingsService,
    private readonly campusApplications: CampusApplicationsService,
    private readonly applications: ApplicationsService,
    private readonly applicants: PayerApplicantsService,
    private readonly unlocks: UnlockService,
    private readonly release: TradeReleaseService,
  ) {}

  enabled(): boolean {
    return this.config.FLOW_SYNTHETIC_RUN_ENABLED === true;
  }

  /** One run, recorded. Never throws for a failing step: the result says which one. */
  async runAndRecord(
    now: Date,
    trigger: "schedule" | "ops",
  ): Promise<{ armed: false } | ({ armed: true } & SyntheticRunResult)> {
    if (!this.enabled()) return { armed: false };
    const result = await this.run();
    await this.record(result, now, trigger);
    return { armed: true, ...result };
  }

  /** Walk the flow once, inside one rolled-back transaction. */
  async run(): Promise<SyntheticRunResult> {
    const started = Date.now();
    const runId = randomUUID();
    const studentRef = randomUUID();
    const student: SyntheticStudent = {
      name: "BadaBhai Synthetic Student",
      // A fresh number each run; `setup` checks no worker holds it before anything is made.
      phone: `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`,
      course: "Synthetic Course",
      branch: "Synthetic Branch",
      status: "current_student",
      test_score: null,
    };
    let stepsPassed = 0;
    const step = async <T>(name: FlowSyntheticStep, work: () => Promise<T>): Promise<T> => {
      if (FLOW_SYNTHETIC_STEPS[stepsPassed] !== name)
        throw new Error(`synthetic step order: ${name}`);
      const value = await work();
      stepsPassed += 1;
      return value;
    };

    let failure: { step: FlowSyntheticStep; code: FlowSyntheticFailure } | null = null;
    try {
      await runRolledBack(this.client.db, new Map([[studentRef, student]]), async () => {
        try {
          await this.walk(step, { runId, studentRef, student });
        } catch (err) {
          const failedStep = FLOW_SYNTHETIC_STEPS[stepsPassed] ?? "setup";
          failure = { step: failedStep, code: failureCodeOf(err) };
          this.logger.error(
            `synthetic run ${runId}: step ${failedStep} failed (${failure.code}): ${
              err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            }`,
          );
        }
      });
    } catch (err) {
      // The transaction itself failed (could not begin, or a rollback error after the walk).
      const failedStep = FLOW_SYNTHETIC_STEPS[stepsPassed] ?? "setup";
      failure ??= { step: failedStep, code: failureCodeOf(err) };
      this.logger.error(
        `synthetic run ${runId}: transaction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const f = failure as { step: FlowSyntheticStep; code: FlowSyntheticFailure } | null;
    return {
      passed: f === null,
      stepsPassed: f === null ? FLOW_SYNTHETIC_STEPS.length : FLOW_SYNTHETIC_STEPS.indexOf(f.step),
      failedStep: f?.step ?? null,
      failure: f?.code ?? null,
      durationMs: Date.now() - started,
    };
  }

  /** The walk itself. Every query here and in the services runs in the run's transaction. */
  private async walk(
    step: <T>(name: FlowSyntheticStep, work: () => Promise<T>) => Promise<T>,
    run: { runId: string; studentRef: string; student: SyntheticStudent },
  ): Promise<void> {
    const ctx: RequestContext = { requestId: `synthetic-${run.runId}`, correlationId: run.runId };

    const fixture = await step("setup", () => this.setup(run));
    const { payerId, workerId, trade } = fixture;

    const posting = await step("posted", async () => {
      const created = await this.postings.createForPayer(
        payerId,
        {
          org_label: "BadaBhai synthetic run",
          role_title: "Synthetic flow check",
          vacancy_band: "1",
          role_kind: trade.roleKind,
          match_skill_ids: [trade.matchSkillId],
        } as Parameters<JobPostingsService["createForPayer"]>[1],
        ctx,
      );
      if (created.status !== "draft")
        throw new SyntheticStepRefused("refused", `created ${created.status}`);
      return created;
    });

    await step("published", async () => {
      const opened = await this.postings.updateForPayer(
        posting.id,
        payerId,
        { status: "open" } as Parameters<JobPostingsService["updateForPayer"]>[2],
        ctx,
      );
      if (opened.status !== "open")
        throw new SyntheticStepRefused("refused", `published ${opened.status}`);
    });

    await step("rvm_audience", async () => {
      if (!fixture.onCampusList) {
        throw new SyntheticStepRefused("no_campus_trade", "no postable trade on the Campus list");
      }
      const result = await this.audience.set(
        SYNTHETIC_ADMIN_ID,
        posting.id,
        { audience: "both", reason_code: "other", reason_text: "Synthetic flow check" },
        ctx,
      );
      if (result.outcome !== "changed") {
        throw new SyntheticStepRefused("refused", `audience ${result.outcome}`);
      }
    });

    await step("reached", async () => {
      const rows = (await this.db.execute(sql`
        SELECT 1 FROM job_reach WHERE job_posting_id = ${posting.id}::uuid AND worker_id = ${workerId}::uuid
      `)) as unknown as unknown[];
      if (rows.length !== 1)
        throw new SyntheticStepRefused("refused", "the worker was not reached");
    });

    await step("campus_listed", async () => {
      const page = await this.campusPostings.feed({
        changed_since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        limit: 200,
      });
      const listed = page.postings.find((p) => p.id === posting.id);
      if (!listed) throw new SyntheticStepRefused("refused", "not on the Campus feed");
      if (listed.review_state !== "approved") {
        throw new SyntheticStepRefused(
          "refused",
          `Campus feed review_state ${listed.review_state}`,
        );
      }
    });

    await step("worker_applied", () =>
      this.applications.apply(workerId, posting.id, { rank: null, source_surface: "feed" }, ctx),
    );

    const studentWorkerId = await step("campus_applied", async () => {
      const applied = await this.campusApplications.apply(
        {
          external_ref: `synthetic:${run.runId}`,
          posting_id: posting.id,
          student_ref: run.studentRef,
        },
        ctx,
      );
      if (!applied.created) throw new SyntheticStepRefused("refused", "Campus apply was a replay");
      const rows = (await this.db.execute(sql`
        SELECT worker_id::text AS worker_id FROM institute_applications
        WHERE external_ref = ${`synthetic:${run.runId}`}
      `)) as unknown as Array<{ worker_id: string }>;
      const id = rows[0]?.worker_id;
      if (!id) throw new SyntheticStepRefused("refused", "no institute_applications row");
      return id;
    });

    await step("applicants_listed", async () => {
      const list = await this.applicants.listForOwned(posting.id, payerId, ctx);
      const seen = new Set(
        (list.applicants as ReadonlyArray<{ workerId?: string; worker_id?: string }>).map(
          (a) => a.workerId ?? a.worker_id,
        ),
      );
      if (!seen.has(workerId) || !seen.has(studentWorkerId)) {
        throw new SyntheticStepRefused("refused", `applicants listed: ${seen.size}`);
      }
    });

    await step("contact_opened", async () => {
      const outcome = await this.unlocks.requestUnlock(
        { payerId, workerId: studentWorkerId, jobId: posting.id },
        ctx,
      );
      if (!("status" in outcome) || outcome.status !== "granted") {
        throw new SyntheticStepRefused("refused", "the contact was not opened");
      }
    });
  }

  /**
   * The run's own company (a test account, active, with credits), its worker (a test account with
   * the trade's skill, wanted) and the RVM student's phone, checked free. All inside the run's
   * transaction, so all of it is rolled back with the rest.
   */
  private async setup(run: { runId: string; student: SyntheticStudent }): Promise<{
    payerId: string;
    workerId: string;
    trade: PostingTrade;
    onCampusList: boolean;
  }> {
    const campusTrades = (await this.db.execute(sql`
      SELECT trade_key FROM campus_trades WHERE removed_at IS NULL
    `)) as unknown as Array<{ trade_key: string }>;
    const postableNow = new Set<string>([
      ...LIVE_POSTING_TRADE_KINDS,
      ...(await this.release.postingEnabledKinds()),
    ]);
    const { trade, onCampusList } = pickTrade(
      campusTrades.map((r) => r.trade_key),
      postableNow,
    );

    const studentHash = this.pii.hashPhone(`+91${run.student.phone}`);
    const taken = (await this.db.execute(sql`
      SELECT 1 FROM workers WHERE phone_hash = ${studentHash}
    `)) as unknown as unknown[];
    if (taken.length > 0)
      throw new SyntheticStepRefused("conflict", "the student's phone is taken");

    const payerId = randomUUID();
    const email = `synthetic-run+${run.runId}@badabhai.invalid`;
    await this.db.execute(sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status, is_test_account)
      VALUES (${payerId}::uuid, 'employer', ${this.pii.encrypt(email)}, ${this.pii.hmac(email)},
              ${this.pii.encrypt("BadaBhai synthetic run")}, 'active', true)
    `);
    await grantCreditsWithinTx(this.db, {
      payerId,
      credits: 10,
      lot: { source: "goodwill", isTest: true },
      ledger: { reason: "grant", idempotencyKey: `synthetic-run:${run.runId}` },
    });

    // A synthetic test phone (+9100000…), unique to the run: never a real number.
    const workerId = randomUUID();
    const workerPhone = `+9100000${String(randomInt(0, 100_000)).padStart(5, "0")}`;
    await this.db.execute(sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status, is_test_account)
      VALUES (${workerId}::uuid, ${this.pii.encrypt(workerPhone)},
              ${this.pii.hashPhone(`${workerPhone}:${run.runId}`)}, 'active', true)
    `);
    await this.db.execute(sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, wants, source)
      SELECT ${workerId}::uuid, s.skill_id, s.industry_id, true, 'ops'
      FROM skill s WHERE s.skill_id = ${trade.matchSkillId}
    `);
    return { payerId, workerId, trade, onCampusList };
  }

  /** Keep the run's record, and on a failure the day's one alert. */
  private async record(
    r: SyntheticRunResult,
    now: Date,
    trigger: "schedule" | "ops",
  ): Promise<void> {
    const day = flowCheckDay(now);
    const payload: FlowCheckSyntheticRunRecordedPayload = {
      day,
      trigger,
      passed: r.passed,
      steps_passed: r.stepsPassed,
      failed_step: r.failedStep,
      failure: r.failure,
      duration_ms: r.durationMs,
    };
    const actor = { actor_type: "system" as const };
    const subject = { subject_type: "job_posting" as const, subject_id: null };
    await this.events.emit({
      event_name: "flow_check.synthetic_run_recorded",
      actor,
      subject,
      payload,
    });
    if (r.passed) {
      this.logger.log(`synthetic run ${day}: passed ${r.stepsPassed} steps in ${r.durationMs} ms`);
      return;
    }
    await this.events.emitOnce({
      event_name: "flow_check.synthetic_run_failed",
      actor,
      subject,
      payload,
      idempotencyKey: `flow_check.synthetic_run_failed:${day}`,
    });
  }
}
