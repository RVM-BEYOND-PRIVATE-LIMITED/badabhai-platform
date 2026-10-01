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

const { TopbarCrumb, crumbTrail, isOpaqueId } = await import("./topbar-crumb");

const WORKER = "5eeded00-0001-4a00-8000-000000000001";
const SESSION = "c0ffee00-0002-4b00-8000-000000000002";

beforeEach(() => {
  nav.pathname = "/";
});

describe("crumbTrail — ancestors only", () => {
  it("a top-level page shows its group alone: the h1 names the page", () => {
    expect(crumbTrail("/workers")).toEqual({ group: "Operations", section: null, steps: [] });
    expect(crumbTrail("/")).toEqual({ group: "Overview", section: null, steps: [] });
  });

  it("a detail page adds the section, linked, and no id", () => {
    expect(crumbTrail(`/workers/${WORKER}`)).toEqual({
      group: "Operations",
      section: { href: "/workers", label: "Workers" },
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

  it("recognises an opaque id, and only that", () => {
    expect(isOpaqueId(WORKER)).toBe(true);
    expect(isOpaqueId("abcdef0123456789abcd")).toBe(true);
    expect(isOpaqueId("journey")).toBe(false);
    expect(isOpaqueId("discovery")).toBe(false);
  });
});

describe("TopbarCrumb — markup", () => {
  it("links the section with a caret glyph separator — no `/` character, no id", () => {
    nav.pathname = `/workers/${WORKER}/journey/${SESSION}`;
    const out = renderToStaticMarkup(<TopbarCrumb />);
    expect(out).toContain('<a class="crumb crumb__link" href="/workers">Workers</a>');
    expect(out).toContain('<i class="ph-fill ph-caret-right crumb__sep" aria-hidden="true"></i>');
    expect(out).toContain('<span class="crumb">Journey</span>');
    expect(out).not.toContain("5eeded00");
    expect(out).not.toContain("c0ffee00");
    expect(out).not.toContain(">/<");
  });

  it("on a top-level page the group is the whole crumb, unlinked", () => {
    nav.pathname = "/workers";
    const out = renderToStaticMarkup(<TopbarCrumb />);
    expect(out).toContain('<span class="crumb crumb--group">Operations</span>');
    expect(out).not.toContain("<a ");
    expect(out).not.toContain(">Workers<");
  });
});
