import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillDiscoveryFilterValues } from "./filter-bar";

/**
 * The Skill discovery filter bar, for real — the page test stubs it, which is how its Apply and
 * clear buttons shipped unable to clear the bar's own fields (owner brief 2026-10-01, bug 5).
 *
 * The node test env has no DOM to click in, so the navigation the buttons perform is the pure
 * `filterBarHref` both of them call, and the rendered markup is checked for the buttons
 * themselves.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

const { SkillDiscoveryFilterBar, filterBarHref } = await import("./filter-bar");

const EMPTY: SkillDiscoveryFilterValues = {
  band: "",
  proposedAction: "",
  tradeFamily: "",
  sourceType: "",
  runId: "",
  clusterKey: "",
  phrase: "",
  createdFrom: "",
  createdTo: "",
  sort: "newest",
};
const BASE = "/skills/discovery";
const query = (href: string) => new URL(href, "http://x").searchParams;

describe("Apply — the bar's own fields come from the form, never from the URL", () => {
  it("an emptied field is GONE from the next URL, even when the old value is in carry", () => {
    // The old page passed its whole query as carry, so the stale `phrase` sat in it.
    const carry = { view: "flat", tier: "ambiguous", phrase: "arc", band: "high" };
    const href = filterBarHref(BASE, carry, { ...EMPTY, band: "high", phrase: "" });
    const q = query(href);
    expect(q.get("phrase")).toBeNull();
    expect(q.get("band")).toBe("high");
    expect(q.get("view")).toBe("flat");
    expect(q.get("tier")).toBe("ambiguous");
  });

  it("a changed field takes the form's value, not the carried one", () => {
    const href = filterBarHref(BASE, { runId: "sdr_old" }, { ...EMPTY, runId: "sdr_new" });
    expect(query(href).getAll("runId")).toEqual(["sdr_new"]);
  });

  it("omits empty values — `?band=` would 400 against the strict schema", () => {
    const href = filterBarHref(BASE, {}, { ...EMPTY, band: "high" });
    expect(href).not.toContain("phrase=");
    expect(href).not.toContain("runId=");
    expect(href).toContain("band=high");
  });
});

describe("Clear these fields — empties the bar, keeps what is chosen above it", () => {
  it("drops every bar field and keeps view, tier, status scope and batch order", () => {
    const carry = {
      view: "grouped",
      tier: "direct",
      statusScope: "held",
      groupSort: "undecided",
      band: "high",
      phrase: "arc",
      sort: "oldest",
    };
    const q = query(filterBarHref(BASE, carry, null));
    for (const own of ["band", "phrase", "sort", "runId", "createdFrom"]) {
      expect(q.get(own), own).toBeNull();
    }
    expect(q.get("view")).toBe("grouped");
    expect(q.get("tier")).toBe("direct");
    expect(q.get("statusScope")).toBe("held");
    expect(q.get("groupSort")).toBe("undecided");
  });

  it("with nothing above it either, lands on the bare route", () => {
    expect(filterBarHref(BASE, {}, null)).toBe(BASE);
    expect(filterBarHref(BASE, { band: "high" }, null)).toBe(BASE);
  });
});

describe("the rendered bar", () => {
  const html = renderToStaticMarkup(
    <SkillDiscoveryFilterBar basePath={BASE} carry={{}} initial={{ ...EMPTY, phrase: "arc" }} />,
  );

  it("offers Apply and a clear that says what it clears", () => {
    expect(html).toContain(">Apply<");
    expect(html).toContain(">Clear these fields<");
    // "Clear filters" means "go to the bare route" everywhere else in the portal.
    expect(html).not.toContain(">Clear filters<");
  });

  it("shows the current values in the fields", () => {
    expect(html).toContain('value="arc"');
  });
});
