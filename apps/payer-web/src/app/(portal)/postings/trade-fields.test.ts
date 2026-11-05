import { describe, expect, it } from "vitest";
import type { PostingTradeFormWire } from "../../../lib/contracts";
import { derivedMatchSkills } from "./trade-fields";

/**
 * The form's ONE client-side match rule. The server re-derives the set from the submitted
 * answers and refuses anything outside the pack, so this is a PREVIEW — it must still agree
 * with the server or the rail would promise a reach the publish then contradicts.
 */
const trade: PostingTradeFormWire = {
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  pack_id: "qp_cnc_turning",
  match_skill_id: "mskill_cnc_turner",
  ladder: [],
  questions: [
    {
      question_key: "controller_brand",
      prompt: "Controller?",
      answer_type: "multi_select",
      options: [
        {
          option_key: "fanuc",
          value: "fanuc",
          label: "Fanuc",
          match: false,
          match_skill_ids: [],
        },
        {
          option_key: "siemens",
          value: "siemens",
          label: "Siemens",
          match: false,
          match_skill_ids: [],
        },
      ],
    },
    {
      question_key: "turning_machine",
      prompt: "Machine?",
      answer_type: "multi_select",
      options: [
        {
          option_key: "cnc_lathe",
          value: "cnc_lathe",
          label: "CNC lathe",
          match: true,
          match_skill_ids: ["mskill_cnc_turner"],
        },
        {
          option_key: "vmc",
          value: "vmc",
          label: "VMC",
          match: true,
          match_skill_ids: ["mskill_vmc_operator"],
        },
      ],
    },
  ],
};

describe("derivedMatchSkills", () => {
  it("always includes the trade's base skill, even with no answers", () => {
    expect(derivedMatchSkills(trade, {})).toEqual(["mskill_cnc_turner"]);
  });

  it("a facet-only chip adds no match skill", () => {
    expect(derivedMatchSkills(trade, { controller_brand: ["fanuc", "siemens"] })).toEqual([
      "mskill_cnc_turner",
    ]);
  });

  it("adds every selected match chip, de-duplicated", () => {
    expect(
      derivedMatchSkills(trade, {
        controller_brand: ["fanuc"],
        turning_machine: ["cnc_lathe", "vmc"],
      }),
    ).toEqual(["mskill_cnc_turner", "mskill_vmc_operator"]);
  });

  it("ignores keys and options that are not on the form", () => {
    expect(
      derivedMatchSkills(trade, {
        not_a_question: ["x"],
        turning_machine: ["not_a_machine"],
      }),
    ).toEqual(["mskill_cnc_turner"]);
  });
});
