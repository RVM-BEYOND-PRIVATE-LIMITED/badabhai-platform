import { BadRequestException, Injectable } from "@nestjs/common";
import {
  RELATED_MATCH_SKILLS,
  isMatchSkillId,
  matchSkillIndustry,
  matchSkillLabel,
  relatedMatchSkills,
  type MatchSkillId,
} from "@badabhai/taxonomy";
import { resolveReachSet, type ReachSet } from "@badabhai/match-engine";
import { MatchConfigService } from "./match-config.service";
import { WorkerSkillsRepository } from "./worker-skills.repository";
import type { ReachPreviewDto } from "./match.dto";

/** One entry in the closed vocabulary the posting form's picker renders. */
export interface MatchSkillDto {
  skill_id: string;
  label: string;
  industry_id: string;
  /** The curated related skills that arrive PRE-TICKED when this one is posted. */
  related_skill_ids: string[];
}

/** One related skill on the preview, with its tick state and its marginal reach. */
export interface RelatedPreviewDto {
  skill_id: string;
  label: string;
  /** PRE-TICKED by default (ruling #4). False only when the payer unticked it. */
  ticked: boolean;
  /**
   * How many workers this skill adds ON ITS OWN — the "+18 / +24 / +37" the form
   * shows. It is a per-skill count, NOT a marginal delta against the running set:
   * a worker who holds two related skills is counted under both, so the numbers do
   * not sum to the total. That is deliberate and the total is reported separately —
   * a "+N" that changed depending on tick ORDER would be worse than one that
   * over-counts overlaps, because the payer would see a different number for the
   * same choice made in a different sequence.
   */
  reach_count: number;
}

/** The whole live reach picture for one skill selection. */
export interface ReachPreviewResponseDto {
  skills: {
    skill_id: string;
    label: string;
    /** Workers holding THIS posted skill (tier 1 through it). */
    reach_count: number;
    related: RelatedPreviewDto[];
  }[];
  /** The resolved reach set after unticks — what publishing right now would use. */
  reach_skill_ids: string[];
  /** DISTINCT workers the whole set reaches. The number the payer decides on. */
  reach_total: number;
  /** Workers reached through a POSTED skill (tier 1). */
  reach_tier1: number;
  /** E13 — "Never take money for a posting into a void." */
  zero_reach: boolean;
  /** The unticks that were actually HONOURED (Policy 10 audit trail). */
  applied_unticked_ids: string[];
  /** `match_config.max_skills_per_posting`, so the form can disable the add button. */
  max_skills_per_posting: number;
}

/**
 * The POSTING FORM's server half (spec Part 2): the closed vocabulary, the curated
 * related map, and the LIVE reach counter that is "the control" over breadth.
 *
 * BREADTH BELONGS TO THE COMPANY (Policy 10) AND ONLY WITHIN THE CURATED RELATIONS.
 * Both halves of that sentence are enforced here, server-side, by handing the payer's
 * ids to `resolveReachSet` rather than trusting a client-supplied final set:
 *  - an untick counts ONLY if it names a suggested related skill;
 *  - a POSTED skill can never be unticked;
 *  - the platform never widens past `RELATED_MATCH_SKILLS`.
 * A client that posts arbitrary ids gets them ignored, and a client that posts a
 * hand-built `reach_skill_ids` cannot: there is no such input anywhere.
 *
 * PII-free: closed-set ids, labels from the checked-in vocabulary, and integer counts.
 * Invariant #4: no model is consulted; the relation map is curated trade truth.
 */
@Injectable()
export class MatchSkillsService {
  constructor(
    private readonly config: MatchConfigService,
    private readonly repo: WorkerSkillsRepository,
  ) {}

  /**
   * The closed vocabulary + the curated relation map.
   *
   * Enumerated from `RELATED_MATCH_SKILLS`, whose keys are typed `Record<MatchSkillId,
   * …>` and therefore ARE the vocabulary, rather than from `MATCH_SKILLS[n].id` — the
   * node's FIELD NAMES are being restructured by a parallel workstream, and reading
   * them here would couple this route to that shape. Labels/industries come from the
   * `matchSkillLabel`/`matchSkillIndustry` accessors for the same reason.
   */
  listSkills(): { skills: MatchSkillDto[] } {
    const ids = Object.keys(RELATED_MATCH_SKILLS) as MatchSkillId[];
    const skills = ids
      .filter(isMatchSkillId)
      .map((skillId): MatchSkillDto => ({
        skill_id: skillId,
        label: matchSkillLabel(skillId) ?? skillId,
        industry_id: matchSkillIndustry(skillId) ?? "",
        related_skill_ids: [...relatedMatchSkills(skillId)],
      }))
      .sort((a, b) => (a.skill_id < b.skill_id ? -1 : a.skill_id > b.skill_id ? 1 : 0));
    return { skills };
  }

