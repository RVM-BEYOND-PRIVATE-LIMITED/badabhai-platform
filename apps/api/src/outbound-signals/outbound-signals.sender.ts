import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, Optional, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import { z } from "zod";
import { APPLICANT_POSTING_KINDS } from "@badabhai/types";
import type { OutboundSignalFailure } from "@badabhai/db";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
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
/** How long a claimed row is held before another sender may take it (a crash mid-send). */
export const OUTBOUND_LEASE_MS = 5 * 60_000;
/** After this many failed attempts a row is dead (about a day and a half of back-off). */
export const OUTBOUND_MAX_ATTEMPTS = 14;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 3_600_000;

/** The wait before attempt `attempt + 1`: 1, 2, 4 … minutes, capped at six hours. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
}

/** What a selection row's payload must be. A row that is not this is dead, never guessed at. */
const SelectionPayloadSchema = z.object({
  posting_kind: z.enum(APPLICANT_POSTING_KINDS),
  posting_id: z.string().min(1),
  worker_id: z.string().min(1),
  stage: z.enum(["selected", "hired"]),
  marked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** What one tick did — counts only, no ids (BullMQ job-inspection surface). */
export interface OutboundSweepResult {
  armed: boolean;
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
  cancelled: number;
}

type Outcome = "delivered" | "retried" | "dead" | "cancelled";

/** At most `max` characters, never splitting a surrogate pair. */
function capped(text: string, max: number): string {
  const trimmed = text.trim();
  return [...trimmed].slice(0, max).join("");
}

/**
 * #2747 item 8 (ADR-0064 §3.6) — sends each queued mark on an RVM student to RVM once
 * (`POST /internal/campus/selection-events`, Scheduler_Backend#162 item 8), with back-off and a
 * dead-letter state.
 *
 * THE TABLE IS THE WORK LIST. A repeatable tick with no payload claims due `pending` rows
 * (`SKIP LOCKED`, with a lease), so a lost or duplicated Redis job is harmless, and two senders
 * never take one row. RVM de-duplicates on the row id (`event_id`, also the Idempotency-Key), so a
 * retry after a lost reply cannot open a second prompt or task.
 *
 * THE BODY IS BUILT AT SEND TIME: the student ref only while his link is still ACTIVE (otherwise
 * the row is `cancelled` and nothing leaves), the posting's title, and the owner company's name,
 * decrypted here and never stored in clear. No phone, no student name, no money field.
 *
 * OFF IS IDLE. While `OUTBOUND_SIGNALS_ROLLOUT` is off everywhere the tick claims nothing; rows
 * wait and go once it is back on (the kill switch).
 *
 * LOGS IDS ONLY: the signal id and closed failure codes; never the body or a response.
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
      claimed: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      cancelled: 0,
    };
    if (!result.armed) return result;

    const now = this.clock();
    const rows = await this.repo.claimDue(
      now,
      new Date(now.getTime() + OUTBOUND_LEASE_MS),
      OUTBOUND_BATCH_LIMIT,
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
    try {
      const payload = SelectionPayloadSchema.safeParse(row.payload);
      if (!payload.success || payload.data.worker_id !== row.workerId) {
        return await this.final(row, "dead", "contract", false);
      }
      const p = payload.data;
      const ctx = await this.repo.selectionContext(row.workerId, p.posting_kind, p.posting_id);
      // His link ended (consent withdrawn, unlinked) before the signal went: nothing leaves.
      if (ctx.studentRef === null)
        return await this.final(row, "cancelled", "link_inactive", false);
      if (ctx.jobTitle === null || ctx.companyNameEnc === null) {
        return await this.final(row, "dead", "context_missing", false);
      }
      let company: string;
      try {
        company = this.pii.decrypt(ctx.companyNameEnc);
      } catch {
        return await this.final(row, "dead", "context_missing", false);
      }
      const body: RvmSelectionEventBody = {
        event_id: row.id,
        student_ref: ctx.studentRef,
        company: capped(company, 200),
        job_title: capped(ctx.jobTitle, 200),
        status: p.stage,
        date: p.marked_on,
      };
      if (body.company === "" || body.job_title === "") {
        return await this.final(row, "dead", "context_missing", false);
      }

      const answer = await this.rvm.postSelectionEvent(body);
      if (answer.kind === "accepted") {
        await this.repo.markDelivered(row.id, at);
        return "delivered";
      }
      if (answer.kind === "not_available") return await this.final(row, "dead", "not_available");
      this.logger.warn(`outbound signal ${row.id} refused by RVM (status ${answer.status})`);
      return await this.final(row, "dead", "rejected");
    } catch (err) {
      const failure: OutboundSignalFailure =
        err instanceof RvmStudentApiUnavailableError ? err.failure : "contract";
      return this.retryOrDie(row, failure, at);
    }
  }

  private async retryOrDie(
    row: ClaimedSignal,
    failure: OutboundSignalFailure,
    at: Date,
  ): Promise<Outcome> {
    const attempt = row.attempts + 1;
    if (attempt >= OUTBOUND_MAX_ATTEMPTS) {
      this.logger.warn(`outbound signal ${row.id} dead after ${attempt} attempts (${failure})`);
      return this.final(row, "dead", failure);
    }
    await this.repo.markRetry(row.id, failure, new Date(at.getTime() + backoffMs(attempt)), at);
    return "retried";
  }

  private async final(
    row: ClaimedSignal,
    status: "dead" | "cancelled",
    failure: OutboundSignalFailure,
    countsAttempt = true,
  ): Promise<Outcome> {
    await this.repo.markFinal(row.id, status, failure, this.clock(), countsAttempt);
    return status;
  }
}
