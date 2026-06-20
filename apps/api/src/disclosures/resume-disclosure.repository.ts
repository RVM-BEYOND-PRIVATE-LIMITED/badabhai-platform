import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  type Database,
  type DisclosureStatus,
  type DisclosureDenyReason,
  resumeDisclosures,
  unlocks,
  generatedResumes,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * A Drizzle transaction handle (re-derived locally — NOT imported from
 * `unlocks.repository`, which the TD41 BC-8 static guard keeps as the SOLE importer
 * of the unlocks repo). The disclosure chokepoint opens ONE transaction per grant so
 * the SHARED-cap check + grant-write are atomic per worker (B-B).
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** PII-free ops/list projection of a disclosure row (NO bytes / name / link). */
export interface DisclosureProjection {
  disclosure_id: string;
  payer_id: string;
  worker_id: string;
  job_posting_id: string | null;
  status: DisclosureStatus;
  resume_ref: string | null;
  disclosed_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

/** The name-free render source for a worker's resume (a pointer + the snapshot). */
export interface ResumeSource {
  resumeId: string;
  sourceProfileSnapshot: unknown;
  templateId: string | null;
  version: number;
}

/**
 * Data access for the resume-disclosure stream (ADR-0013 Decision C / the disclosure
 * threat-model addendum). PURE data access — the fail-closed ordering, the masking,
 * the single decrypt, and event emission all live in {@link ResumeDisclosureService}.
 *
 * It READS `unlocks` (never writes it — TD41 BC-8) only to compute the SHARED
 * per-worker "PII disclosed to payers" ceiling that spans unlock reveals AND resume
 * disclosures (B-B), so a worker cannot be harvested past the cap by splitting across
 * the two SKUs. The raw phone is NEVER read or written here.
 */
@Injectable()
export class ResumeDisclosureRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * Advisory lock keyed on `worker_id` — IDENTICAL derivation to
   * `UnlocksRepository.lockWorker` (`hashtextextended(workerId, 0)`), so an unlock
   * and a disclosure for the SAME worker serialize on the SAME lock and the shared
   * ceiling (B-B) is race-free across both streams (F-2).
   */
  async lockWorker(tx: Tx, workerId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workerId}, 0))`);
  }

  /** The existing disclosure row for (payer, worker, posting), or undefined. Tx-scoped. */
  async findByPayerWorkerPosting(
    tx: Tx,
    payerId: string,
    workerId: string,
    jobPostingId: string | null,
  ): Promise<typeof resumeDisclosures.$inferSelect | undefined> {
    const rows = await tx
      .select()
      .from(resumeDisclosures)
      .where(
        and(
          eq(resumeDisclosures.payerId, payerId),
          eq(resumeDisclosures.workerId, workerId),
          jobPostingId === null
            ? isNull(resumeDisclosures.jobPostingId)
            : eq(resumeDisclosures.jobPostingId, jobPostingId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  // ---- SHARED per-worker disclosure ceiling (spans unlocks + disclosures; B-B) ----

  /**
   * Count of PII disclosures to payers for a worker since `since` = unlock reveals
   * (sum of `reveal_count`) + completed resume disclosures. The SHARED daily ceiling.
   */
  async countDisclosuresToPayersSince(tx: Tx, workerId: string, since: Date): Promise<number> {
    const reveals = await tx
      .select({ total: sql<number>`coalesce(sum(${unlocks.revealCount}), 0)::int` })
      .from(unlocks)
      .where(and(eq(unlocks.workerId, workerId), gte(unlocks.grantedAt, since)));

    const disclosures = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(resumeDisclosures)
      .where(
        and(
          eq(resumeDisclosures.workerId, workerId),
          eq(resumeDisclosures.status, "disclosed"),
          gte(resumeDisclosures.disclosedAt, since),
        ),
      );

    return (reveals[0]?.total ?? 0) + (disclosures[0]?.count ?? 0);
  }

  /** Distinct payers who got a contact OR a resume for a worker since `since` (shared weekly). */
  async countDistinctPayersSince(tx: Tx, workerId: string, since: Date): Promise<number> {
    const rows = await tx.execute(sql`
      select count(distinct payer_id)::int as count from (
        select ${unlocks.payerId} as payer_id
          from ${unlocks}
          where ${unlocks.workerId} = ${workerId}
            and ${unlocks.grantedAt} >= ${since}
            and ${unlocks.status} in ('granted','revealed')
        union
        select ${resumeDisclosures.payerId} as payer_id
          from ${resumeDisclosures}
          where ${resumeDisclosures.workerId} = ${workerId}
            and ${resumeDisclosures.disclosedAt} >= ${since}
            and ${resumeDisclosures.status} = 'disclosed'
      ) p
    `);
    const row = (rows as unknown as Array<{ count: number }>)[0];
    return row?.count ?? 0;
  }

  // ---- Grant / deny / disclose writes -------------------------------------------

  /** Insert a fresh disclosure row. Tx-scoped. */
  async insertRow(
    tx: Tx,
    input: {
      payerId: string;
      workerId: string;
      jobPostingId: string | null;
      status: DisclosureStatus;
      denyReason?: DisclosureDenyReason | null;
    },
  ): Promise<typeof resumeDisclosures.$inferSelect> {
    const rows = await tx
      .insert(resumeDisclosures)
      .values({
        payerId: input.payerId,
        workerId: input.workerId,
        jobPostingId: input.jobPostingId,
        status: input.status,
        denyReason: input.denyReason ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert resume_disclosures row");
    return row;
  }

  /** Update an existing row's status (+ optional deny reason / clearing it). Tx-scoped. */
  async updateStatus(
    tx: Tx,
    id: string,
    patch: { status: DisclosureStatus; denyReason?: DisclosureDenyReason | null },
  ): Promise<typeof resumeDisclosures.$inferSelect> {
    const rows = await tx
      .update(resumeDisclosures)
      .set({ status: patch.status, denyReason: patch.denyReason ?? null, updatedAt: sql`now()` })
      .where(eq(resumeDisclosures.id, id))
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to update resume_disclosures row");
    return row;
  }

  /**
   * Mark a granted row DISCLOSED after the masked PDF is rendered + uploaded: set
   * resume_ref (opaque pointer), disclosed_at, expires_at. Runs OUTSIDE the cap tx
   * (post-render), so it is its own small write.
   */
  async markDisclosed(
    id: string,
    input: { resumeRef: string | null; disclosedAt: Date; expiresAt: Date },
  ): Promise<void> {
    await this.db
      .update(resumeDisclosures)
      .set({
        status: "disclosed" satisfies DisclosureStatus,
        resumeRef: input.resumeRef,
        disclosedAt: input.disclosedAt,
        expiresAt: input.expiresAt,
        updatedAt: sql`now()`,
      })
      .where(eq(resumeDisclosures.id, id));
  }

  // ---- Render source + ops read --------------------------------------------------

  /**
   * The worker's most recent generated resume that carries a name-free snapshot to
   * re-render from (employer copy is rendered FRESH with masked initials — the
   * worker's own PDF, which holds the real name, is NEVER served to a payer).
   */
  async findResumeSource(workerId: string): Promise<ResumeSource | undefined> {
    const rows = await this.db
      .select({
        id: generatedResumes.id,
        snapshot: generatedResumes.sourceProfileSnapshot,
        templateId: generatedResumes.templateId,
        version: generatedResumes.version,
      })
      .from(generatedResumes)
      .where(eq(generatedResumes.workerId, workerId))
      .orderBy(desc(generatedResumes.generatedAt))
      .limit(1);
    const row = rows[0];
    if (!row || row.snapshot == null) return undefined;
    return {
      resumeId: row.id,
      sourceProfileSnapshot: row.snapshot,
      templateId: row.templateId,
      version: row.version,
    };
  }

  /** Ops: a payer's disclosures (PII-free projection — NO bytes / name / link). */
  async listByPayer(payerId: string): Promise<DisclosureProjection[]> {
    const rows = await this.db
      .select()
      .from(resumeDisclosures)
      .where(eq(resumeDisclosures.payerId, payerId))
      .orderBy(desc(resumeDisclosures.createdAt))
      .limit(500);
    return rows.map((r) => ({
      disclosure_id: r.id,
      payer_id: r.payerId,
      worker_id: r.workerId,
      job_posting_id: r.jobPostingId,
      status: r.status,
      resume_ref: r.resumeRef,
      disclosed_at: r.disclosedAt,
      expires_at: r.expiresAt,
      created_at: r.createdAt,
    }));
  }
}
