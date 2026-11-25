import { BadRequestException, Injectable } from "@nestjs/common";
import type { QuestionPack } from "@badabhai/ai-contracts";
import {
  JOB_ROLE_DEPARTMENTS,
  JOB_ROLE_DEPARTMENT_BY_KIND,
  jobRoleLabel,
  type JobRoleDepartment,
  type TradeFormKindName,
} from "@badabhai/types";
import {
  LIVE_POSTING_TRADE_KINDS,
  PACK_ANSWER_SKILLS,
  POSTING_TRADES,
  TRADE_CATALOGUE,
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
import { TradeReleaseService } from "../trade-release/trade-release.service";

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

/**
 * #3006 — one row of the trade picker (`GET /payer/posting-trades/catalogue`). Labels only: the
 * client never writes a trade or department name of its own.
 */
export interface PostingTradeCatalogueRow {
  role_kind: string;
  role_label: string;
  /** The department id (`JOB_ROLE_DEPARTMENTS`, #2999). */
  department: JobRoleDepartment;
  department_label: string;
  kind: "shop_floor" | "desk";
}

/** #3006 — one trade's form (`GET /payer/posting-trades/:roleKind`), with its department added. */
export interface PostingTradeDetail extends PostingTradeForm {
  department: JobRoleDepartment;
}

/**
 * #3006 — THE TRADES `GET /payer/posting-trades` SERVES, WHATEVER THE RELEASE TABLE SAYS.
 *
 * That route returns every trade's WHOLE form in one reply, and it is what the installed
 * company apps read. Those copies have no "update required" check, so they must keep receiving
 * exactly the 16 trades they receive today: a 17th trade switched on would reach a build that
 * was never tested with it, and a live trade switched off would vanish from a form a company is
 * filling. New clients read `/catalogue` and `/:roleKind`, which follow the switch.
 *
 * LIFT THIS when the company app enforces a minimum build (server side #3048, app check #3049)
 * and that minimum is raised past every build that reads this route; then the route can follow
 * the switch, or be retired.
 */
export const LEGACY_LIST_TRADE_KINDS = LIVE_POSTING_TRADE_KINDS;

const LEGACY_LIST_KIND_SET: ReadonlySet<string> = new Set(LEGACY_LIST_TRADE_KINDS);

const DEPARTMENT_ORDER: ReadonlyMap<string, number> = new Map(
  JOB_ROLE_DEPARTMENTS.map((department, i) => [department.id, i]),
);
const DEPARTMENT_LABEL: ReadonlyMap<string, string> = new Map(
  JOB_ROLE_DEPARTMENTS.map((department) => [department.id, department.label]),
);
/** Pack order: the CEO pack's trade code, T01..T60. */
const PACK_ORDER: ReadonlyMap<string, number> = new Map(
  TRADE_CATALOGUE.map((entry) => [entry.roleKind, Number(entry.code.slice(1))]),
);
const TRADE_KIND: ReadonlyMap<string, "shop_floor" | "desk"> = new Map(
  TRADE_CATALOGUE.map((entry) => [entry.roleKind, entry.kind]),
);

function departmentOf(roleKind: string): JobRoleDepartment {
  return JOB_ROLE_DEPARTMENT_BY_KIND[roleKind as TradeFormKindName];
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

/** Options for {@link PostingTradesService.normalizeSelection}. */
export interface NormalizeSelectionOptions {
  /**
   * The role kind the posting ALREADY stores (an edit), or null/absent for a create. A posting
   * keeps saving its own stored trade after that trade's release switch goes off — the same
   * reasoning as `legacyRungs`: an edit that fails on its own stored value is a 400 the payer
   * cannot fix. Moving a posting ONTO a switched-off trade is still refused.
   */
  readonly storedRoleKind?: string | null;
  readonly now?: number;
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
 * The trade-specific posting form (owner ruling 2026-11-03; 60 trades since CEO pack v2, #3005).
 *
 * THE PACK IS THE SOURCE. Question text, option labels and chip values come from the
 * checked-in question pack the worker side already answers; this service only decides
 * which chips are match-affecting. WHICH questions a vacancy may ask is the trade's explicit
 * `postingQuestionKeys` list (`TRADE_CATALOGUE`), never a rule on how a key is spelt.
 *
 * OFFERED ONLY WHEN RELEASED (#3002). A trade is listed, served and accepted only while its
 * `trade_release.posting_enabled` switch is on; the 16 live trades are seeded on, the 44 new
 * ones ship off. A posting that already stores a switched-off trade still loads and saves.
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

  constructor(
    private readonly packs: PackRegistryService,
    private readonly release: TradeReleaseService,
  ) {}

  /** The picker + form definitions for every trade whose posting switch is on. */
  async listForms(now: number = Date.now()): Promise<PostingTradeForm[]> {
    const enabled = await this.release.postingEnabledKinds();
    return Promise.all(
      POSTING_TRADES.filter((trade) => enabled.has(trade.roleKind)).map(async (trade) =>
        this.buildForm(trade, now),
      ),
    );
  }

  /**
   * #3006 — `GET /payer/posting-trades`: exactly the 16 {@link LEGACY_LIST_TRADE_KINDS}, in
   * their catalogue order, whatever the release table says (installed apps read this route).
   */
  async listLegacyForms(now: number = Date.now()): Promise<PostingTradeForm[]> {
    return Promise.all(
      POSTING_TRADES.filter((trade) => LEGACY_LIST_KIND_SET.has(trade.roleKind)).map(
        async (trade) => this.buildForm(trade, now),
      ),
    );
  }

  /**
   * #3006 — `GET /payer/posting-trades/catalogue`: one light row per trade whose posting switch
   * is on, in department order (`JOB_ROLE_DEPARTMENTS`) then pack order (T01..T60). One read of
   * the switch table; no pack is loaded.
   */
  async catalogue(): Promise<PostingTradeCatalogueRow[]> {
    const enabled = await this.release.postingEnabledKinds();
    return POSTING_TRADES.filter((trade) => enabled.has(trade.roleKind))
      .map((trade): PostingTradeCatalogueRow => {
        const department = departmentOf(trade.roleKind);
        return {
          role_kind: trade.roleKind,
          role_label: jobRoleLabel(trade.roleKind) ?? trade.roleKind,
          department,
          department_label: DEPARTMENT_LABEL.get(department) ?? department,
          kind: TRADE_KIND.get(trade.roleKind) ?? "shop_floor",
        };
      })
      .sort(
        (a, b) =>
          (DEPARTMENT_ORDER.get(a.department) ?? 99) - (DEPARTMENT_ORDER.get(b.department) ?? 99) ||
          (PACK_ORDER.get(a.role_kind) ?? 99) - (PACK_ORDER.get(b.role_kind) ?? 99),
      );
  }

  /**
   * #3006 — `GET /payer/posting-trades/:roleKind`: one trade's form with its department, or null
   * (the route's 404) for an unknown kind or one whose posting switch is off.
   */
  async detail(roleKind: string, now: number = Date.now()): Promise<PostingTradeDetail | null> {
    const form = await this.formFor(roleKind, now);
    return form === null ? null : { ...form, department: departmentOf(form.role_kind) };
  }

  /**
   * One trade's form, or null when the role is not a postable trade or its posting switch is
   * off. A trade whose pack is absent still answers, with its ladder and no questions.
   */
  async formFor(
    roleKind: string | null | undefined,
    now: number = Date.now(),
  ): Promise<PostingTradeForm | null> {
    const trade = postingTradeFor(roleKind);
    if (!trade || !(await this.release.isPostingEnabled(trade.roleKind))) return null;
    return this.buildForm(trade, now);
  }

  /** Whether this trade's posting switch is on (#3002). Declared-but-off trades answer false. */
  async isReleased(roleKind: string): Promise<boolean> {
    return this.release.isPostingEnabled(roleKind);
  }

  /**
   * Validate a poster's selection against the role's closed set and derive the match
   * skills. Fail closed: an unknown role, rung, question or option is a 400, never a
   * silently dropped answer. Returns `matchSkillIds` with the base trade skill always
   * present, so a posting cannot name a role and still reach nobody.
   *
   * A trade whose posting switch is off is refused with the same error as an unknown role,
   * unless it is the trade the posting already stores (`opts.storedRoleKind`).
   */
  async normalizeSelection(
    roleKind: string | null | undefined,
    tradeLevel: string | null | undefined,
    tradeAnswers: Record<string, readonly string[]> | null | undefined,
    opts: NormalizeSelectionOptions = {},
  ): Promise<NormalizedTradeSelection> {
    if (tradeLevel == null && tradeAnswers == null) {
      return { tradeLevel: null, tradeAnswers: null, matchSkillIds: [] };
    }
    const trade = postingTradeFor(roleKind);
    const accepted =
      trade !== undefined &&
      (trade.roleKind === opts.storedRoleKind ||
        (await this.release.isPostingEnabled(trade.roleKind)));
    if (!trade || !accepted) {
      throw new BadRequestException("trade fields are only available for a postable role");
    }
    const form = await this.buildForm(trade, opts.now ?? Date.now());

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
   * Unknown/legacy keys are ignored rather than echoed. Not gated by the release switch: a
   * stored posting keeps printing after its trade is switched off.
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
      questions: questionsForPack(pack, trade.postingQuestionKeys, trade.matchSkillId),
    };
    this.forms.set(cacheKey, form);
    return form;
  }
}

/**
 * The posting questions from one pack, in `questionKeys` order (the trade's explicit
 * `postingQuestionKeys`, #3005), with each chip's match meaning resolved through the
 * taxonomy bridges. A listed key the pack does not carry is skipped (a form loaded before its
 * deepened version), and so is any key whose question is not a select: free text never becomes
 * a posting chip, whatever a list says.
 *
 * `baseMatchSkillId` is the role's own skill, which is ALWAYS in a posting's match set.
 * A chip that only resolves to that same id does not change reach, so it is a facet chip
 * (`match: false`) even though its bridge entry is a real `mskill_*`. Omit it when the
 * caller wants the raw "does this chip map to a skill" answer.
 */
export function questionsForPack(
  pack: QuestionPack,
  questionKeys: readonly string[],
  baseMatchSkillId?: string,
): PostingTradeQuestion[] {
  const packMap = PACK_ANSWER_SKILLS[pack.pack_id.split("@")[0]!] ?? {};
  const byKey = new Map(pack.items.map((item) => [item.question_key, item]));
  const questions: PostingTradeQuestion[] = [];
  for (const key of new Set(questionKeys)) {
    const item = byKey.get(key);
    if (item === undefined) continue;
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
