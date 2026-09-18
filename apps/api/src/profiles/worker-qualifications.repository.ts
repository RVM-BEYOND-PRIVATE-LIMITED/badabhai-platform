import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { type Database, workerCertificates, workerEducations, workerTrainings } from "@badabhai/db";

import { DATABASE } from "../database/database.module";
import type {
  WorkerCertificateRecord,
  WorkerEducationRecord,
  WorkerTrainingRecord,
} from "../resume/resume-qualification-rows";

/**
 * READS AND WRITES `worker_certificate` and `worker_education` for the résumé's Zone 5
 * (migration 0098).
 *
 * ═══ ONE REPOSITORY FOR TWO TABLES, AND THE TRANSACTION IS THE REASON ═══
 *
 * They are two tables because they are two things — an education has a council and a field of
 * study, a certificate has neither and is not awarded by a board — but they are ONE submission:
 * a worker fills the qualifications page and sends both lists at once. Replacing them through
 * two repositories would be two transactions, and a failure between them leaves a worker whose
 * certificates are the new ones and whose education is the old. The boundary that matters here
 * is the submission, so the repository is drawn around the submission.
 *
 * ═══ NO ENCRYPTION, AND THAT IS 0098's RULING RESTATED ═══
 *
 * Unlike `WorkerEmploymentRepository`, which takes ciphertext and cannot encrypt, this one takes
 * and returns plaintext. `institute` and `issuer` follow the `education_institute` precedent,
 * which has shipped in clear on `worker_attributes` since R9 §3 — the same field, in the same
 * zone, on the same page. The uncomfortable case is named in the migration header: an issuer CAN
 * be an employer. That is the argument for encrypting these and it is the security gate's to
 * rule on; this file must not quietly answer it in either direction.
 *
 * ═══ NEITHER TABLE CROSSES THE AI BOUNDARY ═══
 *
 * Both render deterministically through `resume-qualification-rows.ts`. Nothing on this path
 * builds a prompt, and `pseudonymize.py` is untouched.
 */
