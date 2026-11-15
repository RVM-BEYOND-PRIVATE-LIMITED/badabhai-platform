import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  outboundSignals,
  RVM_INSTITUTE_CODE,
  type Database,
  type OutboundSignalFailure,
  type OutboundSignalKind,
} from "@badabhai/db";
import type { ApplicantPostingKind } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/** The ids a selection signal stores (ADR-0064 §3.6): never a name, a title or a reference. */
export interface SelectionSignalPayload {
  readonly posting_kind: ApplicantPostingKind;
  readonly posting_id: string;
  readonly worker_id: string;
  readonly stage: "selected" | "hired";
  /** The day of the mark, India time (`YYYY-MM-DD`). */
  readonly marked_on: string;
}

/** One claimed row, as the sender needs it. */
export interface ClaimedSignal {
  readonly id: string;
  readonly kind: OutboundSignalKind;
  readonly workerId: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/** What the body is built from at send time. Every field is read fresh, never stored twice. */
export interface SelectionSendContext {
  /** The student's RVM reference, only while his link is ACTIVE; null otherwise. */
  readonly studentRef: string | null;
  /** The posting's title; null when the posting is gone. */
  readonly jobTitle: string | null;
  /** The owner company's name, still encrypted; null when there is no owner row. */
  readonly companyNameEnc: string | null;
}

/**
 * `outbound_signals` (migration 0167) and the reads the sender builds a body from. Rows only:
 * every rule is {@link OutboundSignalsService}'s or the sender's.
 */
@Injectable()
export class OutboundSignalsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Is this worker an RVM student with an ACTIVE link? Read inside the stage transaction, so the
   * signal is queued only for a student who is linked when the mark is saved.
   */
  async isActiveRvmStudent(workerId: string, tx: Database): Promise<boolean> {
    const rows = await tx.execute<{ one: number }>(sql`
      SELECT 1 AS one FROM worker_institute_links
      WHERE worker_id = ${workerId}::uuid
        AND institute_code = ${RVM_INSTITUTE_CODE}
        AND status = 'active'
      LIMIT 1`);
    return rows.length > 0;
  }

  /**
   * Queue one selection signal in the caller's transaction. `false` when this mark was signalled
   * before (the unique `dedupe_key`): a student moved back and marked again sends nothing new.
   */
  async insertSelection(
    input: {
      readonly dedupeKey: string;
      readonly kind: OutboundSignalKind;
      readonly payload: SelectionSignalPayload;
      readonly at: Date;
    },
    tx: Database,
  ): Promise<boolean> {
    const inserted = await tx
      .insert(outboundSignals)
      .values({
        destination: "rvm_selection_events",
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        workerId: input.payload.worker_id,
        payload: { ...input.payload },
        nextAttemptAt: input.at,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .onConflictDoNothing({ target: outboundSignals.dedupeKey })
      .returning({ id: outboundSignals.id });
    return inserted.length > 0;
  }

  /**
   * Claim up to `limit` due pending rows, oldest first, by pushing each one's `next_attempt_at` to
   * `leaseUntil`. `SKIP LOCKED`, so two senders never take the same row; a sender that dies
   * mid-send leaves the row to come due again when the lease runs out (the destination
   * de-duplicates the retry on the row id).
   */
  async claimDue(now: Date, leaseUntil: Date, limit: number): Promise<ClaimedSignal[]> {
    const rows = await this.db.execute<{
      id: string;
      kind: OutboundSignalKind;
      worker_id: string;
      payload: unknown;
      attempts: number;
    }>(sql`
      UPDATE outbound_signals s
      SET next_attempt_at = ${leaseUntil.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
      WHERE s.id IN (
        SELECT id FROM outbound_signals
        WHERE status = 'pending' AND next_attempt_at <= ${now.toISOString()}::timestamptz
        ORDER BY next_attempt_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING s.id, s.kind, s.worker_id, s.payload, s.attempts`);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      workerId: r.worker_id,
      payload: r.payload,
      attempts: Number(r.attempts),
    }));
  }

  /** Everything a selection body is built from, read now. */
  async selectionContext(
    workerId: string,
    postingKind: ApplicantPostingKind,
    postingId: string,
  ): Promise<SelectionSendContext> {
    const posting =
      postingKind === "agency_job"
        ? sql`SELECT j.title AS title, p.org_name_enc AS org_name_enc
              FROM jobs j LEFT JOIN payers p ON p.id = j.payer_id
              WHERE j.id = ${postingId}::uuid`
        : sql`SELECT jp.role_title AS title, p.org_name_enc AS org_name_enc
              FROM job_postings jp LEFT JOIN payers p ON p.id = jp.payer_id
              WHERE jp.id = ${postingId}::uuid`;
    const [link] = await this.db.execute<{ student_ref: string }>(sql`
      SELECT student_ref FROM worker_institute_links
      WHERE worker_id = ${workerId}::uuid
        AND institute_code = ${RVM_INSTITUTE_CODE}
        AND status = 'active'`);
    const [row] = await this.db.execute<{ title: string | null; org_name_enc: string | null }>(
      posting,
    );
    return {
      studentRef: link?.student_ref ?? null,
      jobTitle: row?.title ?? null,
      companyNameEnc: row?.org_name_enc ?? null,
    };
  }

  async markDelivered(id: string, at: Date): Promise<void> {
    await this.db.execute(sql`
      UPDATE outbound_signals
      SET status = 'delivered', delivered_at = ${at.toISOString()}::timestamptz,
          attempts = attempts + 1, last_failure = NULL,
          updated_at = ${at.toISOString()}::timestamptz
      WHERE id = ${id}::uuid AND status = 'pending'`);
  }

  /** A failed attempt that will be tried again at `nextAt`. */
  async markRetry(
    id: string,
    failure: OutboundSignalFailure,
    nextAt: Date,
    at: Date,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE outbound_signals
      SET attempts = attempts + 1, last_failure = ${failure},
          next_attempt_at = ${nextAt.toISOString()}::timestamptz,
          updated_at = ${at.toISOString()}::timestamptz
      WHERE id = ${id}::uuid AND status = 'pending'`);
  }

  /**
   * The end of the line: `dead` (attempts exhausted, or a refusal no retry can change) or
   * `cancelled` (never to be sent). `countsAttempt` is false when nothing was sent.
   */
  async markFinal(
    id: string,
    status: "dead" | "cancelled",
    failure: OutboundSignalFailure,
    at: Date,
    countsAttempt: boolean,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE outbound_signals
      SET status = ${status}, last_failure = ${failure},
          attempts = attempts + ${countsAttempt ? 1 : 0},
          updated_at = ${at.toISOString()}::timestamptz
      WHERE id = ${id}::uuid AND status = 'pending'`);
  }
}
