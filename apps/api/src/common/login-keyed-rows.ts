import { and, eq } from "drizzle-orm";
import { displayPrefs, featurePilotSubjects, type Database } from "@badabhai/db";
import type { DisplayPrefsSubjectKind } from "@badabhai/types";

/** The logins a deletion path removes today: a worker, and a company or agency login. */
export interface ErasedLogin {
  readonly kind: Extract<DisplayPrefsSubjectKind, "worker" | "payer_user">;
  /** `workers.id` or `payers.id`: the LOGIN, never a company's tenant key. */
  readonly id: string;
}

/**
 * #2837 (risks R87, R88) — THE ROWS KEYED ON A LOGIN'S ID THAT NO CASCADE REACHES, erased with it.
 *
 * `display_prefs` (0165, #2819) and `feature_pilot_subjects` (0164, #2820) name a login by an id
 * with NO foreign key: one column names a row in one of several tables, and a theme or a pilot place
 * must never block an erasure. So the cascade that removes everything else a login owns misses them,
 * and every path that deletes the login's row calls this on the same transaction:
 *   - a worker: `WorkersRepository.hardDelete` (the DPDP erasure, sweep and QA seam) and
 *     `InstituteLinkRepository.deleteLinkCreatedPendingWorker` (Campus's unlink);
 *   - a company or agency login: `PayerAccountDeletionService.execute` (the QA seam). It has no
 *     row in `feature_pilot_subjects`: a company's pilot place is `feature_pilot_payers`, which has
 *     a foreign key and cascades.
 * No admin deletion exists (an admin is suspended). Only the login's own kind is touched: the same
 * uuid under another kind is another login's row.
 *
 * CALL IT AFTER THE LOGIN'S ROW IS DELETED, NEVER BEFORE. A theme PATCH holds `FOR KEY SHARE` on
 * the login's row for its whole transaction (`DisplayPrefsRepository.lockSubject`). Deleting that
 * row first makes the erasure wait for a PATCH already holding it, and these statements then run on
 * a fresh READ COMMITTED snapshot that sees the row the PATCH committed. A PATCH that starts after
 * the delete waits on the row instead and finds it gone. The other order would let a PATCH's first
 * insert commit after these deletes ran, and outlive the login.
 *
 * Unconditional: both tables are applied in production, and each has a `table` entry in
 * `schema-contract.ts` because every erasure now names it.
 */
export async function eraseLoginKeyedRows(tx: Database, login: ErasedLogin): Promise<void> {
  await tx
    .delete(displayPrefs)
    .where(and(eq(displayPrefs.subjectKind, login.kind), eq(displayPrefs.subjectId, login.id)));
  if (login.kind === "worker") {
    await tx
      .delete(featurePilotSubjects)
      .where(
        and(
          eq(featurePilotSubjects.subjectKind, "worker"),
          eq(featurePilotSubjects.subjectId, login.id),
        ),
      );
  }
}
