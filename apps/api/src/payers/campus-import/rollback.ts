/**
 * #2754 item 14 — roll back one import batch: archive the accounts it created, close the postings
 * it created, take back the converted balance it granted, and remove the applications and opened
 * contacts it moved. Campus is the system of record again afterwards (the runbook turns Campus
 * sign-in and plans back on); BadaBhai is left as it was before the batch, with the import's own
 * rows marked `rolled_back` on the ledger.
 *
 * WHAT IS UNDONE, record by record (ONE transaction per record, with its ledger row, so a stopped
 * rollback can simply be run again: a row already `rolled_back` is never touched twice):
 *   - OPENED CONTACT (`access`, created): the `unlocks` row the import granted is ended
 *     (`expired`, `expires_at` now). One that already existed (`matched`) is the company's own.
 *   - APPLICATION (created): the `applications` row, its `institute_applications` link (the import's
 *     own record, so Campus's status feed does not report a move that was reversed) and the stage on
 *     the imported posting are deleted. One the worker had made himself (`matched`) is kept.
 *   - POSTING (created): closed through the posting service's own ops close (`job_posting.closed`).
 *   - BALANCE (created): what the lot still holds is taken back with ONE compensating line,
 *     `campus_conversion_reversed` (`reverseLotWithinTx`). Credits the company already spent stay
 *     spent and are counted.
 *   - ACCOUNT (created): archived (`payer.archived`), as the admin archive does, with its other
 *     inventory frozen. NOT archived, and counted, when it is in use beyond the import: it has a
 *     posting no import created, or a paid order. An account the import only MATCHED (it existed before)
 *     is never archived. Live sessions end on the next request (the payer guard refuses an archived
 *     account); the CLI has no session store to sweep.
 *
 * Rows that moved nothing (`held`, `skipped`, `exception`) have nothing to undo and stay as they
 * are. The batch ends `rolled_back`, which spends its key: a later run needs a new `--batch`, and a
 * company archived here is then an exception (`matched_account_archived`) for a person to decide.
 *
 * Events: `payer.archived` and `job_posting.closed`, as the admin and ops paths write them. The
 * import wrote no event for an application or an opened contact, so their removal writes none.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  applications,
  companyImportBatches,
  companyImportRows,
  instituteApplications,
  jobPostings,
  payerApplicantStages,
  paymentOrders,
  payers,
  reverseLotWithinTx,
  unlocks,
  type CompanyImportRowKind,
  type Database,
} from "@badabhai/db";
import type { EventsService } from "../../events/events.service";
import { AdminActionsRepository } from "../../admin/admin-actions.repository";
import { AdminCompaniesRepository } from "../../admin/companies/admin-companies.repository";
import { CampusImportRefusal, findBatch } from "./import-ledger.repository";

export type PostingCloseOutcome = "closed" | "already_closed" | "not_closeable";

export interface RollbackDeps {
  db: Database;
  events: Pick<EventsService, "emit">;
  /** Close one imported posting through the posting service's ops close. */
  closePosting: (postingId: string) => Promise<PostingCloseOutcome>;
}

export interface RollbackSummary {
  batchKey: string;
  alreadyRolledBack: boolean;
  access: { ended: number; keptExisting: number };
  applications: { removed: number; keptExisting: number };
  postings: { closed: number; alreadyClosed: number; notCloseable: number };
  balances: { reversed: number; creditsTakenBack: number; creditsAlreadySpent: number; notReversed: Record<string, number> };
  accounts: { archived: number; alreadyArchived: number; keptExisting: number; keptInUse: number };
}

/** The idempotency key of the compensating line for one lot. */
export function campusReversalKey(lotId: string): string {
  return `campus_conversion_reversed:${lotId}`;
}

/** Undo order: what hangs off a posting first, the account last. */
const ORDER: readonly CompanyImportRowKind[] = ["access", "application", "job", "balance", "company"];

interface BatchRow {
  id: string;
  kind: CompanyImportRowKind;
  sourceId: string;
  state: "created" | "matched";
  targetId: string;
}

const bump = (tally: Record<string, number>, key: string): void => {
  tally[key] = (tally[key] ?? 0) + 1;
};

