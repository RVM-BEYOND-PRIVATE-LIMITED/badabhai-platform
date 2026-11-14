import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { campusDriveRequests, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The erased state `cdr_contact_chk` allows; stamped when the statement runs. */
const ERASED = {
  contactNameEnc: null,
  contactPhoneEnc: null,
  contactErasedAt: sql`clock_timestamp()`,
  updatedAt: sql`clock_timestamp()`,
};

/**
 * #2746 PR 6 — DPDP ERASURE OF A CAMPUS-DRIVE CONTACT. DATABASE ACCESS ONLY.
 *
 * The contact person's name and phone are personal data, possibly of someone with no BadaBhai
 * account. Erasing them keeps the request (its dates, status and Campus reference are the company's
 * record and the placement team's) and leaves exactly what `cdr_contact_chk` allows: both
 * ciphertexts NULL, `contact_erased_at` set. `updated_at` moves, so Campus's feed carries the
 * request again with `contact: null` and Campus learns to drop its own copy.
 *
 * WHERE IT RUNS TODAY. `PayerAccountDeletionService` (the only payer erasure that exists, the
 * QA-only `POST /payer/me/delete/immediate`) calls {@link eraseEnteredBy} on the SAME transaction
 * as the login's row delete, so the erasure commits only if the delete does: the requests of the
 * login's OWN tenant go with the `payers` row (`ON DELETE CASCADE`), but under
 * `PAYER_ORG_TENANCY_MODE=on` a team member's requests belong to the company's tenant key and
 * would otherwise keep the contact that member typed. {@link eraseOne} is for an ops
 * erasure of one request on the contact person's own request; no route calls it yet.
 *
 * Provided by `PayersModule` (the deletion service's module) rather than imported from
 * `CampusDrivesModule`: its only dependency is the @Global DATABASE, and importing the feature
 * module there would close a cycle (`CampusDrivesModule` imports `PayersModule`).
 */
@Injectable()
export class CampusDriveContactErasureRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Erase the contact on every request `payerId` entered (`created_by`). Returns how many. */
  async eraseEnteredBy(payerId: string, executor: Database = this.db): Promise<number> {
    const rows = await executor
      .update(campusDriveRequests)
      .set(ERASED)
      .where(
        and(
          eq(campusDriveRequests.createdBy, payerId),
          isNull(campusDriveRequests.contactErasedAt),
        ),
      )
      .returning({ id: campusDriveRequests.id });
    return rows.length;
  }

  /** Erase one request's contact. `false` when there is no such request or it was erased already. */
  async eraseOne(id: string, executor: Database = this.db): Promise<boolean> {
    const rows = await executor
      .update(campusDriveRequests)
      .set(ERASED)
      .where(and(eq(campusDriveRequests.id, id), isNull(campusDriveRequests.contactErasedAt)))
      .returning({ id: campusDriveRequests.id });
    return rows.length > 0;
  }
}
