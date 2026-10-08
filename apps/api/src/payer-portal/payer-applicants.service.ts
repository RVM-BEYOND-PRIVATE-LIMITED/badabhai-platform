import { Injectable, NotFoundException } from "@nestjs/common";
import type { ApplicantStage } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { ReachService } from "../reach/reach.service";
import type { ApplicantListResponseDto, ApplicantRowDto } from "../reach/reach.dto";
import {
  MatchCandidatesService,
  type MatchCandidateListDto,
  type MatchCandidateRowDto,
} from "../match/match-candidates.service";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerTenantScope } from "../payers/payer-tenant-scope";
import { PayerApplicantStagesService, withStages } from "./payer-applicant-stages.service";
import { APPLICANT_NOT_FOUND } from "./payer-applicant-stage.dto";

/** A feed row with its pipeline stage — only while `PAYER_APPLICANT_STAGES_ENABLED` is on. */
export type StagedRow<R> = R & { stage: ApplicantStage };

/**
 * The list shapes `GET /payer/reach/jobs/:jobId/applicants` can return. payer-web already parses
 * the two base shapes (`apps/payer-web/src/lib/contracts.ts`): the weighted list of the workers
 * who applied to an agency `jobs` row (#1898), the actual-applicant list for a company posting.
 * With `PAYER_APPLICANT_STAGES_ENABLED` on, every row additionally carries `stage` (owner ruling
 * 2026-10-07) — appended, nothing else in the row changes; with it off the shapes are exactly
 * the base ones.
 */
export type PayerApplicantListDto =
  | ApplicantListResponseDto
  | MatchCandidateListDto
  | { jobId: string; applicants: StagedRow<ApplicantRowDto>[] }
  | { jobId: string; applicants: StagedRow<MatchCandidateRowDto>[] };

/**
 * The ONE message every not-listable id gets — unknown, another tenant's job, another tenant's
 * posting — so the error object the client receives is identical for all three (F-3
 * no-oracle). Shared with the stage route.
 */
const NOT_FOUND = APPLICANT_NOT_FOUND;

/**
 * The payer's applicant list for an id they OWN (ADR-0019 R22; ADR-0036 moment ⑥; #1823).
 *
 * SOURCE SELECTION — the id is resolved in this order, and the first owner-scoped hit wins.
 * The result does NOT depend on `MATCH_V1_ENABLED` (#1898): before it, flag-on skipped step 1,
 * so an agency's own job 404'd ("No posting found here").
 *  1. an owned `jobs` row (agency / seed) → the workers who APPLIED to it
 *     (`applications.job_id`, `action = 'applied'`), weighted by the RANK core, with its
 *     payer-actor `feed.shown` (#1898; formerly the whole eligible worker pool).
 *  2. otherwise an owned `job_postings` row → that posting's ACTUAL applicants, through
 *     `listForPosting` — the same read V1 uses. NOT gated by `FEED_POSTINGS_UNION_ENABLED`
 *     (owner decision O8): disarming the worker-feed union must never hide people who already
 *     applied. Snapshot-less applications sort last (the SQL's LEFT JOIN + COALESCE).
 *  3. otherwise → the identical neutral 404.
 *
 * Both sources list only people who applied; neither ever lists a worker who did not.
 *
 * AUTHZ: the verified SESSION payer (never a route/body value) is resolved to its tenancy ONCE
 * per request (ADR-0053, `PayerTenantScopeService`). The TENANT KEY is consumed only in the
 * ownership WHEREs (`jobs.payer_id`, `job_postings.payer_id`, and the board's chokepoint); the
 * ACTING LOGIN only as the agency list's `feed.shown` actor. A payer can list applicants only for
 * an id their tenant owns; a foreign id is indistinguishable from an unknown one. With org
 * tenancy off the tenant is the session payer, exactly as before.
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
 * ADR-0031 (b): a worker pending deletion is never listed on either source —
 * `ReachRepository.listApplicantSignalRowsForJob` and `MatchFeedRepository.listCandidates` both
 * exclude him in the SQL.
 *
 * STAGES (owner ruling 2026-10-07): with `PAYER_APPLICANT_STAGES_ENABLED` on, each row also
 * carries its `stage` on the payer's saved New / Shortlist / Passed board (`new` when nobody has
 * moved him), read from `payer_applicant_stages` for the resolved posting kind. The board never
 * filters or reorders the list — a passed applicant is still listed, labelled `passed`; what to
 * show under which tab is the client's call. Off, the rows are exactly the base shapes.
 */
@Injectable()
export class PayerApplicantsService {
  constructor(
    private readonly reach: ReachService,
    private readonly jobPostings: JobPostingsService,
    // ADR-0036 moment ⑥ — the actual-applicant source.
    private readonly matchCandidates: MatchCandidatesService,
    // Owner ruling 2026-10-07 — the saved pipeline board (null reads while the flag is off).
    private readonly stages: PayerApplicantStagesService,
    // ADR-0053 — the payer tenant resolver (PayersModule).
    private readonly tenancy: PayerTenantScopeService,
  ) {}

  async listForOwned(
    jobId: string,
    actorPayerId: string,
    ctx: RequestContext,
  ): Promise<PayerApplicantListDto> {
    const scope = await this.tenancy.resolve(actorPayerId);
    // THE BOARD IS READ FIRST, and only while PAYER_APPLICANT_STAGES_ENABLED is on (`null`, no
    // query, while off). The agency list below emits `feed.shown` as its last step, so reading
    // the stages before it keeps "a failed request emitted nothing" true: nothing fallible runs
    // after the emit. The read resolves the posting through the ownership chokepoint first
    // (`findOwnedJobRef`, ADR-0053 §4), so for an unknown or foreign id it reads no board at all
    // and is empty, and the 404 below is unchanged.
    const stages = await this.stages.stagesForOwnedPosting(jobId, scope.tenantKey);
    // ONE ownership read decides the source, whatever MATCH_V1_ENABLED says (#1898): an owned
    // `jobs` row lists its appliers; a miss (unknown or another tenant's job) falls through to
    // the posting seam.
    const jobList = await this.reach.tryApplicantsForOwnedJob(jobId, scope, ctx);
    if (jobList) {
      return stages
        ? { ...jobList, applicants: withStages(jobList.applicants, stages.agency_job) }
        : jobList;
    }
    const postingList = await this.listForOwnedPosting(jobId, scope);
    return stages
      ? { ...postingList, applicants: withStages(postingList.applicants, stages.company_posting) }
      : postingList;
  }

  private async listForOwnedPosting(
    postingId: string,
    scope: PayerTenantScope,
  ): Promise<MatchCandidateListDto> {
    await this.assertOwnsPosting(postingId, scope);
    return this.matchCandidates.listForPosting(postingId);
  }

  /**
   * The SAME no-oracle ownership read the rest of the payer posting surface uses. Its own 404
   * says "Job posting not found"; it is re-thrown as {@link NOT_FOUND} so a posting miss and a
   * job miss carry one body.
   */
  private async assertOwnsPosting(postingId: string, scope: PayerTenantScope): Promise<void> {
    try {
      await this.jobPostings.getOneInScope(postingId, scope);
    } catch (err) {
      if (err instanceof NotFoundException) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
  }
}