/** Mark one ledger row rolled back, noting what was done; only from the state it was read in. */
async function markRolledBack(tx: Database, row: BatchRow, outcome: string): Promise<boolean> {
  const updated = await tx
    .update(companyImportRows)
    .set({
      state: "rolled_back",
      detail: sql`${companyImportRows.detail} || ${JSON.stringify({ rollback: outcome, rolled_back_from: row.state })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(companyImportRows.id, row.id), eq(companyImportRows.state, row.state)))
    .returning({ id: companyImportRows.id });
  return updated.length === 1;
}

/** Lock one ledger row and confirm it is still in the state it was read in. */
async function stillLive(tx: Database, row: BatchRow): Promise<boolean> {
  const [locked] = await tx
    .select({ state: companyImportRows.state })
    .from(companyImportRows)
    .where(eq(companyImportRows.id, row.id))
    .for("update");
  return locked?.state === row.state;
}

export async function rollbackCompanyImport(
  deps: RollbackDeps,
  batchKey: string,
  rolledBackBy: string,
): Promise<RollbackSummary> {
  const summary: RollbackSummary = {
    batchKey,
    alreadyRolledBack: false,
    access: { ended: 0, keptExisting: 0 },
    applications: { removed: 0, keptExisting: 0 },
    postings: { closed: 0, alreadyClosed: 0, notCloseable: 0 },
    balances: { reversed: 0, creditsTakenBack: 0, creditsAlreadySpent: 0, notReversed: {} },
    accounts: { archived: 0, alreadyArchived: 0, keptExisting: 0, keptInUse: 0 },
  };
  const { db } = deps;
  const batch = await findBatch(db, batchKey);
  if (!batch) throw new CampusImportRefusal(`no import batch ${batchKey}`);
  if (batch.state === "rolled_back") return { ...summary, alreadyRolledBack: true };

  const rows = (await db
    .select({
      id: companyImportRows.id,
      kind: companyImportRows.kind,
      sourceId: companyImportRows.sourceId,
      state: companyImportRows.state,
      targetId: companyImportRows.targetId,
    })
    .from(companyImportRows)
    .where(
      and(eq(companyImportRows.batchId, batch.id), inArray(companyImportRows.state, ["created", "matched"])),
    )) as BatchRow[];
  const byKind = (kind: CompanyImportRowKind) => rows.filter((r) => r.kind === kind);

  for (const kind of ORDER) {
    for (const row of byKind(kind)) {
      if (kind === "job") {
        // The ops close runs its own statements and event; the ledger row follows it.
        const outcome = row.state === "created" ? await deps.closePosting(row.targetId) : "already_closed";
        await db.transaction(async (raw) => {
          const tx = raw as unknown as Database;
          if (!(await stillLive(tx, row))) return;
          await markRolledBack(tx, row, outcome);
        });
        if (outcome === "closed") summary.postings.closed += 1;
        else if (outcome === "already_closed") summary.postings.alreadyClosed += 1;
        else summary.postings.notCloseable += 1;
        continue;
      }
      await db.transaction(async (raw) => {
        const tx = raw as unknown as Database;
        if (!(await stillLive(tx, row))) return;
        if (kind === "access") {
          if (row.state === "created") {
            await tx
              .update(unlocks)
              .set({ status: "expired", expiresAt: new Date() })
              .where(and(eq(unlocks.id, row.targetId), eq(unlocks.status, "granted")));
            summary.access.ended += 1;
            await markRolledBack(tx, row, "ended");
          } else {
            summary.access.keptExisting += 1;
            await markRolledBack(tx, row, "kept_existing");
          }
          return;
        }
        if (kind === "application") {
          if (row.state === "created") {
            const [app] = await tx
              .select({ workerId: applications.workerId, postingId: applications.jobPostingId })
              .from(applications)
              .where(eq(applications.id, row.targetId))
              .for("update");
            await tx
              .delete(instituteApplications)
              .where(
                and(
                  eq(instituteApplications.instituteCode, "rvm"),
                  eq(instituteApplications.externalRef, row.sourceId),
                ),
              );
            if (app?.postingId && app.workerId) {
              await tx
                .delete(payerApplicantStages)
                .where(
                  and(
                    eq(payerApplicantStages.postingKind, "company_posting"),
                    eq(payerApplicantStages.postingId, app.postingId),
                    eq(payerApplicantStages.workerId, app.workerId),
                  ),
                );
            }
            await tx.delete(applications).where(eq(applications.id, row.targetId));
            summary.applications.removed += 1;
            await markRolledBack(tx, row, "removed");
          } else {
            summary.applications.keptExisting += 1;
            await markRolledBack(tx, row, "kept_existing");
          }
          return;
        }
        if (kind === "balance") {
          const [lot] = (await tx.execute(sql`
            SELECT payer_id FROM credit_lots WHERE id = ${row.targetId}::uuid`)) as unknown as { payer_id: string }[];
          const result = lot
            ? await reverseLotWithinTx(tx, {
                payerId: lot.payer_id,
                lotId: row.targetId,
                reason: "campus_conversion_reversed",
                idempotencyKey: campusReversalKey(row.targetId),
              })
            : ({ applied: false, reason: "no_lot" } as const);
          if (result.applied) {
            summary.balances.reversed += 1;
            summary.balances.creditsTakenBack += result.credits;
            summary.balances.creditsAlreadySpent += result.spent;
            await markRolledBack(tx, row, result.spent > 0 ? `reversed_${result.spent}_spent` : "reversed");
          } else {
            bump(summary.balances.notReversed, result.reason);
            await markRolledBack(tx, row, result.reason);
          }
          return;
        }
        // kind === "company"
        if (row.state === "matched") {
          summary.accounts.keptExisting += 1;
          await markRolledBack(tx, row, "kept_existing");
          return;
        }
        const payerId = row.targetId;
        const [account] = await tx
          .select({ status: payers.status })
          .from(payers)
          .where(eq(payers.id, payerId))
          .for("update");
        if (!account || account.status === "archived") {
          summary.accounts.alreadyArchived += 1;
          await markRolledBack(tx, row, "already_archived");
          return;
        }
        // A posting no import created (by any batch) is the company's own.
        const ownPosting = await tx
          .select({ id: jobPostings.id })
          .from(jobPostings)
          .where(
            and(
              eq(jobPostings.payerId, payerId),
              sql`NOT EXISTS (SELECT 1 FROM company_import_rows r
                               WHERE r.kind = 'job' AND r.target_id = ${jobPostings.id})`,
            ),
          )
          .limit(1);
        const paid = await tx
          .select({ id: paymentOrders.id })
          .from(paymentOrders)
          .where(and(eq(paymentOrders.payerId, payerId), eq(paymentOrders.status, "paid")))
          .limit(1);
        if (ownPosting.length > 0 || paid.length > 0) {
          // A company using BadaBhai on its own account is not taken off it by a rollback.
          summary.accounts.keptInUse += 1;
          await markRolledBack(tx, row, ownPosting.length > 0 ? "kept_in_use_posting" : "kept_in_use_paid");
          return;
        }
        // The admin archive's own login step: status, previous_status and the drive re-stamp
        // Campus reads; then the ADR-0037 inventory freeze.
        const moved = await new AdminCompaniesRepository(tx).archiveLogin(payerId, tx);
        await new AdminActionsRepository(tx).suspendPayerInventory(payerId, tx);
        await deps.events.emit({
          event_name: "payer.archived",
          actor: { actor_type: "system", actor_id: null },
          subject: { subject_type: "payer", subject_id: payerId },
          payload: { payer_id: payerId, previous_status: moved?.leftStatus ?? account.status, new_status: "archived" },
          idempotencyKey: `payer.archived:${payerId}:campus_rollback:${batch.id}`,
          correlationId: randomUUID(),
          tx,
        });
        summary.accounts.archived += 1;
        await markRolledBack(tx, row, "archived");
      });
    }
  }

  await db
    .update(companyImportBatches)
    .set({ state: "rolled_back", rolledBackAt: new Date(), rolledBackBy })
    .where(and(eq(companyImportBatches.id, batch.id), sql`${companyImportBatches.state} <> 'rolled_back'`));
  return summary;
}
