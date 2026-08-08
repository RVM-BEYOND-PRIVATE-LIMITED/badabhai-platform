import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { profilingVoiceAnswers, type Database } from "@badabhai/db";
import type { VoiceTranscriptStatus } from "@badabhai/types";

import { DATABASE } from "../database/database.module";

/**
 * `profiling_voice_answer` — the record that a worker SPOKE this answer.
 *
 * IT IS THE EVIDENCE, NOT THE VALUE. The settled answer lives in `worker_pack_answer`, written by
 * the flush; this says which clip produced it, how long it was, whether the transcript arrived,
 * and which attempt it was. Duplicating the value here would create a second answer of record
 * free to disagree with the first.
 *
 * WHY IT IS BEING WRITTEN NOW AND NOT WHEN IT SHIPPED. The table landed with migration 0071 and
 * has had no writer since — the exact pattern this whole workstream exists to stop repeating. It
 * gets one with its first real producer rather than a month before.
 *
 * A FAILED WRITE MUST NOT COST THE WORKER THEIR ANSWER. This row is an audit fact; the answer
 * itself is already durable in the transcript buffer and reaches Postgres through the flush. So
 * the caller logs and continues rather than failing the turn — a worker in a noisy yard must not
 * lose a spoken answer because an evidence INSERT hit a connection blip.
 */
@Injectable()
export class ProfilingVoiceRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Record one recorded clip, superseding any live answer for the same question.
   *
   * SUPERSESSION, NOT DELETION. "Phir se bolein" is an ordinary thing for a worker to do, and the
   * partial unique index `(session_id, question_key) WHERE superseded_at IS NULL` enforces at most
   * one LIVE answer per question. Marking the previous one superseded rather than removing it is
   * what keeps the audit able to answer "how many times did we ask this before it landed?".
   *
   * Two statements, not one, and deliberately NOT in a transaction: the supersede is idempotent
   * (it only ever touches rows that are still live) and the insert is guarded by the index. A
   * failure between them leaves the previous row superseded with no successor, which reads as
   * "they re-recorded and the clip never arrived" — true, and better than a partial transaction
   * on a path whose whole job is to be fast enough for someone to wait on.
   */
  async recordAnswer(row: {
    workerId: string;
    sessionId: string;
    voiceNoteId: string;
    packId: string;
    packVersion: number;
    questionKey: string;
    ordinal: number;
    durationSeconds: number | null;
    transcriptStatus: Extract<VoiceTranscriptStatus, "succeeded" | "failed">;
    transcriptErrorCode: string | null;
  }): Promise<void> {
    await this.db
      .update(profilingVoiceAnswers)
      .set({ superseded: sql`now()` })
      .where(
        and(
          eq(profilingVoiceAnswers.sessionId, row.sessionId),
          eq(profilingVoiceAnswers.questionKey, row.questionKey),
          isNull(profilingVoiceAnswers.superseded),
        ),
      );

    // `attempt_no` counts from the rows already recorded for this question, superseded ones
    // included — it is "how many times did the worker speak this answer", which is exactly what a
    // re-record increments and what `pva_session_question_attempt_uq` requires to be unique.
    const counted = await this.db
      .select({ attempts: sql<number>`count(*)::int` })
      .from(profilingVoiceAnswers)
      .where(
        and(
          eq(profilingVoiceAnswers.sessionId, row.sessionId),
          eq(profilingVoiceAnswers.questionKey, row.questionKey),
        ),
      );

    await this.db.insert(profilingVoiceAnswers).values({
      workerId: row.workerId,
      sessionId: row.sessionId,
      voiceNoteId: row.voiceNoteId,
      packId: row.packId,
      packVersion: row.packVersion,
      questionKey: row.questionKey,
      attemptNo: (counted[0]?.attempts ?? 0) + 1,
      ordinal: row.ordinal,
      // The clip exists and was accepted; `uploaded` is the signed-PUT half, which happened
      // before this route was ever called.
      captureStatus: "recorded",
      transcriptStatus: row.transcriptStatus,
      transcriptErrorCode: row.transcriptErrorCode,
      durationSeconds: row.durationSeconds,
    });
  }
}
