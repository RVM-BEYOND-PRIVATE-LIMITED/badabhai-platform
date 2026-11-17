import { describe, expect, it } from "vitest";
import {
  NUMBERS_DEFINITION_VERSION,
  NUMBERS_METRIC_GROUPS,
  NUMBERS_METRIC_UNITS,
  NUMBERS_WAITS_ON,
  allNumbersMetrics,
  numbersMetric,
} from "./definitions";

/** #2755 item 1 — the catalogue of the ten metric groups. */

describe("the catalogue", () => {
  it("holds exactly the ten groups of brief section 8, numbered 1..10 in order", () => {
    expect(NUMBERS_METRIC_GROUPS.map((g) => g.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(NUMBERS_METRIC_GROUPS.map((g) => g.id)).toEqual([
      "paying_companies",
      "companies_posted",
      "worker_profiles",
      "hires",
      "posting_choice",
      "welcome_credits",
      "couldnt_reach",
      "waivers",
      "revenue",
      "telecaller",
    ]);
  });

  it("every metric has an id, a title, a known unit, a source, a rule and an availability", () => {
    for (const m of allNumbersMetrics()) {
      expect(m.id, m.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(m.title.trim().length, m.id).toBeGreaterThan(0);
      expect(NUMBERS_METRIC_UNITS, m.id).toContain(m.unit);
      expect(m.source.trim().length, m.id).toBeGreaterThan(10);
      expect(m.rule.trim().length, m.id).toBeGreaterThan(10);
      expect(["live", "not_available"], m.id).toContain(m.availability.status);
    }
  });

  it("metric ids are unique across the whole catalogue (part B keys rows on them)", () => {
    const ids = allNumbersMetrics().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(NUMBERS_METRIC_GROUPS.map((g) => g.id)).size).toBe(10);
  });

  it("every not_available metric names its reason and the issue it waits on", () => {
    for (const m of allNumbersMetrics()) {
      if (m.availability.status !== "not_available") continue;
      expect(m.availability.reason.trim().length, m.id).toBeGreaterThan(5);
      expect(NUMBERS_WAITS_ON, m.id).toContain(m.availability.waits_on);
    }
  });

  it("live today: groups 1, 2, 3, 4, 9 (as charged) and 10; waiting: 5, 6, 7, 8 and the GST split", () => {
    const statusOf = (groupNumber: number) =>
      NUMBERS_METRIC_GROUPS.find((g) => g.number === groupNumber)!.metrics.map(
        (m) => `${m.id}:${m.availability.status}`,
      );
    for (const n of [1, 2, 3, 4, 10]) {
      for (const s of statusOf(n)) expect(s).toMatch(/:live$/);
    }
    for (const n of [5, 6, 7, 8]) {
      for (const s of statusOf(n)) expect(s).toMatch(/:not_available$/);
    }
    expect(numbersMetric("revenue_by_pack")?.availability.status).toBe("live");
    expect(numbersMetric("revenue_gst_split")?.availability).toMatchObject({
      status: "not_available",
      waits_on: "#2749",
    });
    expect(numbersMetric("revenue_managed_hiring")?.availability).toMatchObject({
      status: "not_available",
      waits_on: "#2751",
    });
    for (const id of ["posting_choice_free_share", "posting_choice_starter_share"]) {
      expect(numbersMetric(id)?.availability).toMatchObject({ waits_on: "#2751" });
    }
    for (const id of [
      "welcome_credits_used_up",
      "welcome_then_bought",
      "couldnt_reach_claims",
      "couldnt_reach_credits_returned",
      "credits_waived",
    ]) {
      expect(numbersMetric(id)?.availability, id).toMatchObject({ waits_on: "#2750" });
    }
  });

  it("the repeat-purchase windows are 30, 60 and 90 days, as shares of a first-payment cohort", () => {
    for (const d of [30, 60, 90]) {
      const m = numbersMetric(`repeat_purchase_${d}d`);
      expect(m?.unit).toBe("share");
      expect(m?.rule).toMatch(/FIRST paid order/);
    }
  });

  it("money figures are paise; the paying-company source refuses the mock route's rows", () => {
    for (const m of allNumbersMetrics().filter((x) => x.id.startsWith("revenue_"))) {
      expect(m.unit, m.id).toBe("paise");
    }
    expect(numbersMetric("revenue_by_pack")?.rule).toMatch(/× 100/);
    expect(numbersMetric("paying_companies")?.source).toMatch(/Never credit_ledger\.price_inr/);
  });

  it("the completed-profile rule is the onboarding funnel's profile_confirmed step", () => {
    expect(numbersMetric("completed_profiles")?.source).toMatch(/profile_confirmed/);
    expect(numbersMetric("completed_profiles")?.rule).toMatch(/onboarding funnel/);
  });

  it("an unknown id is undefined, and the version is the groups' version", () => {
    expect(numbersMetric("nope")).toBeUndefined();
    expect(NUMBERS_DEFINITION_VERSION).toBe(1);
  });
});