@Injectable()
export class WorkerQualificationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * REPLACE this worker's credentials, in ONE transaction.
   *
   * DELETE-ALL-THEN-INSERT, NOT AN UPSERT, and the schema forces it exactly as it forces the
   * same shape on `worker_employment`: `wc_worker_sort_uq` and `wed_worker_sort_uq` are UNIQUE
   * on `(worker_id, sort_order)`, so re-submitting a list where the worker deleted the second of
   * three collides on every position after it. Positional upserts would need a two-phase shuffle
   * to stay legal; a replace is one statement per table and cannot leave either half-updated.
   *
   * THREE STATES PER LIST, NOT TWO, and the whole submit path turns on keeping them apart —
   * the same contract `SetMyPreferencesSchema` established:
   *
   *   `undefined`  the worker never reached that page. The stored rows SURVIVE.
   *   `[]`         "I have none" — a real answer, and it CLEARS the rows.
   *   `[...]`      the new list, in the worker's own order.
   *
   * A single `readonly T[]` parameter could not express the first case, which is why both are
   * optional rather than defaulted to empty. Defaulting would silently wipe a worker's
   * certificates the first time a client posted only their education.
   *
   * Returns the counts the event needs and whether anything was replaced — facts only the
   * transaction can know.
   */
  async replaceForWorker(
    workerId: string,
    input: {
      readonly certificates?: readonly {
        name: string;
        issuer: string | null;
        year: number | null;
        /** Layer A (d) — ALREADY-ENCRYPTED token, or null. This repository cannot encrypt. */
        licenceNumberEnc?: string | null;
        /** `YYYY-MM-DD`, or null. Plain: an expiry date is not an identifier. */
        licenceExpiry?: string | null;
      }[];
      readonly educations?: readonly {
        credential: string | null;
        field: string | null;
        council: string | null;
        year: number | null;
        institute: string | null;
      }[];
      /** Layer A (d) — the courses list. Three-state like the other two. */
      readonly trainings?: readonly {
        name: string;
        provider: string | null;
        year: number | null;
      }[];
    },
  ): Promise<{
    certificatesWritten: number;
    educationsWritten: number;
    trainingsWritten: number;
    replacedExisting: boolean;
  }> {
    const { certificates, educations, trainings } = input;
    // NOTHING SUBMITTED IS NOT AN EMPTY SUBMISSION. Opening a transaction to do nothing would
    // still report `replacedExisting: false` correctly, but it would also cost a round trip on
    // every partial save the client makes, and the honest answer here needs no database at all.
    if (certificates === undefined && educations === undefined && trainings === undefined) {
      return {
        certificatesWritten: 0,
        educationsWritten: 0,
        trainingsWritten: 0,
        replacedExisting: false,
      };
    }

    return this.db.transaction(async (tx) => {
      let replacedExisting = false;

      if (certificates !== undefined) {
        const existing = await tx
          .select({ id: workerCertificates.id })
          .from(workerCertificates)
          .where(eq(workerCertificates.workerId, workerId));
        replacedExisting ||= existing.length > 0;

        await tx.delete(workerCertificates).where(eq(workerCertificates.workerId, workerId));
        if (certificates.length > 0) {
          await tx.insert(workerCertificates).values(
            certificates.map((c, index) => ({
              workerId,
              name: c.name,
              issuer: c.issuer,
              year: c.year,
              // Layer A (d): the token arrives encrypted; the expiry is a plain date.
              licenceNumberEnc: c.licenceNumberEnc ?? null,
              licenceExpiry: c.licenceExpiry ?? null,
              // THE SUBMITTED ORDER IS THE DISPLAY ORDER, never derived from `year`. Two
              // certificates can share a year and an undated one still has the place the worker
              // gave it; sorting by year would reshuffle rows between renders and make every
              // regenerated PDF a false diff.
              sortOrder: index,
            })),
          );
        }
      }

      if (educations !== undefined) {
        const existing = await tx
          .select({ id: workerEducations.id })
          .from(workerEducations)
          .where(eq(workerEducations.workerId, workerId));
        replacedExisting ||= existing.length > 0;

        await tx.delete(workerEducations).where(eq(workerEducations.workerId, workerId));
        if (educations.length > 0) {
          await tx.insert(workerEducations).values(
            educations.map((e, index) => ({
              workerId,
              credential: e.credential,
              field: e.field,
              council: e.council,
              year: e.year,
              institute: e.institute,
              sortOrder: index,
            })),
          );
        }
      }

      if (trainings !== undefined) {
        const existing = await tx
          .select({ id: workerTrainings.id })
          .from(workerTrainings)
          .where(eq(workerTrainings.workerId, workerId));
        replacedExisting ||= existing.length > 0;

        await tx.delete(workerTrainings).where(eq(workerTrainings.workerId, workerId));
        if (trainings.length > 0) {
          await tx.insert(workerTrainings).values(
            trainings.map((t, index) => ({
              workerId,
              name: t.name,
              provider: t.provider,
              year: t.year,
              sortOrder: index,
            })),
          );
        }
      }

      return {
        certificatesWritten: certificates?.length ?? 0,
        educationsWritten: educations?.length ?? 0,
        trainingsWritten: trainings?.length ?? 0,
        replacedExisting,
      };
    });
  }

  /**
   * APPEND one training captured by the CHAT (Layer A elicitation, qp_universal@4), and only when
   * the worker has no `worker_training` rows at all.
   *
   * WHY INSERT-ONLY-WHEN-EMPTY, and not an upsert: the qualifications page is the richer capture
   * surface (up to eight rows, worker-ordered) and the chat asks exactly one. If the page has
   * written, its rows are the worker's considered list and a chat sentence must never edit it.
   * If nothing has been written, the chat's answer is the only credential the worker gave, and
   * landing it in the same table is what makes the resume and the page read ONE store.
   *
   * IDEMPOTENT BY CONSTRUCTION for the job-retry path: the guard is "no rows", so a redelivery
   * after a successful insert skips and a redelivery after a failed insert retries cleanly.
   */
  async appendTrainingIfEmpty(
    workerId: string,
    entry: { readonly name: string; readonly provider: string | null; readonly year: number | null },
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: workerTrainings.id })
        .from(workerTrainings)
        .where(eq(workerTrainings.workerId, workerId))
        .limit(1);
      if (existing.length > 0) return false;
      await tx.insert(workerTrainings).values({
        workerId,
        name: entry.name,
        provider: entry.provider,
        year: entry.year,
        sortOrder: 0,
      });
      return true;
    });
  }

  /**
   * One worker's credentials in DISPLAY ORDER.
   *
   * ORDERED BY `sort_order`, NEVER BY YEAR — the schema's decision, restated here so a future
   * reader does not "fix" it. See the insert above for why.
   *
   * TWO STATEMENTS, NOT A JOIN. The two tables share a worker and nothing else; a join would
   * produce the cross product of a worker's educations and certificates and every consumer would
   * have to undo it.
   */
  async loadForResume(workerId: string): Promise<{
    certificates: WorkerCertificateRecord[];
    educations: WorkerEducationRecord[];
    trainings: WorkerTrainingRecord[];
  }> {
    const [certificates, educations, trainings] = await Promise.all([
      this.db
        .select({
          name: workerCertificates.name,
          issuer: workerCertificates.issuer,
          year: workerCertificates.year,
          // Layer A (d) — read for the worker-self GET's decrypt; the composition ignores them.
          licenceNumberEnc: workerCertificates.licenceNumberEnc,
          licenceExpiry: workerCertificates.licenceExpiry,
        })
        .from(workerCertificates)
        .where(eq(workerCertificates.workerId, workerId))
        .orderBy(asc(workerCertificates.sortOrder)),
      this.db
        .select({
          credential: workerEducations.credential,
          field: workerEducations.field,
          council: workerEducations.council,
          year: workerEducations.year,
          institute: workerEducations.institute,
        })
        .from(workerEducations)
        .where(eq(workerEducations.workerId, workerId))
        .orderBy(asc(workerEducations.sortOrder)),
      // Layer A (d) — the courses, in the worker's own order.
      this.db
        .select({
          name: workerTrainings.name,
          provider: workerTrainings.provider,
          year: workerTrainings.year,
        })
        .from(workerTrainings)
        .where(eq(workerTrainings.workerId, workerId))
        .orderBy(asc(workerTrainings.sortOrder)),
    ]);

    return { certificates, educations, trainings };
  }
}
