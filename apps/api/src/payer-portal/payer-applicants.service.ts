import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isMatchV1Enabled, type ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { ReachService } from "../reach/reach.service";
import type { ApplicantListResponseDto } from "../reach/reach.dto";
import {
  MatchCandidatesService,
  type MatchCandidateListDto,
} from "../match/match-candidates.service";
import { JobPostingsService } from "../job-postings/job-postings.service";

/**
 * The two list shapes `GET /payer/reach/jobs/:jobId/applicants` can return. payer-web
 * already parses both (`apps/payer-web/src/lib/contracts.ts`): the weighted full-pool
 * list for an agency `jobs` row, the actual-applicant list for a company posting.
 */
export type PayerApplicantListDto = ApplicantListResponseDto | MatchCandidateListDto;

/**
 * The ONE message every not-listable id gets — unknown, another payer's job, another payer's
 * posting. It is the message `ReachService.applicantsForOwnedJob` throws, so the error object
 * the client receives is identical for all three (F-3 no-oracle).
 */
const NOT_FOUND = "Job not found";

/**
 * The payer's applicant list for an id they OWN (ADR-0019 R22; ADR-0036 moment ⑥; #1823).
 *
 * SOURCE SELECTION — the id is resolved in this order, and the first owner-scoped hit wins:
 *  1. `MATCH_V1_ENABLED` on → the V1 branch, unchanged: an owned posting's ACTUAL applicants
 *     in frozen-rank order.
 *  2. otherwise an owned `jobs` row (agency / seed) → the weighted full-pool list, unchanged,
 *     with its payer-actor `feed.shown`.
 *  3. otherwise an owned `job_postings` row → that posting's ACTUAL applicants, through the
 *     same `listForPosting` V1 uses. NOT gated by `FEED_POSTINGS_UNION_ENABLED` (owner
 *     decision O8): disarming the worker-feed union must never hide people who already
 *     applied. Snapshot-less applications sort last (the SQL's LEFT JOIN + COALESCE).
 *  4. otherwise → the identical neutral 404.
 *
 * AUTHZ: `payerId` is the verified SESSION payer, never a route/body value, and it is consumed
 * only in the two ownership WHEREs (`jobs.payer_id`, `job_postings.payer_id`). A payer can list
 * applicants only for an id they own; a foreign id is indistinguishable from an unknown one.
 *
 * FAIL CLOSED: only `NotFoundException` is translated into the neutral 404. Any other error
 * (a dropped connection, a statement timeout) propagates as a 5xx. The controller this replaced
 * swallowed EVERY error into a 404, which reported a DB outage as "you own nothing".
 *
 * NO `feed.shown` on either posting branch (the V1 precedent): a company looking at people who
 * already applied is not a feed impression. The read is therefore RATE-LIMITED, not durably
 * audited: the controller's hourly reach cap is a Redis counter that expires each hour, and no
 * event or access log records a posting-list read. Only the legacy `jobs` list leaves a trace
 * (its payer-actor `feed.shown`). A durable read trail would be a new versioned event, never a
 * reused `feed.shown`.
 *
 * ADR-0031 (b): a worker pending deletion is never listed on either source — the legacy pool
 * and `MatchFeedRepository.listCandidates` both exclude him in the SQL.
 */
@Injectable()
export class PayerApplicantsService {
  constructor(
    private readonly reach: ReachService,
    private readonly jobPostings: JobPostingsService,
    // ADR-0036 moment ⑥ — the actual-applicant source.
    private readonly matchCandidates: MatchCandidatesService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async listForOwned(
    jobId: string,
    payerId: string,
    ctx: RequestContext,
  ): Promise<PayerApplicantListDto> {
    if (isMatchV1Enabled(this.config)) return this.listForOwnedPosting(jobId, payerId);

    // ONE ownership read decides the source: an owned `jobs` row is ranked from the row it
    // returned; a miss (unknown or another payer's job) falls through to the posting seam.
    const jobList = await this.reach.tryApplicantsForOwnedJob(jobId, payerId, ctx);
    return jobList ?? this.listForOwnedPosting(jobId, payerId);
  }

  private async listForOwnedPosting(
    postingId: string,
    payerId: string,
  ): Promise<MatchCandidateListDto> {
    await this.assertOwnsPosting(postingId, payerId);
    return this.matchCandidates.listForPosting(postingId);
  }

  /**
   * The SAME no-oracle ownership read the rest of the payer posting surface uses. Its own 404
   * says "Job posting not found"; it is re-thrown as {@link NOT_FOUND} so a posting miss and a
   * job miss carry one body.
   */
  private async assertOwnsPosting(postingId: string, payerId: string): Promise<void> {
    try {
      await this.jobPostings.getOneForPayer(postingId, payerId);
    } catch (err) {
      if (err instanceof NotFoundException) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }
}
