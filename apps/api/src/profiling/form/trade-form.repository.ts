import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
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
   * The worker's most recent answer to ONE question, from ANY pack (#1459).
   *
   * WHY THIS IS NOT `listAnswers`. That read is pack-scoped, and the two keys the tier
   * pre-settle bridges live in DIFFERENT packs: `experience_years` is `qp_universal`'s
   * (written under whichever pack the chat had pinned, which is why the filter is by question
   * key and not by pack), while the per-trade tier gate (`turning_experience`, …) belongs to
   * the occupation pack. A pack-scoped read cannot see across that line, which is exactly why
   * the duplicate ask survived.
   *
   * NEWEST FIRST, with `id` as the tiebreak: `wpa_worker_question_uq` is keyed
   * (worker, pack, question_key), so a cross-pack duplicate for one question is already
   * impossible in practice — the ordering is here so a future writer that changes that
   * cannot make this read ambiguous.
   */
  async findLatestAnswerByQuestionKey(
    workerId: string,
    questionKey: string,
  ): Promise<WorkerPackAnswer | undefined> {
    const rows = await this.db
      .select()
      .from(workerPackAnswers)
      .where(
        and(
          eq(workerPackAnswers.workerId, workerId),
          eq(workerPackAnswers.questionKey, questionKey),
        ),
      )
      .orderBy(desc(workerPackAnswers.answeredAt), desc(workerPackAnswers.id))
      .limit(1);
    return rows[0];
  }

  /**
   * Run `cb` inside one Drizzle transaction — the same shape `AdminActionsRepository` uses.
   *
   * The service needs it because ONE answer is two rows in two tables, not one row: this table
   * and `worker_attributes`. See {@link upsertAnswer}.
   */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /**
   * Write one answer.
   *
   * ═══ ONE ANSWER IS TWO ROWS, AND THEY MUST COMMIT TOGETHER ═══
   *
   * THIS COMMENT USED TO SAY THE OPPOSITE, and the reasoning was wrong rather than merely
   * outdated. It read: *"NOT IN A TRANSACTION… A form answer is a single row and its own unit of
   * work… a partially-filled form is the ordinary state of a form."* The first clause is false.
   * A form answer is a row HERE and a row in `worker_attributes` (`trade-form.service.ts`
   * projects every answer through `projectProfile` — all 18 items in `qp_cnc_turning` are
   * `target_kind: attribute`), and the two were separate autocommits.
   *
   * A PARTIALLY-FILLED FORM IS ORDINARY; A PARTIALLY-SAVED ANSWER IS NOT. When the second write
   * failed, this table kept the row the progress rail counts while `worker_attributes` — what the
   * printed sheet and the matcher actually read — did not. The worker is told the question is
   * answered, the capability zone stays empty, and RETRYING CANNOT CONVERGE: this upsert succeeds
   * again every time, so the pair never lands. Fail-closed says both or neither.
   *
   * `tx` lets the caller enrol this write in that transaction; passing nothing keeps the old
   * standalone behaviour for any caller that genuinely writes one row.
   */
  async upsertAnswer(row: NewWorkerPackAnswer, tx?: Database): Promise<void> {
    await (tx ?? this.db)
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
          answerOtherText: sql`excluded.answer_other_text`,
          // A RE-WRITTEN "OTHER" ANSWER CLEARS ITS OWN POLISH, unconditionally — the same rule
          // `WorkHistoryPolishService`'s docblock states for a stint's description: "an EDITED
          // stint is re-polished for free... a changed description arrives as a new row with a
          // null polish". This IS that new row, on conflict rather than on insert, so the clear
          // has to happen here or a corrected answer would keep printing its PREVIOUS rewrite.
          answerOtherTextPolished: sql`NULL`,
          answerOtherTextPolishedDeclined: sql`false`,
          status: sql`excluded.status`,
          source: sql`excluded.source`,
          answeredAt: sql`excluded.answered_at`,
        },
      });
  }

  /**
   * Store the LLM-reviewed rewrite of a worker's "other" answer (ADR-0039 work-history-polish
   * precedent, extended by the round-4 "typed custom answer, everywhere" ruling).
   *
   * SCOPED TO `answer_other_text IS NOT NULL`, like `saveAttributePolish` scopes to
   * `value_kind = 'text'` — the belt alongside the caller's own check, so a race with a
   * corrected answer can never attach a rewrite to the wrong row's value.
   */
  async savePolishedOtherAnswer(
    workerId: string,
    packId: string,
    questionKey: string,
    polished: string,
  ): Promise<boolean> {
    const updated = await this.db
      .update(workerPackAnswers)
      .set({ answerOtherTextPolished: polished })
      .where(
        and(
          eq(workerPackAnswers.workerId, workerId),
          eq(workerPackAnswers.packId, packId),
          eq(workerPackAnswers.questionKey, questionKey),
          sql`${workerPackAnswers.answerOtherText} IS NOT NULL`,
        ),
      )
      .returning({ id: workerPackAnswers.id });
    return updated.length > 0;
  }

  /**
   * The worker's own refusal of the rewrite (mirrors `worker-attributes.repository.ts`'s
   * text-polish decline). Kept apart from "not reviewed yet" so a later render does not
   * silently re-offer a rewrite he already turned down.
   */
  async declineOtherAnswerPolish(
    workerId: string,
    packId: string,
    questionKey: string,
  ): Promise<boolean> {
    const updated = await this.db
      .update(workerPackAnswers)
      .set({ answerOtherTextPolishedDeclined: true })
      .where(
        and(
          eq(workerPackAnswers.workerId, workerId),
          eq(workerPackAnswers.packId, packId),
          eq(workerPackAnswers.questionKey, questionKey),
          sql`${workerPackAnswers.answerOtherText} IS NOT NULL`,
        ),
      )
      .returning({ id: workerPackAnswers.id });
    return updated.length > 0;
  }
}
