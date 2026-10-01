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

const ON = { agencyPortalEnabled: true } as const;

const BOTH_ROLES = [
  { name: "company", input: { isAgency: false, isOwner: true, ...ON } },
  { name: "agency", input: { isAgency: true, isOwner: true, ...ON } },
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
  const company = navSections({ isAgency: false, isOwner: true, ...ON });
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

  it("the AI chat is the SAME destination as New posting, never Postings", () => {
    expect(activeHrefs("/postings/ai/draft-1")).toEqual(["/postings/new"]);
  });

  it("/postings/new does not also light the Postings list (siblings, not parent/child)", () => {
    expect(activeHrefs("/postings/new")).toEqual(["/postings/new"]);
  });

  it("/capacity lights nothing — it is a redirect to Plans & capacity, never a rendered page", () => {
    // (capacity/page.tsx only redirects: a company to /plans#hiring-capacity, an agent to the
    // dashboard — the w3b page-gate suite pins both.)
    expect(activeHrefs("/capacity")).toEqual([]);
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
    const agency = navSections({ isAgency: true, isOwner: false, ...ON });

    it.each([
      ["/agency/jobs", "/agency/jobs"],
      ["/agency/jobs/new", "/agency/jobs/new"],
      ["/agency/workers", "/agency/workers"],
      ["/agency/referrals", "/agency/referrals"],
      ["/agency/qr", "/agency/qr"],
      ["/agency/revenue", "/agency/revenue"],
    ])("%s activates %s", (pathname, href) => {
      expect(activeHrefs(pathname, agency)).toContain(href);
    });

    it("the supply routes do not bleed into each other", () => {
      expect(activeHrefs("/agency/workers/abc", agency)).toEqual(["/agency/workers"]);
    });

    it("a posting's detail lights Postings; the create form lights only itself", () => {
      expect(activeHrefs("/agency/jobs/2f8c", agency)).toEqual(["/agency/jobs"]);
      expect(activeHrefs("/agency/jobs/new", agency)).toEqual(["/agency/jobs/new"]);
    });

    it("bulk invite upload lights nothing — it is not in the rail", () => {
      expect(activeHrefs("/agency/bulk-upload", agency)).toEqual([]);
    });
  });
});

describe("nav model — role shapes the affordances, not the gates", () => {
  it("a recruiter is shown neither Credits nor Team", () => {
    const hrefs = allItems(navSections({ isAgency: false, isOwner: false, ...ON })).map(
      (i) => i.href,
    );
    expect(hrefs).not.toContain("/credits");
    expect(hrefs).not.toContain("/team");
  });

  it("an owner is shown both", () => {
    const hrefs = allItems(navSections({ isAgency: false, isOwner: true, ...ON })).map(
      (i) => i.href,
    );
    expect(hrefs).toContain("/credits");
    expect(hrefs).toContain("/team");
  });

  it("the parked Revenue page stays a link, badged parked", () => {
    const items = allItems(navSections({ isAgency: true, isOwner: false, ...ON }));
    const revenue = items.find((i) => i.href === "/agency/revenue")!;
    expect(revenue.parked).toBe(true);
  });
});

