import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { chatMessages, type Database } from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/**
 * READS the worker's OWN turns from `chat_messages`, for the résumé's two transcript-backed
 * rules: §8.4's verbatim quote block and R8 §4's over-claim veto.
 *
 * WHY A READ OF RAW TRANSCRIPT IS THE RIGHT SHAPE HERE, and why it is narrow. Both rules ask a
 * question only the worker's literal words can answer — "did he actually say this?" and "did he
 * say he does NOT do this?" — and every derived artifact on the render path has already lost the
 * evidence: the extraction is the model's paraphrase, the answer map is a set of slugs, and the
 * attribute rows carry no provenance at all. So this returns the sentences and nothing else.
 *
 * INBOUND ONLY. `direction: "outbound"` is what BadaBhai said, and quoting the interviewer back
 * at the reader as the worker's own words would be the exact failure §8 forbids. The filter is
 * in the query rather than in the caller so there is no shape in which it is forgotten.
 *
 * NOT PII-SANITISED, AND THAT IS STATED RATHER THAN IMPLIED. These rows are raw worker text —
 * they can carry his employer, his city, occasionally his own name. Nothing here masks anything.
 * The two consumers are responsible for what they do with it: the veto never prints a word of it,
 * and `selectOwnWords` re-screens every phrase it lets through. This must NEVER be handed to an
 * LLM call, a log line, an event or an analytics payload.
 */
@Injectable()
export class WorkerTranscriptRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The worker's own message bodies, most recent first, capped.
   *
   * THE CAP IS A COST BOUND, NOT AN EDITORIAL ONE. A long interview can run to dozens of turns
   * and both consumers scan every one of them per render; 200 covers every session the engine
   * can produce (the ask ceiling is 28) with room for re-answers, and bounds the read for a
   * pathological session rather than trusting that one cannot exist.
   */
  async loadWorkerTurns(workerId: string, limit = 200): Promise<string[]> {
    const rows = await this.db
      .select({ bodyText: chatMessages.bodyText })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.workerId, workerId),
          eq(chatMessages.direction, "inbound"),
          isNotNull(chatMessages.bodyText),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);
    return rows
      .map((r) => (r.bodyText ?? "").trim())
      .filter((t) => t.length > 0)
      .reverse();
  }
}
