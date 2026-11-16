import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { QuestionPack } from "@badabhai/ai-contracts";
import { deriveWorkerSkills, workerSkillDeriveInput } from "@badabhai/match-engine";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";
import {
  TRADE_LEVEL_CONFIRM_ITEMS,
  TRADE_LEVEL_LABELS,
  TRADE_LEVEL_PACKS,
  isInPostingScope,
  matchSkillLabel,
  normalizeTradeLevelKey,
  packAnswerFromStoredRow,
  postingTradeFor,
  priceTierForTradeSkill,
  scopePostingSkills,
  tradeLevelEntriesForPackAnswers,
  tradeLevelLabelFor,
  type MatchSkillId,
} from "@badabhai/taxonomy";
import type { TradeFormKindName } from "@badabhai/types";

import { EXPERIENCE_BUCKETS, CandidateSearchSchema } from "../candidates/candidate-search.dto";
import type {
  CandidatePoolQuery,
  CandidateSearchRepository,
} from "../candidates/candidate-search.repository";
import {
  CandidateSearchService,
  expandSameLabelRoles,
} from "../candidates/candidate-search.service";
import { roleKindSchema } from "../common/job-content.schemas";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { PayerCreateJobPostingSchema } from "../job-postings/job-postings.dto";
import { PostingTradesService } from "../posting-trades/posting-trades.service";
import { toCorpusItem } from "../profiling/corpus-packs.fixture";
import type { PackRegistryService } from "../profiling/pack-registry.service";
import { descriptorForKind, TRADE_FORM_KINDS } from "../profiling/roles/role-registry";
import { attributesFor } from "./form-onboarding.test-support";
import type { MatchConfigService } from "./match-config.service";
import type { WorkerSkillsRepository } from "./worker-skills.repository";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE LAUNCH TRADES, END TO END — #2753 item 1.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The check: "Each launch trade can be set on a profile with level and years and used in a
 * posting and a search filter; sheet-metal programmer and 3D CAD designer have their own levels."
 * The launch trades are the brief's five: CNC operator (turner, VMC), CNC/CAM programmer,
 * sheet-metal operator and programmer, 3D CAD designer.
 *
 * ONE ROW PER TRADE, THREE STOPS, REAL PARTS. No hand-built pack and no hand-built ladder:
 *  - PROFILE — the ACTIVE version of the trade's checked-in pack (what the form and the chat
 *    serve), its level and tenure questions, chips run through the projector both writers call,
 *    then the crosswalk the persist path calls (`tradeLevelEntriesForPackAnswers`) and the derive
 *    path (`deriveWorkerSkills`) — the same seams `form-onboarding-match-skills.test.ts` uses.
 *  - POSTING — the posting DTO's role and rung schemas, then `PostingTradesService` over the same
 *    corpus pack, which is the validator a create, an edit and the agency path all call.
 *  - SEARCH — `CandidateSearchSchema`, the `GET /payer/candidates/filters` role list and the skill
 *    set `CandidateSearchService.search` hands the pool read.
 * The database is the one stub: what the pool read DOES with the skill set is the `.db` tests'.
 *
 * A KNOWN GAP IS PINNED, NOT HIDDEN. 3D CAD fails the posting stop today (it is not one of the 16
 * postable trades, #2635) and has no trade form (it is profiled by the chat interview only). Both
 * are asserted as they are, under "KNOWN GAP", so the day either changes this file goes red and
 * the row is updated rather than the gap being forgotten.
 */

/** One launch trade, as the brief names it and as the code spells it. */
interface LaunchTrade {
  readonly kind: TradeFormKindName;
  readonly packId: string;
  /** The trade's own match skill: the level row's skill, the posting's base, the search role. */
  readonly skillId: MatchSkillId;
  /** The stored values of the active level question, lowest rung first. */
  readonly levels: readonly string[];
  /** A chip that names the trade on a profile — what derives `skillId` for a worker. */
  readonly skillChip: { readonly question: string; readonly option: string };
  /** Whether the worker TRADE FORM serves it (false: the chat interview only). */
  readonly onTradeForm: boolean;
  /** Whether it is one of the 16 postable trades (#2635). */
  readonly postable: boolean;
}

const CNC_RUNGS = [
  "trainee",
  "operator",
  "setter",
  "setter_programmer",
  "programmer",
  "supervisor",
];

const LAUNCH_TRADES: readonly LaunchTrade[] = [
  {
    kind: "cnc_turner",
    packId: "qp_cnc_turning",
    skillId: "mskill_cnc_turner",
    levels: CNC_RUNGS,
    skillChip: { question: "turning_machine", option: "cnc_lathe" },
    onTradeForm: true,
    postable: true,
  },
  {
    kind: "vmc_milling",
    packId: "qp_vmc_milling",
    skillId: "mskill_vmc_operator",
    levels: CNC_RUNGS,
    skillChip: { question: "milling_machine", option: "vmc" },
    onTradeForm: true,
    postable: true,
  },
  {
    kind: "cam_programmer",
    packId: "qp_cam_programming",
    skillId: "mskill_cam_programmer",
    levels: ["trainee", "programmer", "senior", "lead", "supervisor"],
    skillChip: { question: "programming_mode", option: "cam_software" },
    onTradeForm: true,
    postable: true,
  },
  {
    kind: "sheet_metal_worker",
    packId: "qp_sheet_metal_fab",
    skillId: "mskill_sheet_metal_worker",
    // @3 (#2753 item 1): @2's "Senior / Programmer" chip is two rungs.
    levels: ["helper", "operator", "skilled", "senior", "programmer", "supervisor"],
    skillChip: { question: "sheet_metal_machine", option: "cnc_press_brake" },
    onTradeForm: true,
    postable: true,
  },
  {
    kind: "cad_designer_3d",
    packId: "qp_cad_design_3d",
    skillId: "mskill_cad_designer_3d",
    levels: ["trainee", "designer", "senior_designer", "lead", "supervisor"],
    skillChip: { question: "design_software", option: "solidworks" },
    onTradeForm: false,
    postable: false,
  },
];

/** The six-band tenure scale every launch trade's form asks (years as `value_number`). */
const TENURE_YEARS = [0, 0, 2, 4, 7, 12];

const CORPUS = loadQuestionPackCorpus().packs;

/** The ONE active version of a pack — what the form serves and `loadForFamily` resolves. */
function activePack(packId: string): PackRecord {
  const active = CORPUS.filter((p) => p.pack_id === packId && p.status === "active");
  if (active.length !== 1) throw new Error(`${packId} has ${active.length} active versions`);
  return active[0]!;
}

function itemOf(pack: PackRecord, predicate: (item: PackRecord["items"][number]) => boolean) {
  const item = pack.items.find(predicate);
  if (!item) throw new Error(`${pack.pack_id}@${pack.version}: question not found`);
  return item;
}

function levelItem(trade: LaunchTrade) {
  const levelKey = TRADE_LEVEL_PACKS[trade.packId]!.levelKey;
  return itemOf(
    activePack(trade.packId),
    (item) => (item.target_field ?? item.question_key) === levelKey,
  );
}

function tenureItem(trade: LaunchTrade) {
  const tenureKey = descriptorForKind(trade.kind)!.tenureQuestionKey;
  return itemOf(activePack(trade.packId), (item) => item.question_key === tenureKey);
}

/** What `WorkerSkillsService.rebuildForWorker` derives for a pack-only worker (form road). */
function derivedSkills(pack: PackRecord, answers: Record<string, readonly string[]>): string[] {
  const packAnswers = attributesFor(pack, answers).flatMap((attribute) => {
    const answer = packAnswerFromStoredRow({
      packId: pack.pack_id,
      attributeKey: attribute.attributeKey,
      valueText: attribute.valueKind === "text" ? (attribute.value as string) : null,
      valueTextList:
        attribute.valueKind === "text_list" ? [...(attribute.value as readonly string[])] : null,
    });
    return answer ? [answer] : [];
  });
  const input = workerSkillDeriveInput({ profile: null, secondaryRoleIds: [], packAnswers });
  return input === null ? [] : deriveWorkerSkills(input).map((row) => row.skillId);
}

/**
 * A family's ACTIVE corpus version in the engine's item shape — what `PackRegistryService`
 * resolves from the seeded rows. Mapped through `toCorpusItem` (never a cast) and memoised: the
 * service asks once per validation, and re-reading the corpus each time is seconds under CI load.
 */
const ENGINE_PACKS = new Map<string, QuestionPack | null>();
function activeEnginePack(familyId: string): QuestionPack | null {
  if (!ENGINE_PACKS.has(familyId)) {
    const active = CORPUS.filter((p) => p.family_id === familyId && p.status === "active");
    const record = active.length === 1 ? active[0]! : null;
    ENGINE_PACKS.set(
      familyId,
      record === null
        ? null
        : {
            pack_id: record.pack_id,
            version: record.version,
            family_id: record.family_id,
            locale: record.locale ?? "hi-IN",
            status: "active",
            content_hash: `corpus_${record.pack_id}_${record.version}`,
            items: (record.items as unknown as Array<Record<string, unknown>>).map(toCorpusItem),
          },
    );
  }
  return ENGINE_PACKS.get(familyId)!;
}

/** The posting validator over the checked-in corpus: each family resolves its ACTIVE version. */
function postingTrades(): PostingTradesService {
  const packs = {
    loadForFamily: async (familyId: string) => activeEnginePack(familyId),
  } as unknown as PackRegistryService;
  return new PostingTradesService(packs);
}

/** The search service with the database stubbed out; `searchPool` records what it was asked. */
function searchHarness() {
  const repo = {
    searchPool: vi.fn(async (_query: CandidatePoolQuery) => ({
      counts: { total: 0, matched: 0, unrecorded: 0 },
      rows: [],
    })),
    listPoolCities: vi.fn(async () => [] as string[]),
    listWantedRoles: vi.fn(async () => []),
  };
  const service = new CandidateSearchService(
    repo as unknown as CandidateSearchRepository,
    { listStatedTradeLevels: vi.fn(async () => []) } as unknown as WorkerSkillsRepository,
    { get: vi.fn(async () => ({ tierFloorMonths: 36 })) } as unknown as MatchConfigService,
    { emit: vi.fn(async () => undefined) } as unknown as EventsService,
  );
  return { service, repo };
}

const PAYER = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "corr-2753", requestId: "req-2753" } as RequestContext;

