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
    title: "Directory",
    items: [
      { href: "/candidates", label: "Candidates", icon: "users-three" as const },
      { href: "/jobs", label: "Postings", icon: "briefcase" as const },
    ],
  },
  {
    title: "Quality & AI",
    items: [{ href: "/feedback", label: "Feedback", icon: "chat-centered-text" as const }],
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
      '<i class="ph-fill ph-users-three sidebar__icon" aria-hidden="true"></i><span class="sidebar__label">Candidates</span>',
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
    const other = out.slice(out.indexOf('href="/candidates"') - 40, out.indexOf("Candidates</span>"));
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
    for (const href of ["/candidates", "/jobs"]) {
      expect(linkTo(out, href)).toMatch(
        /<span class="sidebar__label">[^<]+<\/span><span class="nav-pending" aria-hidden="true"><\/span>$/,
      );
    }
  });
});

/**
 * GROUPS THAT OPEN AND CLOSE (A6, #2576). Each group's title is a disclosure button over its own
 * list; every group starts open (the whole nav fits a 1080p screen that way). The behaviour —
 * closing, reopening, a navigation reopening — is in nav.behaviour.test.tsx.
 */
describe("SidebarNav — the group titles", () => {
  it("each title is a button in its heading, open, controlling its own list", () => {
    const html = renderAt("/jobs");
    const toggles = [...html.matchAll(/<h2 class="sidebar__grouptitle"><button type="button" class="sidebar__grouptoggle" aria-expanded="true" aria-controls="([^"]+)">/g)];
    expect(toggles).toHaveLength(2);
    for (const [, id] of toggles) {
      expect(html).toContain(`<ul class="sidebar__list" id="${id}">`);
    }
    expect(new Set(toggles.map((t) => t[1])).size).toBe(2);
  });

  it("names the group in the button and draws the brand caret, hidden from assistive tech", () => {
    expect(renderAt("/jobs")).toContain(
      '<span class="sidebar__grouplabel">Quality &amp; AI</span><i class="ph-fill ph-caret-down sidebar__groupcaret" aria-hidden="true"></i></button></h2>',
    );
  });

  it("no group is hidden and none has moved on a fresh render — nothing animates on load", () => {
    const html = renderAt("/jobs");
    expect(html).not.toContain(" hidden");
    expect(html).not.toContain("data-moved");
  });
});

/**
 * THE ACTIVE MARKER (A6): one wash under the active row that glides between rows. It needs a
 * measurement, so the server render (and a browser without JS) has none — and then each active
 * row draws its own wash, exactly as before. The measured marker is in nav.behaviour.test.tsx.
 */
describe("SidebarNav — the active marker before it is measured", () => {
  it("is absent, and the nav does not hand the active wash to it", () => {
    const html = renderAt("/jobs");
    expect(html).not.toContain("sidebar__marker");
    expect(html).not.toContain("data-marker");
    expect(linkTo(html, "/jobs")).toContain('class="sidebar__link is-active"');
  });
});

describe("measureMarker", () => {
  const rect = (top: number, height: number) => ({ top, height }) as DOMRect;
  const navAt = (top: number, row: unknown) =>
    ({
      getBoundingClientRect: () => rect(top, 400),
      querySelector: (selector: string) => {
        expect(selector).toBe(".sidebar__link.is-active");
        return row;
      },
    }) as unknown as HTMLElement;
  const rowAt = (top: number, height: number, rendered = true) => ({
    getBoundingClientRect: () => rect(top, height),
    getClientRects: () => ({ length: rendered ? 1 : 0 }),
  });

  it("is the active row's offset from the nav's top, and its height", async () => {
    const { measureMarker } = await import("./nav");
    expect(measureMarker(navAt(100, rowAt(244, 36)))).toEqual({ top: 144, height: 36 });
  });

  it("follows the row's own height (a 44px touch row)", async () => {
    const { measureMarker } = await import("./nav");
    expect(measureMarker(navAt(0, rowAt(48, 44)))).toEqual({ top: 48, height: 44 });
  });

  it("is null with no active row, or with the row in a closed group (not rendered)", async () => {
    const { measureMarker } = await import("./nav");
    expect(measureMarker(navAt(0, null))).toBeNull();
    expect(measureMarker(navAt(0, rowAt(48, 36, false)))).toBeNull();
  });
});
