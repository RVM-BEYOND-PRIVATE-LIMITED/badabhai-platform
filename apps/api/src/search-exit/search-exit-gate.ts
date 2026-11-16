import { Logger } from "@nestjs/common";
import { sql as dsql, type SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";

import type { TenantKey } from "../payers/payer-tenant-scope";
import { searchExitEnabled, type SearchExitConfig } from "./search-exit.flag";
import { warnSearchExitsTableMissingOnce } from "./search-exit-missing-table";

/** What the gate reads with: the unlock transaction's own handle (`execute` is all it needs). */
export type SearchExitExecutor = Pick<Database, "execute">;

const logger = new Logger("SearchExitGate");

/**
 * Whether `worker_search_exits` exists, WITHOUT naming it as a relation. `to_regclass` takes the
 * name as text and answers NULL for a missing table instead of raising, so this statement cannot
 * fail on 42P01 and never aborts the unlock transaction it runs in.
 *
 * WHY A STATEMENT OF ITS OWN, not a CASE in front of the read: Postgres resolves every relation a
 * statement names when it PARSES it, before any CASE is evaluated, so
 * `CASE WHEN to_regclass(...) IS NULL THEN false ELSE EXISTS (SELECT … FROM worker_search_exits …)`
 * still raises 42P01 when the table is missing (`worker-search-exits.db.test.ts` shows it). The
 * read below is sent only after this probe has answered true.
 */
export function searchExitsTablePresentStatement(): SQL {
  return dsql`SELECT to_regclass('public.worker_search_exits') IS NOT NULL AS present`;
}

/** Whether he left company search: one primary-key read of `worker_search_exits`. */
export function leftSearchStatement(workerId: string): SQL {
  return dsql`
    SELECT 1 AS hidden FROM worker_search_exits x WHERE x.worker_id = ${workerId}::uuid LIMIT 1
  `;
}

/**
 * "Is he an applicant of this company?" — the per-posting applicant feeds' OWN membership
 * (`feedMembershipStatement`, payer-applicant-stages.repository.ts), asked across every posting
 * the TENANT owns instead of one, because a company opening him may come from its search page or
 * its inbox with no job named:
 *  - a company posting (`applications.job_posting_id`) whose `payer_id` is the tenant, or
 *  - an agency job (`applications.job_id`) whose `payer_id` is the tenant, and he has a
 *    `worker_profiles` row (that list ranks FROM `worker_profiles`, so an applier without one is
 *    not on it);
 * with an `applied` decision he has not taken back (a withdrawal deletes the row or turns it into a
 * skip), not inside the ADR-0031 (b) deletion grace window, not suspended. Ownership is the tenant
 * key, exactly as `findOwnedJobRef` decides it. A twin of the feed membership, not a re-reading of
 * it: `worker-search-exits.db.test.ts` pins that the two agree.
 */
export function appliedToTenantStatement(workerId: string, tenant: TenantKey): SQL {
  return dsql`
    SELECT 1 AS member
    FROM applications a
    INNER JOIN workers w ON w.id = a.worker_id
    LEFT JOIN job_postings jp ON jp.id = a.job_posting_id
    LEFT JOIN jobs j ON j.id = a.job_id
    WHERE a.worker_id = ${workerId}::uuid
      AND a.action = 'applied'
      AND w.deletion_scheduled_at IS NULL
      -- #2562 - suspended workers are frozen on payer surfaces.
      AND w.status <> 'suspended'
      AND (
        jp.payer_id = ${tenant}::uuid
        OR (
          j.payer_id = ${tenant}::uuid
          AND EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.worker_id = a.worker_id)
        )
      )
    LIMIT 1
  `;
}

const hasRow = (rows: unknown): boolean => (rows as unknown as unknown[]).length > 0;
const firstPresent = (rows: unknown): boolean =>
  (rows as unknown as { present?: unknown }[])[0]?.present === true;

/**
 * #2753 item 6 — THE UNLOCK RULE FOR A WORKER WHO LEFT COMPANY SEARCH. "A company he applied to can
 * still open him" means a company he did NOT apply to must not, even holding his worker id from a
 * search page it loaded before he left.
 *
 * True means REFUSE: the switch is on, he has a `worker_search_exits` row, and this tenant is not
 * one he applied to. The caller answers its one neutral body (`{ status: "unavailable" }`): no
 * debit, no grant row, and the house deny event (`unlock.denied`, internal reason only).
 *
 * WHERE IT IS ASKED. `UnlockService.requestUnlock`, INSIDE its advisory-locked transaction, in the
 * refusals block AFTER the open-grant early return (a company already holding an open contact never
 * reaches this, so a re-open or a reveal of a held contact is unaffected) and BEFORE the caps and
 * the debit. Résumé disclosures already require a live unlock, so they need nothing of their own.
 *
 * EVERY READ IS ON `tx`, the transaction's own connection. A global-pool read inside the locked
 * transaction is the pool-vs-lock deadlock the unlock service's class doc describes.
 *
 * OFF IS TODAY: with `SEARCH_EXIT_ENABLED` off this returns false WITHOUT A READ, so the unlock path
 * is byte-identical and `worker_search_exits` is never named.
 *
 * ON BEFORE MIGRATION 0168: FAIL OPEN, WITHOUT A FAILED STATEMENT. Nobody can have left search
 * without the table (leaving writes it), so a missing table means "not hidden". It must not be
 * learned by catching a 42P01: a failed statement ABORTS the Postgres transaction this runs in, and
 * the unlock would then fail on its next statement (25P02). So the gate first PROBES with
 * {@link searchExitsTablePresentStatement}, which cannot raise, and names the table only once the
 * probe says it exists. The first miss in the process logs one warning. Any other read error
 * propagates, failing the transaction closed (nothing is written).
 *
 * NOT AFFECTED, BY DESIGN: his own job feed, applying, chat, and every company's applicant list for
 * a job he applied to. Leaving search narrows who can FIND him, never what he can do.
 */
export async function searchExitRefuses(
  tx: SearchExitExecutor,
  config: SearchExitConfig | undefined,
  workerId: string,
  tenant: TenantKey,
): Promise<boolean> {
  if (!searchExitEnabled(config)) return false;
  if (!firstPresent(await tx.execute(searchExitsTablePresentStatement()))) {
    warnSearchExitsTableMissingOnce("unlock");
    return false;
  }
  if (!hasRow(await tx.execute(leftSearchStatement(workerId)))) return false;
  if (hasRow(await tx.execute(appliedToTenantStatement(workerId, tenant)))) return false;
  // Ids only (truncated, the institute gate's convention): the internal reason never reaches the
  // company, whose body is the same neutral one every other refusal answers.
  logger.log(
    `unlock refused: left company search worker=${workerId.slice(0, 8)} tenant=${tenant.slice(0, 8)}`,
  );
  return true;
}
