import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NAV } from "./nav-model";

/**
 * The topbar crumb reads "Group › Page" (A6, #2576): the sidebar group, then the page's section —
 * the current page itself on a sidebar destination, linked once the page sits deeper than a
 * record below it, readable segment names, and never an id.
 */
const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { TopbarCrumb, crumbTrail, SEGMENT_LABELS } = await import("./topbar-crumb");

const WORKER = "5eeded00-0001-4a00-8000-000000000001";
const SESSION = "c0ffee00-0002-4b00-8000-000000000002";

beforeEach(() => {
  nav.pathname = "/";
});

describe("crumbTrail — Group › Page", () => {
  it("a sidebar destination is its group, then itself — the current page", () => {
    expect(crumbTrail("/candidates")).toEqual({
      group: "Directory",
      section: { href: "/candidates", label: "Candidates" },
      sectionIsPage: true,
      sectionIsParent: false,
      steps: [],
    });
    expect(crumbTrail("/")).toEqual({
      group: "Home",
      section: { href: "/", label: "Dashboard" },
      sectionIsPage: true,
      sectionIsParent: false,
      steps: [],
    });
  });

  it("every sidebar destination reads its own group and its own label", () => {
    for (const section of NAV) {
      for (const item of section.items) {
        const trail = crumbTrail(item.href);
        expect(trail, item.href).not.toBeNull();
        expect(trail!.group, item.href).toBe(section.title);
        expect(trail!.section, item.href).toEqual({ href: item.href, label: item.label });
        expect(trail!.sectionIsPage, item.href).toBe(true);
        expect(trail!.steps, item.href).toEqual([]);
      }
    }
  });

  it("a detail page adds the section — its PARENT, which its back link already links — and no id", () => {
    expect(crumbTrail(`/candidates/${WORKER}`)).toEqual({
      group: "Directory",
      section: { href: "/candidates", label: "Candidates" },
      sectionIsPage: false,
      sectionIsParent: true,
      steps: [],
    });
  });

  it("a child of a detail page skips the id and never names itself", () => {
    // The page here is the timeline; its h1 says "Event timeline", so the crumb must not.
    expect(crumbTrail(`/candidates/${WORKER}/timeline`)?.steps).toEqual([]);
  });

  it("a deeper page names each READABLE step between the section and itself", () => {
    expect(crumbTrail(`/candidates/${WORKER}/journey/${SESSION}`)).toEqual({
      group: "Directory",
      section: { href: "/candidates", label: "Candidates" },
      sectionIsPage: false,
      sectionIsParent: false,
      steps: ["Journey"],
    });
  });

  it("an agency posting sits under Postings, through Agency postings (A6)", () => {
    expect(crumbTrail("/jobs/agency")).toMatchObject({
      group: "Directory",
      section: { href: "/jobs", label: "Postings" },
      sectionIsParent: true,
      steps: [],
    });
    for (const tab of [`/jobs/agency/${WORKER}`, `/jobs/agency/${WORKER}/match-skills`]) {
      expect(crumbTrail(tab), tab).toMatchObject({
        group: "Directory",
        section: { href: "/jobs", label: "Postings" },
        sectionIsParent: false,
        steps: ["Agency postings"],
      });
    }
  });

  it("the most specific nav entry wins, and a lookalike prefix is not a match", () => {
    expect(crumbTrail("/skills/discovery/abc")?.section.href).toBe("/skills/discovery");
    expect(crumbTrail("/jobsx")).toBeNull();
  });

  it("is null off the nav", () => {
    expect(crumbTrail("/nowhere")).toBeNull();
    expect(crumbTrail("/account")).toBeNull();
  });

  it("never names an id as a step — a uuid OR any other key", () => {
    // A record's key need not look like a uuid: `/candidates/abc/timeline` once read
    // "Candidates / Abc". Only a known view of the record above is a step.
    expect(crumbTrail("/candidates/abc/timeline")?.steps).toEqual([]);
    expect(crumbTrail("/candidates/abc/journey/def")?.steps).toEqual(["Journey"]);
    expect(crumbTrail("/candidates/12345/journey/x")?.steps).toEqual(["Journey"]);
    expect(crumbTrail("/candidates/constructor/journey/x")?.steps).toEqual(["Journey"]);
    expect(crumbTrail("/candidates/toString/x")?.steps).toEqual([]);
  });

  it("names only the views it knows, by the name the screen uses", () => {
    expect(SEGMENT_LABELS).toEqual({
      agency: "Agency postings",
      journey: "Journey",
      timeline: "Event timeline",
    });
  });
});

