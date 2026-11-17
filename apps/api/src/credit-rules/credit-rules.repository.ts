import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import {
  auditLogs,
  creditRulesConfig,
  type CreditRulesConfigRow,
  type Database,
} from "@badabhai/db";
import type { CreditRules } from "@badabhai/pricing";
import { DATABASE } from "../database/database.module";

/** One new revision, written by {@link CreditRulesRepository.publish}. */
export interface PublishCreditRulesInput {
  readonly rules: CreditRules;
  /** The revision the admin edited; the new row is this + 1. */
  readonly expectedRevision: number;
  readonly adminId: string;
  /** The audit row's contents, written in the same transaction as the revision. */
  readonly audit: {
    readonly action: string;
    readonly metadata: Record<string, unknown>;
  };
}

/**
 * Data access for `credit_rules_config` (#2750 item 1). The ONLY reader and writer of the table:
 * every other module asks {@link ../credit-rules/credit-rules.service.ts CreditRulesService}.
 *
 * Append-only: {@link publish} inserts the next revision and clears `is_active` on the old row in
 * ONE transaction, with the audit row. No row's `rules` is ever rewritten.
 */
@Injectable()
export class CreditRulesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The active revision, or undefined before the first edit. */
  async getActive(): Promise<CreditRulesConfigRow | undefined> {
    const rows = await this.db
      .select()
      .from(creditRulesConfig)
      .where(eq(creditRulesConfig.isActive, true))
      .limit(1);
    return rows[0];
  }

  /**
   * Write the next revision. Returns `stale` — and writes NOTHING — when the newest stored revision
   * is not `expectedRevision` (another admin edited first). Two edits racing on the same revision
   * both pass that read; `credit_rules_config_revision_uq` then refuses the second insert and its
   * transaction rolls back (the caller maps the unique violation to the same `stale` answer).
   *
   * `tx` is handed to `afterWrite` so the caller's event commits or rolls back with the revision.
   */
  async publish(
    input: PublishCreditRulesInput,
    afterWrite: (tx: Database, row: CreditRulesConfigRow) => Promise<void>,
  ): Promise<{ outcome: "published"; row: CreditRulesConfigRow } | { outcome: "stale" }> {
    return this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ revision: creditRulesConfig.revision })
        .from(creditRulesConfig)
        .orderBy(desc(creditRulesConfig.revision))
        .limit(1);
      if ((latest?.revision ?? 0) !== input.expectedRevision) return { outcome: "stale" as const };

      await tx
        .update(creditRulesConfig)
        .set({ isActive: false })
        .where(eq(creditRulesConfig.isActive, true));
      const [row] = await tx
        .insert(creditRulesConfig)
        .values({
          rules: input.rules,
          revision: input.expectedRevision + 1,
          isActive: true,
          updatedBy: input.adminId,
        })
        .returning();
      if (!row) throw new Error("credit_rules_config: the revision was not written");

      await tx.insert(auditLogs).values({
        actorType: "admin",
        actorId: input.adminId,
        action: input.audit.action,
        entityType: "credit_rules_config",
        entityId: row.id,
        metadata: input.audit.metadata,
      });
      await afterWrite(tx as unknown as Database, row);
      return { outcome: "published" as const, row };
    });
  }
}
