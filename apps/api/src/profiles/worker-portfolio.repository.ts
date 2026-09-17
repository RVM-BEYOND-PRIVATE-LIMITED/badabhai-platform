import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { type Database, workerPortfolio } from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/** One stored portfolio row, as the service reads it. */
export interface PortfolioRow {
  readonly kind: string;
  readonly storageKey: string | null;
  readonly url: string | null;
  readonly caption: string | null;
}

/**
 * READS AND WRITES `worker_portfolio` (migration 0113, ADR-0042 D9 / Layer A (e)).
 *
 * REPLACE-ALL-THEN-INSERT, like the qualifications repository and for the same schema reason:
 * `wp_worker_sort_uq` is UNIQUE on `(worker_id, sort_order)`, so a positional upsert after a
 * deletion collides. The submitted order IS the display order.
 */
@Injectable()
export class WorkerPortfolioRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async replaceForWorker(
    workerId: string,
    items: readonly {
      kind: "photo" | "video" | "link";
      storageKey: string | null;
      url: string | null;
      caption: string | null;
    }[],
  ): Promise<{ itemsWritten: number; replacedExisting: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: workerPortfolio.id })
        .from(workerPortfolio)
        .where(eq(workerPortfolio.workerId, workerId));
      const replacedExisting = existing.length > 0;

      await tx.delete(workerPortfolio).where(eq(workerPortfolio.workerId, workerId));
      if (items.length > 0) {
        await tx.insert(workerPortfolio).values(
          items.map((item, index) => ({
            workerId,
            kind: item.kind,
            storageKey: item.storageKey,
            url: item.url,
            caption: item.caption,
            sortOrder: index,
          })),
        );
      }
      return { itemsWritten: items.length, replacedExisting };
    });
  }

  /** The worker's samples in their own order. */
  async loadForWorker(workerId: string): Promise<PortfolioRow[]> {
    return this.db
      .select({
        kind: workerPortfolio.kind,
        storageKey: workerPortfolio.storageKey,
        url: workerPortfolio.url,
        caption: workerPortfolio.caption,
      })
      .from(workerPortfolio)
      .where(eq(workerPortfolio.workerId, workerId))
      .orderBy(asc(workerPortfolio.sortOrder));
  }
}
