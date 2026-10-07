import { Injectable, Logger } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { ReachService } from "../reach/reach.service";
import type { ApplicantRowDto } from "../reach/reach.dto";
import { MatchCandidatesService } from "../match/match-candidates.service";
import {
  PayerApplicantInboxRepository,
  type InboxPageRow,
} from "./payer-applicant-inbox.repository";
import { encodeInboxCursor } from "./payer-applicant-inbox.cursor";
import type {
  InboxApplicantRowDto,
  PayerApplicantInboxDto,
  PayerApplicantInboxQueryDto,
} from "./payer-applicant-inbox.dto";

/**
 * The payer's CROSS-POSTING applicant inbox (`GET /payer/reach/applicants`, the payer-web
 * "Candidates" tab; owner request 2026-10-07): every applicant to every posting the SESSION
 * payer owns, newest application first, optionally one posting only.
 *
 * WHAT A ROW IS: the row the per-posting list (`GET /payer/reach/jobs/:jobId/applicants`,
 * `PayerApplicantsService.listForOwned`) shows for that applicant, built by THE SAME CODE, plus a
 * `posting` reference — so payer-web's applicant card and unlock flow take it unchanged:
 *  - agency `jobs` row → `ReachService.appliersForOwnedJobs`, which ranks each job's appliers
 *    with the RANK core exactly as the per-job list does (`ReachService.rankAppliers`);
 *  - company posting → `MatchCandidatesService.rowsForOwnedApplications`, the per-posting
 *    mapper over the posting's rank (`row_number()` over the shared rank keys).
 * `rank`/`hot` therefore stay POSTING-relative ("#2 on VMC Operator"), not inbox positions.
 *
 * READS, BOUNDED: one page read ({@link PayerApplicantInboxRepository.listPage}), then at most
 * three detail reads whatever the page holds — the owned jobs' signal rows and their appliers'
 * signal rows (two statements for all the page's agency jobs together), and the company rows
 * (one statement). No per-posting fan-out. The agency detail ranks each page job's WHOLE applier
 * set, because `rank`/`hot` are positions within it — the same work the per-job list does.
 *
 * AUTHZ: `payerId` is the verified session payer, consumed only in ownership WHEREs — the page
 * read's and, again, each detail read's. A `postingId` the payer does not own (or that does not
 * exist) gives the SAME `{ applicants: [], nextCursor: null }` as an owned posting nobody has
 * applied to: a filter on a collection, not a resource lookup, so there is no 404 to tell the
 * cases apart, and every case costs the same one page read (no existence oracle, and no timing
 * difference between "not yours" and "yours, empty").
 *
 * EVENTS: the per-posting list's posture, row for row. Each AGENCY row shown here emits the
 * `feed.shown` the per-job list emits for it (payer actor, payload `worker_id`/`job_id`/`rank`/
 * `score`/`hot` — the unchanged v1 schema), as one all-or-nothing batch. Company rows emit
 * nothing, as on their posting's list (an applicant is not a feed impression), so a company-only
 * page is rate-limited (the controller's reach cap) but not durably audited — the existing
 * RV-R5 residual. A durable read trail would be a NEW versioned event, never a reused one.
 *
 * FAIL CLOSED: any read error propagates (a 5xx) and nothing is emitted. A page row whose detail
 * is gone by the time it is read — the worker entered the deletion grace window between the two
 * reads — is left out rather than shown half-built; the cursor still advances past it.
 */
@Injectable()
export class PayerApplicantInboxService {
  private readonly logger = new Logger(PayerApplicantInboxService.name);

  constructor(
    private readonly repo: PayerApplicantInboxRepository,
    private readonly reach: ReachService,
    private readonly candidates: MatchCandidatesService,
  ) {}

  async list(
    payerId: string,
    query: PayerApplicantInboxQueryDto,
    ctx: RequestContext,
  ): Promise<PayerApplicantInboxDto> {
    // One row past the page says whether there is a next one, without a COUNT.
    const read = await this.repo.listPage(payerId, {
      postingId: query.postingId,
      after: query.cursor,
      limit: query.limit + 1,
    });
    const page = read.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      read.length > query.limit && last
        ? encodeInboxCursor({ appliedKey: last.appliedKey, applicationId: last.applicationId })
        : null;

    const agency = page.filter((r) => r.postingKind === "agency_job");
    const company = page.filter((r) => r.postingKind === "company_posting");
    const [appliersByJob, candidateByApplication] = await Promise.all([
      this.reach.appliersForOwnedJobs(uniquePostingIds(agency), payerId),
      this.candidates.rowsForOwnedApplications(
        payerId,
        company.map((r) => ({ applicationId: r.applicationId, postingId: r.postingId })),
      ),
    ]);
    const agencyRow = indexAppliers(appliersByJob);

    const applicants: InboxApplicantRowDto[] = [];
    const shown: { jobId: string; row: ApplicantRowDto }[] = [];
    for (const ref of page) {
      if (ref.postingKind === "agency_job") {
        const row = agencyRow(ref.postingId, ref.workerId);
        if (!row) continue;
        applicants.push({ ...row, posting: postingRef(ref, "agency_job") });
        shown.push({ jobId: ref.postingId, row });
      } else {
        const row = candidateByApplication.get(ref.applicationId);
        if (!row) continue;
        applicants.push({ ...row, posting: postingRef(ref, "company_posting") });
      }
    }

    const dropped = page.length - applicants.length;
    if (dropped > 0) {
      // Counts only: the rows left out are opaque ids nobody needs in a log line.
      this.logger.warn(`payer inbox: ${dropped} page row(s) had no detail row; left out`);
    }

    if (shown.length > 0) await this.reach.emitPayerFeedShown(shown, payerId, ctx);

    return { applicants, nextCursor };
  }
}

function uniquePostingIds(rows: readonly InboxPageRow[]): string[] {
  return [...new Set(rows.map((r) => r.postingId))];
}

/** `(jobId, workerId) → row` over the ranked lists, so the page loop is a lookup, not a scan. */
function indexAppliers(
  byJob: Map<string, ApplicantRowDto[]>,
): (jobId: string, workerId: string) => ApplicantRowDto | undefined {
  const index = new Map<string, Map<string, ApplicantRowDto>>();
  for (const [jobId, rows] of byJob) index.set(jobId, new Map(rows.map((r) => [r.workerId, r])));
  return (jobId, workerId) => index.get(jobId)?.get(workerId);
}

function postingRef<K extends InboxPageRow["postingKind"]>(ref: InboxPageRow, kind: K) {
  return { id: ref.postingId, title: ref.postingTitle, kind };
}
