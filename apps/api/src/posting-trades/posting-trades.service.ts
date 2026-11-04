import { BadRequestException, Injectable } from "@nestjs/common";
import type { QuestionPack } from "@badabhai/ai-contracts";
import { jobRoleLabel } from "@badabhai/types";
import {
  PACK_ANSWER_SKILLS,
  POSTING_TRADES,
  TRADE_LEVEL_LABELS,
  isMatchSkillId,
  matchSkillForRole,
  matchSkillsForAttribute,
  postingTradeFor,
  type PostingTrade,
  type PostingTradeLadderRung,
  type TradeLevel,
} from "@badabhai/taxonomy";
import { PackRegistryService } from "../profiling/pack-registry.service";

/** One option/chip on the posting form. */
export interface PostingTradeOption {
  option_key: string;
  /** The stored `value_text` for a pack option (usually the option key). */
  value: string;
  label: string;
  /** True when tapping this chip adds a match skill and therefore changes reach. */
  match: boolean;
  /** The `mskill_*` ids this chip implies (empty for a facet-only chip). */
  match_skill_ids: string[];
}

/** One chip question on the posting form. */
export interface PostingTradeQuestion {
  question_key: string;
  prompt: string;
  answer_type: "single_select" | "multi_select";
  options: PostingTradeOption[];
}

/** The whole posting-side definition of one trade. */
export interface PostingTradeForm {
  role_kind: string;
  /** The role's display label (the same label the worker form and sheet print). */
  role_label: string;
  pack_id: string;
  /** The trade's own match skill — always part of the posting's match set. */
  match_skill_id: string;
  ladder: PostingTradeLadderRung[];
  questions: PostingTradeQuestion[];
}

/** What a validated trade selection yields. */
export interface NormalizedTradeSelection {
  tradeLevel: string | null;
  tradeAnswers: Record<string, string[]> | null;
  matchSkillIds: string[];
}

/** A resolved display row for a worker-facing job detail. */
export interface TradeFacetDisplay {
  question_key: string;
  prompt: string;
  values: string[];
}

/**
 * Questions a POSTING must never ask. They are worker-interview material: a tenure
 * bucket, the fresher-only ITI/trade-test block, the rung question itself (the ladder
 * is the posting's rung control) and the separating-confirm questions that only make
 * sense on the worker's side. `programming_level` and `inspection_level` are kept:
 * they are real posting requirements ("must write programs", "QC engineer"), not a
 * self-assessment of tenure.
 */
const POSTING_LEVEL_ALLOWLIST = new Set(["programming_level", "inspection_level"]);

function isPostingQuestion(key: string): boolean {
  if (key.endsWith("_experience")) return false;
  if (key.startsWith("iti_")) return false;
  if (key === "trade_test_status") return false;
  if (key.endsWith("_confirm")) return false;
  if (key.endsWith("_level") && !POSTING_LEVEL_ALLOWLIST.has(key)) return false;
  return true;
}

/**
 * Whether `level` is a rung a posting of this trade may STORE: one the form offers, or one of
 * the trade's legacy rungs (#2550) an older catalogue offered and existing postings still carry.
 */
function isPostableRung(trade: PostingTrade, form: PostingTradeForm, level: string): boolean {
  return (
    form.ladder.some((rung) => rung.rung === level) ||
    (trade.legacyRungs as readonly string[]).includes(level)
  );
}

/**
 * The trade-specific posting form (owner ruling 2026-11-03, 16 live trades).
 *
 * THE PACK IS THE SOURCE. Question text, option labels and chip values come from the
 * checked-in question pack the worker side already answers; this service only decides
 * which of those questions make sense on a vacancy and which chips are match-affecting.
 * That decision is deterministic and comes from the SAME `PACK_ANSWER_SKILLS` bridge the
 * worker derive path reads, so a chip that reaches a worker from a profile also moves a
 * posting's reach when a company asks for it — one vocabulary, no second copy.
 *
 * THE LADDER IS DISPLAY-ONLY. `trade_level` is stored and printed; it never enters
 * `match_skill_ids` or rank. The base trade skill is always a match input; a facet chip
 * never is.
 */
@Injectable()
export class PostingTradesService {
  /** Built forms are pure functions of an immutable pack version. */
  private readonly forms = new Map<string, PostingTradeForm>();

