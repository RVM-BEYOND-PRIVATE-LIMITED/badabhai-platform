import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { creditLots, jobPostingChoices, type Database } from "@badabhai/db";
import type { PostingChoice, PostingSurface } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";

/** One posting's recorded tap, as the service writes it. */
export interface PostingChoiceInsert {
  readonly jobPostingId: string;
  readonly tenant: TenantKey;
  readonly choice: PostingChoice;
  readonly surface: PostingSurface;
}

/**
 * #2751 items 1 to 3 — the posting choice's reads and its one write. `job_posting_choices` is named
 * ONLY here, and only after the service checked the `posting_choice` switch for the company, so the
 * table is never touched while the switch is off (migration 0187 is applied before it is armed).
 */
@Injectable()
export class PostingChoiceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Record the posting's choice ONCE (the posting id is the primary key) and run `afterInsert` (the
   * event) in the SAME transaction only when this call inserted the row. `true` when it did; `false`
   * when the posting already had a choice (a retried or repeated publish), which changes nothing.
   */
  async recordOnce(
    input: PostingChoiceInsert,
    afterInsert: (tx: Database) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(jobPostingChoices)
        .values({
          jobPostingId: input.jobPostingId,
          payerId: input.tenant,
          choice: input.choice,
          surface: input.surface,
        })
        .onConflictDoNothing({ target: jobPostingChoices.jobPostingId })
        .returning({ id: jobPostingChoices.jobPostingId });
      if (inserted.length === 0) return false;
      await afterInsert(tx as unknown as Database);
      return true;
    });
  }

  /**
   * Has the company (its tenant key, the wallet) ever been given its welcome credits (#2750 item
   * 4)? The welcome grant writes exactly one `welcome` lot per company, ever, and a lot is never
   * deleted (an expired one keeps its row), so its presence is the answer.
   */
  async hasWelcomeLot(tenant: TenantKey): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(creditLots)
      .where(and(eq(creditLots.payerId, tenant), eq(creditLots.source, "welcome")))
      .limit(1);
    return rows.length > 0;
  }
}
