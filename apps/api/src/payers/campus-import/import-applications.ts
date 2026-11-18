/**
 * #2754 items 8 and 9 — move each open Campus application of a moved job onto that job's posting,
 * with its stage, and carry over a contact the company had already opened on Campus.
 *
 * WHO MOVES WITH IDENTITY (#2754 "Applicants whose details may not move", default built):
 *   - an RVM STUDENT moved into BadaBhai by the bulk student move (#2887, `student_import_subjects`,
 *     keyed by the Campus candidate id), or linked by #2752 (`worker_institute_links`, active, by
 *     student reference). Campus exports a student's application only with his live consent (#153);
 *   - an OUTSIDE candidate who ALREADY HAS a BadaBhai worker account on that phone, with his own
 *     consent to employer sharing (the latest `worker_consents` row, as company search reads it).
 * Everyone else is HELD: a ledger row with the Campus application id, the job and a reason code,
 * and no name or phone. An application needs a `workers` row and none is created for a person who
 * never agreed to BadaBhai. When he joins (or the student moves), a later run moves him.
 *
 * WHAT ONE MOVED APPLICATION WRITES, in ONE transaction with its ledger row:
 *   - `applications`: applied, `source_surface` `other`, `created_at` = Campus's applied time.
 *     One per worker and posting: an existing apply is reused, a skip becomes the apply;
 *   - for an RVM student, `institute_applications` (`rvm`, external ref = the Campus application
 *     id), so Campus's status feed (#155 item 10) and #156 item 6 find the moved application;
 *   - `payer_applicant_stages` with the mapped stage (#2747), acting login = the company's account,
 *     unless the stage is `new` (no row means new);
 *   - CARRIED ACCESS (item 9): when the company had opened him on Campus, an `unlocks` row granted
 *     for good (`OPEN_FOR_GOOD_UNTIL`, #2747) at the Campus time, with NO credit ledger line. Its own
 *     ledger row (kind `access`) is the migrated marker the numbers screen leaves out (#2755).
 *
 * NO EVENTS. An imported application is not a new apply: `application.submitted` would tell the
 * company, the numbers and the activity sweep that hundreds of people applied today. The ledger
 * rows are the record.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  applications,
  instituteApplications,
  payerApplicantStages,
  unlocks,
  type Database,
} from "@badabhai/db";
import type { PiiCryptoService } from "../../common/pii-crypto.service";
import { OPEN_FOR_GOOD_UNTIL } from "../../unlocks/open-grant";
import type { CampusApplication, CampusBundle } from "./bundle.schema";
import { campusPhoneToE164, decideApplication } from "./mapping";
import { lockRow, writeRow, FINISHED_STATES, type OpenBatch } from "./import-ledger.repository";

export interface ApplicationImportSummary {
  moved: number;
  reusedApplication: number;
  alreadyDone: number;
  held: Record<string, number>;
  skipped: Record<string, number>;
  stages: Record<string, number>;
  carriedAccess: number;
}

const bump = (tally: Record<string, number>, key: string): void => {
  tally[key] = (tally[key] ?? 0) + 1;
};

type WorkerMatch = { workerId: string } | { held: string };

/** The BadaBhai worker a Campus applicant is, or why he is held. Never creates a worker. */
async function findWorker(
  tx: Database,
  pii: PiiCryptoService,
  candidate: CampusApplication["candidate"],
): Promise<WorkerMatch> {
  if (candidate.kind === "rvm_student") {
    const moved = (await tx.execute(sql`
      SELECT worker_id FROM student_import_subjects
       WHERE source = 'campus' AND source_id = ${candidate.source_id}
       LIMIT 1`)) as unknown as { worker_id: string }[];
    if (moved[0]) return { workerId: moved[0].worker_id };
    const linked = (await tx.execute(sql`
      SELECT worker_id FROM worker_institute_links
       WHERE student_ref = ${candidate.student_ref.toLowerCase()} AND status = 'active'
       LIMIT 1`)) as unknown as { worker_id: string }[];
    if (linked[0]) return { workerId: linked[0].worker_id };
    return { held: "rvm_student_not_moved" };
  }
  const phone = campusPhoneToE164(candidate.phone);
  if (phone === null) return { held: "applicant_no_phone" };
  const rows = (await tx.execute(sql`
    SELECT w.id AS worker_id,
           (SELECT bool_and(c.revoked_at IS NULL AND c.purposes @> '["employer_sharing"]'::jsonb)
              FROM worker_consents c
             WHERE c.worker_id = w.id
               AND c.accepted_at = (SELECT max(c2.accepted_at) FROM worker_consents c2 WHERE c2.worker_id = w.id)
           ) IS TRUE AS consents
      FROM workers w
     WHERE w.phone_hash = ${pii.hashPhone(phone)}
       AND w.deletion_scheduled_at IS NULL
       AND w.status IN ('pending', 'active')
     LIMIT 1`)) as unknown as { worker_id: string; consents: boolean }[];
  const row = rows[0];
  if (!row) return { held: "no_badabhai_account" };
  if (!row.consents) return { held: "no_badabhai_consent" };
  return { workerId: row.worker_id };
}