  constructor(private readonly packs: PackRegistryService) {}

  /** The picker + form definitions for all 16 postable trades. */
  async listForms(now: number = Date.now()): Promise<PostingTradeForm[]> {
    return Promise.all(POSTING_TRADES.map(async (trade) => this.buildForm(trade, now)));
  }

  /** One trade's form, or null when the role is not one of the 16 (or its pack is absent). */
  async formFor(
    roleKind: string | null | undefined,
    now: number = Date.now(),
  ): Promise<PostingTradeForm | null> {
    const trade = postingTradeFor(roleKind);
    return trade ? this.buildForm(trade, now) : null;
  }

  /**
   * Validate a poster's selection against the role's closed set and derive the match
   * skills. Fail closed: an unknown role, rung, question or option is a 400, never a
   * silently dropped answer. Returns `matchSkillIds` with the base trade skill always
   * present, so a posting cannot name a role and still reach nobody.
   */
  async normalizeSelection(
    roleKind: string | null | undefined,
    tradeLevel: string | null | undefined,
    tradeAnswers: Record<string, readonly string[]> | null | undefined,
    now: number = Date.now(),
  ): Promise<NormalizedTradeSelection> {
    if (tradeLevel == null && tradeAnswers == null) {
      return { tradeLevel: null, tradeAnswers: null, matchSkillIds: [] };
    }
    const trade = postingTradeFor(roleKind);
    if (!trade) {
      throw new BadRequestException("trade fields are only available for a postable role");
    }
    const form = await this.buildForm(trade, now);

    const level = tradeLevel == null ? null : tradeLevel.trim();
    // A legacy rung (#2550: a key the CEO sheets dropped) is never offered, but a posting that
    // already stores one must still save — an edit that fails on its own stored value is a 400
    // the payer cannot fix.
    if (level !== null && !isPostableRung(trade, form, level)) {
      throw new BadRequestException("unknown trade level for this role");
    }

    const normalized: Record<string, string[]> = {};
    const matchSkillIds = new Set<string>([trade.matchSkillId]);
    if (tradeAnswers !== null && tradeAnswers !== undefined) {
      if (typeof tradeAnswers !== "object" || Array.isArray(tradeAnswers)) {
        throw new BadRequestException("trade answers must be an object");
      }
      for (const [questionKey, rawOptions] of Object.entries(tradeAnswers)) {
        const question = form.questions.find((q) => q.question_key === questionKey);
        if (!question) {
          throw new BadRequestException(`unknown posting field: ${questionKey}`);
        }
        const seen = new Set<string>();
        const options: string[] = [];
        for (const raw of rawOptions) {
          const option = question.options.find((o) => o.option_key === raw);
          if (!option) {
            throw new BadRequestException(`unknown option for ${questionKey}: ${raw}`);
          }
          if (seen.has(option.option_key)) continue;
          seen.add(option.option_key);
          options.push(option.option_key);
          for (const skillId of option.match_skill_ids) matchSkillIds.add(skillId);
        }
        if (question.answer_type === "single_select" && options.length > 1) {
          throw new BadRequestException(`${questionKey} takes one option`);
        }
        if (options.length > 0) normalized[questionKey] = options;
      }
    }

    return {
      tradeLevel: level,
      tradeAnswers: normalized,
      matchSkillIds: [...matchSkillIds],
    };
  }

  /**
   * Resolve a stored answer set to DISPLAY text for a worker read. Labels come from the
   * same pack the employer saw, so the worker and the employer read one vocabulary.
   * Unknown/legacy keys are ignored rather than echoed.
   */
  async describeSelection(
    roleKind: string | null | undefined,
    tradeLevel: string | null | undefined,
    tradeAnswers: Record<string, string[]> | null | undefined,
    now: number = Date.now(),
  ): Promise<{ levelLabel: string | null; facets: TradeFacetDisplay[] }> {
    const trade = postingTradeFor(roleKind);
    if (!trade) return { levelLabel: null, facets: [] };
    const form = await this.buildForm(trade, now);
    const levelLabel =
      tradeLevel == null || !isPostableRung(trade, form, tradeLevel) ? null : tradeLevel;
    const facets: TradeFacetDisplay[] = [];
    if (tradeAnswers) {
      for (const question of form.questions) {
        const selected = tradeAnswers[question.question_key] ?? [];
        const values = question.options
          .filter((option) => selected.includes(option.option_key))
          .map((option) => option.label);
        if (values.length > 0) {
          facets.push({
            question_key: question.question_key,
            prompt: question.prompt,
            values,
          });
        }
      }
    }
    return {
      levelLabel:
        levelLabel === null
          ? null
          : (TRADE_LEVEL_LABELS[levelLabel as TradeLevel] ?? humaniseTradeLevel(levelLabel)),
      facets,
    };
  }

