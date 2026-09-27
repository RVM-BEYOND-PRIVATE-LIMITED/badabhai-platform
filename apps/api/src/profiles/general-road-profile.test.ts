import { describe, it, expect } from "vitest";
import {
  DraftProfileSchema,
  ProfileExtractionOutputSchema,
  WorkerProfileDraftSchema,
  type ProfileExtractionOutput,
} from "@badabhai/ai-contracts";
import type { GeneralRoadStamp } from "../profiling/conversation-state";
import { MAX_SKILLS } from "../profiling/skill-certifier";
import type { WorkerEmploymentRecord } from "../resume/resume-employment-rows";
import { buildGeneralRoadExtraction } from "./general-road-profile";

/**
 * ADR-0045 §3.4 — the pure merge behind the general road's profile build. The processor's own
 * suite drives it end to end (no model call, source, status, the employment read); this one pins
 * every rule of the merge itself, where a regression would otherwise hide behind the processor's
 * fixtures.
 */

const AS_OF = new Date("2026-09-27T00:00:00.000Z");

const stamp = (over: Partial<GeneralRoadStamp> = {}): GeneralRoadStamp => ({
  v: 1,
  lane: "skills",
  role_label: "Drone pilot",
  domain_label: "Aviation",
  skills: ["Aerial survey", "Flight planning"],
  outcome: "confirmed",
  handed_over: true,
  ...over,
});

const employment = (over: Partial<WorkerEmploymentRecord> = {}): WorkerEmploymentRecord => ({
  employer: "Contract work",
  employerCity: null,
  employerState: null,
  startYm: "2019-01",
  endYm: "2020-12",
  durationStated: true,
  roles: [],
  ...over,
});

/**
 * What `toExtractionOutput(projection, null)` hands over for an answer map that captured a city, a
 * machine, a primary role, one skill and — the value R5 forbids from counting — 7 years.
 */
function deterministic(
  profile: Record<string, unknown> = {},
  draft: Record<string, unknown> | null = {},
): ProfileExtractionOutput {
  return ProfileExtractionOutputSchema.parse({
    profile: DraftProfileSchema.parse({
      skill_labels: ["answer-map skill"],
      machines: ["quadcopter"],
      experience: { total_years: 7 },
      location_preference: { current_city: "Pune", preferred_cities: ["Pune"] },
      ...profile,
    }),
    blocked: false,
    is_mock: false,
    extraction_status: "completed",
    worker_profile_draft:
      draft === null
        ? null
        : WorkerProfileDraftSchema.parse({
            primary_role: "pilot",
            skills: ["answer-map skill"],
            machines: ["quadcopter"],
            experience_years: 7,
            current_city: "Pune",
            ...draft,
          }),
    ai_metadata: null,
    job_domain_match: null,
  });
}

const build = (
  over: {
    stamp?: GeneralRoadStamp;
    employments?: WorkerEmploymentRecord[];
    base?: ProfileExtractionOutput;
  } = {},
) =>
  buildGeneralRoadExtraction({
    deterministic: over.base ?? deterministic(),
    stamp: over.stamp ?? stamp(),
    employments: over.employments ?? [],
    asOf: AS_OF,
  });

describe("buildGeneralRoadExtraction — the stamp's role, domain and skills", () => {
  it("writes the stamp's skills to skill_labels, REPLACING the answer map's", () => {
    // The gate's list is the list the worker confirmed; an answer-map skill never went through
    // the certifier or the gate.
    expect(build().profile.skill_labels).toEqual(["Aerial survey", "Flight planning"]);
  });

  it("R7: the canonical `skills` column keeps the deterministic value — the stamp never reaches it", () => {
    const base = deterministic({ skills: ["sk_canonical_id"] });
    expect(build({ base }).profile.skills).toEqual(["sk_canonical_id"]);
    expect(build().profile.skills).toEqual([]);
  });

  it("writes role_label and domain_label from the stamp", () => {
    const out = build();
    expect(out.profile.role_label).toBe("Drone pilot");
    expect(out.profile.domain_label).toBe("Aviation");
  });

  it("a null stamp label leaves the deterministic value (null on this path)", () => {
    const out = build({ stamp: stamp({ role_label: null, domain_label: null }) });
    expect(out.profile.role_label).toBeNull();
    expect(out.profile.domain_label).toBeNull();
  });

  it("drops PII-shaped labels — a phone run or an email never reaches a column", () => {
    const out = build({
      stamp: stamp({
        role_label: "call 9876543210",
        domain_label: "ramesh@example.com",
        skills: ["Aerial survey", "call me 98765 43210 9876543", "ramesh@example.com"],
      }),
    });
    expect(out.profile.role_label).toBeNull();
    expect(out.profile.domain_label).toBeNull();
    expect(out.profile.skill_labels).toEqual(["Aerial survey"]);
    expect(out.worker_profile_draft?.skills).toEqual(["Aerial survey"]);
  });

  it("trims, and drops blank entries", () => {
    const out = build({
      stamp: stamp({ role_label: "  Drone pilot  ", skills: ["  Aerial survey ", "   ", ""] }),
    });
    expect(out.profile.role_label).toBe("Drone pilot");
    expect(out.profile.skill_labels).toEqual(["Aerial survey"]);
  });

  it("de-duplicates case-insensitively, keeping the first spelling and the gate's order", () => {
    const out = build({
      stamp: stamp({
        skills: ["Welding", "Flight planning", "welding ", "WELDING", "flight PLANNING"],
      }),
    });
    expect(out.profile.skill_labels).toEqual(["Welding", "Flight planning"]);
  });

  it("caps at MAX_SKILLS, keeping the first ones", () => {
    const many = Array.from({ length: MAX_SKILLS + 10 }, (_, i) => `Skill ${i + 1}`);
    const out = build({ stamp: stamp({ skills: many }) });
    expect(out.profile.skill_labels).toHaveLength(MAX_SKILLS);
    expect(out.profile.skill_labels[0]).toBe("Skill 1");
    expect(out.profile.skill_labels[MAX_SKILLS - 1]).toBe(`Skill ${MAX_SKILLS}`);
  });

  it("the cap counts KEPT skills — duplicates and PII ahead of the cap do not eat into it", () => {
    const many = [
      "dup",
      "DUP",
      "x@y.com",
      ...Array.from({ length: MAX_SKILLS }, (_, i) => `Skill ${i + 1}`),
    ];
    const out = build({ stamp: stamp({ skills: many }) });
    expect(out.profile.skill_labels).toHaveLength(MAX_SKILLS);
    expect(out.profile.skill_labels[0]).toBe("dup");
    expect(out.profile.skill_labels).toContain(`Skill ${MAX_SKILLS - 1}`);
  });

  it("a label too long for its column is dropped, never a thrown profile", () => {
    const out = build({
      stamp: stamp({ role_label: "r".repeat(121), domain_label: "d".repeat(120) }),
    });
    expect(out.profile.role_label).toBeNull();
    expect(out.profile.domain_label).toBe("d".repeat(120));
  });
});

