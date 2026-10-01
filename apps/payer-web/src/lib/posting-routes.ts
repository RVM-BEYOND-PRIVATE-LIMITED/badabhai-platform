import { agencyFlags } from "./config";

/**
 * WHERE "Postings" AND "New posting" LEAD, per persona (owner ruling 2026-10-01).
 *
 * The label is the same for both personas — the job entity is a "Posting" everywhere — but the
 * entity behind it is not:
 *   - a COMPANY posts `job_postings` rows: `/postings`, `/postings/new`;
 *   - an AGENCY posts AGENCY jobs only — rows of the `jobs` table the worker feed reads:
 *     `/agency/jobs`, `/agency/jobs/new`. Those pages sit behind the agency-portal flag like
 *     every agency page, so with the flag off an agency has NO posting surface (`null`), and
 *     callers show no posting entry point rather than a link that 404s.
 *
 * Affordance only: every route keeps its own server gate. Labels only: no route or API path was
 * renamed to change a label.
 */
export interface PostingRoutes {
  /** The persona's postings list. */
  list: string;
  /** The persona's create form ("New posting"). */
  create: string;
}

export const COMPANY_POSTING_ROUTES: PostingRoutes = {
  list: "/postings",
  create: "/postings/new",
};

export const AGENCY_POSTING_ROUTES: PostingRoutes = {
  list: "/agency/jobs",
  create: "/agency/jobs/new",
};

export function postingRoutes(isAgency: boolean): PostingRoutes | null {
  if (!isAgency) return COMPANY_POSTING_ROUTES;
  return agencyFlags().agencyPortalEnabled ? AGENCY_POSTING_ROUTES : null;
}

/**
 * Where an AGENT who opens the company-only posting surface directly is sent: their own
 * postings (or create form), or the dashboard when the agency surface is switched off.
 */
export function agentPostingRedirect(target: keyof PostingRoutes): string {
  return postingRoutes(true)?.[target] ?? "/dashboard";
}
