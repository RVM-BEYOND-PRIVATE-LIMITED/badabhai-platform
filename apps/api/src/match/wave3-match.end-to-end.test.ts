import { describe, expect, it, vi } from "vitest";
import { deriveWorkerSkills, workerSkillDeriveInput } from "@badabhai/match-engine";
import { matchTierFor } from "@badabhai/match-engine";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";
import {
  PACK_ANSWER_SKILLS,
  TRADE_CATALOGUE,
  matchSkillLabel,
  packAnswerFromStoredRow,
  postingTradeFor,
  scopePostingSkills,
  type MatchSkillId,
} from "@badabhai/taxonomy";
import type { QuestionPack } from "@badabhai/ai-contracts";

import { CandidateSearchSchema } from "../candidates/candidate-search.dto";
import type {
  CandidatePoolQuery,
  CandidateSearchRepository,
} from "../candidates/candidate-search.repository";
import {
  CandidateSearchService,
  expandSameLabelRoles,
} from "../candidates/candidate-search.service";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { PostingTradesService } from "../posting-trades/posting-trades.service";
import { toCorpusItem } from "../profiling/corpus-packs.fixture";
import type { PackRegistryService } from "../profiling/pack-registry.service";
import { releaseServiceFor } from "../trade-release/trade-release.test-support";
import { attributesFor } from "./form-onboarding.test-support";
import type { MatchConfigService } from "./match-config.service";
import type { WorkerSkillsRepository } from "./worker-skills.repository";

/**
 * Wave 3 end-to-end, offline half (#3051).
 *
 * For every Wave 3 trade (TRADE_CATALOGUE wave == 3, 8 trades that complete the catalogue):
 *  - a synthetic worker answering the claim question holds the base skill;
 *  - a posting for the trade stores that skill;
 *  - the worker is tier 1 on it, a related holder is tier 2, an unrelated holder is null;
 *  - the company search filter maps the skill (the pre-DB half of feed/may-apply).
 *
 * Stored `job_reach` rows, the V1 feed join and `may apply` are the `.db` twins'
 * half (form-onboarding-reach.db.test.ts pattern) and are proven on the #3013
 * seed, when the release switch is on. The tier decided here IS the row's
 * content (`matchTierFor`), so this pins what the seed will store.
 *
 * No database, no AI models. `db:eval:occupation` (offline, embeddings off) is
 * the routing-quality half; its before/after scores go on the PR, not here.
 */

const WAVE3 = TRADE_CATALOGUE.filter((e) => e.wave === 3);
const CORPUS = loadQuestionPackCorpus().packs;

function activePack(packId: string): PackRecord {
  const active = CORPUS.filter((p) => p.pack_id === packId && p.status === "active");
  if (active.length !== 1) throw new Error(`${packId} has ${active.length} active versions`);
  return active[0]!;
}

function derivedSkills(packId: string, answers: Record<string, readonly string[]>): string[] {
  const pack = activePack(packId);
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
  return input === null ? [] : deriveWorkerSkills(input).map((row) => row.skillId).sort();
}

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

function postingTrades(): PostingTradesService {
  const packs = {
    loadForFamily: async (familyId: string) => activeEnginePack(familyId),
  } as unknown as PackRegistryService;
  // Simulate the #3013 switch-on: all Wave 1 kinds posting-enabled.
  return new PostingTradesService(
    packs,
    releaseServiceFor(WAVE3.map((e) => e.roleKind)),
  );
}

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
const CTX = { correlationId: "corr-3051", requestId: "req-3051" } as RequestContext;

/** First non-escape chip of the claim question that the ACTIVE pack still offers. */
function firstClaimChip(packId: string, claimKey: string): string {
  const pack = activePack(packId);
  const item = pack.items.find((i) => i.question_key === claimKey)!;
  const offered = new Set(
    (item.options ?? [])
      .filter((o) => o.is_none_of_above !== true)
      .map((o) => o.option_key),
  );
  const mapped = Object.keys(PACK_ANSWER_SKILLS[packId]?.[claimKey] ?? {});
  const chip = mapped.find((o) => offered.has(o));
  if (!chip) throw new Error(`${packId}.${claimKey} has no mapped chip on the active pack`);
  return chip;
}

