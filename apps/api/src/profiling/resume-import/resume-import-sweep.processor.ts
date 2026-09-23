import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { randomUUID } from "node:crypto";

import { SERVER_CONFIG } from "../../config/config.module";
import {
  RESUME_IMPORT_SWEEP_QUEUE,
  RESUME_IMPORT_SWEEP_SCHEDULER_ID,
} from "../../queue/queue.constants";
import { ResumeImportRepository } from "./resume-import.repository";
import { ResumeParseService } from "./resume-parse.service";

/**
 * Per-tick cap on stranded rows — a pathological backlog drains across ticks, never one
 * unbounded run (the next tick picks up where this one stopped, oldest-first).
 *
 * A REAL BACKLOG IS POSSIBLE ON FIRST DEPLOY, not hypothetical: this sweep is being added
 * AFTER the paths that strand rows, so every import stranded since RI-3 shipped is sitting in
 * `parsing` right now waiting for it. Each is a single guarded UPDATE plus one event insert, so
 * they are cheap — but there may be many, and they drain at this rate.
 *
 * THE SAME NUMBER AS `SWEEP_BATCH_LIMIT` in `chat-abandonment-sweep.processor.ts`, and
 * deliberately not tuned: two sweeps with different batch sizes is two things to reason about
 * at 3am, and nothing about this work is heavier than that one's.
 */
export const RESUME_IMPORT_SWEEP_BATCH_LIMIT = 100;

/**
 * Bounded backoff between registration attempts (ms) — 1 immediate attempt at boot + these 4
 * retries ~= 80s of cover. Sized for the realistic TRANSIENT cause (Redis not up yet / failing
 * over / a blip during a rolling deploy), NOT for an outage. Mirrors
 * `ChatAbandonmentSweepProcessor`'s and `AccountDeletionSweepProcessor`'s ladders deliberately,
 * for the reason above.
 */
const REGISTRATION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const;