  private async buildForm(trade: PostingTrade, now: number): Promise<PostingTradeForm> {
    const pack = await this.packs.loadForFamily(trade.familyId, now);
    if (!pack) {
      // A missing pack is an unseeded/undeployed database, not a client error. The form
      // still offers the trade and its ladder; the API's write path will refuse a
      // selection it cannot validate rather than store an unverifiable answer.
      return {
        role_kind: trade.roleKind,
        role_label: jobRoleLabel(trade.roleKind) ?? trade.roleKind,
        pack_id: trade.packId,
        match_skill_id: trade.matchSkillId,
        ladder: [...trade.ladder],
        questions: [],
      };
    }
    const cacheKey = `${trade.roleKind}:${pack.pack_id}:${pack.version}`;
    const cached = this.forms.get(cacheKey);
    if (cached) return cached;
    const form: PostingTradeForm = {
      role_kind: trade.roleKind,
      role_label: jobRoleLabel(trade.roleKind) ?? trade.roleKind,
      pack_id: trade.packId,
      match_skill_id: trade.matchSkillId,
      ladder: [...trade.ladder],
      questions: questionsForPack(pack, trade.matchSkillId),
    };
    this.forms.set(cacheKey, form);
    return form;
  }
}

/**
 * The posting-relevant questions from one pack, with each chip's match meaning
 * resolved through the taxonomy bridges.
 *
 * `baseMatchSkillId` is the role's own skill, which is ALWAYS in a posting's match set.
 * A chip that only resolves to that same id does not change reach, so it is a facet chip
 * (`match: false`) even though its bridge entry is a real `mskill_*`. Omit it when the
 * caller wants the raw "does this chip map to a skill" answer.
 */
export function questionsForPack(
  pack: QuestionPack,
  baseMatchSkillId?: string,
): PostingTradeQuestion[] {
  const packMap = PACK_ANSWER_SKILLS[pack.pack_id.split("@")[0]!] ?? {};
  const questions: PostingTradeQuestion[] = [];
  for (const item of pack.items) {
    if (!isPostingQuestion(item.question_key)) continue;
    if (item.answer_type !== "single_select" && item.answer_type !== "multi_select") continue;
    const mapped = packMap[item.question_key] ?? {};
    const options: PostingTradeOption[] = [];
    for (const option of item.options) {
      if (option.is_none_of_above) continue;
      const taxonomyIds = mapped[option.option_key] ?? [];
      const matchSkillIds = matchSkillsFromTaxonomyIds(taxonomyIds);
      options.push({
        option_key: option.option_key,
        value: typeof option.value === "string" ? option.value : option.option_key,
        label: option.label_text,
        match: matchSkillIds.some((id) => id !== baseMatchSkillId),
        match_skill_ids: matchSkillIds,
      });
    }
    if (options.length === 0) continue;
    questions.push({
      question_key: item.question_key,
      prompt: item.prompt_text,
      answer_type: item.answer_type,
      options,
    });
  }
  return questions;
}

/** `setter_programmer` → `Setter Programmer` for a worker-facing label. */
function humaniseTradeLevel(level: string): string {
  return level
    .split("_")
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}

/** `skill_*` / `role_*` / direct `mskill_*` → the posting-level skills they imply. */
export function matchSkillsFromTaxonomyIds(ids: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (isMatchSkillId(id)) {
      out.add(id);
    } else if (id.startsWith("skill_")) {
      for (const skillId of matchSkillsForAttribute(id)) out.add(skillId);
    } else if (id.startsWith("role_")) {
      const skillId = matchSkillForRole(id);
      if (skillId !== undefined) out.add(skillId);
    }
  }
  return [...out];
}
