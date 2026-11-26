import { describe, expect, it } from "vitest";
import type { AnswerRecord } from "@badabhai/ai-contracts";
import {
  PACK_ANSWER_SKILLS,
  packAnswerEvidence,
  packAnswerFromStoredRow,
} from "@badabhai/taxonomy";

import { projectProfile } from "./answer-map-projector";
import { buildTradeCapabilityRows } from "../resume/trade-resume-map";

/**
 * #3019 — shared question keys across two trade forms.
 *
 * A synthetic worker answers `troubleshooting` and `sector_worked` under
 * `qp_plc_automation` and then under `qp_robotics` with different chips.
 * The test runs the real projector, the real resume maps and the real
 * pack-answer bridge over the final attribute bag.
 */

const PLC_PACK = "qp_plc_automation";
const ROBOTICS_PACK = "qp_robotics";

// The two shared keys, answered differently per trade.
const PLC_TROUBLESHOOTING = ["plc_fault", "drive_fault"];
const ROBOTICS_TROUBLESHOOTING = ["collision_recovery", "backup_restore"];
const PLC_SECTOR = ["pharma", "steel_plant"];
const ROBOTICS_SECTOR = ["two_wheeler", "foundry"];

function multiRecord(questionKey: string, values: readonly string[]): AnswerRecord {
  return {
    question_key: questionKey,
    target_field: questionKey,
    status: "answered",
    value_raw: null,
    value_normalized: [...values],
    evidence: null,
    turn: 0,
    history: [],
  };
}

interface StoredAttr {
  attributeKey: string;
  value: readonly string[];
  packId: string | null;
}

function toFinalBag(plc: StoredAttr[], robotics: StoredAttr[]): Record<string, unknown> {
  // Observed: worker_attributes is keyed by (worker, attributeKey), so the second form's shared answers replace the first's.
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
    valueText: null,
    valueTextList: value,
  }));
}

describe("shared question keys pinned (#3019)", () => {
  it("profiles one worker through PLC then robotics and pins storage, resume and match derivation", () => {
    const plcAttrs = projectProfile([
      multiRecord("troubleshooting", PLC_TROUBLESHOOTING),
      multiRecord("sector_worked", PLC_SECTOR),
    ]).attributes;
    const roboticsAttrs = projectProfile([
      multiRecord("troubleshooting", ROBOTICS_TROUBLESHOOTING),
      multiRecord("sector_worked", ROBOTICS_SECTOR),
    ]).attributes;

    expect(
      plcAttrs.find((a) => a.attributeKey === "troubleshooting")?.value,
    ).toEqual(PLC_TROUBLESHOOTING);
    expect(
      roboticsAttrs.find((a) => a.attributeKey === "troubleshooting")?.value,
    ).toEqual(ROBOTICS_TROUBLESHOOTING);

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
    expect(bag["troubleshooting"]).toEqual(ROBOTICS_TROUBLESHOOTING);
    expect(bag["sector_worked"]).toEqual(ROBOTICS_SECTOR);

    // What each resume section prints from the single shared bag.
    const plcRows = buildTradeCapabilityRows(PLC_PACK, bag);
    const roboticsRows = buildTradeCapabilityRows(ROBOTICS_PACK, bag);

    const plcTrouble = plcRows.tickRows.find((r) => r.label === "Troubleshooting");
    expect(plcTrouble?.values).toEqual(["Program download and backup restore"]);
    const plcSector = plcRows.factRows.find((r) => r.label === "Industry");
    expect(plcSector).toBeUndefined();

    const roboticsTrouble = roboticsRows.tickRows.find((r) => r.label === "Troubleshooting");
    expect(roboticsTrouble?.values).toEqual([
      "Collision / servo-alarm recovery",
      "Program backup & restore",
    ]);
    const roboticsSector = roboticsRows.factRows.find((r) => r.label === "Sector worked");
    expect(roboticsSector?.value).toBe("Two-wheelers, Die casting / foundry");

    // What PACK_ANSWER_SKILLS derives: troubleshooting and sector_worked are display-only in
    // both packs, so neither shared key derives a match skill under either pack id (rule 4 pack-scoped).
    expect(PACK_ANSWER_SKILLS[PLC_PACK]?.["troubleshooting"]).toBeUndefined();
    expect(PACK_ANSWER_SKILLS[PLC_PACK]?.["sector_worked"]).toBeUndefined();
    expect(PACK_ANSWER_SKILLS[ROBOTICS_PACK]?.["troubleshooting"]).toBeUndefined();
    expect(PACK_ANSWER_SKILLS[ROBOTICS_PACK]?.["sector_worked"]).toBeUndefined();

    const answers = storedRows(bag, ROBOTICS_PACK).flatMap((row) => {
      const parsed = packAnswerFromStoredRow(row);
      return parsed ? [parsed] : [];
    });
    expect(packAnswerEvidence(answers)).toEqual({
      corpusSkillIds: [],
      roleIds: [],
      matchSkillIds: [],
    });
  });
});