/**
 * ADR-0041 §7's stale-import sweep — the one §7 called "owed before real traffic" and that was
 * never built (#1665).
 *
 * ── THE GAP THIS FILLS ─────────────────────────────────────────────────────────────────────
 *
 * Two paths leave a `worker_resume_import` row in `parsing` with no event behind it, and both
 * are CORRECT AND DELIBERATE rather than bugs to be fixed here:
 *
 *   1. `ResumeRouteService.route` does not catch `buildSuggestions` / `crypto.encrypt`
 *      failures. A payload that cannot be built or sealed is a privacy/correctness fault, not
 *      a degraded route, and CLAUDE.md §3 says stop. The transaction never opens; the row
 *      stays `parsing`.
 *   2. The #1654 deferral: `parse()` returns `settled: false` for `parse_output_invalid` and
 *      `parse_deadline_exceeded` so the identity summary can stage BEFORE the row goes
 *      terminal. A process that dies in that window leaves the same `parsing` row.
 *
 * In both, BullMQ redelivers, `parse()` finds the row past `uploaded`, returns
 * `already_settled` WITHOUT re-reading the document, and the job completes having settled
 * nothing. That is the right trade — the row waits for a sweep rather than a second charge —
 * and the sweep is the half that never arrived.
 *
 * WHY IT IS NOT COSMETIC. A stranded row never emits `profile.resume_parse_failed`, which is
 * the feature's quality metric, not an error log (ruling D9 makes failure ordinary). So RI-7's
 * "how often does our parser let a worker down" is undercounted by exactly these rows. It is
 * INVISIBLE FROM THE OUTSIDE: the client's 90s poll budget expires and the worker IS told
 * something and IS dropped into the chat, so nobody complains and the number quietly lies.
 *
 * ── THE RULING: AN ACTOR, NOT A NINTH REASON (owner, 2026-09-23) ───────────────────────────
 *
 * A swept row is written `failed` / `parse_deadline_exceeded`, exactly as §7 specified — the
 * same reason a job-settled deadline carries. It is told apart by the EVENT ACTOR:
 * `ResumeParseService.settleStale` emits with `{ actor_type: "system", actor_id: null }` where
 * the job path emits `{ actor_type: "worker", actor_id: workerId }`. `system` is already in
 * `ACTOR_TYPES` and the null-id shape is the convention `agency.service.ts` and
 * `agency-payout.service.ts` already use, so the funnel separates cause on a field that is
 * already on every envelope — at zero schema cost. No ninth reason, no vocabulary change, no
 * migration.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────
 *
 * It reads NO document, calls NO model, and re-bills NOTHING. It owns one transition and the
 * event that counts it, and it does not own either of those: `ResumeParseService.recordFailure`
 * stays the SINGLE writer of `failed`, reached here through `settleStale`. This class holds a
 * clock, a batch bound and a predicate, and no business logic (CLAUDE.md §4).
 *
 * ── ROWS STUCK AT `uploaded` ARE NOT SWEPT, AND THAT IS A DECISION ─────────────────────────
 *
 * A row can also strand at `uploaded`: the confirm route CATCHES an enqueue failure (Redis
 * down) and returns 201 anyway so the worker is not blocked, or Redis loses the job, or the
 * process dies before `markParsing`. They are stranded by the same argument and they are
 * deliberately left alone, for two reasons.
 *
 * FIRST, THE VOCABULARY WOULD LIE. `parse_deadline_exceeded` means a reply that never arrived
 * in time. An `uploaded` row has no reply outstanding — nothing was ever asked. Writing it
 * would put "our parser let this worker down" into the exact metric this sweep exists to
 * correct, for an import the parser never saw. That is precisely the conflation #1656 was
 * filed to undo one field over, where spend-capped no-ops were counted as successful parses:
 * merging "no call happened" into "a call failed" hides the one that needs an operator.
 *
 * SECOND, THE REMEDY IS DIFFERENT IN KIND. Nothing has been read and nothing has been billed
 * for an `uploaded` row, so the right response is a RE-ENQUEUE, not a terminal failure — the
 * document is still there and still parseable. That is a different decision (it spends money,
 * and it needs the owner), so it is not smuggled in behind a sweep whose remit is to count
 * failures that already happened. Filed rather than silently left: the sweep COUNTS stale
 * `uploaded` rows every tick and logs the number, so the backlog is visible to an operator
 * without a status being written for it.
 *
 * ── FAILURE POSTURE ────────────────────────────────────────────────────────────────────────
 *
 * The DB predicate is AUTHORITATIVE and the repeatable job is only a clock tick, so a lost or
 * duplicated Redis job is harmless: the next tick re-evaluates the same predicate. Per row the
 * settle is a CONDITIONAL update (`... AND status = 'parsing'`) inside one transaction with its
 * event, which is what makes a live delivery that settles mid-sweep win the race — the sweep
 * then writes nothing and emits nothing. A per-row failure logs the opaque id and CONTINUES;
 * one bad row never blocks the backlog. NEVER logs document text, a storage key, or anything
 * a worker could be identified by — counts and truncated opaque ids only.
 *
 * REGISTRATION is the one part not self-healed by the predicate: a lost *job* is caught by the
 * next tick, but a failed *scheduler registration* means there is no next tick, and imports
 * would silently stop being counted. It is therefore retried with a bounded backoff and goes
 * LOUD on exhaustion.
 */
