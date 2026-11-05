import { describe, expect, it } from "vitest";

import { describeFunnelStop, describeSplitCell, onboardingFunnelSchema } from "./funnel";

/**
 * B14 (#2568) — the portal-side mirror of `GET /admin/funnel/onboarding`.
 *
 * WHAT THIS PINS. The server owns the contract (`apps/api/src/admin/admin-funnel.dto.ts`);
 * this file re-states it in zod. A field the server adds must appear here the day it
 * ships — and a field this file requires that the server drops fails the read closed
 * instead of rendering half a funnel. Both directions are covered: the parse test below
 * runs a captured wire payload through the REAL schema.
 */

const WIRE = {
  generated_at: "2026-11-05T00:00:00.000Z",
  signup_from: "2026-09-01T00:00:00.000Z",
  signup_to: "2026-10-01T00:00:00.000Z",
  test_accounts: "exclude",
  total_workers: 10,
  steps: [
    { key: "login", order: 1, done: 10, in_progress: 0, not_done: 0 },
    { key: "profiling", order: 2, done: 6, in_progress: 1, not_done: 3 },
    { key: "resume", order: 3, done: 5, in_progress: 0, not_done: 5 },
    { key: "profile_confirmed", order: 4, done: 3, in_progress: 1, not_done: 6 },
    { key: "job_search_apply", order: 5, done: 3, in_progress: 0, not_done: 7 },
    { key: "photo", order: 6, done: 2, in_progress: 0, not_done: 8 },
    { key: "interview_kit", order: 7, done: 1, in_progress: 0, not_done: 9 },
  ],
  stopped_at: [
    { key: "login", count: 0 },
    { key: "profiling", count: 4 },
    { key: "resume", count: 1 },
    { key: "profile_confirmed", count: 2 },
    { key: "job_search_apply", count: 0 },
    { key: "photo", count: 1 },
    { key: "interview_kit", count: 1 },
    { key: "completed", count: 1 },
  ],
  splits: {
    trade: [
      {
        value: "role_welder",
        total: 9,
        suppressed: false,
        stopped_at: [{ key: "profiling", count: 4 }],
      },
      { value: "role_tailor", total: 0, suppressed: true, stopped_at: [] },
    ],
    city: [],
    language: [],
    app_version: [],
  },
  caveats: ["interview_kit_attribution_since_0079"],
};

describe("funnel wire contract", () => {
  it("parses a captured status payload through the REAL schema", () => {
    expect(onboardingFunnelSchema.parse(WIRE)).toEqual(WIRE);
  });

  it("a split value the portal has never heard of still parses (open vocabularies, never enums)", () => {
    const unknown = {
      ...WIRE,
      splits: {
        ...WIRE.splits,
        trade: [{ value: "role_futuristic", total: 40, suppressed: false, stopped_at: [] }],
      },
    };
    expect(onboardingFunnelSchema.parse(unknown).splits.trade[0]!.value).toBe("role_futuristic");
  });
});

describe("describeFunnelStop", () => {
  it("names the holding step and the share", () => {
    expect(describeFunnelStop({ key: "profiling", count: 4 }, 10)).toBe(
      "4/10 are held at profiling.",
    );
  });

  it("completions read as completions, not as another hold", () => {
    expect(describeFunnelStop({ key: "completed", count: 1 }, 10)).toBe(
      "1/10 finished every step.",
    );
  });

  it("an empty cohort says so instead of dividing by zero", () => {
    expect(describeFunnelStop({ key: "profiling", count: 0 }, 0)).toBe(
      "No workers in this cohort — nothing to describe.",
    );
  });
});

describe("describeSplitCell", () => {
  it("a suppressed cell says too-few, never zero", () => {
    const text = describeSplitCell({ value: "role_tailor", total: 0, suppressed: true });
    expect(text).toMatch(/too few/);
    expect(text).not.toMatch(/\b0 workers\b/);
  });

  it("a visible cell states its count", () => {
    expect(describeSplitCell({ value: "role_welder", total: 9, suppressed: false })).toBe(
      "role_welder: 9 workers.",
    );
  });
});
