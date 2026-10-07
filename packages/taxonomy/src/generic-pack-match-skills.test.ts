import { describe, expect, it } from "vitest";

import {
  GENERIC_PACK_MATCH_SKILLS,
  genericPackChatMatchSkills,
  genericPackMatchSkillIdsEmitted,
  genericPackMatchSkills,
  genericPackSkillAnswers,
  isWorkerOnlyAnswerMap,
} from "./generic-pack-match-skills";
import { GENERIC_PACK_SKILLS, GENERIC_PACKS_WITHOUT_MATCH_SKILL } from "./generic-pack-skills";
import { ATTRIBUTE_TO_MATCH_SKILLS, ROLE_TO_MATCH_SKILL } from "./match-skills";

/** Every match skill some role or corpus attribute bridges to. */
const BRIDGED = new Set<string>([
  ...Object.values(ROLE_TO_MATCH_SKILL),
  ...Object.values(ATTRIBUTE_TO_MATCH_SKILLS).flat(),
]);

const WORKER_ONLY = { llm_led_turns: 0, llm_draft_settled: false } as const;

/** A persisted `conversation_state` subset for one generic-pack skills answer. */
function state(
  packId: unknown,
  values: unknown,
  stamp: Record<string, unknown> = WORKER_ONLY,
): Record<string, unknown> {
  return {
    pack_id: packId,
    answer_map: [
      {
        question_key: "electrical_scope",
        target_field: "skills",
        status: "answered",
        value_normalized: values,
      },
    ],
    ...stamp,
  };
}

describe("GENERIC_PACK_MATCH_SKILLS — the table itself (#2075)", () => {
  it("is exactly the owner's ruling: qp_electrical industrial/panel → industrial electrician", () => {
    // Pins the WHOLE reachable surface. Any widening has to be written here, in review.
    expect(GENERIC_PACK_MATCH_SKILLS).toEqual({
      qp_electrical: {
        electrical_scope: {
          industrial: ["mskill_industrial_electrician"],
          panel: ["mskill_industrial_electrician"],
        },
      },
    });
    expect(genericPackMatchSkillIdsEmitted()).toEqual(["mskill_industrial_electrician"]);
  });

  it("names only PACK-ONLY skills: no role or corpus id bridges to any of them", () => {
    // If one gains a bridge, the bridge (via `GENERIC_PACK_SKILLS`) must carry the claim instead,
    // or chat and form workers making the same claim would derive different sets.
    expect(genericPackMatchSkillIdsEmitted().filter((id) => BRIDGED.has(id))).toEqual([]);
  });

  it("never overlaps the corpus table: a pack-question pair is mapped in one place only", () => {
    for (const [packId, questions] of Object.entries(GENERIC_PACK_MATCH_SKILLS)) {
      for (const questionKey of Object.keys(questions)) {
        expect(GENERIC_PACK_SKILLS[packId]?.[questionKey]).toBeUndefined();
      }
    }
  });

  it("qp_electrical still derives no corpus id (it stays in GENERIC_PACKS_WITHOUT_MATCH_SKILL)", () => {
    expect(GENERIC_PACKS_WITHOUT_MATCH_SKILL).toContain("qp_electrical");
    expect(GENERIC_PACK_SKILLS.qp_electrical).toBeUndefined();
  });

  it("qp_painting and qp_masonry have no ruling and derive nothing here either", () => {
    expect(GENERIC_PACK_MATCH_SKILLS.qp_painting).toBeUndefined();
    expect(GENERIC_PACK_MATCH_SKILLS.qp_masonry).toBeUndefined();
  });
});

describe("genericPackMatchSkills", () => {
  const scope = (values: readonly unknown[]) => [{ questionKey: "electrical_scope", values }];

  it("industrial and panel each claim the industrial electrician; together, once", () => {
    expect(genericPackMatchSkills("qp_electrical", scope(["industrial"]))).toEqual([
      "mskill_industrial_electrician",
    ]);
    expect(genericPackMatchSkills("qp_electrical", scope(["panel"]))).toEqual([
      "mskill_industrial_electrician",
    ]);
    expect(genericPackMatchSkills("qp_electrical", scope(["panel", "industrial"]))).toEqual([
      "mskill_industrial_electrician",
    ]);
  });

  it("house_wiring and motor derive nothing (no proxy)", () => {
    expect(genericPackMatchSkills("qp_electrical", scope(["house_wiring", "motor"]))).toEqual([]);
  });

  it("null, unknown or other packs, unknown questions, free text and non-strings derive nothing", () => {
    expect(genericPackMatchSkills(null, scope(["industrial"]))).toEqual([]);
    expect(genericPackMatchSkills("qp_industrial_electrician", scope(["industrial"]))).toEqual([]);
    expect(genericPackMatchSkills("qp_painting", scope(["industrial", "panel"]))).toEqual([]);
    expect(
      genericPackMatchSkills("qp_electrical", [
        { questionKey: "voltage_level", values: ["industrial"] },
      ]),
    ).toEqual([]);
    expect(
      genericPackMatchSkills("qp_electrical", scope(["Factory ka kaam", 1, null, ["panel"]])),
    ).toEqual([]);
  });

  it("inherited Object.prototype keys derive nothing and never throw", () => {
    const proto = ["toString", "constructor", "__proto__", "hasOwnProperty"];
    expect(genericPackMatchSkills("qp_electrical", scope(proto))).toEqual([]);
    for (const key of proto) {
      expect(genericPackMatchSkills(key, scope(["industrial"]))).toEqual([]);
      expect(
        genericPackMatchSkills("qp_electrical", [{ questionKey: key, values: ["industrial"] }]),
      ).toEqual([]);
    }
  });
});

