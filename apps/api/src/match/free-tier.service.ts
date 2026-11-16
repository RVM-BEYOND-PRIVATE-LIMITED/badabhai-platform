import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  type Database,
  freeTierIdempotencyKey,
  grantCreditsWithinTx,
  lotAlignmentWarning,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { MatchConfigService } from "./match-config.service";

/**
 * ADR-0036 §8 — the free tier. A new payer starts with
 * `match_config.free_unlock_credits` (50) unlock credits.
 *
 * EXACTLY-ONCE UNDER RETRY. The grant carries `idempotency_key = 'free_tier_grant:<payerId>'`
 * ({@link freeTierIdempotencyKey}, the SAME function the `db:grant:free-tier` D6 backfill uses)
 * and goes through `grantCreditsWithinTx` (packages/db credit-wallet.ts, #2749): under the wallet
 * row lock it checks the key, and a key already on the ledger writes nothing at all — no lot, no
 * line, no balance move. `credit_ledger_idempotency_key_uq` stays the backstop. So a retried
 * signup, a redelivered request, and a concurrent duplicate (or the backfill running at the same
 * time) all converge on exactly one grant and exactly one balance change.
 *
 * #2749 — the grant is a `legacy` lot that never expires (the switch-over decides what becomes of
 * signup credits), ONE `grant` line naming it, and the balance, in ONE transaction.
 *
 * PII-free & faceless: an opaque payer id and an integer.
 */
@Injectable()
export class FreeTierService {
  private readonly logger = new Logger(FreeTierService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: MatchConfigService,
  ) {}

  /**
   * Grant the free tier to a payer. Returns the number of credits ACTUALLY granted by
   * this call — 0 when the grant already existed, which is the honest answer and is what
   * lets a caller decide whether to emit anything.
   */
  async grantForPayer(payerId: string): Promise<number> {
    const cfg = await this.config.get();
    const credits = cfg.freeUnlockCredits;
    if (credits <= 0) return 0;

    const grant = await this.db.transaction((tx) =>
      grantCreditsWithinTx(tx, {
        payerId,
        credits,
        lot: { source: "legacy", expiresAt: null },
        ledger: { reason: "grant", idempotencyKey: freeTierIdempotencyKey(payerId) },
      }),
    );
    // ERROR, not warn: after the 0168 apply-to-deploy window a realignment means some writer
    // moved a balance without the wallet helpers (the self-heal stays; see credit-wallet.ts).
    const realigned = lotAlignmentWarning(payerId, grant.alignment);
    if (realigned !== null) this.logger.error(realigned);
    // ALREADY GRANTED — the key was on the ledger, so nothing was written.
    return grant.applied ? credits : 0;
  }

  /**
   * Grant without ever failing the caller. Signup uses this: a payer whose account was
   * created must not see a 500 because a credit grant hiccuped. The grant is idempotent
   * and `db:grant:free-tier` re-runs safely, so a miss here is repairable — losing the
   * signup is not.
   */
  async grantQuietly(payerId: string): Promise<void> {
    try {
      const granted = await this.grantForPayer(payerId);
      if (granted > 0) this.logger.log(`free tier granted payer=${payerId} credits=${granted}`);
    } catch (err) {
      const cls = err instanceof Error ? err.name : "UnknownError";
      const msg = err instanceof Error ? err.message : "unknown";
      this.logger.error(
        `free-tier grant FAILED for payer=${payerId} (${cls}: ${msg}); signup stands — ` +
          `re-run pnpm db:grant:free-tier --apply to repair`,
      );
    }
  }
}
