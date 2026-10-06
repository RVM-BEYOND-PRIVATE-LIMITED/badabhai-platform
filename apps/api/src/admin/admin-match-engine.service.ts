import { Injectable, NotFoundException } from "@nestjs/common";
import { matchSkillLabel, relatedMatchSkills } from "@badabhai/taxonomy";
import { MatchFeedService } from "../match/match-feed.service";
import type { MatchFeedRow } from "../match/match-feed.repository";
import { MatchCandidatesService } from "../match/match-candidates.service";
import { MatchConfigService } from "../match/match-config.service";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import {
  AdminMatchEngineRepository,
  type EngineCardPostingMeta,
  type EngineFunnelCounts,
} from "./admin-match-engine.repository";
import {
  ENGINE_CARD_CAP,
  ENGINE_SHORT_REF_LENGTH,
  type EngineCardDto,
  type EngineFunnelDto,
  type EnginePostingViewDto,
  type EngineRecentWorkersResponseDto,
  type EngineSkillRefDto,
  type EngineWorkerViewDto,
} from "./admin-match-engine.dto";

/**
 * The admin ENGINE VIEW — Matching V1 made visible, read-only.
 *
 * ── IT SHOWS THE ENGINE; IT IS NOT A SECOND ENGINE ──────────────────────────────────────
 * The cards are {@link MatchFeedService.composePage} — the very method `GET /feed` serves
 * from (repository ORDER BY, overfetch, E14 interleave, truncation) — and the candidate list
 * is {@link MatchCandidatesService.listForPosting}, the payer's own list. Nothing here sorts,
 * scores or filters a match. If the feed's order changes, this screen changes with it; a
 * copy of the ORDER BY here would be a screen that could disagree with the product while
 * claiming to explain it. The worker's own feed FILTERS (city / shift / pay) are request
 * parameters he sends, not stored state, so the view shows the unfiltered feed.
 *
 * ── NO EVENTS ───────────────────────────────────────────────────────────────────────────
 * `composePage` emits nothing, deliberately: an admin looking at a worker's feed is not the
 * worker being shown it, and a `feed.shown_v2` from here would corrupt the impressions the
 * ranking analytics are built on. No admin audit event either: this is the entity-detail
 * data class (opaque ids, closed-vocabulary skills, integers) the other `read_entities` entity
 * reads serve un-audited — though the skill rows themselves are new on the floor (see the
 * controller header; owner ruling requested) — and the only existing admin read audit
 * (`admin.worker_journey_viewed`) has a closed `view` enum this surface is not in —
 * reusing it would mislabel the read, widening it is an event-schema change.
 *
 * ── FACELESS ────────────────────────────────────────────────────────────────────────────
 * Workers are opaque uuids + an 8-char short ref. No name, phone, org label or company:
 * the feed row's `payerKey` (an opaque company key the interleave needs) is never mapped
 * onto a card.
 */
@Injectable()
export class AdminMatchEngineService {
  constructor(
    private readonly repo: AdminMatchEngineRepository,
    private readonly feed: MatchFeedService,
    private readonly candidates: MatchCandidatesService,
    private readonly config: MatchConfigService,
    private readonly workerSkills: WorkerSkillsRepository,
  ) {}

  async listRecentWorkers(limit: number): Promise<EngineRecentWorkersResponseDto> {
    const rows = await this.repo.listRecentWorkers(limit);
    return {
      workers: rows.map((r) => ({
        worker_id: r.workerId,
        short_ref: shortRef(r.workerId),
        created_at: r.createdAt.toISOString(),
        trade_label: r.topSkillId === null ? null : (matchSkillLabel(r.topSkillId) ?? null),
      })),
    };
  }

  async getWorkerView(workerId: string, now: Date = new Date()): Promise<EngineWorkerViewDto> {
    // 404 FIRST: nothing else is read for an id that is unknown or pending deletion.
    const worker = await this.repo.findLiveWorker(workerId);
    if (!worker) throw new NotFoundException("Not found");

    const [skills, counts, page] = await Promise.all([
      this.repo.listWorkerSkills(workerId),
      this.repo.countFunnel(workerId),
      this.feed.composePage(workerId, ENGINE_CARD_CAP, {}),
    ]);
    const meta = await this.repo.findCardPostingMeta(page.map((r) => r.jobPostingId));

    return {
      worker_id: worker.id,
      short_ref: shortRef(worker.id),
      skills: skills.map((s) => ({
        skill_id: s.skillId,
        label: labelOf(s.skillId),
        wants: s.wants,
        months_bucketed: s.monthsBucketed,
        source: s.source,
      })),
      funnel: toFunnel(counts),
      cards: page.map((row, index) => toCard(row, index, meta.get(row.jobPostingId))),
      card_cap: ENGINE_CARD_CAP,
      generated_at: now.toISOString(),
    };
  }

