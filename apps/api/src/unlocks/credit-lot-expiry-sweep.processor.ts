import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { sqlStateOf } from "../common/db-error";
import { SERVER_CONFIG } from "../config/config.module";
import {
  CREDIT_LOT_EXPIRY_QUEUE,
  CREDIT_LOT_EXPIRY_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { UnlocksRepository } from "./unlocks.repository";

/** What one tick did — counts only, no ids (BullMQ job-inspection surface). */
export interface CreditLotExpirySweepResult {
  /** Wallets with a due lot that this tick read (at most CREDIT_LOT_EXPIRY_BATCH_LIMIT). */
  walletsDue: number;
  /** Wallets whose due lots this tick expired. */
  walletsExpired: number;
  lotsExpired: number;
  creditsExpired: number;
  /** Wallets whose transaction failed (logged one by one; retried on the next tick). */
  walletsFailed: number;
}

/**
 * #2749 item 4 — THE CREDIT-LOT EXPIRY SWEEP. Every open lot past its `expires_at` is closed with
 * ONE `expired` ledger line (once per lot, ever: the line's key is the lot), its remaining credits
 * leave the balance, and `balance = Σ open lots = Σ ledger` holds after. The spend path expires a
 * due lot too, before it spends; this sweep is what makes the expiry happen on time for a company
 * that is not spending.
 *
 * ARCHITECTURE mirrors the reach-widen expiry sweep: a repeatable BullMQ job is only a clock tick —
 * the predicate over `credit_lots` (open + past `expires_at`) is authoritative, so a lost or
 * duplicated job is harmless. Registration failures log one loud warn and never fail boot.
 *
 * ONE TRANSACTION PER WALLET, in the spend path's lock order (wallet row → lots → ledger), so the
 * sweep racing an unlock on the same wallet waits on the row lock and never deadlocks, and one
 * wallet's failure (logged with its id and SQLSTATE) neither rolls back nor stops the others.
 * The work list is bounded (CREDIT_LOT_EXPIRY_BATCH_LIMIT wallets, longest-overdue first); a
 * backlog drains across ticks.
 *
 * ARMED, WITH NO DRY RUN AND NO FLAG, deliberately: nothing in #2749 PR 1 writes an `expires_at`
 * (packs gain their validity with the catalogue in PR 2, legacy lots their date at the
 * switch-over), so until the data carries a date every tick finds nothing. The restriction lives
 * in the data, not in a switch someone must remember to flip.
 *
 * EVENTS: none in PR 1 — the `expired` ledger line is the record. Not on `/health`.
 */
@Processor(CREDIT_LOT_EXPIRY_QUEUE)
export class CreditLotExpirySweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CreditLotExpirySweepProcessor.name);

  constructor(
    private readonly repo: UnlocksRepository,
    @InjectQueue(CREDIT_LOT_EXPIRY_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  /**
   * Register the repeatable sweep at boot. `upsertJobScheduler` is idempotent by scheduler id:
   * every boot re-asserts the SAME scheduler instead of stacking duplicates.
   */
  async onApplicationBootstrap(): Promise<void> {
    const every = this.config.CREDIT_LOT_EXPIRY_SWEEP_INTERVAL_MINUTES * 60_000;
    try {
      await this.queue.upsertJobScheduler(CREDIT_LOT_EXPIRY_SWEEP_SCHEDULER_ID, { every });
    } catch (err) {
      this.logger.warn(
        `credit-lot expiry sweep scheduler registration failed — lot expiry is not ` +
          `(re-)registered by this process; a previously-registered scheduler keeps ticking, ` +
          `the spend path still expires a due lot before it spends, and the next boot ` +
          `re-asserts it (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /** One tick: read the bounded work list, then expire each wallet in its own transaction. */
  async process(): Promise<CreditLotExpirySweepResult> {
    const wallets = await this.repo.findWalletsWithDueLots(
      this.config.CREDIT_LOT_EXPIRY_BATCH_LIMIT,
    );
    const result: CreditLotExpirySweepResult = {
      walletsDue: wallets.length,
      walletsExpired: 0,
      lotsExpired: 0,
      creditsExpired: 0,
      walletsFailed: 0,
    };
    for (const wallet of wallets) {
      try {
        const done = await this.repo.expireDueLotsForWallet(wallet);
        if (done.lotsExpired > 0) {
          result.walletsExpired += 1;
          result.lotsExpired += done.lotsExpired;
          result.creditsExpired += done.creditsExpired;
        }
      } catch (err) {
        result.walletsFailed += 1;
        // Ids and the SQLSTATE only: a driver message carries the bound parameters.
        this.logger.error(
          `credit-lot expiry failed for wallet=${wallet} sqlstate=${sqlStateOf(err) ?? "none"} ` +
            `(${err instanceof Error ? err.name : "UnknownError"}); retried on the next tick`,
        );
      }
    }
    if (result.walletsDue > 0) {
      this.logger.log(
        `credit-lot expiry sweep: wallets_due=${result.walletsDue} ` +
          `wallets_expired=${result.walletsExpired} lots_expired=${result.lotsExpired} ` +
          `credits_expired=${result.creditsExpired} wallets_failed=${result.walletsFailed}`,
      );
    }
    return result;
  }
}
