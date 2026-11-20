import {
  HIRE_STATUSES,
  type ApplicantPostingKind,
  type HireStatus,
} from "@badabhai/types";

/**
 * The hire-record vocabulary, client-safe.
 *
 * The read layer, the list page and its filter bar all name the same closed values. Keeping the
 * labels here means a `"use client"` filter bar does not import `lib/hires.ts` (which is
 * `server-only` just to reach `adminFetch`).
 */
export { HIRE_STATUSES };
export type { HireStatus };

export const HIRE_STATUS_LABELS: Readonly<Record<HireStatus, string>> = {
  reported: "Reported",
  confirmed: "Confirmed",
  rejected: "Rejected",
};

export const HIRE_POSTING_KIND_LABELS: Readonly<Record<ApplicantPostingKind, string>> = {
  company_posting: "Company posting",
  agency_job: "Agency job",
};
