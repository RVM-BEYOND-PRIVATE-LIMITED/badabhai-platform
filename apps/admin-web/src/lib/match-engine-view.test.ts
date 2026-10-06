import { describe, expect, it } from "vitest";
import {
  changedFunnelKeys,
  diffCards,
  engineHref,
  funnelBalances,
  funnelSteps,
  monthsLabel,
  skillSourceLabel,
  tierBadgeLabel,
  tierBadgeTone,
  withExiting,
  type EngineCard,
  type EngineFunnel,
} from "./match-engine-view";

const card = (id: string, rank: number, tier = 1): EngineCard => ({
  rank,
  job_posting_id: id,
  role_title: `Role ${id}`,
  role_kind: null,
  city: "Pune",
  match_tier: tier,
  matched_skill_id: "mskill_x",
  matched_skill_label: "X",
  boosted: false,
  published_at: null,
  why: tier === 1 ? "direct: X" : "related: X → Y",
});

const FUNNEL: EngineFunnel = {
  open_postings: 10,
  reached_direct: 3,
  reached_related: 2,
  hidden: 5,
  already_actioned: 1,
};

describe("tier labels", () => {
  it("names the two tiers and never dresses an unknown tier as direct", () => {
    expect(tierBadgeLabel(1)).toBe("Direct");
    expect(tierBadgeLabel(2)).toBe("Related");
    expect(tierBadgeLabel(3)).toBe("Tier 3");
    expect(tierBadgeLabel(null)).toBe("—");
    expect(tierBadgeTone(1)).toBe("direct");
    expect(tierBadgeTone(2)).toBe("related");
    expect(tierBadgeTone(7)).toBe("unknown");
  });

  it("labels skill sources and months, keeping an unknown source readable", () => {
    expect(skillSourceLabel("interview")).toBe("Interview");
    expect(skillSourceLabel("derived_coarse")).toBe("Derived");
    expect(skillSourceLabel("new_source")).toBe("New source");
    expect(monthsLabel(0)).toBe("under a month");
    expect(monthsLabel(1)).toBe("~1 month");
    expect(monthsLabel(24)).toBe("~24 months");
  });
});

describe("the funnel", () => {
  it("draws four steps in order with shares of open postings", () => {
    const steps = funnelSteps(FUNNEL);
    expect(steps.map((s) => s.key)).toEqual([
      "open_postings",
      "reached_direct",
      "reached_related",
      "hidden",
    ]);
    expect(steps.map((s) => s.share)).toEqual([100, 30, 20, 50]);
  });

  it("has zero-width bars, not NaN, when nothing is open", () => {
    const steps = funnelSteps({
      ...FUNNEL,
      open_postings: 0,
      reached_direct: 0,
      reached_related: 0,
      hidden: 0,
    });
    expect(steps.every((s) => s.share === 0)).toBe(true);
  });

  it("flags a funnel that does not add up instead of re-balancing it", () => {
    expect(funnelBalances(FUNNEL)).toBe(true);
    expect(funnelBalances({ ...FUNNEL, hidden: 4 })).toBe(false);
  });

  it("reports only the numbers that moved", () => {
    expect(
      [...changedFunnelKeys(FUNNEL, { ...FUNNEL, reached_direct: 4, hidden: 4 })].sort(),
    ).toEqual(["hidden", "reached_direct"]);
    expect(changedFunnelKeys(FUNNEL, FUNNEL).size).toBe(0);
  });
});

describe("card diff between polls", () => {
  it("finds arrivals and departures by posting id; a re-rank is neither", () => {
    const prev = [card("a", 1), card("b", 2), card("c", 3)];
    const next = [card("b", 1), card("a", 2), card("d", 3)];
    const d = diffCards(prev, next);
    expect([...d.entered]).toEqual(["d"]);
    expect(d.exited.map((e) => [e.card.job_posting_id, e.index])).toEqual([["c", 2]]);
  });

  it("slots a departing card back where it stood without reordering the live feed", () => {
    const next = [card("a", 1), card("c", 2)];
    const drawn = withExiting(next, [{ card: card("b", 2), index: 1 }]);
    expect(drawn.map((r) => [r.card.job_posting_id, r.exiting])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
    // The live cards keep the server's order exactly.
    expect(drawn.filter((r) => !r.exiting).map((r) => r.card.job_posting_id)).toEqual(["a", "c"]);
  });
});

describe("engineHref", () => {
  it("keeps the selection in the query and drops the default tab", () => {
    expect(engineHref({})).toBe("/matching/engine");
    expect(engineHref({ worker: "w1" })).toBe("/matching/engine?worker=w1");
    expect(engineHref({ worker: "w1", tab: "posting", posting: "p1" })).toBe(
      "/matching/engine?worker=w1&tab=posting&posting=p1",
    );
    expect(engineHref({ worker: "a&b" })).toBe("/matching/engine?worker=a%26b");
  });
});
