import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql as dsql, type SQL } from "drizzle-orm";
import { type Database, payerApplicantStages } from "@badabhai/db";
import type { ApplicantPostingKind, ApplicantStage } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import { findOwnedJobRef } from "../payers/owned-job-ref";

/** One applicant on one posting — the table's primary key. */
export interface ApplicantStageKey {
  postingKind: ApplicantPostingKind;
  postingId: string;
  workerId: string;
}

/** One stored row of a posting's board, as the feed read returns it. */
export interface StoredApplicantStage {
  workerId: string;
  /** Raw text: the CHECK keeps it inside `APPLICANT_STAGES`; narrowing is the service's call. */
  stage: string;
}

/**
 * "Is this worker on that posting's applicant feed?" — the per-posting feed's OWN membership,
 * spelled for one (posting, worker) pair, so a stage can only be set on someone the payer can see
 * on the board:
 *  - `agency_job` → the per-job list's (`applicantSignalRowsStatement`): an `applied` decision on
 *    `applications.job_id`, not pending deletion, and a `worker_profiles` row (that list ranks
 *    FROM `worker_profiles`, so an applier without one is not on it);
 *  - `company_posting` → the posting list's (`MatchFeedRepository.listCandidates`): an `applied`
 *    decision on `applications.job_posting_id`, not pending deletion.
 * A skip, a worker inside the ADR-0031 (b) deletion grace window, or a worker who never applied
 * is not a member. Served by `applications_worker_job_uq` / `applications_worker_posting_uq`.
 */
export function feedMembershipStatement(key: ApplicantStageKey): SQL {
  const onPosting =
    key.postingKind === "agency_job"
      ? dsql`a.job_id = ${key.postingId}::uuid`
      : dsql`a.job_posting_id = ${key.postingId}::uuid`;
  const hasProfile =
    key.postingKind === "agency_job"
      ? dsql`AND EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.worker_id = a.worker_id)`
      : dsql``;
  return dsql`
    SELECT 1 AS member
    FROM applications a
    INNER JOIN workers w ON w.id = a.worker_id
    WHERE ${onPosting}
      AND a.worker_id = ${key.workerId}::uuid
      AND a.action = 'applied'
      AND w.deletion_scheduled_at IS NULL
      ${hasProfile}
    LIMIT 1
  `;
}

/**
 * `payer_applicant_stages` (migration 0134) — DATABASE ACCESS ONLY. Whether a request may set a
 * stage, whether it is a real change and what it emits are `PayerApplicantStagesService`'s.
 *
 * NO PAYER PREDICATE ON THIS TABLE, ANYWHERE (ADR-0053 §4, class C "via parent"). The table has no
 * tenant column; every caller first resolves the posting through the posting-ownership chokepoint
 * ({@link findOwnedPostingKind} → `findOwnedJobRef`) and then addresses rows by the
 * `(posting_kind, posting_id)` that resolution returned. When PAY-DB-01 moves the chokepoint to the
 * org's tenant key, this repository needs no change.
 *
 * NOTHING HERE MAY RUN WHILE `PAYER_APPLICANT_STAGES_ENABLED` IS OFF. The table is 0134's, and
 * 0134 is apply-before-flag-on: every caller checks the flag first.
 *
 * SPINE READ-ONLY: this repository never touches `events`. `payer.applicant_stage_changed` is
 * emitted through `EventsService.emit` on the transaction {@link withTransaction} opens, so the
 * stage and its event commit together or not at all.
 *
 * Depends only on the @Global DATABASE, so it is PROVIDED in PayerPortalModule.
 */
@Injectable()
export class PayerApplicantStagesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `cb` inside one Drizzle transaction (the `ResumeSkinRepository` seam). */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /**
   * Which kind of posting `postingId` is, if the SESSION payer owns it — `null` for an unknown id
   * and for another payer's alike. THE posting-ownership chokepoint (`findOwnedJobRef`: both
   * tables, concurrently, jobs-first), the one the unlock and disclosure writes use, mapped onto
   * the board's vocabulary. Ownership, not status: a closed posting's board is still the payer's.
   * The only ownership decision this repository makes.
   */
  async findOwnedPostingKind(
    postingId: string,
    payerId: string,
  ): Promise<ApplicantPostingKind | null> {
    const ref = await findOwnedJobRef(this.db, postingId, payerId);
    if (ref === null) return null;
    return ref.kind === "job" ? "agency_job" : "company_posting";
  }

  /** Whether the worker is on the posting's applicant feed ({@link feedMembershipStatement}). */
  async isFeedApplicant(key: ApplicantStageKey, tx: Database = this.db): Promise<boolean> {
    const rows = await tx.execute(feedMembershipStatement(key));
    return (rows as unknown as unknown[]).length > 0;
  }

  /**
   * The stored stage, holding the row lock (`FOR UPDATE`) until `tx` ends — so two concurrent
   * requests moving the same applicant serialise, and each event reports the stage it actually replaced.
   * `null` when no row exists (the applicant reads `new`). Must be called on a transaction.
   */
  async lockStage(key: ApplicantStageKey, tx: Database): Promise<string | null> {
    const [row] = await tx
      .select({ stage: payerApplicantStages.stage })
      .from(payerApplicantStages)
      .where(keyWhere(key))
      .limit(1)
      .for("update");
    return row?.stage ?? null;
  }

  /**
   * The applicant's FIRST stored stage. Inserts only; `false` when a row already exists — a first
   * move committed by a concurrent request after this transaction's {@link lockStage} saw none.
   */
  async insertStage(
    key: ApplicantStageKey,
    stage: ApplicantStage,
    actorPayerId: string,
    at: Date,
    tx: Database,
  ): Promise<boolean> {
    const inserted = await tx
      .insert(payerApplicantStages)
      .values({ ...key, stage, actorPayerId, createdAt: at, updatedAt: at })
      .onConflictDoNothing({
        target: [
          payerApplicantStages.postingKind,
          payerApplicantStages.postingId,
          payerApplicantStages.workerId,
        ],
      })
      .returning({ workerId: payerApplicantStages.workerId });
    return inserted.length > 0;
  }

  /**
   * Replace the stored stage, stamping the acting login. The caller holds the row lock from
   * {@link lockStage}.
   */
  async updateStage(
    key: ApplicantStageKey,
    stage: ApplicantStage,
    actorPayerId: string,
    at: Date,
    tx: Database,
  ): Promise<void> {
    await tx
      .update(payerApplicantStages)
      .set({ stage, actorPayerId, updatedAt: at })
      .where(keyWhere(key));
  }

  /**
   * Every stored stage on ONE posting, addressed by the `(posting_kind, posting_id)` the caller
   * resolved through {@link findOwnedPostingKind} — deliberately NO payer predicate (see the class
   * note). A primary-key prefix scan.
   */
  async listPostingStages(
    postingKind: ApplicantPostingKind,
    postingId: string,
  ): Promise<StoredApplicantStage[]> {
    return this.db
      .select({ workerId: payerApplicantStages.workerId, stage: payerApplicantStages.stage })
      .from(payerApplicantStages)
      .where(
        and(
          eq(payerApplicantStages.postingKind, postingKind),
          eq(payerApplicantStages.postingId, postingId),
        ),
      );
  }
}

function keyWhere(key: ApplicantStageKey): SQL | undefined {
  return and(
    eq(payerApplicantStages.postingKind, key.postingKind),
    eq(payerApplicantStages.postingId, key.postingId),
    eq(payerApplicantStages.workerId, key.workerId),
  );
}
