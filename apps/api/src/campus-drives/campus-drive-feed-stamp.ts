import { eq, sql } from "drizzle-orm";
import { campusDriveRequests, type Database } from "@badabhai/db";

/**
 * #2746 PR 6, migration review M1 — RE-STAMP A COMPANY'S DRIVE REQUESTS WHEN ITS STANDING CHANGES.
 *
 * Campus's drive feed orders, filters and pages on `campus_drive_requests.updated_at` alone (its
 * `changed_at`, served by `campus_drive_requests_changed_idx`). Whether an item is WITHDRAWN (owner
 * ruling R2) is read live from the request's company: `payers.status` and `payers.role`, and
 * `employer_profiles.verification_status` and `gst_number_enc`, of `campus_drive_requests.payer_id`
 * (the tenant key: the org's anchor under tenancy `on`, the login itself otherwise). So every writer
 * that can change one of those four calls this, IN ITS OWN TRANSACTION, after its write: the
 * requests move in the feed with the change and Campus pulls them again, stripped or restored.
 * (A `GREATEST` over the three tables' `updated_at` did not: the request is stamped by the
 * database's clock, the company rows by the api host's, so a later change could leave
 * `changed_at` where it was, and Campus, upserting by id, kept the stale item.)
 *
 * WHICH REQUESTS. Those whose `payer_id` is the row the writer changed. That is exactly the set the
 * R2 rule reads that row for: a request reads the standing of its own `payer_id` and of nothing
 * else, so the id of the `payers` / `employer_profiles` row that moved names every request whose
 * standing can have changed (a company's archive calls this for the anchor and for each team login
 * it archived) and none other. Served by `campus_drive_requests_payer_idx`. Keyed on the row that
 * moved, not on a tenant key: a named ADR-0053 exception (`payer-tenancy.static.test.ts` T5,
 * `ORG_TENANCY_PLAN.md` §4), the same class as `suspendPayerInventory` and `eraseEnteredBy`.
 *
 * NEAR THE COMMIT (security re-check L1). Campus re-reads a two-minute overlap window, and the
 * stamp is taken when this statement runs, not when the transaction commits. The admin services
 * therefore call it AGAIN as the LAST statement of their transaction (after the inventory freeze,
 * the events and the audit row), so the stamp Campus sees is taken just before the commit; the call
 * right after each write keeps every write covered on its own.
 *
 * LOCK ORDER payers → requests: the caller has already written (so row-locked) the `payers` or
 * `employer_profiles` row; this then takes the request rows. A company archive locks EVERY login's
 * `payers` row, in id order, before its first write, so no request row is held while it waits on a
 * login's row (a QA delete of a team member takes that login's row, then the requests it typed). A
 * Campus decision and a company's cancel lock only the request row and take no lock on `payers` or
 * `employer_profiles` (the decision re-reads the standing in a separate plain statement; their
 * event and audit inserts reference neither table), and a create's insert takes only `FOR KEY
 * SHARE` on its `payers` row, which a status write (`FOR NO KEY UPDATE`) does not block. So no
 * cycle.
 *
 * The stamp is the database's clock (`clock_timestamp()`), the same as every request write.
 * `campus-drive-standing-writers.static.test.ts` fails a write of one of those columns that is not
 * followed by this call, on the same transaction, in the same function.
 */
export async function restampCompanyDriveRequests(tx: Database, payerId: string): Promise<void> {
  await tx
    .update(campusDriveRequests)
    .set({ updatedAt: sql`clock_timestamp()` })
    .where(eq(campusDriveRequests.payerId, payerId));
}
