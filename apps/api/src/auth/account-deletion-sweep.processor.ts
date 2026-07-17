import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  Inject,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import {
  ACCOUNT_DELETION_QUEUE,
  ACCOUNT_DELETION_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import { AccountDeletionService } from "./account-deletion.service";

/** Per-run cap on due rows — a pathological backlog drains across ticks, never one
 * unbounded run (the next tick picks up where this one stopped). */
const SWEEP_BATCH_LIMIT = 100;

/**
 * Bounded backoff between registration attempts (ms) — 1 immediate attempt at boot + these
 * 4 retries ≈ 80s of cover. Sized for the realistic TRANSIENT cause (Redis not up yet /
 * failing over / a blip during a rolling deploy), NOT for an outage: an outage that outlives
 * the ladder leaves the marker intact in the DB and is reported `down` by /health, which is
 * the loud path. Unbounded retries would only hide the permanent causes (bad ACL/permissions,
 * a bullmq API mismatch) that fail identically on every boot — exactly Blocker 2.
 */
const REGISTRATION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const;

/**
 * Hourly sweep that erases workers whose deletion grace has elapsed (ADR-0031). The DB
 * marker (`workers.deletion_scheduled_at`) is AUTHORITATIVE — the repeatable BullMQ job
 * is only a clock tick, so a lost/duplicated Redis job is harmless: the next tick
 * re-reads the marker and catches anything missed (and a duplicate tick just finds
 * nothing due). Per worker the sweep atomically RE-CHECKS the row is still due
 * (claimDueDeletion — guards the cancel-vs-sweep race), then runs the UNCHANGED
 * ADR-0026 Phase 5 erasure (`execute()` is idempotent + best-effort-complete). A
 * per-worker failure logs the opaque id prefix and CONTINUES — one bad row never blocks
 * the rest of the backlog. NEVER logs a phone/name — opaque worker ids only.
 *
 * REGISTRATION is the one part that is NOT self-healing by the marker: a lost *job* is
 * caught by the next tick, but a failed *scheduler registration* means there is no next
 * tick at all, so overdue rows would pile up unerased (a silent DPDP-erasure stop). It is
 * therefore (1) RETRIED with a bounded backoff here, and (2) surfaced as
 * `checks.deletion_sweep` on `GET /health`, which probes the scheduler's real existence in
 * Redis rather than this process's memory. Both paths stay fail-safe: a dead sweep never
 * throws out of boot, never crashes the API, and never touches the DB marker.
 */
@Processor(ACCOUNT_DELETION_QUEUE)
export class AccountDeletionSweepProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AccountDeletionSweepProcessor.name);

  /** Resolves once registration has SUCCEEDED or exhausted its bounded retries. Never
   * rejects (a dead sweep is reported, not thrown). Awaited by tests; also the seam that
   * keeps the background retry chain referenced. */
  private registration: Promise<void> = Promise.resolve();

  /** Set by onModuleDestroy so an in-flight backoff aborts instead of firing against a
   * closing queue during shutdown. */
  private stopped = false;
  private cancelDelay?: () => void;

  constructor(
    private readonly workers: WorkersRepository,
    private readonly accountDeletion: AccountDeletionService,
    @InjectQueue(ACCOUNT_DELETION_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  /**
   * Register the repeatable sweep at boot. `upsertJobScheduler` (bullmq ≥5.16) is
   * idempotent by scheduler id: every boot re-asserts the SAME scheduler (updating the
   * cadence if config changed) instead of stacking duplicates.
   *
   * The FIRST attempt is awaited (one round trip — the boot cost is unchanged); retries run
   * in the BACKGROUND and are deliberately NOT awaited, because onApplicationBootstrap gates
   * `app.listen()` — blocking here through a Redis outage would keep the whole API (and
   * /health itself, the thing that reports the sweep) from serving. A registration failure
   * NEVER throws out of boot.
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
    const every = this.config.ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS * 3_600_000;
    try {
      await this.queue.upsertJobScheduler(ACCOUNT_DELETION_SWEEP_SCHEDULER_ID, { every });
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
   * Bounded-backoff retry of the boot registration. On exhaustion it goes LOUD (error log)
   * and stops: from then on the sweep is dead in this process and `GET /health` reports
   * `checks.deletion_sweep: "down"` until a boot (or another replica) re-registers it. The
   * DB marker is untouched throughout, so nothing is lost — erasure is DELAYED, and the
   * delay is now visible instead of silent.
   */
  private async retryRegistration(): Promise<void> {
    for (const [i, delayMs] of REGISTRATION_RETRY_DELAYS_MS.entries()) {
      // Checked before AND after the sleep: before, so a destroy during the previous
      // attempt never arms another timer; after, so a destroy during the sleep stops here.
      if (this.stopped) return;
      await this.delay(delayMs);
      if (this.stopped) return;
      if (await this.tryRegister(i + 2)) return;
    }
    this.logger.error(
      `sweep scheduler registration FAILED after ${
        REGISTRATION_RETRY_DELAYS_MS.length + 1
      } attempts — the ADR-0031 deletion sweep is NOT running in this process and overdue ` +
        `erasures will accumulate. GET /health reports checks.deletion_sweep=down until it ` +
        `is re-registered (see docs/observability-runbook.md §7).`,
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

  /** One sweep tick: erase every worker whose grace has elapsed (bounded batch). */
  async process(): Promise<{ due: number; erased: number }> {
    const now = new Date();
    const due = await this.workers.findDueDeletions(now, SWEEP_BATCH_LIMIT);
    let erased = 0;

    // SEQUENTIAL on purpose: execute() fans out to sessions/storage/DB per worker — one
    // at a time keeps the sweep gentle on shared infra and the logs attributable.
    for (const workerId of due) {
      const idPrefix = workerId.slice(0, 8);
      try {
        // Atomic re-check (cancel-vs-sweep race): a cancel that landed after the SELECT
        // above cleared the marker, so the claim matches nothing and the worker is NOT
        // erased. Only a still-pending, still-overdue row is claimed.
        const claimed = await this.workers.claimDueDeletion(workerId, now);
        if (!claimed) {
          this.logger.log(`sweep skip worker=${idPrefix} (cancelled or already erased)`);
          continue;
        }
        await this.accountDeletion.execute(workerId);
        erased += 1;
      } catch (err) {
        // Per-worker failure: log the opaque prefix + reason class and CONTINUE — the
        // marker survives, so the next tick retries this worker.
        this.logger.warn(
          `sweep erase failed worker=${idPrefix} (continuing; reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }

    if (due.length > 0) this.logger.log(`sweep complete due=${due.length} erased=${erased}`);
    return { due: due.length, erased };
  }
}
