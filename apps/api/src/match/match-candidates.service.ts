import { Inject, Injectable } from "@nestjs/common";
import { effectiveTier, type RankInputs } from "@badabhai/match-engine";
import {
  LEVEL_FIT_ORDER,
  levelFitFor,
  levelNeededSpec,
  matchSkillLabel,
  TRADE_LEVEL_LABELS,
  type LevelFit,
  type LevelNeededSpec,
  type TradeLevel,
} from "@badabhai/taxonomy";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository, type CandidateRow, type LevelSorts } from "./match-feed.repository";
import { levelNeededSortEnabled, type LevelNeededSortConfig } from "./level-needed-sort.flag";
import { OPS_LIST_CAP } from "../common/pagination";
import { SERVER_CONFIG } from "../config/config.module";
import type { TenantKey } from "../payers/payer-tenant-scope";

/**
 * One ranked candidate on the company's paid list. FACELESS: an opaque `workerId` and
 * the frozen rank inputs — no name, no phone, no employer, no photo. Identity is bought
 * separately through the `/payer/unlocks` chokepoint. A worker pending deletion is never
 * a row (ADR-0031 (b); `MatchFeedRepository.listCandidates`).
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
  /**
   * Middle Way P5 — the rungs he stated, per trade skill, for the level badge.
   * Display-only, like `matchedSkillLabel`: never a rank input, and an empty array
   * when he stated none. The card picks the rung for the trade it is showing; the
   * API hands over every rung with both labels resolved so the card never does.
   */
  tradeLevels: TradeLevelBadge[];
  /**
   * Engine v1.1 "Level needed" (CEO ruling 30 Oct 2026, ADR-0061) — where his rung, FROZEN at
   * apply, puts him against the posting's minimum rung: `meets` (sorted first), `not_confirmed`
   * (middle; the card tags it "Level not confirmed"), `below` (last). NULL when the list has no
   * level sort — "Any level", a trade the sort is not on for, or `LEVEL_NEEDED_SORT_ENABLED` off.
   * Labels the order the SQL produced; nothing here sorts. ADDITIVE: absent from older clients'
   * schemas, always present (possibly null) on this one.
   */
  levelFit: LevelFit | null;
}

/** One rung on the candidate's card — closed vocabularies, both resolved server-side. */
export interface TradeLevelBadge {
  /** The trade skill the rung sits on (an `mskill_*` id). */
  skillId: string;
  /** The trade's display label, when the taxonomy knows it. */
  skillLabel: string | null;
  /** The stored rung key. */
  tradeLevel: string;
  /** The printed rung ("Setter"), or the raw key when the taxonomy does not know it. */
  tradeLevelLabel: string;
  /** True once the separating question was answered (Setter and above only). */
  levelConfirmed: boolean;
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
 * code disagree, the spec wins. With `MATCH_V1_ENABLED` on it serves every payer posting
 * list; with it off it serves a company's OWNED posting only (#1823 owner decision O8, via
 * `PayerApplicantsService`). An agency `jobs` row lists ITS appliers, weighted by the reach
 * core (#1898), whatever the flag says.
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
    // Engine v1.1 — `LEVEL_NEEDED_SORT_ENABLED`. Optional only so a hand-built instance (a unit
    // test) without it fails closed to today's list; Nest always injects the global config.
    @Inject(SERVER_CONFIG) private readonly serverConfig?: LevelNeededSortConfig,
  ) {}

  async listForPosting(jobPostingId: string): Promise<MatchCandidateListDto> {
    const cfg = await this.config.get();
    const levelSorts = await this.levelSortsFor([jobPostingId]);
    // One posting, so at most one spec. Read back by value, not by the route's spelling of the id
    // (the map is keyed by the id as Postgres prints it).
    const spec = levelSorts.values().next().value ?? null;
    const rows = await this.repo.listCandidates(
      jobPostingId,
      cfg.tierFloorMonths,
      OPS_LIST_CAP,
      levelSorts,
    );

    return {
      jobId: jobPostingId,
      applicants: rows.map((row, index) =>
        toMatchCandidateRowDto(row, index + 1, cfg.tierFloorMonths, spec),
      ),
    };
  }

  /**
   * The "Level needed" sort of each named posting (engine v1.1, ADR-0061), keyed by posting id as
   * Postgres prints it. EMPTY — and NO QUERY — while `LEVEL_NEEDED_SORT_ENABLED` is off, so the
   * flag-off list is the v1.0 list query for query. A posting appears only when its trade is one of
   * `LEVEL_SORT_TRADE_KINDS` AND it names a rung that trade's ladder knows; every other posting —
   * "Any level" included — keeps the v1.0 order (`levelNeededSpec` returns null for it).
   *
   * The DECISION lives here, not in SQL: which trades, which rung, which groups. The repository
   * only applies the groups it is handed.
   */
  private async levelSortsFor(postingIds: readonly string[]): Promise<Map<string, LevelNeededSpec>> {
    const sorts = new Map<string, LevelNeededSpec>();
    if (!levelNeededSortEnabled(this.serverConfig) || postingIds.length === 0) return sorts;
    for (const posting of await this.repo.listPostingLevels(postingIds)) {
      const spec = levelNeededSpec(posting.roleKind, posting.tradeLevel);
      if (spec !== null) sorts.set(posting.id, spec);
    }
    return sorts;
  }

  /**
   * The cross-posting inbox's company rows (`GET /payer/reach/applicants`): for each named
   * application on a posting the TENANT owns (the caller's resolved key, ADR-0053), the row
   * {@link listForPosting} would show for it — built by the SAME mapper, with the rank it holds
   * on its own posting's list (the repository's `row_number()` over the shared rank keys).
   * Keyed by application id.
   *
   * An application that is not (or no longer) on its posting's list — another tenant's posting,
   * a skip, a worker who entered the deletion grace window since the page was read — is simply
   * absent from the map. Nothing here re-sorts or re-ranks.
   */
  async rowsForOwnedApplications(
    tenant: TenantKey,
    refs: ReadonlyArray<{ applicationId: string; postingId: string }>,
  ): Promise<Map<string, MatchCandidateRowDto>> {
    if (refs.length === 0) return new Map();
    const cfg = await this.config.get();
    const postingIds = [...new Set(refs.map((r) => r.postingId))];
    const levelSorts: LevelSorts = await this.levelSortsFor(postingIds);
    const rows = await this.repo.listRankedCandidatesByApplication(
      tenant,
      postingIds,
      refs.map((r) => r.applicationId),
      cfg.tierFloorMonths,
      levelSorts,
    );
    return new Map(
      rows.map((row) => [
        row.applicationId,
        toMatchCandidateRowDto(
          row,
          row.rank,
          cfg.tierFloorMonths,
          levelSorts.get(row.jobPostingId) ?? null,
        ),
      ]),
    );
  }

  /**
   * The SAME rows mapped onto the engine's `RankInputs`. Exists so the integration test
   * can hand the SQL's output to `rankKeyCompare` and assert the two agree; it is not
   * used to serve anything, because sorting here would defeat the index the whole
   * "every read is an indexed sort" design is built on.
   *
   * The mapping pins the null semantics that the SQL's `COALESCE(x, -1)` encodes: a NULL
   * month count is UNKNOWN, and unknown sorts below a real 0 rather than tying with it.
   *
   * Engine v1.1: with the posting's level `spec`, every row carries `levelOrder` from the FROZEN
   * rung — the same `levelFitFor` that labels `levelFit` — and without one no row does, so the
   * comparator is v1.0's.
   */
  static toRankInputs(
    rows: readonly CandidateRow[],
    spec: LevelNeededSpec | null = null,
  ): RankInputs[] {
    return rows.map((row) => ({
      matchTier: row.matchTier === 1 ? 1 : 2,
      skillMonths: row.skillMonths ?? -1,
      industryMonths: row.industryMonths ?? -1,
      lastWorkedAt: row.lastWorkedAt,
      lastActiveAt: row.createdAt.toISOString(),
      id: row.applicationId,
      ...(spec === null
        ? {}
        : {
            levelOrder:
              LEVEL_FIT_ORDER[levelFitFor(spec, row.frozenTradeLevel, row.frozenLevelConfirmed)],
          }),
    }));
  }
}

