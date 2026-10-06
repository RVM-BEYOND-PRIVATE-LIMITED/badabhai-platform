import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NAV } from "./nav-model";

/**
 * The topbar crumb gives SECTION CONTEXT (owner ruling 2026-10-01): the section linked once the
 * page sits below it, opaque ids hidden, readable segment names, and never the page's own name —
 * the h1 says that.
 */
const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { TopbarCrumb, crumbTrail, SEGMENT_LABELS } = await import("./topbar-crumb");

const WORKER = "5eeded00-0001-4a00-8000-000000000001";
const SESSION = "c0ffee00-0002-4b00-8000-000000000002";

beforeEach(() => {
  nav.pathname = "/";
});

describe("crumbTrail — ancestors only", () => {
  it("a top-level page shows its group alone: the h1 names the page", () => {
    expect(crumbTrail("/workers")).toEqual({
      group: "Operations",
      section: null,
      sectionIsParent: false,
      steps: [],
    });
    expect(crumbTrail("/")).toEqual({
      group: "Overview",
      section: null,
      sectionIsParent: false,
      steps: [],
    });
  });

  it("a detail page adds the section — its PARENT, which its back link already links — and no id", () => {
    expect(crumbTrail(`/workers/${WORKER}`)).toEqual({
      group: "Operations",
      section: { href: "/workers", label: "Workers" },
      sectionIsParent: true,
      steps: [],
    });
  });

  it("a child of a detail page skips the id and never names itself", () => {
    // The page here is the timeline; its h1 says "Event timeline", so the crumb must not.
    expect(crumbTrail(`/workers/${WORKER}/timeline`)?.steps).toEqual([]);
  });

  it("a deeper page names each READABLE step between the section and itself", () => {
    expect(crumbTrail(`/workers/${WORKER}/journey/${SESSION}`)).toEqual({
      group: "Operations",
      section: { href: "/workers", label: "Workers" },
      sectionIsParent: false,
      steps: ["Journey"],
    });
  });

  it("the most specific nav entry wins, and a lookalike prefix is not a match", () => {
    expect(crumbTrail("/skills/discovery/abc")?.section?.href).toBe("/skills/discovery");
    expect(crumbTrail("/jobsx")).toBeNull();
  });

  it("is null off the nav", () => {
    expect(crumbTrail("/nowhere")).toBeNull();
  });

  it("never repeats a list page's h1 — for every sidebar destination", () => {
    for (const item of NAV.flatMap((s) => s.items)) {
      const trail = crumbTrail(item.href);
      expect(trail, item.href).not.toBeNull();
      expect(trail!.section, item.href).toBeNull();
      expect(trail!.steps, item.href).toEqual([]);
      expect(trail!.group, item.href).not.toBe(item.label);
    }
  });

  it("never names an id as a step — a uuid OR any other key", () => {
    // A record's key need not look like a uuid: `/workers/abc/timeline` once read
    // "Workers / Abc". Only a known view of the record above is a step.
    expect(crumbTrail("/workers/abc/timeline")?.steps).toEqual([]);
    expect(crumbTrail("/workers/abc/journey/def")?.steps).toEqual(["Journey"]);
    expect(crumbTrail("/workers/12345/journey/x")?.steps).toEqual(["Journey"]);
    expect(crumbTrail("/workers/constructor/journey/x")?.steps).toEqual(["Journey"]);
    expect(crumbTrail("/workers/toString/x")?.steps).toEqual([]);
  });

  it("names only the views it knows, by the name the screen uses", () => {
    expect(SEGMENT_LABELS).toEqual({ journey: "Journey", timeline: "Event timeline" });
  });
});

describe("TopbarCrumb — markup", () => {
  it("links the section with a caret glyph separator — no `/` character, no id", () => {
    nav.pathname = `/workers/${WORKER}/journey/${SESSION}`;
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain('<a class="crumb crumb__link" href="/workers">Workers</a>');
    expect(out).toContain('<i class="ph-fill ph-caret-right crumb__sep" aria-hidden="true"></i>');
    expect(out).toContain('<span class="crumb">Journey</span>');
    // An ordered list of crumbs: group, section, step — the separator inside the step it opens.
    expect(out).toContain('<nav class="crumbs" aria-label="Breadcrumb"><ol class="crumbs__list">');
    expect(out).toContain(
      '<li class="crumb__step"><i class="ph-fill ph-caret-right crumb__sep" aria-hidden="true"></i><a class="crumb crumb__link" href="/workers">Workers</a></li>',
    );
    expect((out.match(/<li[ >]/g) ?? []).length).toBe(3);
    expect(out).not.toContain("5eeded00");
    expect(out).not.toContain("c0ffee00");
    expect(out).not.toContain(">/<");
  });

  it("on a top-level page the group is the whole crumb, unlinked", () => {
    nav.pathname = "/workers";
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain('<li class="crumb crumb--group">Operations</li>');
    expect((out.match(/<li[ >]/g) ?? []).length).toBe(1);
    expect(out).not.toContain("<a ");
    expect(out).not.toContain(">Workers<");
  });
});

describe("TopbarCrumb — never links a section the reader cannot open", () => {
  // A page BELOW the section's detail page, so the parent rule further down is not what decides.
  const DEEP = `/workers/${WORKER}/timeline`;

  it("names it instead, when the reader's filtered sidebar does not hold it", () => {
    // A reader whose role lost /workers: the server dropped it from their sidebar, and a crumb
    // link there would only redirect them.
    nav.pathname = DEEP;
    const withoutWorkers = NAV.map((s) => ({
      ...s,
      items: s.items.filter((i) => i.href !== "/workers"),
    }));
    const out = renderToStaticMarkup(<TopbarCrumb sections={withoutWorkers} />);
    expect(out).toContain('<span class="crumb">Workers</span>');
    expect(out).not.toContain('href="/workers"');
  });

  it("links it when the reader may open it", () => {
    nav.pathname = DEEP;
    const out = renderToStaticMarkup(<TopbarCrumb sections={NAV} />);
    expect(out).toContain('<a class="crumb crumb__link" href="/workers">Workers</a>');
  });
});

/**
 * ONE LINK PER TARGET (sweep AW-16). A page directly below a section has the section list as
 * its real parent, so its back link (header rule 1) already goes there — measured on all seven
 * first-level detail routes, where crumb and back link both linked the list. The crumb keeps
 * the section as context and leaves the linking to the back link.
 */
describe("TopbarCrumb — the section a back link already links", () => {
  /** The seven sections with an `/<section>/[id]` detail page — every one measured. */
  const FIRST_LEVEL = [
    "/workers",
    "/jobs",
    "/companies",
    "/agencies",
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
    expect(out).toContain('<a class="crumb crumb__link" href="/companies">Companies</a>');
  });
});