describe("nav model — Posting naming, and an agency posts AGENCY jobs only (2026-10-01)", () => {
  const labelsOf = (sections: NavSection[]) => allItems(sections).map((i) => i.label);

  it("the job entity is a Posting for BOTH personas — the same two labels", () => {
    for (const isAgency of [false, true]) {
      const labels = labelsOf(navSections({ isAgency, isOwner: true, ...ON }));
      expect(labels).toContain("New posting");
      expect(labels).toContain("Postings");
      expect(labels.join(" ")).not.toMatch(/vacanc|Post a job/i);
    }
  });

  it("the company rail, in order", () => {
    expect(labelsOf(navSections({ isAgency: false, isOwner: true, ...ON }))).toEqual([
      "Dashboard",
      "New posting",
      "Postings",
      "Plans & capacity",
      "Credits",
      "Team",
    ]);
  });

  it("the agency rail, in order — Supply labels match their page titles", () => {
    expect(labelsOf(navSections({ isAgency: true, isOwner: true, ...ON }))).toEqual([
      "Dashboard",
      "New posting",
      "Postings",
      "Worker activity",
      "Referrals",
      "QR invite",
      "Credits",
      "Team",
      "Revenue",
    ]);
  });

  it("Plans & capacity is a COMPANY page: never in an agency rail (any role, any flag)", () => {
    // It sells entitlements on company postings; an agency posts agency jobs only (ruling 2),
    // and an agent who opens /plans or /capacity is redirected to the dashboard.
    for (const isOwner of [false, true]) {
      for (const agencyPortalEnabled of [false, true]) {
        const items = allItems(navSections({ isAgency: true, isOwner, agencyPortalEnabled }));
        expect(items.map((i) => i.href), `owner ${isOwner} flag ${agencyPortalEnabled}`).not.toContain(
          "/plans",
        );
      }
    }
    // …while a company keeps it, owner or recruiter.
    for (const isOwner of [false, true]) {
      const items = allItems(navSections({ isAgency: false, isOwner, ...ON }));
      expect(items.map((i) => i.href)).toContain("/plans");
    }
  });

  it("an agency recruiter's rail has no Billing group at all (Credits is owner-only)", () => {
    const sections = navSections({ isAgency: true, isOwner: false, ...ON });
    expect(sections.map((s) => s.title)).not.toContain("Billing");
  });

  it("an agency's posting items open the AGENCY surface; nothing in its rail opens /postings*", () => {
    const items = allItems(navSections({ isAgency: true, isOwner: true, ...ON }));
    expect(items.find((i) => i.label === "New posting")!.href).toBe("/agency/jobs/new");
    expect(items.find((i) => i.label === "Postings")!.href).toBe("/agency/jobs");
    expect(items.filter((i) => i.href.startsWith("/postings"))).toEqual([]);
  });

  it("a company's posting items open the company surface", () => {
    const items = allItems(navSections({ isAgency: false, isOwner: true, ...ON }));
    expect(items.find((i) => i.label === "New posting")!.href).toBe("/postings/new");
    expect(items.find((i) => i.label === "Postings")!.href).toBe("/postings");
    expect(items.filter((i) => i.href.startsWith("/agency"))).toEqual([]);
  });

  it("'New posting' is a plus (create), never plus-circle; Credits is the wallet", () => {
    for (const isAgency of [false, true]) {
      const items = allItems(navSections({ isAgency, isOwner: true, ...ON }));
      expect(items.find((i) => i.label === "New posting")!.icon).toBe("plus");
      expect(items.find((i) => i.label === "Credits")!.icon).toBe("wallet");
      expect(items.map((i) => i.icon)).not.toContain("plus-circle");
    }
  });
});

describe("nav model — the nav follows the page gate (agency-portal flag)", () => {
  const hrefs = (agencyPortalEnabled: boolean, isOwner = true) =>
    allItems(navSections({ isAgency: true, isOwner, agencyPortalEnabled })).map((i) => i.href);
  /** Every agency-only page checks `agencyPortalEnabled` before it renders (off → 404). */
  const FLAG_GATED = [
    "/agency/jobs/new",
    "/agency/jobs",
    "/agency/workers",
    "/agency/referrals",
    "/agency/qr",
    "/agency/revenue",
  ];

  it("flag ON: every agency destination is offered", () => {
    expect(hrefs(true)).toEqual(expect.arrayContaining(FLAG_GATED));
  });

  it("flag OFF: none of them is offered (each would 404); the shared surfaces stay", () => {
    const off = hrefs(false);
    for (const h of FLAG_GATED) expect(off, h).not.toContain(h);
    expect(off).toEqual(["/dashboard", "/credits", "/team"]);
    // …and no empty group heading is left behind.
    const sections = navSections({ isAgency: true, isOwner: true, agencyPortalEnabled: false });
    for (const s of sections) expect(s.items.length, s.title ?? "lead").toBeGreaterThan(0);
  });

  it("the flag never touches the company rail", () => {
    const company = (agencyPortalEnabled: boolean) =>
      allItems(navSections({ isAgency: false, isOwner: true, agencyPortalEnabled })).map(
        (i) => i.href,
      );
    expect(company(false)).toEqual(company(true));
  });

  it("bulk invite upload is never in the rail, under any flag or role (ADR-0022 Amdt 3)", () => {
    for (const isAgency of [false, true]) {
      for (const isOwner of [false, true]) {
        for (const agencyPortalEnabled of [false, true]) {
          const sections = navSections({ isAgency, isOwner, agencyPortalEnabled });
          const items = allItems(sections);
          expect(items.map((i) => i.href)).not.toContain("/agency/bulk-upload");
          expect(items.map((i) => i.label).join(" ")).not.toMatch(/bulk/i);
        }
      }
    }
  });
});
