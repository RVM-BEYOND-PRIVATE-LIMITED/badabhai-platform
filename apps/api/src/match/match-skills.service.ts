import { BadRequestException, Injectable } from "@nestjs/common";
import {
  POSTING_SCOPE_SKILL_IDS,
  RELATED_MATCH_SKILLS,
  isInPostingScope,
  isMatchSkillId,
  matchSkillIndustry,
  matchSkillLabel,
  relatedMatchSkills,
  scopePostingSkills,
  type MatchSkillId,
  type ScopedPostingSkills,
} from "@badabhai/taxonomy";
import { resolveReachSet, type ReachSet } from "@badabhai/match-engine";
import { DEFAULT_JOB_POSTING_AUDIENCE, audienceReachesBadaBhaiWorkers } from "@badabhai/db";
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
 * A publish-time reach set, plus what scoping removed from the request (#2635). For a posting
 * outside the 16 trades nothing is scoped and `droppedSkillIds` is always empty.
 */
export interface ScopedReachSet extends ReachSet {
  /** Requested ids the posting's trade does not own — dropped, never rejected. */
  droppedSkillIds: string[];
}

/** Which posting a reach set is being resolved for. */
export interface ResolveForPublishOptions {
  /**
   * The posting's `role_kind`. One of the 16 postable trades → the request is scoped to that
   * trade and related expansion stays inside the 16 (#2635). Anything else → unscoped.
   */
  roleKind?: string | null;
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
   * The vocabulary PLUS the live `match_config.max_skills_per_posting` cap — the Admin Portal
   * agency match-skill editor's read (#2207, for #2192). One read gives the editor both halves of
   * the rule the server enforces on save ({@link validateSelection}), so it never hard-codes an id,
   * a label or a count. The cap is read per call, never cached here, for the same reason
   * `reachPreview` reads it: an ops change to `match_config` must reach the editor without a deploy.
   */
  async listVocabulary(): Promise<{ skills: MatchSkillDto[]; max_skills_per_posting: number }> {
    const cfg = await this.config.get();
    return { ...this.listSkills(), max_skills_per_posting: cfg.maxSkillsPerPosting };
  }

  /**
   * The live reach preview — "reaches 61 workers / +18 / +24 / +37" plus the E13
   * zero-reach warning, BEFORE the payer pays.
   *
   * Every count is one `COUNT(DISTINCT worker_id) WHERE skill_id = ANY(...) AND wants`,
   * which is exactly the shape of `worker_skill_reach_idx` — index-only, no heap fetch.
   *
   * #2635 — this is the COMPANY preview, and a company can publish only a 16-trade job, so its
   * related expansion always stays inside the 16 (what publish will store). When the form names
   * its trade (`role_kind`), the posted ids are scoped to that trade too, exactly as publish does.
   */
  async reachPreview(dto: ReachPreviewDto): Promise<ReachPreviewResponseDto> {
    const cfg = await this.config.get();
    const { posted } = this.checkRequest(
      dto.match_skill_ids,
      dto.role_kind,
      cfg.maxSkillsPerPosting,
    );

    const resolved = resolveReachSet({
      postedSkillIds: posted,
      relatedDefault: cfg.relatedSkillsDefault,
      untickedIds: dto.unticked_related_ids,
      scopeSkillIds: POSTING_SCOPE_SKILL_IDS,
    });

    const unticked = new Set<string>(resolved.appliedUntickedIds);
    // #2746 — an RVM-only posting reaches no BadaBhai worker (`materializeJobReachWithin` writes it
    // no reach row), so every BadaBhai supply count is zero and none is read. Its `zero_reach` is
    // false: the E13 warning is about a posting into a void, and this one goes to RVM students
    // (the publish-time alert is suppressed for the same reason).
    // Omitted = the column default, which reaches BadaBhai workers (today's preview).
    const badaBhaiSupply = audienceReachesBadaBhaiWorkers(
      dto.audience ?? DEFAULT_JOB_POSTING_AUDIENCE,
    );
    const count = (skillIds: readonly string[]): Promise<number> =>
      badaBhaiSupply ? this.repo.countWorkersReachedBy(skillIds) : Promise.resolve(0);

    // Per-skill counts. Issued in parallel: they are independent index-only reads and
    // the form is a live, per-keystroke surface.
    const perSkill = await Promise.all(
      resolved.postedSkillIds.map(async (skillId) => ({
        skill_id: skillId,
        label: matchSkillLabel(skillId) ?? skillId,
        reach_count: await count([skillId]),
        related: await Promise.all(
          relatedMatchSkills(skillId)
            .filter((r) => !resolved.postedSkillIds.includes(r) && isInPostingScope(r))
            .map(async (relatedId): Promise<RelatedPreviewDto> => ({
              skill_id: relatedId,
              label: matchSkillLabel(relatedId) ?? relatedId,
              // Pre-ticked (ruling #4) unless the payer unticked it, and never ticked
              // at all when related expansion is configured off.
              ticked: cfg.relatedSkillsDefault === "on" && !unticked.has(relatedId),
              reach_count: await count([relatedId]),
            })),
        ),
      })),
    );

    const [reachTotal, reachTier1] = await Promise.all([
      count(resolved.reachSkillIds),
      count(resolved.postedSkillIds),
    ]);

    return {
      skills: perSkill,
      reach_skill_ids: resolved.reachSkillIds,
      reach_total: reachTotal,
      reach_tier1: reachTier1,
      zero_reach: badaBhaiSupply && reachTotal === 0,
      applied_unticked_ids: resolved.appliedUntickedIds,
      max_skills_per_posting: cfg.maxSkillsPerPosting,
    };
  }

  /**
   * Resolve a publish-time reach set. The single place a posting's `reach_skill_ids`
   * is decided, shared by the publish path, the unpause path and the ops widen.
   *
   * #2635 — MATCHING RUNS ONLY FOR THE 16 POSTABLE TRADES. When `roleKind` is one of them, the
   * request is scoped to that trade first (its base skill always, plus every requested id the
   * trade owns; the rest are DROPPED and returned so the caller can record them) and related
   * expansion stays inside the 16. Any other posting resolves exactly as before.
   *
   * An id outside the closed vocabulary is still a 400 — that is a client bug, not a request
   * the trade can be scoped against. The skill cap counts what the client asked for (see
   * {@link checkRequest}).
   */
  async resolveForPublish(
    matchSkillIds: readonly string[],
    untickedIds: readonly string[],
    opts: ResolveForPublishOptions = {},
  ): Promise<ScopedReachSet> {
    const cfg = await this.config.get();
    const { posted, scoped } = this.checkRequest(
      matchSkillIds,
      opts.roleKind,
      cfg.maxSkillsPerPosting,
    );
    const reach = resolveReachSet({
      postedSkillIds: posted,
      relatedDefault: cfg.relatedSkillsDefault,
      untickedIds,
      ...(scoped ? { scopeSkillIds: POSTING_SCOPE_SKILL_IDS } : {}),
    });
    return { ...reach, droppedSkillIds: scoped ? [...scoped.dropped] : [] };
  }

  /**
   * Validate a match-skill SELECTION with no reach resolution: the closed `mskill_*` set and
   * the runtime `match_config.max_skills_per_posting` cap — the SAME rule the posting form
   * enforces, from the same private check, so the agency job form (ADR-0050 C4, #1983) can
   * never drift from it. Returns the de-duplicated ids in first-seen order. 400 on an unknown
   * id, an empty list or an over-cap list; never truncates.
   */
  async validateSelection(matchSkillIds: readonly string[]): Promise<MatchSkillId[]> {
    const cfg = await this.config.get();
    this.assertKnownSkills(matchSkillIds);
    return this.assertPostableSkills(matchSkillIds, cfg.maxSkillsPerPosting);
  }

  /**
   * #2635 — the ONE request check the preview and publish both run, in this order:
   *  1. closed-set on the RAW ids — an unknown id is a 400, never silently scoped away;
   *  2. for a 16-trade posting, scope to the trade (base skill kept, off-trade ids dropped);
   *  3. the cap. It counts what the CLIENT asked for: the base skill the server adds on its
   *     own never pushes a request over it, so a legacy client sending three welding skills
   *     for a Welder job is not refused for a skill it did not send.
   */
  private checkRequest(
    ids: readonly string[],
    roleKind: string | null | undefined,
    maxSkills: number,
  ): { posted: MatchSkillId[]; scoped: ScopedPostingSkills | undefined } {
    this.assertKnownSkills(ids);
    const scoped = scopePostingSkills(roleKind, ids);
    if (scoped === undefined) return { posted: this.assertPostableSkills(ids, maxSkills), scoped };
    const serverAdded = ids.includes(scoped.kept[0]!) ? 0 : 1;
    return { posted: this.assertPostableSkills(scoped.kept, maxSkills, serverAdded), scoped };
  }

  /**
   * Non-empty + cap check over closed-set ids. REJECTS an oversized list rather than
   * truncating it: `packages/match-engine` deliberately leaves the cap to the API
   * (`// integration:` in `reach.ts`) precisely so the refusal is an explicit 400 a payer
   * can see, not a silent drop of a skill they typed. `serverAdded` ids (the trade's base
   * skill, #2635) are in the list but not counted against the cap.
   */
  private assertPostableSkills(
    ids: readonly string[],
    maxSkills: number,
    serverAdded = 0,
  ): MatchSkillId[] {
    const unique = [...new Set(ids)] as MatchSkillId[];
    if (unique.length === 0) {
      throw new BadRequestException("at least one match skill is required");
    }
    const asked = unique.length - serverAdded;
    if (asked > maxSkills) {
      throw new BadRequestException(`a posting may name at most ${maxSkills} skills (got ${asked})`);
    }
    return unique;
  }

  /** 400 on any id outside the closed `mskill_*` vocabulary. */
  private assertKnownSkills(ids: readonly string[]): void {
    const unknown = ids.filter((id) => !isMatchSkillId(id));
    if (unknown.length > 0) {
      // Names the ids, not a count: they are public closed-set values, and an opaque
      // "invalid skill" on a live form is unusable. No PII can appear here — the
      // input is regex-constrained to `mskill_[a-z0-9_]+` by the DTO.
      throw new BadRequestException(`unknown match skill id(s): ${unknown.join(", ")}`);
    }
  }
}