describe("the launch-trade table is the brief's five, spelled as the code spells them", () => {
  it("names each trade's pack, skill and level key consistently", () => {
    expect(LAUNCH_TRADES.map((t) => t.kind)).toEqual([
      "cnc_turner",
      "vmc_milling",
      "cam_programmer",
      "sheet_metal_worker",
      "cad_designer_3d",
    ]);
    for (const trade of LAUNCH_TRADES) {
      expect(descriptorForKind(trade.kind)?.packId, trade.kind).toBe(trade.packId);
      expect(TRADE_LEVEL_PACKS[trade.packId]?.skillId, trade.kind).toBe(trade.skillId);
    }
  });
});

describe.each(LAUNCH_TRADES)("$kind — a profile carries its level and years", (trade) => {
  const pack = activePack(trade.packId);
  const level = levelItem(trade);
  const tenure = tenureItem(trade);

  it("asks the level as a mandatory single-select whose stored values are the trade's ladder", () => {
    expect(level.answer_type).toBe("single_select");
    expect(level.is_mandatory).toBe(true);
    expect(level.options!.map((o) => o.value_text)).toEqual([...trade.levels]);
    const labels = trade.levels.map((stored) => tradeLevelLabelFor(trade.packId, stored));
    for (const [i, label] of labels.entries()) {
      expect(label, `${trade.packId}:${trade.levels[i]}`).toBeTruthy();
    }
    // Every rung prints apart from every other: no two stored rungs share a headline.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("stores each stated rung on the trade's own skill row (projector → persist crosswalk)", () => {
    for (const option of level.options!) {
      const attributes = attributesFor(pack, {
        [level.question_key]: [option.option_key],
        [tenure.question_key]: ["three_to_five"],
      });
      const entries = tradeLevelEntriesForPackAnswers(
        `${pack.pack_id}@${pack.version}`,
        attributes.map((a) => ({ attributeKey: a.attributeKey, value: a.value })),
      );
      expect(entries, `${trade.packId}:${option.option_key}`).toEqual([
        expect.objectContaining({
          skillId: trade.skillId,
          tradeLevel: normalizeTradeLevelKey(option.value_text),
        }),
      ]);
    }
  });

  it("asks each confirmed rung its separating question, gated on that rung", () => {
    const levelKey = TRADE_LEVEL_PACKS[trade.packId]!.levelKey;
    for (const [rung, confirmKey] of Object.entries(
      TRADE_LEVEL_CONFIRM_ITEMS[trade.packId] ?? {},
    )) {
      const confirm = itemOf(pack, (item) => item.question_key === confirmKey);
      expect(confirm.ask_if, `${trade.packId}:${rung}`).toMatchObject({
        op: "in",
        left: { field: levelKey },
        right: { const: expect.arrayContaining([rung]) },
      });
    }
  });

  it("asks the years as a mandatory single-select of the six numeric bands", () => {
    expect(tenure.answer_type).toBe("single_select");
    expect(tenure.is_mandatory).toBe(true);
    expect(tenure.options!.map((o) => o.value_number)).toEqual(TENURE_YEARS);
    // The projector stores the band's years, a number — what the years bridge (item 2) reads.
    const stored = attributesFor(pack, { [tenure.question_key]: ["three_to_five"] }).find(
      (a) => a.attributeKey === (tenure.target_field ?? tenure.question_key),
    );
    expect(stored?.value).toBe(4);
    // Each band, read as months, lands in exactly one experience bucket the search offers.
    for (const years of TENURE_YEARS) {
      const months = years * 12;
      const buckets = EXPERIENCE_BUCKETS.filter(
        (b) => months >= b.minMonths && (b.maxMonths === null || months < b.maxMonths),
      );
      expect(buckets, `${years} years`).toHaveLength(1);
    }
  });

  it("derives the trade's own match skill from a chip that names the trade", () => {
    const answers = {
      [trade.skillChip.question]: [trade.skillChip.option],
      [tenure.question_key]: ["three_to_five"],
    };
    expect(derivedSkills(pack, answers)).toContain(trade.skillId);
  });

  it(
    trade.onTradeForm
      ? "is served by the worker trade form"
      : "KNOWN GAP — has no trade form; the chat interview is its only profile surface",
    () => {
      expect(descriptorForKind(trade.kind)!.formEnabled).toBe(trade.onTradeForm);
      expect((TRADE_FORM_KINDS as readonly string[]).includes(trade.kind)).toBe(trade.onTradeForm);
    },
  );
});

