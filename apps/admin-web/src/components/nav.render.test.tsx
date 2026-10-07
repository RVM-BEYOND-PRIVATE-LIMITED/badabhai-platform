import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The sidebar draws each item's glyph from the shared icon font, before its label, decorative
 * (the label names the destination), and inheriting the row's colour — so the active row's
 * glyph is Safety Yellow on the navy band with no icon-specific rule.
 */
const nav = vi.hoisted(() => ({ pathname: "/jobs/abc" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { SidebarNav } = await import("./nav");

const SECTIONS = [
  {
    title: "Operations",
    items: [
      { href: "/workers", label: "Workers", icon: "users-three" as const },
      { href: "/jobs", label: "Postings", icon: "briefcase" as const },
    ],
  },
];
const renderAt = (pathname: string) => {
  nav.pathname = pathname;
  return renderToStaticMarkup(<SidebarNav sections={SECTIONS} />);
};
/** The `<a>` of the item linking to `href`. */
const linkTo = (out: string, href: string) => {
  const start = out.lastIndexOf("<a ", out.indexOf(`href="${href}"`));
  return out.slice(start, out.indexOf("</a>", start));
};

const out = renderAt("/jobs/abc");

describe("SidebarNav", () => {
  it("draws the glyph before the label, hidden from assistive tech", () => {
    expect(out).toContain(
      '<i class="ph-fill ph-users-three sidebar__icon" aria-hidden="true"></i><span class="sidebar__label">Workers</span>',
    );
  });

  it("marks the section of a detail route active — as the current section, not the page", () => {
    const active = out.slice(out.indexOf('href="/jobs"') - 40, out.indexOf("Postings") + 20);
    expect(active).toContain('aria-current="true"');
    expect(active).not.toContain('aria-current="page"');
    expect(active).toContain("is-active");
    expect(active).toContain("ph-briefcase");
  });

  it("the exact page is the current PAGE", () => {
    const here = linkTo(renderAt("/jobs"), "/jobs");
    expect(here).toContain('aria-current="page"');
    expect(here).toContain("is-active");
  });

  it("a route that merely starts with the same letters is not inside the section", () => {
    // `/jobsx` is not below `/jobs`: the section match is `${href}/`, not a bare prefix.
    const lookalike = linkTo(renderAt("/jobsx"), "/jobs");
    expect(lookalike).not.toContain("aria-current");
    expect(lookalike).not.toContain("is-active");
  });

  it("an item that is not this route's section is not current at all", () => {
    const other = out.slice(out.indexOf('href="/workers"') - 40, out.indexOf("Workers</span>"));
    expect(other).not.toContain("aria-current");
    expect(other).not.toContain("is-active");
  });
});

/**
 * Each sidebar link carries the navigation PENDING CUE (review of #2095): with no loading boundary
 * in the console, the link that started a navigation is what shows it is under way.
 */
describe("SidebarNav — the pending cue", () => {
  it("every link holds the cue after its label, hidden from assistive tech — the link's name is unchanged", () => {
    for (const href of ["/workers", "/jobs"]) {
      expect(linkTo(out, href)).toMatch(
        /<span class="sidebar__label">[^<]+<\/span><span class="nav-pending" aria-hidden="true"><\/span>$/,
      );
    }
  });
});
