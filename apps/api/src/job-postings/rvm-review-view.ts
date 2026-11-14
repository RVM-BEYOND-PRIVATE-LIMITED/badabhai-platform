import {
  rvmReviewStateFor,
  type InstituteReviewState,
  type JobPostingAudience,
} from "@badabhai/db";

/**
 * #2746 — a posting's RVM review as its company (and the admin console) reads it. `reason` is the
 * placement team's own note to the company on a decision, shown verbatim and never logged.
 * A pending review carries neither field: there is no decision to explain.
 */
export interface RvmReviewView {
  state: InstituteReviewState;
  reviewed_at?: Date;
  reason?: string;
}

/** The review row as a reader fetched it (`PostingAudienceRepository.reviewStatesFor` shape). */
export interface RvmReviewFacts {
  stateNow: InstituteReviewState | null;
  reason: string | null;
  reviewedAt: Date | null;
}

/**
 * ONE mapping for every reader: `null` when the audience has no RVM part, `{ state: "pending" }`
 * for an RVM audience with no row or with a decision on older content (the live-hash rule already
 * folded into `stateNow`), and the decision's time and note only while the decision still holds.
 */
export function rvmReviewView(
  audience: JobPostingAudience,
  facts: RvmReviewFacts | undefined,
): RvmReviewView | null {
  const state = rvmReviewStateFor(audience, facts?.stateNow ?? null);
  if (state === null) return null;
  if (state === "pending" || facts === undefined) return { state };
  return {
    state,
    ...(facts.reviewedAt !== null ? { reviewed_at: facts.reviewedAt } : {}),
    ...(facts.reason !== null ? { reason: facts.reason } : {}),
  };
}
