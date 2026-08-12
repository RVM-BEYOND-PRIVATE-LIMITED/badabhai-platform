import { describe, expect, it } from "vitest";
import { isNavItemActive, navSections, type NavItem, type NavSection } from "./nav-model";

/**
 * THE PORTAL NAV MODEL — serializability + the activation table.
 *
 * THE REGRESSION THIS EXISTS FOR: `match` was a closure. The portal layout is a Server
 * Component and `AppShell` is a Client Component, so these sections cross the RSC boundary
 * as props — and a function cannot. Every portal route threw "Functions cannot be passed
 * directly to Client Components" and `/dashboard` answered 500.
 *
 * Nothing caught it. `layout.test.tsx` mocks `./app-shell` (the real one uses hooks and
 * cannot be invoked directly), so the boundary the bug lived on was the one thing the suite
 * replaced with a stand-in; `tsc` and `next build` are both happy to compile a function into
 * a prop. The guard therefore has to assert the SHAPE of the data, not the render.
 */

function allItems(sections: NavSection[]): NavItem[] {
  return sections.flatMap((s) => s.items);
}

const BOTH_ROLES = [
  { name: "company", input: { isAgency: false, isOwner: true } },
  { name: "agency", input: { isAgency: true, isOwner: true } },
] as const;

describe("nav model — survives the server → client boundary", () => {
  for (const { name, input } of BOTH_ROLES) {
    it(`${name}: the whole model is structured-cloneable (no functions anywhere)`, () => {
      // structuredClone throws DataCloneError on a function, at ANY depth — which is the
      // same constraint React applies when serializing props for a Client Component. A
      // shallow "typeof item.match !== 'function'" check would miss one nested inside a
      // future `badge`/`onSelect`/`children` field; this cannot.
      expect(() => structuredClone(navSections(input))).not.toThrow();
    });

    it(`${name}: every item's match is DATA, and every field is a primitive or array`, () => {
      for (const item of allItems(navSections(input))) {
        expect(typeof item.match, `${item.href} match`).toBe("object");
        for (const [key, value] of Object.entries(item)) {
          expect(typeof value, `${item.href}.${key}`).not.toBe("function");
        }
      }
    });
  }
});

describe("nav model — which paths light which item up", () => {
  const company = navSections({ isAgency: false, isOwner: true });
  const activeHrefs = (pathname: string, sections = company): string[] =>
    allItems(sections)
      .filter((i) => isNavItemActive(i.match, pathname))
      .map((i) => i.href);

  // GREEN rows — what the model must PERMIT. A matcher that lights nothing up passes every
  // "does it avoid a false positive" test and is silently useless, so each destination gets
  // a row proving it activates on its own route.
  it.each([
    ["/dashboard", "/dashboard"],
    ["/postings", "/postings"],
    ["/postings/new", "/postings/new"],
    ["/plans", "/plans"],
    ["/credits", "/credits"],
    ["/team", "/team"],
  ])("%s activates %s", (pathname, href) => {
    expect(activeHrefs(pathname)).toContain(href);
  });

  it("a posting detail route lights Postings, and only Postings", () => {
    expect(activeHrefs("/postings/2f8c/applicants")).toEqual(["/postings"]);
  });

  it("the AI chat is the SAME destination as Post a job, never Postings", () => {
    expect(activeHrefs("/postings/ai/draft-1")).toEqual(["/postings/new"]);
  });

  it("/postings/new does not also light the Postings list (siblings, not parent/child)", () => {
    expect(activeHrefs("/postings/new")).toEqual(["/postings/new"]);
  });

  it("/capacity folds into Plans & capacity rather than lighting nothing", () => {
    expect(activeHrefs("/capacity")).toEqual(["/plans"]);
  });

  it("exactly one item is active on every ordinary route (no double highlight)", () => {
    for (const p of ["/dashboard", "/postings", "/postings/new", "/plans", "/credits", "/team"]) {
      expect(activeHrefs(p), p).toHaveLength(1);
    }
  });

  it("an unknown route lights nothing", () => {
    expect(activeHrefs("/nowhere")).toEqual([]);
  });

  it("a string-prefix neighbour is NOT a child route", () => {
    // The old closures used bare `startsWith`, so "/plans-archive" would have lit Plans.
    // Matching is segment-aware now.
    expect(activeHrefs("/plans-archive")).toEqual([]);
    expect(activeHrefs("/teams")).toEqual([]);
  });

  it("/dashboard is exact — a child route does not keep it lit", () => {
    expect(activeHrefs("/dashboard/anything")).toEqual([]);
  });

  describe("agency", () => {
    const agency = navSections({ isAgency: true, isOwner: false });

    it.each([
      ["/agency/workers", "/agency/workers"],
      ["/agency/referrals", "/agency/referrals"],
      ["/agency/qr", "/agency/qr"],
      ["/agency/revenue", "/agency/revenue"],
      ["/agency/bulk-upload", "/agency/bulk-upload"],
    ])("%s activates %s", (pathname, href) => {
      expect(activeHrefs(pathname, agency)).toContain(href);
    });

    it("the supply routes do not bleed into each other", () => {
      expect(activeHrefs("/agency/workers/abc", agency)).toEqual(["/agency/workers"]);
    });
  });
});

describe("nav model — role shapes the affordances, not the gates", () => {
  it("a recruiter is shown neither Credits nor Team", () => {
    const hrefs = allItems(navSections({ isAgency: false, isOwner: false })).map((i) => i.href);
    expect(hrefs).not.toContain("/credits");
    expect(hrefs).not.toContain("/team");
  });

  it("an owner is shown both", () => {
    const hrefs = allItems(navSections({ isAgency: false, isOwner: true })).map((i) => i.href);
    expect(hrefs).toContain("/credits");
    expect(hrefs).toContain("/team");
  });

  it("only the flag-gated route is comingSoon; the parked one stays a link", () => {
    const items = allItems(navSections({ isAgency: true, isOwner: false }));
    const bulk = items.find((i) => i.href === "/agency/bulk-upload")!;
    const revenue = items.find((i) => i.href === "/agency/revenue")!;
    // Coming Soon renders as a non-anchor (a 404 must not be keyboard-reachable); parked
    // renders as a real link to a page that explains itself.
    expect(bulk.comingSoon).toBe(true);
    expect(revenue.comingSoon).toBeUndefined();
    expect(revenue.parked).toBe(true);
  });
});
