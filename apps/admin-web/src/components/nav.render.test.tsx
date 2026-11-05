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
    const other = out.slice(
      out.indexOf('href="/candidates"') - 40,
      out.indexOf("Candidates</span>"),
    );
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
    const toggles = [
      ...html.matchAll(
        /<h2 class="sidebar__grouptitle"><button type="button" class="sidebar__grouptoggle" aria-expanded="true" aria-controls="([^"]+)">/g,
      ),
    ];
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
  /** A box in the offset-parent chain: its layout offset, its top border, its offset parent. */
  type Box = { offsetTop: number; clientTop: number; offsetParent: Box | null };
  const box = (offsetTop: number, offsetParent: Box | null, clientTop = 0): Box => ({
    offsetTop,
    clientTop,
    offsetParent,
  });
  /** The nav (drawn `offsetTop` px down the page), holding `row` — its active link — inside. */
  const navWith = (row: unknown, nav: Box = box(100, null)) =>
    Object.assign(nav, {
      getBoundingClientRect: () => ({ top: nav.offsetTop, height: 400 }) as DOMRect,
      querySelector: (selector: string) => {
        expect(selector).toBe(".sidebar__link.is-active");
        return row;
      },
    }) as unknown as HTMLElement;
  /**
   * The active link inside its positioned `li` (the link's offset parent); `drawnAt` is where it
   * is PAINTED — its client rect, which a transform moves and the layout offsets do not.
   * `closing`: its list is `hidden` already, but still laid out while its exit plays.
   */
  const rowIn = (li: Box, height: number, drawnAt = 0, rendered = true, closing = false) => ({
    ...box(0, li),
    offsetHeight: height,
    closest: (selector: string) => (selector === "[hidden]" && closing ? {} : null),
    getClientRects: () => ({ length: rendered ? 1 : 0 }),
    getBoundingClientRect: () => ({ top: drawnAt, height }) as DOMRect,
  });

  it("is the active row's layout offset in the nav, and its height", async () => {
    const { measureMarker } = await import("./nav");
    const nav = box(100, null);
    expect(measureMarker(navWith(rowIn(box(144, nav), 36), nav))).toEqual({
      top: 144,
      height: 36,
    });
  });

  it("is where the row SETTLES while its group is still sliding open, not where it is drawn", async () => {
    // Re-opening the active row's own group: its list runs nav-group-in from 6px up. Mid-slide the
    // browser makes the transformed list the li's offset parent, and the row is DRAWN 6px short
    // (100 + 128 on the page) — a client-rect reading parked the marker there for good.
    const { measureMarker } = await import("./nav");
    const nav = box(100, null);
    const list = box(98, nav);
    const li = box(36, list);
    expect(measureMarker(navWith(rowIn(li, 36, 100 + 128), nav))).toEqual({
      top: 134,
      height: 36,
    });
  });

  it("counts every positioned box's border on the way up — an offset ends at a padding edge", async () => {
    const { measureMarker } = await import("./nav");
    const nav = box(100, null);
    const li = box(140, nav, 2);
    expect(measureMarker(navWith(rowIn(li, 36), nav))).toEqual({ top: 142, height: 36 });
  });

  it("follows the row's own height (a 44px touch row)", async () => {
    const { measureMarker } = await import("./nav");
    const nav = box(0, null);
    expect(measureMarker(navWith(rowIn(box(48, nav), 44), nav))).toEqual({ top: 48, height: 44 });
  });

  it("is null with no active row, or with the row in a closed group (not rendered)", async () => {
    const { measureMarker } = await import("./nav");
    const nav = box(0, null);
    expect(measureMarker(navWith(null, nav))).toBeNull();
    expect(measureMarker(navWith(rowIn(box(48, nav), 36, 0, false), nav))).toBeNull();
  });

  it("is null while the row's group is CLOSING — hidden at once, though laid out until it has gone", async () => {
    // The exit holds the list's box (a discrete `display` transition) while its rows fade; the
    // row's own wash fades with them, instead of the marker lingering where the row was.
    const { measureMarker } = await import("./nav");
    const nav = box(0, null);
    expect(measureMarker(navWith(rowIn(box(48, nav), 36, 48, true, true), nav))).toBeNull();
  });

  it("is null when the chain never reaches the nav (no stylesheet: nothing is positioned)", async () => {
    const { measureMarker } = await import("./nav");
    const body = box(0, null);
    expect(measureMarker(navWith(rowIn(box(48, body), 36)))).toBeNull();
  });
});
