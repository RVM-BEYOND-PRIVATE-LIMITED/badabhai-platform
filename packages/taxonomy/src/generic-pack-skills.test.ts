import { describe, expect, it } from "vitest";

import {
  canonicalGenericPackSkills,
  GENERIC_PACK_SKILLS,
  GENERIC_PACKS_WITHOUT_MATCH_SKILL,
  genericPackSkillIdsEmitted,
} from "./generic-pack-skills";
import { ATTRIBUTE_TO_MATCH_SKILLS, matchSkillsForAttribute } from "./match-skills";
import { SKILL_CORPUS } from "./skill-corpus";

/** The match skills a set of corpus ids reaches through the attribute bridge, as the engine does. */
function reached(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((id) => [...matchSkillsForAttribute(id)]))].sort();
}

describe("generic pack bridge — every id rides the EXISTING attribute bridge", () => {
  it("emits only live (non-deprecated) corpus ids the attribute bridge knows", () => {
    // A deprecated id is retagged away by `db:retag:skills`; emitting one would write a stale id.
    const live = new Set(
      SKILL_CORPUS.filter((s) => s.status !== "deprecated").map((s) => s.skillId),
    );
    for (const id of genericPackSkillIdsEmitted()) {
      expect(id in ATTRIBUTE_TO_MATCH_SKILLS, `${id} is not in the attribute bridge`).toBe(true);
      expect(live.has(id), `${id} is not a live corpus skill`).toBe(true);
    }
  });

  it("emits nothing but skill_ ids — never an mskill_ id that would bypass the bridge", () => {
    for (const id of genericPackSkillIdsEmitted()) expect(id).toMatch(/^skill_[a-z0-9_]+$/);
  });

  it("every mapped value reaches at least one match skill (posting-level only)", () => {
    for (const [packId, questions] of Object.entries(GENERIC_PACK_SKILLS)) {
      for (const [key, options] of Object.entries(questions)) {
        for (const [value, ids] of Object.entries(options)) {
          expect(reached(ids).length, `${packId}.${key}.${value} reaches nothing`).toBeGreaterThan(
            0,
          );
        }
      }
    }
  });

  it("never maps a pack the owner ruled has no match skill", () => {
    for (const packId of GENERIC_PACKS_WITHOUT_MATCH_SKILL) {
      expect(GENERIC_PACK_SKILLS[packId], `${packId} must derive nothing`).toBeUndefined();
    }
  });
});

describe("canonicalGenericPackSkills", () => {
  it("welding: each process is its own claim", () => {
    const ids = canonicalGenericPackSkills("qp_welding", [
      { questionKey: "welding_process", values: ["mig", "arc"] },
    ]);
    expect(ids).toEqual(["skill_arc_welding", "skill_mig_welding"]);
    expect(reached(ids)).toEqual(["mskill_arc_welder", "mskill_mig_welder"]);
  });

  it("welding: gas welding and 'other' derive nothing (no proxy)", () => {
    expect(
      canonicalGenericPackSkills("qp_welding", [
        { questionKey: "welding_process", values: ["gas", "other"] },
      ]),
    ).toEqual([]);
  });

  it("plumbing: every scope reaches the plumber", () => {
    const ids = canonicalGenericPackSkills("qp_plumbing", [
      { questionKey: "plumbing_scope", values: ["household", "drainage"] },
    ]);
    expect(reached(ids)).toEqual(["mskill_plumber"]);
  });

  it("is PACK-SCOPED: `furniture` is carpentry in qp_carpentry and nothing in qp_painting", () => {
    const answer = [{ questionKey: "carpentry_scope", values: ["furniture"] }];
    expect(reached(canonicalGenericPackSkills("qp_carpentry", answer))).toEqual([
      "mskill_carpenter",
    ]);
    expect(
      canonicalGenericPackSkills("qp_painting", [
        { questionKey: "painting_scope", values: ["furniture", "building"] },
      ]),
    ).toEqual([]);
    // The same question key under another pack id is still nothing.
    expect(canonicalGenericPackSkills("qp_painting", answer)).toEqual([]);
  });

  it("a trade with no match skill derives nothing", () => {
    expect(
      canonicalGenericPackSkills("qp_electrical", [
        { questionKey: "electrical_scope", values: ["house_wiring", "panel", "motor"] },
      ]),
    ).toEqual([]);
  });

  it("machining: manual lathe, VMC-or-milling and plain grinding derive nothing; CNC turning does", () => {
    expect(
      canonicalGenericPackSkills("qp_machining", [
        { questionKey: "machine_type", values: ["lathe", "vmc", "grinding", "unknown"] },
      ]),
    ).toEqual([]);
    expect(
      reached(
        canonicalGenericPackSkills("qp_machining", [
          { questionKey: "machine_type", values: ["cnc_turning"] },
        ]),
      ),
    ).toEqual(["mskill_cnc_turner"]);
  });

  it("null pack, unknown question, unknown value and non-string values derive nothing", () => {
    const welding = [{ questionKey: "welding_process", values: ["mig"] }];
    expect(canonicalGenericPackSkills(null, welding)).toEqual([]);
    expect(canonicalGenericPackSkills("qp_unknown", welding)).toEqual([]);
    expect(
      canonicalGenericPackSkills("qp_welding", [
        { questionKey: "welding_position", values: ["mig"] },
      ]),
    ).toEqual([]);
    expect(
      canonicalGenericPackSkills("qp_welding", [
        { questionKey: "welding_process", values: ["MIG welding", 42, null] },
      ]),
    ).toEqual([]);
  });

  it("is order-independent, sorted and deduped", () => {
    const a = canonicalGenericPackSkills("qp_fitting", [
      { questionKey: "fitting_type", values: ["pipe", "bench", "bench"] },
    ]);
    const b = canonicalGenericPackSkills("qp_fitting", [
      { questionKey: "fitting_type", values: ["bench", "pipe"] },
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual(["skill_bench_fitting", "skill_pipe_fitting"]);
  });
  describe("inherited Object.prototype keys derive nothing and never throw", () => {
    const PROTO_KEYS = ["toString", "constructor", "__proto__", "hasOwnProperty"];

    it("as option values", () => {
      expect(
        canonicalGenericPackSkills("qp_welding", [
          { questionKey: "welding_process", values: PROTO_KEYS },
        ]),
      ).toEqual([]);
      // A real option alongside them still derives, and only it.
      expect(
        canonicalGenericPackSkills("qp_welding", [
          { questionKey: "welding_process", values: [...PROTO_KEYS, "mig"] },
        ]),
      ).toEqual(["skill_mig_welding"]);
    });

    it("as the question key (`constructor` + `name` must not spread a string)", () => {
      for (const questionKey of PROTO_KEYS) {
        expect(
          canonicalGenericPackSkills("qp_welding", [
            { questionKey, values: ["name", "length", "mig", ...PROTO_KEYS] },
          ]),
        ).toEqual([]);
      }
    });

    it("as the pack id", () => {
      for (const packId of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
        expect(
          canonicalGenericPackSkills(packId, [
            { questionKey: "welding_process", values: ["mig"] },
            { questionKey: "constructor", values: ["name"] },
            { questionKey: "__proto__", values: PROTO_KEYS },
          ]),
        ).toEqual([]);
      }
    });

    it("every result is a skill_ id", () => {
      const ids = canonicalGenericPackSkills("qp_plumbing", [
        { questionKey: "plumbing_scope", values: ["household", "drainage", ...PROTO_KEYS] },
        { questionKey: "constructor", values: ["name"] },
      ]);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(id).toMatch(/^skill_[a-z0-9_]+$/);
    });
  });
});