/** The `applications` row: insert, or reuse one for the same worker and posting. */
async function writeApplication(
  tx: Database,
  workerId: string,
  postingId: string,
  appliedAt: Date,
): Promise<{ id: string; reused: boolean }> {
  const inserted = await tx
    .insert(applications)
    .values({
      jobPostingId: postingId,
      workerId,
      action: "applied",
      sourceSurface: "other",
      createdAt: appliedAt,
      updatedAt: appliedAt,
    })
    .onConflictDoNothing()
    .returning({ id: applications.id });
  if (inserted[0]) return { id: inserted[0].id, reused: false };
  const [existing] = await tx
    .select({ id: applications.id, action: applications.action })
    .from(applications)
    .where(and(eq(applications.workerId, workerId), eq(applications.jobPostingId, postingId)))
    .limit(1);
  if (!existing) throw new Error("application insert hit a conflict but no row was found");
  if (existing.action !== "applied") {
    // He had skipped the job in the app; his Campus application is the apply.
    await tx
      .update(applications)
      .set({ action: "applied", reason: null, updatedAt: new Date() })
      .where(eq(applications.id, existing.id));
  }
  return { id: existing.id, reused: true };
}

export async function importApplications(
  db: Database,
  pii: PiiCryptoService,
  batch: OpenBatch,
  bundle: CampusBundle,
  placedCompanies: ReadonlyMap<string, string>,
  placedJobs: ReadonlyMap<string, string>,
): Promise<ApplicationImportSummary> {
  const summary: ApplicationImportSummary = {
    moved: 0,
    reusedApplication: 0,
    alreadyDone: 0,
    held: {},
    skipped: {},
    stages: {},
    carriedAccess: 0,
  };

  for (const app of bundle.applications) {
    await db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const prior = await lockRow(tx, "application", app.source_id);
      if (prior && FINISHED_STATES.has(prior.state)) {
        summary.alreadyDone += 1;
        return;
      }
      const row = (
        state: "created" | "matched" | "held" | "skipped",
        targetId: string | null,
        reason: string | null,
        detail: Record<string, unknown>,
      ) =>
        writeRow(tx, {
          batchId: batch.id,
          kind: "application",
          sourceId: app.source_id,
          companySourceId: app.company_source_id,
          state,
          targetId,
          reason,
          detail: { job_source_id: app.job_source_id, candidate: app.candidate.kind, ...detail },
        });

      const decision = decideApplication(app);
      if (!decision.move) {
        await row("skipped", null, decision.reason, { status: app.status });
        bump(summary.skipped, decision.reason);
        return;
      }
      const postingId = placedJobs.get(app.job_source_id);
      const companyId = placedCompanies.get(app.company_source_id);
      if (postingId === undefined || companyId === undefined) {
        await row("skipped", null, "job_not_moved", {});
        bump(summary.skipped, "job_not_moved");
        return;
      }
      const match = await findWorker(tx, pii, app.candidate);
      if ("held" in match) {
        await row("held", null, match.held, { stage: decision.stage });
        bump(summary.held, match.held);
        return;
      }

      const application = await writeApplication(tx, match.workerId, postingId, new Date(app.applied_at));
      if (app.candidate.kind === "rvm_student") {
        await tx
          .insert(instituteApplications)
          .values({
            instituteCode: "rvm",
            externalRef: app.source_id,
            applicationId: application.id,
            ownsApplication: !application.reused,
            jobPostingId: postingId,
            workerId: match.workerId,
            campusAppliedAt: new Date(app.applied_at),
          })
          .onConflictDoNothing();
      }
      if (decision.stage !== "new") {
        await tx
          .insert(payerApplicantStages)
          .values({
            postingKind: "company_posting",
            postingId,
            workerId: match.workerId,
            stage: decision.stage,
            actorPayerId: companyId,
          })
          .onConflictDoNothing();
      }
      bump(summary.stages, decision.stage);

      // Item 9: the company had opened him on Campus. Opened for good, at the Campus time, free.
      if (app.company_unlocked_at !== null) {
        const openedAt = new Date(app.company_unlocked_at);
        const opened = await tx
          .insert(unlocks)
          .values({
            payerId: companyId,
            workerId: match.workerId,
            jobPostingId: postingId,
            status: "granted",
            grantedAt: openedAt,
            expiresAt: OPEN_FOR_GOOD_UNTIL,
            createdAt: openedAt,
          })
          .onConflictDoNothing()
          .returning({ id: unlocks.id });
        let unlockId = opened[0]?.id;
        let accessState: "created" | "matched" = "created";
        if (!unlockId) {
          const [existing] = await tx
            .select({ id: unlocks.id })
            .from(unlocks)
            .where(and(eq(unlocks.payerId, companyId), eq(unlocks.workerId, match.workerId)))
            .limit(1);
          unlockId = existing?.id;
          accessState = "matched";
        }
        if (unlockId) {
          await writeRow(tx, {
            batchId: batch.id,
            kind: "access",
            sourceId: app.source_id,
            companySourceId: app.company_source_id,
            state: accessState,
            targetId: unlockId,
            reason: null,
            detail: { migrated: true, no_credit: true },
          });
          if (accessState === "created") summary.carriedAccess += 1;
        }
      }

      await row(application.reused ? "matched" : "created", application.id, null, {
        stage: decision.stage,
        worker: app.candidate.kind === "rvm_student" ? "moved_student" : "existing_account",
      });
      summary.moved += 1;
      if (application.reused) summary.reusedApplication += 1;
    });
  }
  return summary;
}