/**
 * ONE candidate row → the faceless {@link MatchCandidateRowDto}. The ONLY place that shape is
 * built: the per-posting list and the cross-posting inbox both call it, so a field added here
 * reaches both and a field added beside it reaches one (which
 * `payer-applicant-inbox.service.test.ts` reports). `effectiveTier` only LABELS the order the
 * SQL produced; nothing here sorts.
 */
export function toMatchCandidateRowDto(
  row: CandidateRow,
  rank: number,
  tierFloorMonths: number,
  levelSpec: LevelNeededSpec | null = null,
): MatchCandidateRowDto {
  return {
    workerId: row.workerId,
    applicationId: row.applicationId,
    rank,
    matchTier: row.matchTier,
    effectiveTier:
      row.matchTier === null
        ? null
        : effectiveTier(row.matchTier === 1 ? 1 : 2, row.skillMonths ?? 0, tierFloorMonths),
    skillMonths: row.skillMonths,
    industryMonths: row.industryMonths,
    lastWorkedAt: row.lastWorkedAt,
    matchedSkillLabel:
      row.matchedSkillId === null ? null : (matchSkillLabel(row.matchedSkillId) ?? null),
    engineVersion: row.engineVersion,
    tradeLevels: row.tradeLevels.map(toTradeLevelBadge),
    levelFit:
      levelSpec === null
        ? null
        : levelFitFor(levelSpec, row.frozenTradeLevel, row.frozenLevelConfirmed),
  };
}

/**
 * One stored rung → the card's badge facts. Both labels resolve here so the card
 * never maps ids: an unknown skill prints no trade name (null, not a guess), and
 * an unknown rung prints its own key (visible, so a bad row is reviewable rather
 * than silently blank).
 */
function toTradeLevelBadge(row: {
  skillId: string;
  tradeLevel: string;
  levelConfirmed: boolean;
}): TradeLevelBadge {
  return {
    skillId: row.skillId,
    skillLabel: matchSkillLabel(row.skillId) ?? null,
    tradeLevel: row.tradeLevel,
    tradeLevelLabel:
      TRADE_LEVEL_LABELS[row.tradeLevel as TradeLevel] ?? row.tradeLevel,
    levelConfirmed: row.levelConfirmed,
  };
}

/** Re-exported for the parity test so it names one source for the label lookup. */
export { matchSkillLabel };
