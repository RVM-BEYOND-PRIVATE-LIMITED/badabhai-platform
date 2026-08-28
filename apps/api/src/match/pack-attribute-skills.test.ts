import { describe, expect, it } from "vitest";
import { deriveWorkerSkills } from "@badabhai/match-engine";
import { ATTRIBUTE_TO_MATCH_SKILLS } from "@badabhai/taxonomy";

import {
  corpusSkillsEmitted,
  corpusSkillsForPackAttributes,
  PACK_ATTRIBUTE_SKILLS,
} from "./pack-attribute-skills";

/** The three answers the turner-reach fixture seeds, as `worker_attributes` holds them. */
const TURNER = new Map<string, readonly string[]>([
  ["turning_machine", ["cnc_lathe", "conventional_lathe"]],
  ["controller_brand", ["fanuc", "siemens"]],
  ["setting_operation", ["tool_offset", "work_offset", "first_piece"]],
]);

/** The end-to-end product statement, without a database: chips in, match skills out. */
const matchSkillsFor = (answers: ReadonlyMap<string, readonly string[]>): string[] =>
  deriveWorkerSkills({
    canonicalRoleId: null,
    profileSkills: corpusSkillsForPackAttributes(answers),
    totalYears: 8,
  })
    .map((row) => row.skillId)
    .sort();

describe("B0b — a role-pack turner becomes reachable", () => {
  it("derives mskill_cnc_turner from the machine he said he runs", () => {
    // THE WHOLE POINT OF THE ITEM. Before this bridge these exact answers derived nothing, so
    // the most completely-profiled worker on the platform appeared in no posting's reach.
    expect(matchSkillsFor(TURNER)).toContain("mskill_cnc_turner");
  });

  it("derives NOTHING from a worker who answered nothing about machines", () => {
    // Being routed to the turning pack is not the same as having said you turn. Reach follows
    // the answer, which is also why no canonical_role_id is invented here.
    expect(matchSkillsFor(new Map([["material_worked", ["mild_steel"]]]))).toEqual([]);
  });

  it("is deterministic and order-independent", () => {
    const reversed = new Map([...TURNER].reverse());
    expect(corpusSkillsForPackAttributes(TURNER)).toEqual(
      corpusSkillsForPackAttributes(reversed).sort(),
    );
    expect(corpusSkillsForPackAttributes(TURNER)).toEqual(corpusSkillsForPackAttributes(TURNER));
  });

  it("ignores keys and options it does not know, rather than failing the rebuild", () => {
    // A pack that grows a question must not stop an existing worker's reach from rebuilding.
    const withJunk = new Map<string, readonly string[]>([
      ...TURNER,
      ["a_question_added_later", ["some_new_option"]],
      ["turning_machine", ["cnc_lathe", "an_option_added_later"]],
    ]);
    expect(matchSkillsFor(withJunk)).toContain("mskill_cnc_turner");
  });
});

describe("the fabrication rule (§5.3) — what this map REFUSES to claim", () => {
  it("never turns a turner's own quality checks into a quality inspector", () => {
    // Checking your own first piece, or filling an SPC chart at the machine, is not a QC chair.
    // An unclaimed capability upgrade surfaces at the machine trial and the employer stops
    // trusting BadaBhai rather than the worker - the most damaging failure available to us.
    expect(PACK_ATTRIBUTE_SKILLS.quality_work).toBeUndefined();
    const everyQualityAnswer = new Map([
      ["quality_work", ["first_piece_check", "in_process", "spc", "rejection"]],
    ]);
    expect(matchSkillsFor(everyQualityAnswer)).toEqual([]);
  });

  it("does not seat a man in a programmer's chair for editing G-code at the machine", () => {
    expect(matchSkillsFor(new Map([["programming_level", ["edit_program"]]]))).toEqual([]);
    expect(matchSkillsFor(new Map([["programming_level", ["offset_only"]]]))).toEqual([]);
  });

  it("DOES honour the two chips that genuinely claim a programmer's work", () => {
    // A guard is only trustworthy once you have tested what it PERMITS. "Naya programme likh
    // leta hoon" and "CAM software se banata hoon" are the posting-level claims, in his words.
    expect(matchSkillsFor(new Map([["programming_level", ["write_program"]]]))).toEqual([
      "mskill_cnc_programmer",
    ]);
    expect(matchSkillsFor(new Map([["programming_level", ["cam"]]]))).toEqual([
      "mskill_cam_programmer",
    ]);
  });

  it("leaves sector_worked out entirely — §4.3 locks it as display-only", () => {
    expect(PACK_ATTRIBUTE_SKILLS.sector_worked).toBeUndefined();
  });

  it("maps no option that names nothing specific", () => {
    for (const dead of ["other_machine", "unknown_controller", "no_drawing", "no_advanced"]) {
      for (const options of Object.values(PACK_ATTRIBUTE_SKILLS)) {
        expect(options[dead]).toBeUndefined();
      }
    }
  });
});

describe("the cross-package contract with the taxonomy", () => {
  it("emits only corpus ids the taxonomy bridge actually knows", () => {
    // An id absent from ATTRIBUTE_TO_MATCH_SKILLS contributes NOTHING and nothing complains -
    // it would look exactly like a worker who legitimately implies no postable skill. This is
    // the pin that turns a silent retag on the taxonomy side into a red test on ours.
    const unknown = corpusSkillsEmitted().filter((id) => !(id in ATTRIBUTE_TO_MATCH_SKILLS));
    expect(unknown).toEqual([]);
  });

  it("still reaches a turner posting through the taxonomy's own bridge", () => {
    // Not a restatement of the test above: that one checks the ids are KNOWN, this one checks
    // the one that matters still resolves to the match skill a turner vacancy publishes.
    expect(ATTRIBUTE_TO_MATCH_SKILLS.skill_turning).toContain("mskill_cnc_turner");
  });
});