describe("buildGeneralRoadExtraction — R5: total years come from the Work History only", () => {
  it("sums the dated employment, over the chat's projected 7", () => {
    // 24 months + 6 months = 2.5 years.
    const out = build({
      employments: [employment(), employment({ startYm: "2021-01", endYm: "2021-06" })],
    });
    expect(out.profile.experience.total_years).toBe(2.5);
    expect(out.worker_profile_draft?.experience_years).toBe(2.5);
  });

  it("closes a current job at `asOf`", () => {
    // 2025-10 .. 2026-09 inclusive = 12 months.
    const out = build({ employments: [employment({ startYm: "2025-10", endYm: null })] });
    expect(out.profile.experience.total_years).toBe(1);
  });

  it("an undated job makes the total unknown — and the projected 7 is REMOVED, not kept", () => {
    const out = build({
      employments: [
        employment(),
        employment({ startYm: null, endYm: null, durationStated: false }),
      ],
    });
    expect(out.profile.experience.total_years).toBeNull();
    expect(out.worker_profile_draft?.experience_years).toBeNull();
  });

  it("no stored job means no total — and the projected 7 is REMOVED, not kept", () => {
    const out = build({ employments: [] });
    expect(out.profile.experience.total_years).toBeNull();
    expect(out.worker_profile_draft?.experience_years).toBeNull();
  });
});

describe("buildGeneralRoadExtraction — the rich draft", () => {
  it("carries the role, the skill labels and the years", () => {
    const draft = build({ employments: [employment()] }).worker_profile_draft!;
    expect(draft.primary_role).toBe("Drone pilot");
    expect(draft.skills).toEqual(["Aerial survey", "Flight planning"]);
    expect(draft.experience_years).toBe(2);
  });

  it("a stamp with no role leaves the answer map's own primary_role standing", () => {
    const draft = build({ stamp: stamp({ role_label: null }) }).worker_profile_draft!;
    expect(draft.primary_role).toBe("pilot");
  });

  it("keeps every field the road does not own", () => {
    const draft = build().worker_profile_draft!;
    expect(draft.current_city).toBe("Pune");
    expect(draft.machines).toEqual(["quadcopter"]);
  });

  it("is built even when the deterministic output carried none", () => {
    const draft = build({ base: deterministic({}, null) }).worker_profile_draft!;
    expect(draft.primary_role).toBe("Drone pilot");
    expect(draft.skills).toEqual(["Aerial survey", "Flight planning"]);
  });
});

describe("buildGeneralRoadExtraction — nothing a model produced", () => {
  it("pins every model-shaped field to 'no model was asked'", () => {
    const base = ProfileExtractionOutputSchema.parse({
      ...deterministic(),
      profile: DraftProfileSchema.parse({ resume_profile: { role_label: "stale container" } }),
      is_mock: true,
    });
    const out = build({ base });
    expect(out.profile.resume_profile).toBeNull();
    expect(out.ai_metadata).toBeNull();
    expect(out.is_mock).toBe(false);
    expect(out.blocked).toBe(false);
    expect(out.job_domain_match).toBeNull();
    expect(out.skill_embedding_metadata).toEqual([]);
  });

  it("leaves every other legacy field exactly as the projection wrote it", () => {
    const out = build();
    expect(out.profile.machines).toEqual(["quadcopter"]);
    expect(out.profile.location_preference.current_city).toBe("Pune");
    expect(out.profile.location_preference.preferred_cities).toEqual(["Pune"]);
  });

  it("is pure — the inputs are not mutated", () => {
    const base = deterministic();
    const s = stamp({ skills: ["  Aerial survey ", "aerial survey"] });
    const employments = [employment()];
    const before = JSON.stringify({ base, s, employments });
    build({ base, stamp: s, employments });
    expect(JSON.stringify({ base, s, employments })).toBe(before);
  });
});
