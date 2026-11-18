import { describe, expect, it } from "vitest";

import {
  describeFunnelStop,
  describeSplitCell,
  funnelStopTitle,
  onboardingFunnelSchema,
  splitCellLabel,
} from "./funnel";

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
  it("names the holding step by its title, never its key, with grouped figures (#2580)", () => {
    expect(describeFunnelStop({ key: "profiling", count: 4 }, 10)).toBe(
      "4 of 10 are held at AI profiling interview.",
    );
    expect(describeFunnelStop({ key: "job_search_apply", count: 647 }, 2860)).toBe(
      "647 of 2,860 are held at Searched and applied.",
    );
  });

  it("a stop key this build has never heard of is shown as sent, not dropped", () => {
    expect(describeFunnelStop({ key: "video_intro", count: 2 }, 10)).toBe(
      "2 of 10 are held at video_intro.",
    );
  });

  it("completions read as completions, not as another hold", () => {
    expect(describeFunnelStop({ key: "completed", count: 1 }, 10)).toBe(
      "1 of 10 finished every step.",
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
    expect(text).toMatch(/too few/i);
    expect(text).not.toMatch(/\b0 workers\b/);
  });

  it("a visible cell says where its group is held, out of its own total (#2580)", () => {
    expect(
      describeSplitCell({
        value: "role_welder",
        total: 1104,
        suppressed: false,
        stopped_at: [
          { key: "login", count: 0 },
          { key: "profiling", count: 231 },
          { key: "job_search_apply", count: 244 },
          { key: "completed", count: 96 },
        ],
      }),
    ).toBe("Most held at Searched and applied: 244 of 1,104. 96 finished every step.");
  });

  it("a group with no holds says everyone finished; one with no buckets states its size", () => {
    expect(
      describeSplitCell({
        value: "Pune",
        total: 6,
        suppressed: false,
        stopped_at: [
          { key: "profiling", count: 0 },
          { key: "completed", count: 6 },
        ],
      }),
    ).toBe("All 6 finished every step.");
    expect(describeSplitCell({ value: "role_welder", total: 9, suppressed: false })).toBe(
      "9 workers.",
    );
  });
});

describe("splitCellLabel (#2580)", () => {
  it("the catch-all buckets read as words", () => {
    expect(splitCellLabel("city", { value: "unknown" })).toBe("Not stated");
    expect(splitCellLabel("app_version", { value: "other" })).toBe("Everything else");
  });

  it("a trade reads as the API's role name, else as its id without the prefix", () => {
    expect(splitCellLabel("trade", { value: "role_welder", label: "Welder" })).toBe("Welder");
    expect(splitCellLabel("trade", { value: "role_vmc_setter", label: null })).toBe("vmc setter");
    // An API from before the field sends no label at all.
    expect(splitCellLabel("trade", { value: "role_fitter" })).toBe("fitter");
  });

  it("a language code reads as its name; an unknown code as sent", () => {
    expect(splitCellLabel("language", { value: "hi" })).toBe("Hindi");
    expect(splitCellLabel("language", { value: "mr" })).toBe("Marathi");
    expect(splitCellLabel("language", { value: "xx" })).toBe("xx");
  });

  it("city and app version are shown as sent", () => {
    expect(splitCellLabel("city", { value: "Pune" })).toBe("Pune");
    expect(splitCellLabel("app_version", { value: "1.9.0" })).toBe("1.9.0");
  });
});

describe("funnelStopTitle (#2580)", () => {
  it("titles a step, names completion, and passes an unknown key through", () => {
    expect(funnelStopTitle("photo")).toBe("Photo uploaded");
    expect(funnelStopTitle("completed")).toBe("Finished every step");
    expect(funnelStopTitle("video_intro")).toBe("video_intro");
  });
});
