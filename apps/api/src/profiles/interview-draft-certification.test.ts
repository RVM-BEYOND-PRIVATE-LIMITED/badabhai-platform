import { describe, it, expect } from "vitest";
import type { ProfileProjection } from "../profiling/answer-map-projector";
import {
  certifyInterviewDraft,
  MODEL_FREE_TEXT_DRAFT_FIELDS,
} from "./interview-draft-certification";

/**
 * #2004 — the pure rule behind what the interview path stores in `rich_profile_draft`. The
 * processor suite drives it end to end through `/profile/parse`; this one pins every branch.
 * All values are fabricated.
 */

const model = (value: unknown) => ({ value, source: "llm_parse" as const });
const worker = (value: unknown) => ({ value, source: "answer_map" as const });

describe("certifyInterviewDraft — model-written free text is withheld", () => {
  it.each([
    ["primary_role", "Welder, Ramesh Kumar"],
    ["skills", ["mig welding", "call 9876543210"]],
    ["machines", ["Ramesh Engineering Works lathe"]],
    ["controllers", ["Fanuc"]],
    ["certifications", ["ITI from Suresh Sir"]],
    ["education_level", "10th pass"],
    ["education_field", "Mechanical"],
  ])("withholds an llm_parse %s whole, whatever it says", (field, value) => {
    const out = certifyInterviewDraft({ [field]: model(value) }, "welder");
    expect(out.draft[field]).toBeUndefined();
    expect(out.withheld).toEqual([field]);
  });

  it("covers exactly the free-text draft fields #2004 names, plus the controllers split", () => {
    expect([...MODEL_FREE_TEXT_DRAFT_FIELDS].sort()).toEqual(
      [
        "certifications",
        "controllers",
        "education_field",
        "education_level",
        "machines",
        "primary_role",
        "skills",
      ].sort(),
    );
  });

  it("an llm_parse primary_role equal to the pin is STILL withheld — the source decides, not the text", () => {
    const out = certifyInterviewDraft({ primary_role: model("welder") }, "welder");
    expect(out.draft.primary_role).toBeUndefined();
  });

  it("keeps llm_parse numbers, booleans and the enum (gate 3 closed them)", () => {
    const draft: ProfileProjection = {
      experience_years: model(7),
      expected_salary: model(25000),
      current_salary: model(20000),
      relocation_willingness: model(true),
      availability: model("immediate"),
    };
    const out = certifyInterviewDraft(draft, null);
    expect(out.draft).toEqual(draft);
    expect(out.withheld).toEqual([]);
  });
});

describe("certifyInterviewDraft — model cities are held to the gazetteer, whole-value", () => {
  it("keeps a city the gazetteer knows, as the gazetteer's name", () => {
    const out = certifyInterviewDraft({ current_city: model("pune") }, null);
    expect(out.draft.current_city?.value).toBe("Pune");
  });

  it("withholds a city with anything else around it — a name rides beside a real city", () => {
    const out = certifyInterviewDraft({ current_city: model("Ramesh Kumar, Pune") }, null);
    expect(out.draft.current_city).toBeUndefined();
    expect(out.withheld).toEqual(["current_city"]);
  });

  it("narrows a preferred_locations list to its gazetteer entries", () => {
    const out = certifyInterviewDraft(
      { preferred_locations: model(["Pune", "Sharma ji ka gaon", "Mumbai"]) },
      null,
    );
    expect(out.draft.preferred_locations?.value).toEqual(["Pune", "Mumbai"]);
    expect(out.withheld).toEqual(["preferred_locations"]);
  });

  it("withholds a list with no gazetteer entry at all", () => {
    const out = certifyInterviewDraft({ preferred_locations: model(["Gram Rampur 9876"]) }, null);
    expect(out.draft.preferred_locations).toBeUndefined();
  });
});

describe("certifyInterviewDraft — the answer map", () => {
  it("keeps the worker's own answers unchanged", () => {
    const draft: ProfileProjection = {
      skills: worker(["mig", "arc"]),
      machines: worker(["lathe"]),
      certifications: worker(["ITI welder"]),
      education_level: worker("10th"),
      education_field: worker("Fitter"),
      current_city: worker("Pune"),
      preferred_locations: worker(["Pune"]),
      experience_years: worker(5),
    };
    const out = certifyInterviewDraft(draft, null);
    expect(out.draft).toEqual(draft);
    expect(out.withheld).toEqual([]);
  });

  it("keeps the answer-map trade when it is the pinned catalogue label (case/space-insensitive)", () => {
    const out = certifyInterviewDraft({ primary_role: worker("Darzi ") }, "darzi");
    expect(out.draft.primary_role?.value).toBe("Darzi ");
  });

  it("withholds an answer-map trade the pin does not vouch for — Phase A may have written it", () => {
    // `settleFromLlmDraft` writes the model's `role_label` here, and the record cannot say so.
    const out = certifyInterviewDraft({ primary_role: worker("Supervisor Mahesh") }, "welder");
    expect(out.draft.primary_role).toBeUndefined();
    expect(out.withheld).toEqual(["primary_role"]);
  });

  it("withholds an answer-map trade when there is no pin at all", () => {
    const out = certifyInterviewDraft({ primary_role: worker("welder") }, null);
    expect(out.draft.primary_role).toBeUndefined();
  });
});
