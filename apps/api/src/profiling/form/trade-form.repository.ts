import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  type Database,
  workerPackAnswers,
  type NewWorkerPackAnswer,
  type WorkerPackAnswer,
} from "@badabhai/db";

import { DATABASE } from "../../database/database.module";

/**
 * The trade form's own reads and writes against `worker_pack_answer`.
 *
 * WORKER-SCOPED, NOT SESSION-SCOPED, and that is the whole reason this exists beside
 * `ChatRepository.listPackAnswers`. An interview's answers belong to the session that produced
 * them; a FORM's belong to the worker, because the worker may close the app on section two and
 * come back on another day through another session. `wpa_worker_question_uq` is already keyed
 * `(worker_id, pack_id, question_key)` — worker-first — so this is the read that index was
 * designed for, and no new index is needed.
 *
 * ONE ROW PER QUESTION, UPSERTED. A worker who changes their mind about which materials they have
 * run is correcting an answer, not adding a second one; the unique index makes that structural
 * rather than a rule this service has to remember.
 */
@Injectable()
export class TradeFormRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Every answer this worker has given to this pack, in stable question order. */
  async listAnswers(workerId: string, packId: string): Promise<WorkerPackAnswer[]> {
    return this.db
      .select()
      .from(workerPackAnswers)
      .where(and(eq(workerPackAnswers.workerId, workerId), eq(workerPackAnswers.packId, packId)))
      .orderBy(workerPackAnswers.questionKey);
  }

  /**
   * Write one answer.
   *
   * NOT IN A TRANSACTION, unlike the interview's flush. A form answer is a single row and its own
   * unit of work: the worker taps "aage badhein" and that question is saved whatever happens to
   * the next one. The interview batches because a partial transcript is worse than none; a
   * partially-filled form is the ordinary state of a form.
   */
  async upsertAnswer(row: NewWorkerPackAnswer): Promise<void> {
    await this.db
      .insert(workerPackAnswers)
      .values(row)
      .onConflictDoUpdate({
        target: [
          workerPackAnswers.workerId,
          workerPackAnswers.packId,
          workerPackAnswers.questionKey,
        ],
        set: {
          chatSessionId: sql`excluded.chat_session_id`,
          packVersion: sql`excluded.pack_version`,
          answerText: sql`excluded.answer_text`,
          answerNumber: sql`excluded.answer_number`,
          answerBool: sql`excluded.answer_bool`,
          answerOptionKeys: sql`excluded.answer_option_keys`,
          status: sql`excluded.status`,
          source: sql`excluded.source`,
          answeredAt: sql`excluded.answered_at`,
        },
      });
  }
}
