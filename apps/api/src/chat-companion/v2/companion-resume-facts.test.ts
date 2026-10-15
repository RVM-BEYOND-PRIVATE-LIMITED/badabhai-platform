import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { DraftProfileSchema, FREE_CHAT_RESUME_FACTS_MAX } from "@badabhai/ai-contracts";
import type { WorkerProfile } from "@badabhai/db";

import { resumeFactsForModel } from "../../profiling/free-chat/free-chat-model-calls";
import { PREFERENCE_WIRE_KEYS } from "../../profiles/worker-preferences.dto";
import { CompanionResumeFacts, resumeFactsOf } from "./companion-resume-facts";
import type { EditState } from "./edit-snapshot";

/** The preferences GET's shape: EVERY wire key, null (unset) unless the case sets it. */
function preferences(values: Record<string, unknown> = {}): EditState["preferences"] {
  const unset = Object.fromEntries(Object.values(PREFERENCE_WIRE_KEYS).map((key) => [key, null]));
  return { values: { ...unset, ...values }, partial: [], dropped_count: 0 } as never;
}

function state(over: Partial<EditState> = {}): EditState {
  return {
    employment: undefined,
    draft: DraftProfileSchema.parse({}),
    languages: { languages: [], partial: false } as never,
    qualifications: undefined,
    occupations: undefined,
    preferences: preferences(),
    ...over,
  };
}

// #2304 — what the Bada Bhai chat's reply reads about the résumé: the edit path's own view.
describe("resumeFactsOf", () => {
  it("the preferences row carries the WHOLE band the résumé prints, and its period", () => {
    const facts = resumeFactsOf(
      state({
        preferences: preferences({
          salary_expected_min: 20000,
          salary_expected_max: 25000,
          salary_period: "month",
          shift: "day",
        }),
      }),
      "meri salary kitni hai",
    );
    expect(facts).toContainEqual({
      ref: "pref",
      section: "preferences",
      fields: expect.objectContaining({
        expected_salary: "25000",
        expected_salary_min: "20000",
        salary_period: "month",
        shift: "day",
      }),
    });
  });

  it("no band among the preferences: the confirmed draft's band, as the chat road prints it", () => {
    const draft = DraftProfileSchema.parse({
      salary_expectation: { amount_min: 18000, amount_max: 22000, period: "monthly" },
    });
    const facts = resumeFactsOf(
      state({ draft, preferences: preferences({ shift: "night" }) }),
      "x",
    );
    expect(facts.find((row) => row.ref === "pref")?.fields).toMatchObject({
      expected_salary_min: "18000",
      expected_salary: "22000",
      salary_period: "monthly",
      shift: "night",
    });
  });

  it("an unreadable preferences section sends no band at all — never the draft's guess", () => {
    const draft = DraftProfileSchema.parse({
      salary_expectation: { amount_min: 18000, amount_max: 22000 },
    });
    const facts = resumeFactsOf(state({ draft, preferences: undefined }), "x");
    expect(facts.some((row) => row.section === "preferences")).toBe(false);
  });

  it("skills and languages come through, a row with nothing stored is dropped, no target leaks", () => {
    const draft = DraftProfileSchema.parse({ skill_labels: ["CNC turning"] });
    const facts = resumeFactsOf(
      state({
        draft,
        languages: { languages: [{ language: "hindi" }], partial: false } as never,
      }),
      "x",
    );
    expect(facts).toEqual([
      { ref: "s1", section: "skills", fields: { skill: "CNC turning" } },
      { ref: "l1", section: "languages", fields: { language: "hindi" } },
    ]);
    // The preferences row held only nulls: it says nothing and is not sent.
    for (const row of facts) expect("target" in row).toBe(false);
  });

  it("is cut to the contract's cap, fairly across sections", () => {
    const draft = DraftProfileSchema.parse({
      skill_labels: Array.from({ length: 80 }, (_, i) => `skill ${i + 1}`),
    });
    const facts = resumeFactsOf(
      state({
        draft,
        preferences: preferences({ salary_expected_max: 25000 }),
      }),
      "x",
    );
    expect(facts).toHaveLength(FREE_CHAT_RESUME_FACTS_MAX);
    expect(facts.some((row) => row.ref === "pref")).toBe(true);
  });
});

describe("CompanionResumeFacts.factsFor", () => {
  const profile = {} as WorkerProfile;

  it("reads the edit path's state once and hands back the rows", async () => {
    const readState = vi.fn(async () =>
      state({ preferences: preferences({ salary_expected_max: 25000 }) }),
    );
    const reader = new CompanionResumeFacts({ readState } as never);
    const facts = await reader.factsFor("w-1", profile, "meri salary kitni hai");
    expect(readState).toHaveBeenCalledWith("w-1", profile);
    expect(facts?.[0]).toMatchObject({ ref: "pref", fields: { expected_salary: "25000" } });
  });

  it("nothing stored is null, not an empty list", async () => {
    const reader = new CompanionResumeFacts({ readState: vi.fn(async () => state()) } as never);
    expect(await reader.factsFor("w-1", profile, "x")).toBeNull();
  });

  it("FAILS SOFT: a read that throws is null — the reply runs without facts, never fails", async () => {
    const reader = new CompanionResumeFacts({
      readState: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as never);
    expect(await reader.factsFor("w-1", profile, "x")).toBeNull();
  });
});

describe("resumeFactsForModel", () => {
  it("redacts the worker's own name out of every value and strips template tokens", () => {
    const out = resumeFactsForModel(
      [
        {
          ref: "e1",
          section: "employment",
          fields: { work_done: "Ramesh Yadav ne {{x}}turning ki", employer_name: null },
        },
      ],
      "Ramesh Yadav",
    );
    expect(out).toEqual([
      {
        ref: "e1",
        section: "employment",
        fields: { work_done: "[NAME] ne turning ki", employer_name: null },
      },
    ]);
  });

  it("clips a long value, nulls a value left blank, and caps the rows", () => {
    const rows = Array.from({ length: FREE_CHAT_RESUME_FACTS_MAX + 5 }, (_, i) => ({
      ref: `s${i + 1}`,
      section: "skills" as const,
      fields: { skill: i === 0 ? "x".repeat(500) : i === 1 ? "{{only}}" : `skill ${i}` },
    }));
    const out = resumeFactsForModel(rows, null)!;
    expect(out).toHaveLength(FREE_CHAT_RESUME_FACTS_MAX);
    expect(out[0]!.fields["skill"]).toHaveLength(200);
    expect(out[1]!.fields["skill"]).toBeNull();
  });

  it("none is null — the reply runs as before #2304", () => {
    expect(resumeFactsForModel(null, "Ramesh")).toBeNull();
    expect(resumeFactsForModel([], "Ramesh")).toBeNull();
  });
});
