import { describe, expect, it } from "vitest";
import type { ExperienceEntry, ResumeEmployment } from "@badabhai/ai-contracts";

import {
  buildChatEmploymentSuggestions,
  buildResumeEmploymentSuggestions,
} from "./employment-suggestions";

const experience = (over: Partial<ExperienceEntry> = {}): ExperienceEntry => ({
  role_label: "CNC Turner",
  duration_text: "2 saal",
  duration_months: 24,
  work_done: "Twin-spindle lathes on steering housings",
  ...over,
});

const resumeEmployment = (over: Partial<ResumeEmployment> = {}): ResumeEmployment => ({
  employer_name: "Sandhar Technologies",
  role_title: "CNC Operator",
  start_year: 2019,
  end_year: 2021,
  evidence: { message_index: 0, quote: "Sandhar Technologies, CNC Operator, 2019-2021" },
  ...over,
});

describe("buildChatEmploymentSuggestions", () => {
  it("one settled experience entry produces exactly one suggestion, source:'chat'", () => {
    const out = buildChatEmploymentSuggestions([experience()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      source: "chat",
      values: {
        employer_name: null,
        employer_city: null,
        role_label: "CNC Turner",
        start_ym: null,
        end_ym: null,
        work_done: "Twin-spindle lathes on steering housings",
      },
    });
  });

  it("two settled experience entries produce exactly two suggestions", () => {
    const out = buildChatEmploymentSuggestions([
      experience({ role_label: "CNC Turner" }),
      experience({ role_label: "Fitter", work_done: "" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.values.role_label)).toEqual(["CNC Turner", "Fitter"]);
  });

  it("never carries an employer name — there is structurally none to carry (ExperienceEntrySchema has no such field)", () => {
    const out = buildChatEmploymentSuggestions([experience(), experience({ role_label: "Fitter" })]);
    expect(out.every((s) => s.values.employer_name === null)).toBe(true);
  });

  it("never carries a start or end date — chat gives a duration, never a calendar span", () => {
    const out = buildChatEmploymentSuggestions([experience()]);
    expect(out[0]!.values.start_ym).toBeNull();
    expect(out[0]!.values.end_ym).toBeNull();
  });

  it("a blank work_done ('' from R7's nullToEmpty) reads as null, not as an empty string suggestion", () => {
    const out = buildChatEmploymentSuggestions([experience({ work_done: "" })]);
    expect(out[0]!.values.work_done).toBeNull();
  });

  it("an empty experiences array produces no suggestions", () => {
    expect(buildChatEmploymentSuggestions([])).toEqual([]);
  });
});

describe("buildResumeEmploymentSuggestions", () => {
  it("one parsed employment with a name produces one suggestion, source:'resume'", () => {
    const out = buildResumeEmploymentSuggestions([resumeEmployment()]);
    expect(out).toEqual([
      {
        source: "resume",
        values: {
          employer_name: "Sandhar Technologies",
          employer_city: null,
          role_label: "CNC Operator",
          start_ym: null,
          end_ym: null,
          work_done: null,
        },
      },
    ]);
  });

  it("never invents a month from a bare parsed year", () => {
    const out = buildResumeEmploymentSuggestions([resumeEmployment({ start_year: 2019, end_year: 2021 })]);
    expect(out[0]!.values.start_ym).toBeNull();
    expect(out[0]!.values.end_ym).toBeNull();
  });

  it("a row with neither a name nor a title is not offered — an empty suggestion asks nothing", () => {
    const out = buildResumeEmploymentSuggestions([
      resumeEmployment({ employer_name: null, role_title: null }),
    ]);
    expect(out).toEqual([]);
  });

  it("a row with only a role title (no employer) is still offered", () => {
    const out = buildResumeEmploymentSuggestions([
      resumeEmployment({ employer_name: null, role_title: "Fitter" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.values.employer_name).toBeNull();
    expect(out[0]!.values.role_label).toBe("Fitter");
  });

  it("multiple employments each produce their own suggestion, in order", () => {
    const out = buildResumeEmploymentSuggestions([
      resumeEmployment({ employer_name: "Sandhar Technologies" }),
      resumeEmployment({ employer_name: "TVS Motor", role_title: "Welder" }),
    ]);
    expect(out.map((s) => s.values.employer_name)).toEqual(["Sandhar Technologies", "TVS Motor"]);
  });
});
