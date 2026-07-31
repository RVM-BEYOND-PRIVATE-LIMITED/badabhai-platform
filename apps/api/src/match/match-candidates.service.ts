import { Injectable } from "@nestjs/common";
import { effectiveTier, type RankInputs } from "@badabhai/match-engine";
import { matchSkillLabel } from "@badabhai/taxonomy";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository, type CandidateRow } from "./match-feed.repository";
import { OPS_LIST_CAP } from "../common/pagination";

/**
 * One ranked candidate on the company's paid list. FACELESS: an opaque `workerId` and
 * the frozen rank inputs — no name, no phone, no employer, no photo. Identity is bought
 * separately through the `/payer/unlocks` chokepoint.
 */
export interface MatchCandidateRowDto {
  workerId: string;
  applicationId: string;
  rank: number;
  /**
   * THE RAW TIER, always (E18). 2 means "he holds a related skill, not the one you
   * posted" and the card must badge it — "CNC Turner — related to VMC Operator" — even
   * when the floor promoted him into tier-1 ordering. The company opted into that
   * breadth and should see plainly what it is looking at before spending ₹40.
   */
  matchTier: number | null;
  /**
   * The tier he was ORDERED by, after the tier-with-floor ruling. Surfaced so the list's
   * order is explainable from the row itself rather than only reproducible by re-running
   * the rule — the payer-facing claim is "he has the skill and more months on it", and
   * that sentence has to be checkable.
   */
  effectiveTier: number | null;
  skillMonths: number | null;
  industryMonths: number | null;
  lastWorkedAt: string | null;
  /** E18's badge text — the label of the skill he actually matched on, when known. */
  matchedSkillLabel: string | null;
  /** The rule version that produced these numbers (Policy 24). */
  engineVersion: string | null;
}

export interface MatchCandidateListDto {
  jobId: string;
  applicants: MatchCandidateRowDto[];
}

/**
 * MOMENT ⑥ — "Company opens the list. Pure indexed sort."
 *
 * WHAT CHANGED, AND WHY IT IS A BUG FIX RATHER THAN A FEATURE. The shipped
 * `GET /payer/reach/jobs/:jobId/applicants` ranks the ENTIRE WORKER POOL — it calls
 * `rankWorkersForJob(jobSpec, everyWorkerSignalRow)` and returns all of them. Nobody on
 * that list applied to anything. The spec's moment ⑥ is
 * `SELECT * FROM application WHERE job_id = :job`, and the ADR calls it "the company's
 * paid candidate list". So this re-sources it to the ACTUAL APPLICANTS.
 *
 * That is a real behaviour change, and it is deliberate: where the spec and the existing
 * code disagree, the spec wins. It only takes effect behind `MATCH_V1_ENABLED`.
 *
 * THE ORDER IS THE SQL'S, NOT THIS SERVICE'S. `MatchFeedRepository.listCandidates`
 * returns rows already in rank order out of `applications_rank_idx`; nothing here
 * re-sorts. `effectiveTier` is recomputed per row ONLY to LABEL what the SQL did — if
 * this service sorted, there would be three implementations of one rule instead of two.
 */
@Injectable()
export class MatchCandidatesService {
  constructor(
    private readonly repo: MatchFeedRepository,
    private readonly config: MatchConfigService,
  ) {}

  async listForPosting(jobPostingId: string): Promise<MatchCandidateListDto> {
    const cfg = await this.config.get();
    const rows = await this.repo.listCandidates(jobPostingId, cfg.tierFloorMonths, OPS_LIST_CAP);

    return {
      jobId: jobPostingId,
      applicants: rows.map((row, index) => ({
        workerId: row.workerId,
        applicationId: row.applicationId,
        rank: index + 1,
        matchTier: row.matchTier,
        effectiveTier:
          row.matchTier === null
            ? null
            : effectiveTier(
                row.matchTier === 1 ? 1 : 2,
                row.skillMonths ?? 0,
                cfg.tierFloorMonths,
              ),
        skillMonths: row.skillMonths,
        industryMonths: row.industryMonths,
        lastWorkedAt: row.lastWorkedAt,
        matchedSkillLabel:
          row.matchedSkillId === null ? null : (matchSkillLabel(row.matchedSkillId) ?? null),
        engineVersion: row.engineVersion,
      })),
    };
  }

  /**
   * The SAME rows mapped onto the engine's `RankInputs`. Exists so the integration test
   * can hand the SQL's output to `rankKeyCompare` and assert the two agree; it is not
   * used to serve anything, because sorting here would defeat the index the whole
   * "every read is an indexed sort" design is built on.
   *
   * The mapping pins the null semantics that the SQL's `COALESCE(x, -1)` encodes: a NULL
   * month count is UNKNOWN, and unknown sorts below a real 0 rather than tying with it.
   */
  static toRankInputs(rows: readonly CandidateRow[]): RankInputs[] {
    return rows.map((row) => ({
      matchTier: row.matchTier === 1 ? 1 : 2,
      skillMonths: row.skillMonths ?? -1,
      industryMonths: row.industryMonths ?? -1,
      lastWorkedAt: row.lastWorkedAt,
      lastActiveAt: row.createdAt.toISOString(),
      id: row.applicationId,
    }));
  }
}

/** Re-exported for the parity test so it names one source for the label lookup. */
export { matchSkillLabel };