describe("wave 3 catalogue shape (#3051)", () => {
  it("covers the eight Wave 3 trades", () => {
    expect(WAVE3.map((e) => e.code).sort()).toEqual([
      "T44", "T49", "T50", "T51", "T53", "T55", "T59", "T60",
    ]);
    for (const e of WAVE3) expect(e.claimQuestionKey, e.code).toBeDefined();
  });
});

describe.each(WAVE3)("$code $packId — profile, posting, tier, search", (trade) => {
  const claimKey = trade.claimQuestionKey!;
  const chip = firstClaimChip(trade.packId, claimKey);

  it("a synthetic worker answering the claim question holds the base skill", () => {
    expect(derivedSkills(trade.packId, { [claimKey]: [chip] })).toContain(trade.matchSkillId);
  });

  it("a posting for the trade stores that skill", async () => {
    const service = postingTrades();
    const form = await service.formFor(trade.roleKind);
    expect(form?.pack_id, `${trade.code} form`).toBe(trade.packId);
    const rungs = postingTradeFor(trade.roleKind)!.ladder;
    for (const { rung } of rungs.slice(0, 3)) {
      const selection = await service.normalizeSelection(trade.roleKind, rung, {});
      expect(selection.matchSkillIds).toEqual([trade.matchSkillId as MatchSkillId]);
    }
    expect(scopePostingSkills(trade.roleKind, [])).toEqual({
      kept: [trade.matchSkillId],
      dropped: [],
    });
  });

  it("tier 1 for the holder, tier 2 for a related holder, null for an unrelated holder", () => {
    expect(matchTierFor([trade.matchSkillId as MatchSkillId], [trade.matchSkillId as MatchSkillId])).toBe(1);
    if (trade.relatedTo.length === 0) {
      // T49 Safety has no related trade by ruling; nothing is tier 2 on it.
      expect(trade.code).toBe("T49");
    } else {
      const related = trade.relatedTo[0]! as MatchSkillId;
      expect(matchTierFor([related], [trade.matchSkillId as MatchSkillId])).toBe(2);
    }
    // mskill_plumber is outside the Wave 3 manufacturing set; it reaches none of them.
    expect(matchTierFor(["mskill_plumber" as MatchSkillId], [trade.matchSkillId as MatchSkillId])).toBeNull();
  });

  it("the company search filter maps the skill", async () => {
    expect(CandidateSearchSchema.safeParse({ skill_ids: [trade.matchSkillId] }).success).toBe(true);
    const { service, repo } = searchHarness();
    const { roles } = await service.filters();
    const option = roles.find((role) => expandSameLabelRoles([role.id]).includes(trade.matchSkillId));
    expect(option, `${trade.code} search option`).toBeDefined();
    expect(option!.label).toBe(matchSkillLabel(trade.matchSkillId as MatchSkillId));
    await service.search(PAYER, CandidateSearchSchema.parse({ skill_ids: [option!.id] }), CTX);
    expect(repo.searchPool.mock.calls[0]![0].skillIds).toContain(trade.matchSkillId);
  });
});

describe("three named cases (#3051 §2)", () => {
  it("a holder of the legacy Foundry/Forging skill matches a Die Casting job at tier 2", () => {
    expect(
      matchTierFor(["mskill_foundry_forging_operator" as MatchSkillId], ["mskill_die_casting_operator" as MatchSkillId]),
    ).toBe(2);
  });

  it("a PLC technician who ticks robot teaching derives the robot skill and matches a Robot job at tier 1", () => {
    const skills = derivedSkills("qp_plc_automation", {
      plc_brand: ["siemens"],
      plc_advanced_system: ["robot_programming"],
    });
    expect(skills).toContain("mskill_plc_automation_tech");
    expect(skills).toContain("mskill_robot_operator_programmer");
    expect(
      matchTierFor(skills as MatchSkillId[], ["mskill_robot_operator_programmer" as MatchSkillId]),
    ).toBe(1);
  });

  it("a T58 3D CAD job reaches a 2D draughtsman at tier 2", () => {
    expect(
      matchTierFor(["mskill_designer" as MatchSkillId], ["mskill_cad_designer_3d" as MatchSkillId]),
    ).toBe(2);
  });

  it("T49 Safety has no related trade: no tier 2 row exists", async () => {
    const t49 = TRADE_CATALOGUE.find((e) => e.code === "T49")!;
    expect(t49.relatedTo).toEqual([]);
    expect(
      matchTierFor(["mskill_plumber" as MatchSkillId], [t49.matchSkillId as MatchSkillId]),
    ).toBeNull();
  });
});
