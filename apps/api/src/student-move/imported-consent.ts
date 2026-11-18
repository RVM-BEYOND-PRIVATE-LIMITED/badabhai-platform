import { workerConsents, type Database, type WorkerConsent } from "@badabhai/db";
import type { ConsentPurpose } from "@badabhai/types";

/**
 * #2887 — the consent a moved student gave on Campus, stored as his BadaBhai consent row (owner
 * choice, 17 Nov 2026: an ACTIVE row, so a student an admin makes visible can be searched before he
 * ever signs in).
 *
 * THE VERSION SAYS WHERE IT CAME FROM. `consent_version` is `campus_import:<Campus text version>`
 * and `accepted_at` is the date he consented on Campus: the ruling's "source campus_import and the
 * Campus consent text version and date", with no new column. It names no BadaBhai notice version,
 * so every rule keyed to a BadaBhai notice (the brief's contact rules, the employer-sharing notice
 * list) reads it as an older notice: the conservative answer.
 *
 * FIRST SIGN-IN STILL ASKS. Sign-in reports `consent_accepted: false` while his latest consent is
 * this imported one ({@link isImportedConsent}), so the worker app shows BadaBhai's own consent
 * screen, with the 18+ tick (#2541), once. Accepting writes an ordinary row that supersedes this
 * one; an under-18 answer withdraws everything, this row included.
 */

export const IMPORTED_CONSENT_PREFIX = "campus_import:";

/** The purposes a moved student holds from his Campus consent. */
export const IMPORTED_CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  "profiling",
  "resume_generation",
  "communication",
  "employer_sharing",
  "employer_messaging",
];

/** Campus's consent text version: short, printable, no separators that could forge a prefix. */
const CAMPUS_VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/** Was this consent row written by the student import? */
export function isImportedConsent(consentVersion: string | null | undefined): boolean {
  return typeof consentVersion === "string" && consentVersion.startsWith(IMPORTED_CONSENT_PREFIX);
}

/**
 * Write a moved student's Campus consent as his consent row, on the import's transaction. Append-
 * only, like every consent row: a later BadaBhai acceptance supersedes it by being newer.
 *
 * @throws RangeError for a malformed Campus version or an invalid date (nothing is written).
 */
export async function recordImportedConsent(
  tx: Database,
  workerId: string,
  input: { readonly campusConsentVersion: string; readonly campusConsentedAt: Date },
): Promise<WorkerConsent> {
  if (!CAMPUS_VERSION.test(input.campusConsentVersion)) {
    throw new RangeError("recordImportedConsent: malformed Campus consent version");
  }
  if (Number.isNaN(input.campusConsentedAt.getTime())) {
    throw new RangeError("recordImportedConsent: invalid Campus consent date");
  }
  const [row] = await tx
    .insert(workerConsents)
    .values({
      workerId,
      consentVersion: `${IMPORTED_CONSENT_PREFIX}${input.campusConsentVersion}`,
      purposes: [...IMPORTED_CONSENT_PURPOSES],
      acceptedAt: input.campusConsentedAt,
      ipHash: null,
      userAgent: null,
    })
    .returning();
  if (!row) throw new Error("recordImportedConsent: the consent row was not written");
  return row;
}
