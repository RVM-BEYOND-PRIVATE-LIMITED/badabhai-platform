import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { MatchConfigService } from "./match-config.service";

/**
 * ADR-0036 §8 — the free tier. A new payer starts with
 * `match_config.free_unlock_credits` (50) unlock credits.
 *
 * EXACTLY-ONCE UNDER RETRY, ENFORCED BY THE DATABASE. The ledger insert carries
 * `idempotency_key = 'free_tier_grant:<payerId>'`, and `credit_ledger_idempotency_key_uq`
 * makes a second attempt insert NO row. The balance is bumped ONLY when the ledger
 * insert actually inserted — read from `RETURNING`, never assumed — and both writes share
 * ONE transaction. So a retried signup, a redelivered request, and a concurrent duplicate
 * all converge on exactly one grant and exactly one balance change.
 *
 * That is the same mechanism (and the same key) the `db:grant:free-tier` D6 backfill uses
 * for EXISTING payers, deliberately: the two paths can run in either order, or at the same
 * time, and the payer still ends up with exactly 50.
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

    return this.db.transaction(async (tx) => {
      // THE LEDGER FIRST. It is the source of truth and it carries the idempotency key,
      // so it is the statement that decides whether this grant happens at all. Bumping
      // the balance first and then discovering the ledger row already existed would
      // double a payer's credits on every retry.
      const inserted = await tx.execute<{ id: string }>(dsql`
        INSERT INTO credit_ledger (payer_id, delta, reason, idempotency_key)
        VALUES (${payerId}::uuid, ${credits}, 'grant', ${`free_tier_grant:${payerId}`})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `);
      const rows = inserted as unknown as { id: string }[];
      // ALREADY GRANTED — read from RETURNING, not assumed. Nothing else runs.
      if (rows.length === 0) return 0;

      await tx.execute(dsql`
        INSERT INTO payer_credits (payer_id, balance)
        VALUES (${payerId}::uuid, ${credits})
        ON CONFLICT (payer_id) DO UPDATE
          SET balance = payer_credits.balance + ${credits}, updated_at = now()
      `);
      return credits;
    });
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