describe.each(LAUNCH_TRADES.filter((t) => t.postable))("$kind — a posting can name it", (trade) => {
  const posting = postingTradeFor(trade.kind)!;

  it("is one of the postable trades, matching on the trade's own skill", () => {
    expect(posting).toBeDefined();
    expect(posting.packId).toBe(trade.packId);
    expect(posting.matchSkillId).toBe(trade.skillId);
    expect(scopePostingSkills(trade.kind, [])).toEqual({ kept: [trade.skillId], dropped: [] });
  });

  it("accepts the role and every ladder rung on the posting body", () => {
    for (const { rung } of posting.ladder) {
      const parsed = PayerCreateJobPostingSchema.safeParse({
        org_label: "Acme Works",
        role_title: "Shop floor opening",
        vacancy_band: "1",
        role_kind: trade.kind,
        trade_level: rung,
      });
      expect(parsed.success, `${trade.kind}:${rung}`).toBe(true);
    }
    expect(roleKindSchema.safeParse(trade.kind).success).toBe(true);
  });

  it("validates every ladder rung against the trade's active pack, deriving the trade's skill", async () => {
    const service = postingTrades();
    const form = await service.formFor(trade.kind);
    expect(form?.pack_id).toBe(trade.packId);
    expect(form?.questions.length, "the active pack resolved").toBeGreaterThan(0);
    for (const { rung } of posting.ladder) {
      const selection = await service.normalizeSelection(trade.kind, rung, {});
      expect(selection.tradeLevel).toBe(rung);
      expect(selection.matchSkillIds).toEqual([trade.skillId]);
      const shown = await service.describeSelection(trade.kind, rung, {});
      expect(shown.levelLabel).toBe(TRADE_LEVEL_LABELS[rung]);
    }
  });

  it("accepts as a posting rung every rung a worker of the trade can state", async () => {
    // One ladder on both sides (30 Oct ruling Q2, #2550): a company can ask for any level a
    // worker can claim — on the ladder, or (the worker pack's `helper`) as a legacy key.
    const service = postingTrades();
    for (const stored of trade.levels) {
      const rung = normalizeTradeLevelKey(stored)!;
      const selection = await service.normalizeSelection(trade.kind, rung, {});
      expect(selection.tradeLevel, `${trade.kind}:${rung}`).toBe(rung);
    }
  });
});

