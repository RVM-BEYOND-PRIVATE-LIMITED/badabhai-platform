import { randomUUID } from "node:crypto";
import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { Database, WalletExpiryResult } from "@badabhai/db";
import { sqlStateOf } from "../common/db-error";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import {
  CREDIT_LOT_EXPIRY_QUEUE,
  CREDIT_LOT_EXPIRY_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { UnlocksRepository } from "./unlocks.repository";
import { creditsExpiredEvent } from "./credits-expired-event";

/** What one tick did — counts only, no ids (BullMQ job-inspection surface). */
export interface CreditLotExpirySweepResult {
  /** Wallets with a due lot that this tick read (at most CREDIT_LOT_EXPIRY_BATCH_LIMIT). */
  walletsDue: number;
  /** Wallets whose due lots this tick expired. */
  walletsExpired: number;
  lotsExpired: number;
  creditsExpired: number;
  /**
   * Wallets whose transaction failed — the expiry or its event (they share it) — logged one by
   * one, rolled back, retried on the next tick.
   */
  walletsFailed: number;
  /** Wallet keys holding a due lot but no `payer_credits` row: never in the work list, logged. */
  orphanWallets: number;
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
 * backlog drains across ticks. It holds only wallets that HAVE a `payer_credits` row: a due lot
 * whose wallet row is gone can never be expired, so it would otherwise take a slot on every tick;
 * those are counted and logged once per tick instead.
 *
 * ARMED, WITH NO DRY RUN AND NO FLAG, deliberately: only a `pack` lot whose pack sets
 * `validityDays` carries an `expires_at` (#2749 PR 3, stamped at the grant; legacy lots get their
 * date at the switch-over), and production's default packs set none, so until the data carries a
 * date every tick finds nothing. The restriction lives in the data, not in a switch someone must
 * remember to flip.
 *
 * EVENTS: one `payer.credits_expired` (trigger `sweep`, actor `system`) per lot, written INSIDE
 * that wallet's transaction (`EventsService.emit({ tx })`), so the expiry and its event commit
 * together: a committed expiry can never lose its event, and an event that cannot be written
 * (validation, the events table) rolls that wallet's expiry back — counted in `walletsFailed`
 * and retried on the next tick. Not on `/health`.
 */
@Processor(CREDIT_LOT_EXPIRY_QUEUE)
export class CreditLotExpirySweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(CreditLotExpirySweepProcessor.name);

  constructor(
    private readonly repo: UnlocksRepository,
    @InjectQueue(CREDIT_LOT_EXPIRY_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly events: EventsService,
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
    const orphanWallets = await this.repo.countOrphanWalletsWithDueLots();
    if (orphanWallets > 0) {
      // Once per tick, a count only: these lots name a wallet with no `payer_credits` row, so
      // nothing can lock or expire them. Skipped, not retried into the batch.
      this.logger.warn(
        `credit-lot expiry sweep: skipped ${orphanWallets} wallet key(s) holding due lots ` +
          `but no payer_credits row`,
      );
    }
    const result: CreditLotExpirySweepResult = {
      walletsDue: wallets.length,
      walletsExpired: 0,
      lotsExpired: 0,
      creditsExpired: 0,
      walletsFailed: 0,
      orphanWallets,
    };
    for (const wallet of wallets) {
      let done: WalletExpiryResult;
      try {
        const correlationId = randomUUID();
        // The events ride the wallet's OWN transaction: they commit with the expiry or not at all.
        done = await this.repo.expireDueLotsForWallet(wallet, async (tx, expired) => {
          for (const lot of expired.expiredLots) {
            await this.events.emit({
              ...creditsExpiredEvent({
                walletKey: wallet,
                lot,
                trigger: "sweep",
                actor: { actor_type: "system", actor_id: null },
                correlationId,
                requestId: CREDIT_LOT_EXPIRY_SWEEP_SCHEDULER_ID,
              }),
              tx: tx as unknown as Database,
            });
          }
        });
      } catch (err) {
        result.walletsFailed += 1;
        // Ids and the SQLSTATE only: a driver message carries the bound parameters.
        this.logger.error(
          `credit-lot expiry failed for wallet=${wallet} sqlstate=${sqlStateOf(err) ?? "none"} ` +
            `(${err instanceof Error ? err.name : "UnknownError"}); rolled back (expiry and ` +
            `events), retried on the next tick`,
        );
        continue;
      }
      if (done.lotsExpired > 0) {
        result.walletsExpired += 1;
        result.lotsExpired += done.lotsExpired;
        result.creditsExpired += done.creditsExpired;
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