  /**
   * The live reach preview — "reaches 61 workers / +18 / +24 / +37" plus the E13
   * zero-reach warning, BEFORE the payer pays.
   *
   * Every count is one `COUNT(DISTINCT worker_id) WHERE skill_id = ANY(...) AND wants`,
   * which is exactly the shape of `worker_skill_reach_idx` — index-only, no heap fetch.
   */
  async reachPreview(dto: ReachPreviewDto): Promise<ReachPreviewResponseDto> {
    const cfg = await this.config.get();
    const posted = this.assertPostableSkills(dto.match_skill_ids, cfg.maxSkillsPerPosting);

    const resolved = resolveReachSet({
      postedSkillIds: posted,
      relatedDefault: cfg.relatedSkillsDefault,
      untickedIds: dto.unticked_related_ids,
    });

    const unticked = new Set<string>(resolved.appliedUntickedIds);

    // Per-skill counts. Issued in parallel: they are independent index-only reads and
    // the form is a live, per-keystroke surface.
    const perSkill = await Promise.all(
      resolved.postedSkillIds.map(async (skillId) => ({
        skill_id: skillId,
        label: matchSkillLabel(skillId) ?? skillId,
        reach_count: await this.repo.countWorkersReachedBy([skillId]),
        related: await Promise.all(
          relatedMatchSkills(skillId)
            .filter((r) => !resolved.postedSkillIds.includes(r))
            .map(async (relatedId): Promise<RelatedPreviewDto> => ({
              skill_id: relatedId,
              label: matchSkillLabel(relatedId) ?? relatedId,
              // Pre-ticked (ruling #4) unless the payer unticked it, and never ticked
              // at all when related expansion is configured off.
              ticked: cfg.relatedSkillsDefault === "on" && !unticked.has(relatedId),
              reach_count: await this.repo.countWorkersReachedBy([relatedId]),
            })),
        ),
      })),
    );

    const [reachTotal, reachTier1] = await Promise.all([
      this.repo.countWorkersReachedBy(resolved.reachSkillIds),
      this.repo.countWorkersReachedBy(resolved.postedSkillIds),
    ]);

    return {
      skills: perSkill,
      reach_skill_ids: resolved.reachSkillIds,
      reach_total: reachTotal,
      reach_tier1: reachTier1,
      zero_reach: reachTotal === 0,
      applied_unticked_ids: resolved.appliedUntickedIds,
      max_skills_per_posting: cfg.maxSkillsPerPosting,
    };
  }

  /**
   * Resolve a publish-time reach set. The single place a posting's `reach_skill_ids`
   * is decided, shared by the publish path, the unpause path and the ops widen.
   */
  async resolveForPublish(
    matchSkillIds: readonly string[],
    untickedIds: readonly string[],
  ): Promise<ReachSet> {
    const cfg = await this.config.get();
    const posted = this.assertPostableSkills(matchSkillIds, cfg.maxSkillsPerPosting);
    return resolveReachSet({
      postedSkillIds: posted,
      relatedDefault: cfg.relatedSkillsDefault,
      untickedIds,
    });
  }

  /**
   * Closed-set + cap check. REJECTS an oversized list rather than truncating it:
   * `packages/match-engine` deliberately leaves the cap to the API (`// integration:`
   * in `reach.ts`) precisely so the refusal is an explicit 400 a payer can see, not a
   * silent drop of a skill they typed.
   */
  private assertPostableSkills(ids: readonly string[], maxSkills: number): MatchSkillId[] {
    const unknown = ids.filter((id) => !isMatchSkillId(id));
    if (unknown.length > 0) {
      // Names the ids, not a count: they are public closed-set values, and an opaque
      // "invalid skill" on a live form is unusable. No PII can appear here — the
      // input is regex-constrained to `mskill_[a-z0-9_]+` by the DTO.
      throw new BadRequestException(`unknown match skill id(s): ${unknown.join(", ")}`);
    }
    const unique = [...new Set(ids)] as MatchSkillId[];
    if (unique.length === 0) {
      throw new BadRequestException("at least one match skill is required");
    }
    if (unique.length > maxSkills) {
      throw new BadRequestException(
        `a posting may name at most ${maxSkills} skills (got ${unique.length})`,
      );
    }
    return unique;
  }
}
