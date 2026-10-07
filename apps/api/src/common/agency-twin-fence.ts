import { ConflictException } from "@nestjs/common";

/**
 * THE ONE BODY every ops write fence answers with (ADR-0050 §4.3). Identical on every route, so a
 * caller learns that the posting is system-managed and nothing else.
 */
export const AGENCY_TWIN_READ_ONLY_MESSAGE =
  "This job posting is system-managed and cannot be changed here";

/**
 * ADR-0050 §4.3 — ONLY THE SYNC WRITES A TWIN. Every other `job_postings` writer calls this on
 * the row it is about to change and refuses a twin (`sync_source` set) with the identical 409:
 * the ops edit / close / verify / reject routes, the ADR-0036 ops-widen, the ops admin
 * force-close, and the posting plan / boost purchase. The PAYER routes need no call: a twin's
 * `payer_id` is NULL, so their ownership scoping already answers the neutral 404.
 *
 * An edit to an agency vacancy goes through the agency job (`/payer/agency/jobs`, or the ops
 * match-skill route), and the sync carries it to the twin.
 */
export function assertNotAgencyTwin(syncSource: string | null | undefined): void {
  if (syncSource !== null && syncSource !== undefined) {
    throw new ConflictException(AGENCY_TWIN_READ_ONLY_MESSAGE);
  }
}