@Processor(RESUME_IMPORT_SWEEP_QUEUE)
export class ResumeImportSweepProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ResumeImportSweepProcessor.name);

  /** Resolves once registration has SUCCEEDED or exhausted its bounded retries. Never
   * rejects (a dead sweep is reported, not thrown). Awaited by tests; also the seam that
   * keeps the background retry chain referenced. */
  private registration: Promise<void> = Promise.resolve();

  /** Set by onModuleDestroy so an in-flight backoff aborts instead of firing against a
   * closing queue during shutdown. */
  private stopped = false;
  private cancelDelay?: () => void;

  constructor(
    private readonly imports: ResumeImportRepository,
    private readonly parse: ResumeParseService,
    @InjectQueue(RESUME_IMPORT_SWEEP_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  /**
   * Register the repeatable sweep at boot. `upsertJobScheduler` is idempotent by scheduler
   * id: every boot re-asserts the SAME scheduler (updating the cadence if config changed)
   * instead of stacking duplicates.
   *
   * The FIRST attempt is awaited (one round trip); retries run in the BACKGROUND and are
   * deliberately NOT awaited, because `onApplicationBootstrap` gates `app.listen()` —
   * blocking here through a Redis outage would keep the whole API from serving. A
   * registration failure NEVER throws out of boot.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (await this.tryRegister(1)) return;
    this.registration = this.retryRegistration();
  }

  /** Abort a pending backoff at shutdown (no retries against a closing queue). */
  onModuleDestroy(): void {
    this.stopped = true;
    this.cancelDelay?.();
  }

  /**
   * Test/ops seam: resolves once registration has settled (succeeded or exhausted its
   * retries). Never rejects — see `registration`.
   */
  async whenRegistrationSettled(): Promise<void> {
    await this.registration;
  }

  /** One registration attempt. Returns true on success; logs + returns false on failure. */
  private async tryRegister(attempt: number): Promise<boolean> {
    const every = this.config.RESUME_IMPORT_SWEEP_INTERVAL_MINUTES * 60_000;
    try {
      await this.queue.upsertJobScheduler(RESUME_IMPORT_SWEEP_SCHEDULER_ID, { every });
      if (attempt > 1) this.logger.log(`sweep scheduler registered on attempt ${attempt}`);
      return true;
    } catch (err) {
      this.logger.warn(
        `sweep scheduler registration attempt ${attempt}/${
          REGISTRATION_RETRY_DELAYS_MS.length + 1
        } failed (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      return false;
    }
  }

  /**
   * Bounded-backoff retry of the boot registration. On exhaustion it goes LOUD and stops:
   * from then on the sweep is dead in this process, and stranded imports accumulate while
   * RI-7's failure rate quietly under-reports — which is silent metric corruption rather than
   * a visible outage, hence the error log.
   */
  private async retryRegistration(): Promise<void> {
    for (const [i, delayMs] of REGISTRATION_RETRY_DELAYS_MS.entries()) {
      // Checked before AND after the sleep: before, so a destroy during the previous attempt
      // never arms another timer; after, so a destroy during the sleep stops here.
      if (this.stopped) return;
      await this.delay(delayMs);
      if (this.stopped) return;
      if (await this.tryRegister(i + 2)) return;
    }
    this.logger.error(
      `sweep scheduler registration FAILED after ${
        REGISTRATION_RETRY_DELAYS_MS.length + 1
      } attempts — the résumé stale-import sweep is NOT running in this process. Imports ` +
        `stranded in 'parsing' will stay there and profile.resume_parse_failed will ` +
        `under-count them.`,
    );
  }

  /** Backoff sleep that aborts cleanly on shutdown. */
  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.cancelDelay = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** One sweep tick: settle every import stranded past the threshold (bounded batch). */
  async process(): Promise<{ stale: number; settled: number; staleUploaded: number }> {
    const staleBefore = new Date(
      Date.now() - this.config.RESUME_IMPORT_STALE_AFTER_SECONDS * 1_000,
    );
    const stale = await this.imports.findStaleParsing(staleBefore, RESUME_IMPORT_SWEEP_BATCH_LIMIT);

    let settled = 0;

    // SEQUENTIAL on purpose: each settle is its own transaction, and one at a time keeps the
    // sweep gentle on the connection pool and the logs attributable.
    for (const row of stale) {
      const idPrefix = row.id.slice(0, 8);
      try {
        // A fresh correlation id per row, so one stranded import is traceable through the
        // spine without tying together every row this tick happened to touch.
        const correlationId = randomUUID();
        // `false` MEANS THE RACE WAS LOST, NOT THAT SOMETHING BROKE: a live delivery settled
        // the row between the read above and the guarded UPDATE inside. Nothing was written
        // and nothing was emitted, which is the correct outcome, so it is simply not counted.
        if (await this.parse.settleStale(row, { requestId: correlationId, correlationId })) {
          settled += 1;
        }
      } catch (err) {
        // Opaque id prefix and the reason class only — this row points at a worker's résumé
        // and none of it may reach a log line (CLAUDE.md §3).
        this.logger.warn(
          `stale-import sweep failed for import=${idPrefix}; continuing with the rest of the ` +
            `batch (reason: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    // OBSERVABILITY ONLY — see the class docblock for why these are counted and not settled.
    // Bounded by the same limit, so this is "at least n" rather than a count over the table.
    const staleUploaded = await this.imports.countStaleUploaded(
      staleBefore,
      RESUME_IMPORT_SWEEP_BATCH_LIMIT,
    );

    if (stale.length > 0 || staleUploaded > 0) {
      this.logger.log(
        `stale-import sweep tick: stale_parsing=${stale.length} settled=${settled} ` +
          `stale_uploaded=${staleUploaded} (uploaded rows are counted, never settled)`,
      );
    }
    // A FULL BATCH MEANS THERE IS MORE. Said out loud rather than left to inference, because a
    // silently truncated sweep reads as "everything is swept" while a backlog grows behind it.
    if (stale.length === RESUME_IMPORT_SWEEP_BATCH_LIMIT) {
      this.logger.log(
        `stale-import sweep hit the ${RESUME_IMPORT_SWEEP_BATCH_LIMIT}-row batch limit; a ` +
          `backlog remains and drains oldest-first on subsequent ticks`,
      );
    }

    return { stale: stale.length, settled, staleUploaded };
  }
}