describe("TopbarCrumb — markup", () => {
  it("links the section with a caret glyph separator — no `/` character, no id", () => {
    nav.pathname = `/candidates/${WORKER}/journey/${SESSION}`;
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain(
      '<a class="crumb crumb__link" href="/candidates">Candidates<span class="nav-pending" aria-hidden="true"></span></a>',
    );
    expect(out).toContain('<i class="ph-fill ph-caret-right crumb__sep" aria-hidden="true"></i>');
    expect(out).toContain('<span class="crumb">Journey</span>');
    // An ordered list of crumbs: group, section, step — the separator inside the step it opens.
    expect(out).toContain('<nav class="crumbs" aria-label="Breadcrumb"><ol class="crumbs__list">');
    expect(out).toContain(
      '<li class="crumb__step"><i class="ph-fill ph-caret-right crumb__sep" aria-hidden="true"></i><a class="crumb crumb__link" href="/candidates">Candidates<span class="nav-pending" aria-hidden="true"></span></a></li>',
    );
    expect((out.match(/<li[ >]/g) ?? []).length).toBe(3);
    expect(out).not.toContain("5eeded00");
    expect(out).not.toContain("c0ffee00");
    expect(out).not.toContain(">/<");
  });

  it("on a sidebar destination it reads Group › Page, the page current and unlinked", () => {
    nav.pathname = "/candidates";
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toBe(
      '<nav class="crumbs" aria-label="Breadcrumb"><ol class="crumbs__list">' +
        '<li class="crumb crumb--group">Directory</li>' +
        '<li class="crumb__step"><i class="ph-fill ph-caret-right crumb__sep" aria-hidden="true"></i>' +
        '<span class="crumb" aria-current="page">Candidates</span></li></ol></nav>',
    );
  });

  it("the dashboard reads Home › Dashboard; a page off the nav keeps the console's name", () => {
    nav.pathname = "/";
    expect(renderToStaticMarkup(<TopbarCrumb sections={NAV} />)).toContain(
      '<li class="crumb crumb--group">Home</li><li class="crumb__step"><i class="ph-fill ph-caret-right crumb__sep" aria-hidden="true"></i><span class="crumb" aria-current="page">Dashboard</span></li>',
    );
    nav.pathname = "/account";
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain('<li class="crumb crumb--group">Admin</li>');
    expect((out.match(/<li[ >]/g) ?? []).length).toBe(1);
  });
});

describe("TopbarCrumb — never links a section the reader cannot open", () => {
  // A page BELOW the section's detail page, so the parent rule further down is not what decides.
  const DEEP = `/candidates/${WORKER}/timeline`;

  it("names it instead, when the reader's filtered sidebar does not hold it", () => {
    // A reader whose role lost /candidates: the server dropped it from their sidebar, and a crumb
    // link there would only redirect them.
    nav.pathname = DEEP;
    const withoutWorkers = NAV.map((s) => ({
      ...s,
      items: s.items.filter((i) => i.href !== "/candidates"),
    }));
    const out = renderToStaticMarkup(<TopbarCrumb sections={withoutWorkers} />);
    expect(out).toContain('<span class="crumb">Candidates</span>');
    expect(out).not.toContain('href="/candidates"');
  });

  it("links it when the reader may open it", () => {
    nav.pathname = DEEP;
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain(
      '<a class="crumb crumb__link" href="/candidates">Candidates<span class="nav-pending" aria-hidden="true"></span></a>',
    );
  });
});

/**
 * ONE LINK PER TARGET (sweep AW-16). A page directly below a section has the section list as
 * its real parent, so its back link (header rule 1) already goes there — measured on all seven
 * first-level detail routes, where crumb and back link both linked the list. The crumb keeps
 * the section as context and leaves the linking to the back link.
 */
describe("TopbarCrumb — the section a back link already links", () => {
  /** The sections with an `/<section>/[id]` detail page — every one measured (Agencies merged into Companies, A6). */
  const FIRST_LEVEL = [
    "/candidates",
    "/jobs",
    "/companies",
    "/events",
    "/ai-calls",
    "/skills/discovery",
  ] as const;
  const labelOf = (href: string) => NAV.flatMap((s) => s.items).find((i) => i.href === href)!.label;

  it.each(FIRST_LEVEL)("on %s/<id> it is named, not linked", (href) => {
    nav.pathname = `${href}/aa000000-0001-4a00-8000-000000000001`;
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain(`<span class="crumb">${labelOf(href)}</span>`);
    expect(out).not.toContain("<a ");
  });

  it("a page whose back link goes to a RECORD still gets the section as a link", () => {
    nav.pathname = `/companies/${WORKER}/timeline`;
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain(
      '<a class="crumb crumb__link" href="/companies">Companies<span class="nav-pending" aria-hidden="true"></span></a>',
    );
  });
});

/** The crumb's section link — the topbar's one link — carries the pending cue (review of #2095). */
describe("TopbarCrumb — the pending cue", () => {
  it("the section link holds the cue after its label, hidden from assistive tech", () => {
    nav.pathname = `/candidates/${WORKER}/journey/${SESSION}`;
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain(
      '<a class="crumb crumb__link" href="/candidates">Candidates<span class="nav-pending" aria-hidden="true"></span></a>',
    );
  });
});
