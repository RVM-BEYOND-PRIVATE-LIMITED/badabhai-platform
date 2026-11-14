import { inArray, sql } from "drizzle-orm";
import { campusDriveRequests, type Database } from "@badabhai/db";

/**
 * #2746 PR 6, migration review M1 — RE-STAMP A COMPANY'S DRIVE REQUESTS WHEN ITS STANDING CHANGES.
 *
 * Campus's drive feed orders, filters and pages on `campus_drive_requests.updated_at` alone (its
 * `changed_at`, served by `campus_drive_requests_changed_idx`). Whether an item is WITHDRAWN (owner
 * ruling R2) is read live from the request's company: `payers.status` and `payers.role`, and
 * `employer_profiles.verification_status` and `gst_number_enc`, of `campus_drive_requests.payer_id`
 * (the tenant key: the org's anchor under tenancy `on`, the login itself otherwise). So every writer
 * that can change one of those four calls this, IN ITS OWN TRANSACTION, right after its write: the
 * requests move in the feed with the change and Campus pulls them again, stripped or restored.
 * (A `GREATEST` over the three tables' `updated_at` did not: the request is stamped by the
 * database's clock, the company rows by the api host's, so a later change could leave
 * `changed_at` where it was, and Campus, upserting by id, kept the stale item.)
 *
 * WHICH REQUESTS. Those whose `payer_id` is a row the writer changed. That is exactly the set the
 * R2 rule reads that row for: a request reads the standing of its own `payer_id` and of nothing
 * else, so passing the ids of the `payers` / `employer_profiles` rows that moved bumps every
 * request whose standing can have changed (a company's archive passes the anchor and each team
 * login it archived) and none other. Served by `campus_drive_requests_payer_idx`.
 *
 * LOCK ORDER payers → requests: the caller has already written (so row-locked) the `payers` or
 * `employer_profiles` row; this then takes the request rows. A Campus decision and a company's
 * cancel lock only the request row and take no lock on `payers` or `employer_profiles` (their
 * reads of the company are plain joins, `FOR UPDATE OF campus_drive_requests`; their event and
 * audit inserts reference neither table), and a create's insert takes only `FOR KEY SHARE` on its
 * `payers` row, which a status write (`FOR NO KEY UPDATE`) does not block. So no cycle.
 *
 * The stamp is the database's clock (`clock_timestamp()`), the same as every request write.
 * `campus-drive-standing-writers.static.test.ts` fails a file that writes one of those columns
 * without calling this.
 */
export async function restampCompanyDriveRequests(
  tx: Database,
  payerIds: readonly string[],
): Promise<void> {
  if (payerIds.length === 0) return;
  await tx
    .update(campusDriveRequests)
    .set({ updatedAt: sql`clock_timestamp()` })
    .where(inArray(campusDriveRequests.payerId, [...payerIds]));
}