  async getPostingView(
    jobPostingId: string,
    now: Date = new Date(),
  ): Promise<EnginePostingViewDto> {
    const posting = await this.repo.findPostingHeader(jobPostingId);
    if (!posting) throw new NotFoundException("Not found");

    const [reach, list, cfg] = await Promise.all([
      this.workerSkills.countReachForPosting(jobPostingId),
      this.candidates.listForPosting(jobPostingId),
      this.config.get(),
    ]);

    const posted = new Set(posting.matchSkillIds);
    return {
      job_posting_id: posting.id,
      role_title: posting.roleTitle,
      role_kind: posting.roleKind,
      status: posting.status,
      city: posting.city,
      posted_skills: posting.matchSkillIds.map(skillRef),
      related_skills: posting.reachSkillIds.filter((id) => !posted.has(id)).map(skillRef),
      reach: { total: reach.total, tier1: reach.tier1, tier2: reach.total - reach.tier1 },
      candidates: list.applicants.map((a) => ({
        rank: a.rank,
        worker_id: a.workerId,
        short_ref: shortRef(a.workerId),
        application_id: a.applicationId,
        match_tier: a.matchTier,
        effective_tier: a.effectiveTier,
        skill_months: a.skillMonths,
        industry_months: a.industryMonths,
        last_worked_at: a.lastWorkedAt,
        matched_skill_label: a.matchedSkillLabel,
      })),
      tier_floor_months: cfg.tierFloorMonths,
      generated_at: now.toISOString(),
    };
  }
}

/** An opaque display handle: the first 8 hex chars of the uuid. Not an identity. */
export function shortRef(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, ENGINE_SHORT_REF_LENGTH);
}

function labelOf(skillId: string): string {
  return matchSkillLabel(skillId) ?? skillId;
}

function skillRef(skillId: string): EngineSkillRefDto {
  return { skill_id: skillId, label: labelOf(skillId) };
}

/**
 * `hidden` is the remainder, so the funnel adds up by construction. NOT clamped: `job_reach`'s
 * (posting, worker) key makes direct + related ≤ open, so a negative value can only mean drift —
 * and the page flags a funnel that does not balance instead of having it hidden here.
 */
export function toFunnel(c: EngineFunnelCounts): EngineFunnelDto {
  return {
    open_postings: c.openPostings,
    reached_direct: c.reachedDirect,
    reached_related: c.reachedRelated,
    hidden: c.openPostings - c.reachedDirect - c.reachedRelated,
    already_actioned: c.alreadyActioned,
  };
}

/**
 * WHY this card is on his feed, in the materializer's own terms (E6):
 *   tier 1 → `direct: <the posted skill he holds>`;
 *   tier 2 → `related: <his skill> → <the posted skill it is curated as related to>`.
 * The posted skill is resolved from the curated relation map; a reach set an ops WIDEN
 * extended past that map (Policy 27) has no curated parent, so all posted skills are named.
 */
export function explainMatch(
  matchTier: 1 | 2,
  matchedSkillId: string,
  postedSkillIds: readonly string[],
): string {
  const matched = labelOf(matchedSkillId);
  if (matchTier === 1) return `direct: ${matched}`;
  const parent = postedSkillIds.find((p) =>
    relatedMatchSkills(p).includes(matchedSkillId as never),
  );
  const target =
    parent !== undefined
      ? labelOf(parent)
      : postedSkillIds.length > 0
        ? postedSkillIds.map(labelOf).join(" / ")
        : "posted skill";
  return `related: ${matched} → ${target}`;
}

function toCard(
  row: MatchFeedRow,
  index: number,
  meta: EngineCardPostingMeta | undefined,
): EngineCardDto {
  return {
    rank: index + 1,
    job_posting_id: row.jobPostingId,
    role_title: row.roleTitle,
    role_kind: meta?.roleKind ?? null,
    city: row.city,
    match_tier: row.matchTier,
    matched_skill_id: row.matchedSkillId,
    matched_skill_label: matchSkillLabel(row.matchedSkillId) ?? null,
    boosted: row.boosted,
    published_at: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    why: explainMatch(row.matchTier, row.matchedSkillId, meta?.matchSkillIds ?? []),
  };
}