describe("cad_designer_3d — KNOWN GAP: a posting can name the role but cannot go live or carry a level", () => {
  // 3D CAD is not one of the 16 postable trades (#2635, owner rulings 2026-11-03/04). A company may
  // save a DRAFT naming it (the role enum is all declared kinds), but publishing is refused with
  // `posting_trade_required`, the trade fields are refused, and no 16-trade job can reach the
  // trade's own skill. Making it postable is a 17th catalogue row plus the "16 trades" copy in
  // both payer clients and the API's refusal — an owner decision, reported on #2753, not made here.
  const trade = LAUNCH_TRADES.find((t) => t.kind === "cad_designer_3d")!;

  it("is accepted as a role on a draft", () => {
    expect(roleKindSchema.safeParse(trade.kind).success).toBe(true);
  });

  it("is not postable, so a publish naming it is refused and its rungs are rejected", async () => {
    expect(postingTradeFor(trade.kind)).toBeUndefined();
    expect(scopePostingSkills(trade.kind, [trade.skillId])).toBeUndefined();
    await expect(
      postingTrades().normalizeSelection(trade.kind, "senior_designer", {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("keeps the trade's own skill outside the 16-trade matching scope", () => {
    expect(isInPostingScope(trade.skillId)).toBe(false);
  });
});

describe.each(LAUNCH_TRADES)("$kind — the company search filter maps it to its skill", (trade) => {
  it("accepts the trade's skill as a role filter", () => {
    expect(CandidateSearchSchema.safeParse({ skill_ids: [trade.skillId] }).success).toBe(true);
  });

  it("offers one role option that names the trade and widens to its skill", async () => {
    const { service } = searchHarness();
    const { roles } = await service.filters();
    const offered = roles.filter((role) => expandSameLabelRoles([role.id]).includes(trade.skillId));
    expect(offered).toHaveLength(1);
    expect(offered[0]!.label).toBe(matchSkillLabel(trade.skillId));
  });

  it("hands the pool read the trade's skill when that option is searched", async () => {
    const { service, repo } = searchHarness();
    const { roles } = await service.filters();
    const option = roles.find((role) => expandSameLabelRoles([role.id]).includes(trade.skillId))!;
    await service.search(PAYER, CandidateSearchSchema.parse({ skill_ids: [option.id] }), CTX);
    const query = repo.searchPool.mock.calls[0]![0];
    expect(query.skillIds).toContain(trade.skillId);
  });
});

describe("sheet-metal programmer and 3D CAD designer have their own levels", () => {
  it("sheet metal (@3): Programmer is a rung of its own, above Senior and below Supervisor", () => {
    const sheet = LAUNCH_TRADES.find((t) => t.kind === "sheet_metal_worker")!;
    const options = levelItem(sheet).options!;
    expect(options.map((o) => [o.option_key, o.label_text, o.value_text])).toEqual([
      ["helper", "Helper", "helper"],
      ["operator", "Operator", "operator"],
      ["skilled", "Skilled", "skilled"],
      ["senior", "Senior", "senior"],
      ["programmer", "Programmer", "programmer"],
      ["supervisor", "Supervisor", "supervisor"],
    ]);
    expect(tradeLevelLabelFor(sheet.packId, "programmer")).toBe("Programmer");
    expect(priceTierForTradeSkill(sheet.skillId, "programmer")).toBe("higher");
    // The posting ladder carries the same split, in the same order.
    expect(postingTradeFor(sheet.kind)!.ladder.map((r) => r.rung)).toEqual([
      "trainee",
      "operator",
      "skilled",
      "senior",
      "programmer",
      "supervisor",
    ]);
  });

  it("sheet metal: a stored @2 `senior` answer stays valid on @3 and still reads Senior", () => {
    const sheet = LAUNCH_TRADES.find((t) => t.kind === "sheet_metal_worker")!;
    const v2 = CORPUS.find((p) => p.pack_id === sheet.packId && p.version === 2)!;
    const v2Senior = v2.items
      .find((i) => i.question_key === "sheet_metal_level")!
      .options!.find((o) => o.value_text === "senior")!;
    expect(v2Senior.label_text).toBe("Senior / Programmer");
    expect(levelItem(sheet).options!.some((o) => o.value_text === "senior")).toBe(true);
    expect(tradeLevelLabelFor(sheet.packId, "senior")).toBe("Senior");
  });

  it("3D CAD: Designer and Senior Designer are rungs of their own", () => {
    const cad = LAUNCH_TRADES.find((t) => t.kind === "cad_designer_3d")!;
    const labels = Object.fromEntries(
      levelItem(cad).options!.map((o) => [
        o.value_text,
        tradeLevelLabelFor(cad.packId, o.value_text),
      ]),
    );
    expect(labels).toEqual({
      trainee: "Trainee",
      designer: "Designer",
      senior_designer: "Senior Designer",
      lead: "Lead",
      supervisor: "Supervisor",
    });
    expect(priceTierForTradeSkill(cad.skillId, "designer")).toBe("lower");
    expect(priceTierForTradeSkill(cad.skillId, "senior_designer")).toBe("higher");
  });
});
