import { describe, expect, it } from "vitest";
import type { AnswerRecord, QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import {
  PACK_ANSWER_SKILLS,
  packAnswerEvidence,
  packAnswerFromStoredRow,
} from "@badabhai/taxonomy";

import { projectProfile } from "./answer-map-projector";
import { packAnswerRowFor } from "./pack-answer-row";
import { buildTradeCapabilityRows } from "../resume/trade-resume-map";
import { scopeSectionAttributesToPack } from "../resume/pack-section-attributes";

import { corpusPack } from "./corpus-packs.fixture";

/**
 * #3019 pinned the destructive behaviour; #3086 fixes the resume half and pins the fix.
 *
 * A synthetic worker answers `troubleshooting` and `sector_worked` under `qp_plc_automation`
 * and then under `qp_robotics` with different chips. The test runs the real projector, the
 * real pack-answer row builder, the real per-pack scoping, the real resume maps and the real
 * pack-answer bridge.
 *
 * What STAYS (storage regression history — #3086 changes no storage): `worker_attributes`
 * is keyed by (worker, attributeKey) via `wa_worker_key_uq`, so the robotics answers still
 * replace the PLC ones in the shared bag.
 *
 * What #3086 FIXED (resume regression history): each trade's resume section now reads its own
 * form's answers (`worker_pack_answer`, keyed per worker+pack+question) overlaid on the shared
 * bag. Before, the PLC section printed the robotics `backup_restore` chip under its own label
 * ("Program download and backup restore") and dropped its `Industry` row; now it prints its
 * own chips and its own industry row.
 */

// The real packs: the section join (`question_key` → `target_field`) runs against the
// authored items, so a future target rename updates this pin instead of silently rescoping.
const PLC = corpusPack("qp_plc_automation", 2);
const ROBOTICS = corpusPack("qp_robotics", 1);
const PLC_PACK = PLC.pack_id;
const ROBOTICS_PACK = ROBOTICS.pack_id;

function itemOf(pack: QuestionPack, questionKey: string): QuestionPackItem {
  const item = pack.items.find((candidate) => candidate.question_key === questionKey);
  if (!item || item.target_field === null) {
    throw new Error(`${pack.pack_id} has no targeted item ${questionKey}`);
  }
  return item;
}

/** Option keys → the values the write path stores, exactly as `recordFor` resolves them. */
function valuesOf(item: QuestionPackItem, keys: readonly string[]): unknown {
  const byKey = new Map(item.options.map((option) => [option.option_key, option]));
  const values = keys.map((key) => {
    const option = byKey.get(key);
    if (!option) throw new Error(`${item.question_key} has no option ${key}`);
    return option.value ?? option.label_text;
  });
  return item.answer_type === "single_select" ? values[0]! : values;
}

function recordFor(item: QuestionPackItem, keys: readonly string[]): AnswerRecord {
  return {
    question_key: item.question_key,
    target_field: item.target_field,
    status: "answered",
    value_raw: null,
    value_normalized: valuesOf(item, keys) as AnswerRecord["value_normalized"],
    evidence: null,
    turn: 0,
    history: [],
  };
}

// The two shared keys, answered differently per trade.
const PLC_TROUBLESHOOTING = ["plc_fault", "drive_fault"];
const ROBOTICS_TROUBLESHOOTING = ["collision_recovery", "backup_restore"];
const PLC_SECTOR = ["pharma", "steel_plant"];
const ROBOTICS_SECTOR = ["two_wheeler", "foundry"];
// Rule-4 controls: a chip that derives under exactly one pack.
const PLC_BRAND = ["siemens"];
const ROBOT_BRAND = ["fanuc"];

interface StoredAttr {
  attributeKey: string;
  value: readonly string[];
  packId: string | null;
}

function toFinalBag(plc: StoredAttr[], robotics: StoredAttr[]): Record<string, unknown> {
  // UNCHANGED BY #3086 — the storage regression pin. `worker_attributes` is keyed by
  // (worker, attributeKey), so the second form's shared answers still replace the first's.
  const store = new Map<string, StoredAttr>();
  for (const row of [...plc, ...robotics]) store.set(row.attributeKey, row);
  const bag: Record<string, unknown> = {};
  for (const row of store.values()) bag[row.attributeKey] = [...row.value];
  return bag;
}

function storedRows(bag: Record<string, unknown>, packId: string) {
  return Object.entries(bag).map(([attributeKey, value]) => ({
    packId,
    attributeKey,
    valueText: Array.isArray(value) ? null : (value as string),
    valueTextList: Array.isArray(value) ? value : null,
  }));
}

function packRowsFor(pack: QuestionPack, packVersion: number, records: readonly AnswerRecord[]) {
  return records.map((record) => {
    const row = packAnswerRowFor({
      workerId: "worker-3086",
      sessionId: null,
      packId: pack.pack_id,
      packVersion,
      record,
      source: "form",
    });
    if (!row) throw new Error(`${pack.pack_id}.${record.question_key} produced no row`);
    return row;
  });
}

describe("shared question keys pinned (#3019, fixed #3086)", () => {
  it("profiles one worker through PLC then robotics and pins storage, per-pack resume and per-form derivation", () => {
    const plcTrouble = itemOf(PLC, "troubleshooting");
    const plcSector = itemOf(PLC, "sector_worked");
    const plcBrand = itemOf(PLC, "plc_brand");
    const roboticsTrouble = itemOf(ROBOTICS, "troubleshooting");
    const roboticsSector = itemOf(ROBOTICS, "sector_worked");
    const robotBrand = itemOf(ROBOTICS, "robot_brand");

    const plcAttrs = projectProfile([
      recordFor(plcTrouble, PLC_TROUBLESHOOTING),
      recordFor(plcSector, PLC_SECTOR),
      recordFor(plcBrand, PLC_BRAND),
    ]).attributes;
    const roboticsAttrs = projectProfile([
      recordFor(roboticsTrouble, ROBOTICS_TROUBLESHOOTING),
      recordFor(roboticsSector, ROBOTICS_SECTOR),
      recordFor(robotBrand, ROBOT_BRAND),
    ]).attributes;

    expect(plcAttrs.find((a) => a.attributeKey === "troubleshooting")?.value).toEqual(
      PLC_TROUBLESHOOTING,
    );
    expect(roboticsAttrs.find((a) => a.attributeKey === "troubleshooting")?.value).toEqual(
      ROBOTICS_TROUBLESHOOTING,
    );

    const plcStored: StoredAttr[] = plcAttrs.map((a) => ({
      attributeKey: a.attributeKey,
      value: a.value as readonly string[],
      packId: PLC_PACK,
    }));
    const roboticsStored: StoredAttr[] = roboticsAttrs.map((a) => ({
      attributeKey: a.attributeKey,
      value: a.value as readonly string[],
      packId: ROBOTICS_PACK,
    }));

    const bag = toFinalBag(plcStored, roboticsStored);

    // What is stored: the robotics answers replace the PLC answers on both shared keys.
    // (#3086 leaves this exactly as #3019 pinned it — storage is unchanged by design.)
    expect(bag["troubleshooting"]).toEqual(ROBOTICS_TROUBLESHOOTING);
    expect(bag["sector_worked"]).toEqual(ROBOTICS_SECTOR);

    // Each trade's section reads its own form's answers: the real pack-answer rows for one
    // pack, projected through the real item targets, overlaid on the shared bag.
    const plcRows = packRowsFor(PLC, 2, [
      recordFor(plcTrouble, PLC_TROUBLESHOOTING),
      recordFor(plcSector, PLC_SECTOR),
      recordFor(plcBrand, PLC_BRAND),
    ]);
    const roboticsRows = packRowsFor(ROBOTICS, 1, [
      recordFor(roboticsTrouble, ROBOTICS_TROUBLESHOOTING),
      recordFor(roboticsSector, ROBOTICS_SECTOR),
      recordFor(robotBrand, ROBOT_BRAND),
    ]);
    const targets = new Map(
      [...PLC.items, ...ROBOTICS.items].map((item) => [item.question_key, item.target_field]),
    );
    const targetFieldOf = (key: string): string | null => targets.get(key) ?? null;
    const plcBag = scopeSectionAttributesToPack(bag, plcRows, targetFieldOf);
    const roboticsBag = scopeSectionAttributesToPack(bag, roboticsRows, targetFieldOf);

    // Per-form answers survive the overlay: each bag holds its own pack's values.
    expect(plcBag["troubleshooting"]).toEqual(PLC_TROUBLESHOOTING);
    expect(plcBag["sector_worked"]).toEqual(PLC_SECTOR);
    expect(plcBag["plc_brand"]).toEqual(PLC_BRAND);
    expect(roboticsBag["troubleshooting"]).toEqual(ROBOTICS_TROUBLESHOOTING);
    expect(roboticsBag["sector_worked"]).toEqual(ROBOTICS_SECTOR);
    expect(roboticsBag["robot_brand"]).toEqual(ROBOT_BRAND);

    // What each resume section prints from its own scoped bag. Before #3086 both sections
    // read the single shared bag: the PLC section printed the robotics `backup_restore` chip
    // under its own label and dropped its `Industry` row entirely.
    const plcSection = buildTradeCapabilityRows(PLC_PACK, plcBag);
    const roboticsSection = buildTradeCapabilityRows(ROBOTICS_PACK, roboticsBag);

    const plcTroubleRow = plcSection.tickRows.find((r) => r.label === "Troubleshooting");
    expect(plcTroubleRow?.values).toEqual(["PLC fault / CPU stop", "Drive trip and alarm"]);
    const plcSectorRow = plcSection.factRows.find((r) => r.label === "Industry");
    expect(plcSectorRow?.value).toBe("Pharma, Steel / metal plant");

    const roboticsTroubleRow = roboticsSection.tickRows.find((r) => r.label === "Troubleshooting");
    expect(roboticsTroubleRow?.values).toEqual([
      "Collision / servo-alarm recovery",
      "Program backup & restore",
    ]);
    const roboticsSectorRow = roboticsSection.factRows.find((r) => r.label === "Sector worked");
    expect(roboticsSectorRow?.value).toBe("Two-wheelers, Die casting / foundry");

    // What PACK_ANSWER_SKILLS derives: troubleshooting and sector_worked are display-only in
    // both packs, so neither shared key derives a match skill under either pack id (rule 4
    // pack-scoped holds — and the vacuous case stays pinned).
    expect(PACK_ANSWER_SKILLS[PLC_PACK]?.["troubleshooting"]).toBeUndefined();
    expect(PACK_ANSWER_SKILLS[PLC_PACK]?.["sector_worked"]).toBeUndefined();
    expect(PACK_ANSWER_SKILLS[ROBOTICS_PACK]?.["troubleshooting"]).toBeUndefined();
    expect(PACK_ANSWER_SKILLS[ROBOTICS_PACK]?.["sector_worked"]).toBeUndefined();

    // The vacuous case as #3019 pinned it: the shared keys alone, stored under the last
    // writer's pack, derive nothing. (They are picked out of the bag because the bag also
    // carries the packs' deriving brand keys — covered per-form below.)
    const sharedOnly = Object.fromEntries(
      Object.entries(bag).filter(([key]) => key === "troubleshooting" || key === "sector_worked"),
    );
    const answers = storedRows(sharedOnly, ROBOTICS_PACK).flatMap((row) => {
      const parsed = packAnswerFromStoredRow(row);
      return parsed ? [parsed] : [];
    });
    expect(packAnswerEvidence(answers)).toEqual({
      corpusSkillIds: [],
      roleIds: [],
      matchSkillIds: [],
    });

    // Per-form derivation, verified through each pack's own scoped bag: a deriving chip
    // stored under its own pack derives that pack's skill, and the same chip stored under
    // the other pack derives nothing (rule 4 — scoped, never global).
    const plcEvidence = packAnswerEvidence(
      storedRows(plcBag, PLC_PACK).flatMap((row) => {
        const parsed = packAnswerFromStoredRow(row);
        return parsed ? [parsed] : [];
      }),
    );
    expect(plcEvidence).toEqual({
      corpusSkillIds: [],
      roleIds: [],
      matchSkillIds: ["mskill_plc_automation_tech"],
    });
    const roboticsEvidence = packAnswerEvidence(
      storedRows(roboticsBag, ROBOTICS_PACK).flatMap((row) => {
        const parsed = packAnswerFromStoredRow(row);
        return parsed ? [parsed] : [];
      }),
    );
    expect(roboticsEvidence).toEqual({
      corpusSkillIds: [],
      roleIds: [],
      matchSkillIds: ["mskill_robot_operator_programmer"],
    });

    const siemensUnderRobotics = packAnswerFromStoredRow({
      packId: ROBOTICS_PACK,
      attributeKey: "plc_brand",
      valueText: null,
      valueTextList: [...PLC_BRAND],
    });
    expect(siemensUnderRobotics).not.toBeNull();
    expect(packAnswerEvidence([siemensUnderRobotics!])).toEqual({
      corpusSkillIds: [],
      roleIds: [],
      matchSkillIds: [],
    });
    const fanucUnderPlc = packAnswerFromStoredRow({
      packId: PLC_PACK,
      attributeKey: "robot_brand",
      valueText: null,
      valueTextList: [...ROBOT_BRAND],
    });
    expect(fanucUnderPlc).not.toBeNull();
    expect(packAnswerEvidence([fanucUnderPlc!])).toEqual({
      corpusSkillIds: [],
      roleIds: [],
      matchSkillIds: [],
    });
  });
});
