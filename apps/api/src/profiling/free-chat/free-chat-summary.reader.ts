import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Database } from "@badabhai/db";

import { selectLatestFreeChatSummary } from "../../chat/free-chat-summary.query";
import { logSafeReason } from "../../common/db-error";
import { DATABASE } from "../../database/database.module";
import { readFreeChatSummaryValue, summaryTextOf } from "./free-chat-summary";

/**
 * THE WORKER'S ROLLING FREE-CHAT SUMMARY, READ-ONLY (ADR-0055 R4, owner ruling 2026-10-15) — the
 * profiling chat's model-facing notes (ADR-0051 §8), lent to the Bada Bhai chat's casual and career
 * REPLY so it keeps the continuity the worker built while profiling.
 *
 * NARROW BY CONSTRUCTION. One method, one indexed SELECT (`selectLatestFreeChatSummary`, the same
 * query `ChatRepository.findLatestFreeChatSummary` runs), the @Global database handle and nothing
 * else: no `ChatRepository`, so no chat-table writer is reachable from a module that injects this.
 * The companion never WRITES or folds the summary; the profiling chat alone does.
 *
 * WHO READS IT: the reply only. The classifier never gets the summary (ADR-0051 R24), and neither
 * does live news. `FreeChatModelCalls.reply` redacts the worker's own name out of it again at the
 * egress (`summaryForModel`, G2).
 *
 * FAILS SOFT: no summary, a watermark-only record, an unparseable value and a read that throws all
 * read as null — the reply loses its continuity, never the reply. A failure is a warning with the
 * worker id and the error class only, never the summary.
 */
@Injectable()
export class FreeChatSummaryReader {
  private readonly logger = new Logger(FreeChatSummaryReader.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async latestText(workerId: string): Promise<string | null> {
    try {
      const latest = await selectLatestFreeChatSummary(this.db, workerId);
      return summaryTextOf(readFreeChatSummaryValue(latest?.summary));
    } catch (error) {
      this.logger.warn(
        `free-chat summary unreadable for worker ${workerId}; the reply goes without one: ` +
          `${logSafeReason(error, "free-chat summary read")}`,
      );
      return null;
    }
  }
}