describe("isWorkerOnlyAnswerMap — the #2021 gate, one definition", () => {
  it("is true only for both stamps present, 0 and false", () => {
    expect(isWorkerOnlyAnswerMap(WORKER_ONLY)).toBe(true);
    expect(isWorkerOnlyAnswerMap({ llm_led_turns: 1, llm_draft_settled: false })).toBe(false);
    expect(isWorkerOnlyAnswerMap({ llm_led_turns: 0, llm_draft_settled: true })).toBe(false);
    expect(isWorkerOnlyAnswerMap({ llm_led_turns: 0 })).toBe(false);
    expect(isWorkerOnlyAnswerMap({ llm_draft_settled: false })).toBe(false);
    expect(isWorkerOnlyAnswerMap({ llm_led_turns: "0", llm_draft_settled: "false" })).toBe(false);
    expect(isWorkerOnlyAnswerMap({ llm_led_turns: null, llm_draft_settled: null })).toBe(false);
    expect(isWorkerOnlyAnswerMap(null)).toBe(false);
    expect(isWorkerOnlyAnswerMap("worker")).toBe(false);
  });
});

describe("genericPackSkillAnswers — reading untrusted persisted records", () => {
  it("keeps answered skills records, list or scalar, and nothing else", () => {
    expect(
      genericPackSkillAnswers([
        {
          question_key: "electrical_scope",
          target_field: "skills",
          status: "answered",
          value_normalized: ["panel"],
        },
        { question_key: "skills", status: "answered", value_normalized: "industrial" },
        {
          question_key: "electrical_scope",
          target_field: "skills",
          status: "pending",
          value_normalized: ["panel"],
        },
        {
          question_key: "voltage_level",
          target_field: "voltage_level",
          status: "answered",
          value_normalized: "low",
        },
        {
          question_key: "electrical_scope",
          target_field: 7,
          status: "answered",
          value_normalized: ["panel"],
        },
        {
          question_key: 7,
          target_field: "skills",
          status: "answered",
          value_normalized: ["panel"],
        },
        {
          question_key: "electrical_scope",
          target_field: "skills",
          status: "answered",
          value_normalized: null,
        },
        null,
        "record",
      ]),
    ).toEqual([
      { questionKey: "electrical_scope", values: ["panel"] },
      { questionKey: "skills", values: ["industrial"] },
      { questionKey: "electrical_scope", values: [] },
    ]);
  });
});

describe("genericPackChatMatchSkills — the rebuild's read of the persisted session", () => {
  it("a worker-only qp_electrical chat with industrial or panel derives the skill", () => {
    expect(genericPackChatMatchSkills(state("qp_electrical", ["industrial"]))).toEqual([
      "mskill_industrial_electrician",
    ]);
    expect(genericPackChatMatchSkills(state("qp_electrical", ["house_wiring", "panel"]))).toEqual([
      "mskill_industrial_electrician",
    ]);
  });

  it("fails closed on the gate: LLM-led, LLM-settled, legacy (no stamps)", () => {
    const answer = ["industrial", "panel"];
    expect(
      genericPackChatMatchSkills(
        state("qp_electrical", answer, { llm_led_turns: 3, llm_draft_settled: false }),
      ),
    ).toEqual([]);
    expect(
      genericPackChatMatchSkills(
        state("qp_electrical", answer, { llm_led_turns: 0, llm_draft_settled: true }),
      ),
    ).toEqual([]);
    expect(genericPackChatMatchSkills(state("qp_electrical", answer, {}))).toEqual([]);
  });

  it("no session, a malformed pack id or a non-array answer map derive nothing", () => {
    expect(genericPackChatMatchSkills(null)).toEqual([]);
    expect(genericPackChatMatchSkills(undefined)).toEqual([]);
    expect(genericPackChatMatchSkills(state(null, ["industrial"]))).toEqual([]);
    expect(genericPackChatMatchSkills(state(42, ["industrial"]))).toEqual([]);
    expect(
      genericPackChatMatchSkills({ ...WORKER_ONLY, pack_id: "qp_electrical", answer_map: {} }),
    ).toEqual([]);
  });
});
