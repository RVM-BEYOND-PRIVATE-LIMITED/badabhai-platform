import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, Optional, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import { z } from "zod";
import { APPLICANT_POSTING_KINDS } from "@badabhai/types";
import type { OutboundSignalFailure } from "@badabhai/db";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  RvmSelectionEventBodySchema,
  RvmStudentApiClient,
  RvmStudentApiUnavailableError,
  type RvmSelectionEventBody,
} from "../campus-link/rvm-student-api.client";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import {
  OUTBOUND_SIGNALS_QUEUE,
  OUTBOUND_SIGNALS_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { OutboundSignalsRepository, type ClaimedSignal } from "./outbound-signals.repository";

/** How often the sweep looks for due rows. */
export const OUTBOUND_SWEEP_EVERY_MS = 60_000;
/** Rows sent per tick: small, so one slow destination never holds a tick for long. */
export const OUTBOUND_BATCH_LIMIT = 25;
/** The shortest a claim is held before another sender may take the row (a crash mid-send). */
export const OUTBOUND_MIN_LEASE_MS = 5 * 60_000;
/** After this many claims a row is dead (about a day and a half of back-off). */
export const OUTBOUND_MAX_ATTEMPTS = 14;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 3_600_000;
/** The contract's longest company name and job title (UTF-16 units, as zod counts them). */
const MAX_TEXT = 200;

/** The wait before attempt `attempt + 1`: 1, 2, 4 … minutes, capped at six hours. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
}

/**
 * How long a claim is held: long enough for the slowest possible batch (every send timing out),
 * so a second sender never re-claims rows the first is still working through.
 */
export function leaseMs(timeoutMs: number): number {
  return Math.max(OUTBOUND_MIN_LEASE_MS, OUTBOUND_BATCH_LIMIT * timeoutMs + 60_000);
}

/** At most `max` UTF-16 units, never splitting a character. */
export function capped(text: string, max: number = MAX_TEXT): string {
  let out = "";
  for (const ch of text.trim()) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** What a selection row's payload must be. A row that is not this is dead, never guessed at. */
const SelectionPayloadSchema = z.object({
  posting_kind: z.enum(APPLICANT_POSTING_KINDS),
  posting_id: z.string().min(1),
  worker_id: z.string().min(1),
  stage: z.enum(["selected", "hired"]),
  marked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** The stored stages under which a signalled mark is still true when it is sent. */
const STILL_TRUE: Readonly<Record<"selected" | "hired", readonly string[]>> = {
  selected: ["selected", "hired"],
  hired: ["hired"],
};

/** What one tick did — counts only, no ids (BullMQ job-inspection surface). */
export interface OutboundSweepResult {
  armed: boolean;
  configured: boolean;
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
  cancelled: number;
}

type Outcome = "delivered" | "retried" | "dead" | "cancelled";

/**
 * #2747 item 8 (ADR-0064 §3.6) — sends each queued mark on an RVM student to RVM once
 * (`POST /internal/campus/selection-events`, Scheduler_Backend#162 item 8), with back-off and a
 * dead-letter state.
 *
 * THE TABLE IS THE WORK LIST. A repeatable tick with no payload claims due `pending` rows
 * (`SKIP LOCKED`, with a lease that outlasts the slowest batch; each claim counts as an attempt),
 * so a lost or duplicated Redis job is harmless, two senders never take one row, and a row a
 * sender keeps crashing on is given up. RVM de-duplicates on the row id (`event_id`, also the
 * Idempotency-Key), so a retry after a lost reply cannot open a second prompt or task.
 *
 * STILL TRUE WHEN SENT. A row is due `OUTBOUND_SEND_DELAY_MS` after the mark, and before anything
 * leaves the sender re-reads: the stage the board holds now (a mark undone before it went is
 * `cancelled`), the worker (suspended or scheduled for deletion: `cancelled`) and his RVM link
 * (ended: `cancelled`). Then it builds the body: the student ref, the posting's title, the company
 * as students see it (a company posting's `org_label`, the name Campus shows; an agency job's
 * owner account name, decrypted here and never stored in clear), the stage and the day.
 *
 * OFF IS IDLE. While `OUTBOUND_SIGNALS_ROLLOUT` is off everywhere, or RVM's settings are not set,
 * the tick claims nothing; rows wait and go once both are in place.
 *
 * LOGS IDS ONLY: the signal id, closed failure codes, an HTTP status and an error's class name;
 * never the body or a response.
 */
@Processor(OUTBOUND_SIGNALS_QUEUE)
export class OutboundSignalsSender extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboundSignalsSender.name);
  private readonly clock: () => Date;

  constructor(
    private readonly repo: OutboundSignalsRepository,
    private readonly rvm: RvmStudentApiClient,
    private readonly pii: PiiCryptoService,
    private readonly rollout: FeatureRolloutService,
    @InjectQueue(OUTBOUND_SIGNALS_QUEUE) private readonly queue: Queue,
    @Optional() @Inject("OUTBOUND_SIGNALS_CLOCK") clock?: () => Date,
  ) {
    super();
    this.clock = clock ?? (() => new Date());
  }

  /** Register the repeatable sweep. Idempotent by scheduler id; a failure never fails boot. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(OUTBOUND_SIGNALS_SWEEP_SCHEDULER_ID, {
        every: OUTBOUND_SWEEP_EVERY_MS,
      });
    } catch (err) {
      this.logger.warn(
        `outbound-signals sweep scheduler registration failed; a previously-registered scheduler keeps ticking and the next boot re-asserts it (reason: ${
          err instanceof Error ? err.name : "unknown"
        })`,
      );
    }
  }

  async process(): Promise<OutboundSweepResult> {
    const result: OutboundSweepResult = {
      armed: this.rollout.isLiveForServiceCaller("outbound_signals"),
      configured: this.rvm.isConfigured(),
      claimed: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      cancelled: 0,
    };
    if (!result.armed || !result.configured) return result;

    const now = this.clock();
    const rows = await this.repo.claimDue(
      now,
      new Date(now.getTime() + leaseMs(this.rvm.timeoutMs)),
      OUTBOUND_BATCH_LIMIT,
      OUTBOUND_MAX_ATTEMPTS,
    );
    result.claimed = rows.length;
    for (const row of rows) {
      const outcome = await this.sendOne(row);
      result[outcome] += 1;
    }
    if (rows.length > 0) {
      this.logger.log(
        `outbound-signals sweep: claimed=${result.claimed} delivered=${result.delivered} retried=${result.retried} dead=${result.dead} cancelled=${result.cancelled}`,
      );
    }
    return result;
  }

  /** One row, start to finish. Never throws: a failure is recorded on the row. */
  private async sendOne(row: ClaimedSignal): Promise<Outcome> {
    const at = this.clock();
    let body: RvmSelectionEventBody;
    try {
      const built = await this.buildBody(row);
      if (typeof built === "string") return built;
      body = built;
    } catch (err) {
      // A read failed (a dropped connection, say): nothing was sent, so try again later.
      this.logger.warn(
        `outbound signal ${row.id}: could not build the body (${err instanceof Error ? err.name : "unknown"})`,
      );
      return this.retryOrDie(row, "network", at);
    }

    try {
      const answer = await this.rvm.postSelectionEvent(body);
      if (answer.kind === "accepted") {
        await this.repo.markDelivered(row.id, at);
        return "delivered";
      }
      if (answer.kind === "not_available") return await this.final(row, "dead", "not_available");
      this.logger.warn(`outbound signal ${row.id} refused by RVM (status ${answer.status})`);
      return await this.final(row, "dead", "rejected");
    } catch (err) {
      if (err instanceof RvmStudentApiUnavailableError) {
        return this.retryOrDie(row, err.failure, at);
      }
      this.logger.warn(
        `outbound signal ${row.id}: unexpected send error (${err instanceof Error ? err.name : "unknown"})`,
      );
      return this.retryOrDie(row, "contract", at);
    }
  }

  /**
   * The body to send, or the outcome when nothing may be sent: the mark is undone, the worker or
   * his link is no longer there, the posting or company is gone, or the row is off-contract.
   */
  private async buildBody(row: ClaimedSignal): Promise<RvmSelectionEventBody | Outcome> {
    const payload = SelectionPayloadSchema.safeParse(row.payload);
    if (!payload.success || payload.data.worker_id !== row.workerId) {
      return this.final(row, "dead", "contract");
    }
    const p = payload.data;
    const ctx = await this.repo.selectionContext(row.workerId, p.posting_kind, p.posting_id);
    if (ctx.currentStage === null || !STILL_TRUE[p.stage].includes(ctx.currentStage)) {
      return this.final(row, "cancelled", "mark_undone");
    }
    if (!ctx.workerActive) return this.final(row, "cancelled", "worker_inactive");
    if (ctx.studentRef === null) return this.final(row, "cancelled", "link_inactive");
    if (ctx.jobTitle === null) return this.final(row, "dead", "context_missing");

    let company: string | null = ctx.companyLabel;
    if (company === null && ctx.companyNameEnc !== null) {
      try {
        company = this.pii.decrypt(ctx.companyNameEnc);
      } catch {
        company = null;
      }
    }
    if (company === null) return this.final(row, "dead", "context_missing");

    const candidate = {
      event_id: row.id,
      student_ref: ctx.studentRef,
      company: capped(company),
      job_title: capped(ctx.jobTitle),
      status: p.stage,
      date: p.marked_on,
    };
    if (candidate.company === "" || candidate.job_title === "") {
      return this.final(row, "dead", "context_missing");
    }
    // Checked here, before the client: an off-contract body is dead now, never retried 14 times.
    if (!RvmSelectionEventBodySchema.safeParse(candidate).success) {
      return this.final(row, "dead", "contract");
    }
    return candidate;
  }

  private async retryOrDie(
    row: ClaimedSignal,
    failure: OutboundSignalFailure,
    at: Date,
  ): Promise<Outcome> {
    if (row.attempts >= OUTBOUND_MAX_ATTEMPTS) {
      this.logger.warn(
        `outbound signal ${row.id} dead after ${row.attempts} attempts (${failure})`,
      );
      return this.final(row, "dead", failure);
    }
    await this.repo.markRetry(
      row.id,
      failure,
      new Date(at.getTime() + backoffMs(row.attempts)),
      at,
    );
    return "retried";
  }

  private async final(
    row: ClaimedSignal,
    status: "dead" | "cancelled",
    failure: OutboundSignalFailure,
  ): Promise<Outcome> {
    await this.repo.markFinal(row.id, status, failure, this.clock());
    return status;
  }
}
