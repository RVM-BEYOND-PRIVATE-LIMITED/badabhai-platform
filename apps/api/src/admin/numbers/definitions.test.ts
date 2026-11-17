import { describe, expect, it } from "vitest";
import {
  NUMBERS_BASELINE_FROM,
  NUMBERS_COHORT_METRICS,
  NUMBERS_FREEZE_CLASSES,
  NUMBERS_REPEAT_LONGEST_WINDOW_DAYS,
  NUMBERS_REPEAT_WINDOWS_DAYS,
  NUMBERS_DEFINITION_VERSION,
  NUMBERS_METRIC_GROUPS,
  NUMBERS_METRIC_KINDS,
  NUMBERS_METRIC_UNITS,
  NUMBERS_REVENUE_PACK_PREFIX,
  NUMBERS_SNAPSHOT_METRICS,
  NUMBERS_WAITS_ON,
  allNumbersMetrics,
  isRevenuePackMetricId,
  numbersFreezeClassOf,
  numbersFreezeWindowDays,
  numbersMetric,
  repeatPurchaseMetricId,
  revenuePackMetricId,
} from "./definitions";
import { isWeekStart } from "./week";

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

  it("live today: groups 1, 2, 3, 4, 9 (as charged) and 10 (a list); waiting: 5, 6, 7, 8, the GST split and Managed Hiring", () => {
    const statusOf = (groupNumber: number) =>
      NUMBERS_METRIC_GROUPS.find((g) => g.number === groupNumber)!.metrics.map(
        (m) => `${m.id}:${m.availability.status}`,
      );
    for (const n of [2, 3, 4]) {
      for (const s of statusOf(n)) expect(s).toMatch(/:live$/);
    }
    expect(numbersMetric("paying_companies")?.availability.status).toBe("live");
    expect(numbersMetric("paying_companies_cumulative")?.availability.status).toBe("live");
    // Part C's figures: repeat buying is live in the snapshot, the call list live as a LIST.
    for (const n of [1, 10]) {
      for (const s of statusOf(n)) expect(s).toMatch(/:live$/);
    }
    for (const id of ["repeat_purchase_30d", "repeat_purchase_60d", "repeat_purchase_90d"]) {
      expect(numbersMetric(id)?.list_route, id).toBeUndefined();
    }
    expect(numbersMetric("out_of_credits_companies")?.list_route).toBe(
      "GET /admin/numbers/out-of-credits",
    );
    // Nothing waits on this screen's own parts any more.
    expect([...NUMBERS_WAITS_ON]).toEqual(["#2749", "#2750", "#2751"]);
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
    expect([...NUMBERS_REPEAT_WINDOWS_DAYS]).toEqual([30, 60, 90]);
    expect(NUMBERS_REPEAT_LONGEST_WINDOW_DAYS).toBe(Math.max(...NUMBERS_REPEAT_WINDOWS_DAYS));
    for (const d of NUMBERS_REPEAT_WINDOWS_DAYS) {
      const m = numbersMetric(repeatPurchaseMetricId(d));
      expect(m?.id).toBe(`repeat_purchase_${d}d`);
      expect(m?.unit).toBe("share");
      expect(m?.rule).toMatch(/FIRST paid order/);
      // The pending rule and the freeze exception are written in the rule itself.
      expect(m?.rule).toMatch(/PENDING/);
      expect(m?.rule).toMatch(/never a partial share/);
      expect(m?.rule).toMatch(/FREEZE IS KEYED ON THE LONGEST WINDOW/);
      expect(m?.source).toMatch(/payment_orders with status paid/);
    }
  });

  it("the cohort rows freeze on the longest window's end; every other row on its week's end", () => {
    expect([...NUMBERS_COHORT_METRICS]).toEqual([
      "repeat_purchase_30d",
      "repeat_purchase_60d",
      "repeat_purchase_90d",
    ]);
    expect([...NUMBERS_FREEZE_CLASSES]).toEqual(["week", "cohort"]);
    for (const id of NUMBERS_COHORT_METRICS) expect(numbersFreezeClassOf(id)).toBe("cohort");
    for (const id of ["paying_companies", "revenue_by_pack", "revenue_by_pack:pack_50"]) {
      expect(numbersFreezeClassOf(id), id).toBe("week");
    }
    expect(numbersFreezeWindowDays("week")).toBe(0);
    expect(numbersFreezeWindowDays("cohort")).toBe(90);
  });

  it("the call list's rule: usable balance zero, ran out, names only through the identity read, no phone", () => {
    const m = numbersMetric("out_of_credits_companies")!;
    expect(m.source).toMatch(/readSpendableCredits/);
    expect(m.rule).toMatch(/payer.credits_exhausted/);
    expect(m.rule).toMatch(/expires_at/);
    expect(m.rule).toMatch(/AdminIdentityService/);
    expect(m.rule).toMatch(/never the phone/);
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

  it("every metric is a headline but the one form-worker gap diagnostic", () => {
    for (const m of allNumbersMetrics()) expect(NUMBERS_METRIC_KINDS, m.id).toContain(m.kind);
    expect(
      allNumbersMetrics()
        .filter((m) => m.kind === "diagnostic")
        .map((m) => m.id),
    ).toEqual(["form_completed_unconfirmed"]);
    expect(numbersMetric("form_completed_unconfirmed")?.rule).toMatch(/NOT A HEADLINE/);
    expect(numbersMetric("form_completed_unconfirmed")?.source).toMatch(/profile\.form_completed/);
  });

  it("the snapshot stores EXACTLY the live weekly metrics: a not_available one is never stored as a zero, a list never", () => {
    const live = allNumbersMetrics()
      .filter((m) => m.availability.status === "live" && m.list_route === undefined)
      .map((m) => m.id)
      .sort();
    expect(Object.keys(NUMBERS_SNAPSHOT_METRICS).sort()).toEqual(live);
  });

  it("worker figures are the worker subject (their small cells are suppressed), the rest companies", () => {
    const workers = Object.entries(NUMBERS_SNAPSHOT_METRICS)
      .filter(([, subject]) => subject === "worker")
      .map(([id]) => id)
      .sort();
    expect(workers).toEqual(
      [
        "active_workers_30d",
        "completed_profiles",
        "completed_profiles_cumulative",
        "form_completed_unconfirmed",
      ].sort(),
    );
  });

  it("the baseline is a Monday, 2026-06-01", () => {
    expect(NUMBERS_BASELINE_FROM).toBe("2026-06-01");
    expect(isWeekStart(NUMBERS_BASELINE_FROM)).toBe(true);
  });

  it("one pack's revenue id is the prefix and the pack code; a malformed code folds into other", () => {
    expect(NUMBERS_REVENUE_PACK_PREFIX).toBe("revenue_by_pack:");
    expect(revenuePackMetricId("pack_50")).toBe("revenue_by_pack:pack_50");
    expect(revenuePackMetricId("starter")).toBe("revenue_by_pack:starter");
    for (const bad of ["", "Pack 50", "pack-50", "x".repeat(65), "pack_50;drop"]) {
      expect(revenuePackMetricId(bad), bad).toBe("revenue_by_pack:other");
    }
    expect(isRevenuePackMetricId("revenue_by_pack:pack_50")).toBe(true);
    expect(isRevenuePackMetricId("revenue_by_pack")).toBe(false);
    expect(isRevenuePackMetricId("revenue_by_pack:")).toBe(false);
    expect(isRevenuePackMetricId("paying_companies")).toBe(false);
  });

  it("an unknown id is undefined, and the version is the groups' version", () => {
    expect(numbersMetric("nope")).toBeUndefined();
    expect(NUMBERS_DEFINITION_VERSION).toBe(1);
  });
});
