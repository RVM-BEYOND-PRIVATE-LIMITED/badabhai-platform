import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PageHeader } from "./page-header";
import { NAV } from "./nav-model";

/**
 * The ONE page header (owner ruling 2026-10-01): [back link, detail pages only] · title · one
 * sentence · actions, primary first · the filter row directly below.
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("PageHeader — structure", () => {
  it("a top-level page: title and description, no back link, no empty actions slot", () => {
    const out = html(<PageHeader title="Workers" description="Every registered worker." />);
    // The title block carries the sizing hook (`.page__heading`: grow from 18rem, keep its
    // min-content floor) — without the class the actions wrap under every long description.
    expect(out).toContain('<header class="page__head"><div class="page__heading"><h1 class="page__title">Workers</h1>');
    expect(out).toContain('<p class="page__sub">Every registered worker.</p>');
    expect(out).not.toContain("page__back");
    expect(out).not.toContain("backlink");
    expect(out).not.toContain("page__actions");
  });

  it("a detail page: the back link names the parent, points at it, and draws arrow-left", () => {
    const out = html(<PageHeader back={{ href: "/workers", label: "Workers" }} title="Ramesh" />);
    expect(out).toContain(
      '<p class="page__back"><a class="backlink" href="/workers"><i class="ph-fill ph-arrow-left" aria-hidden="true"></i><span>Workers</span></a></p>',
    );
    // The back link comes before the title, inside the header.
    expect(out.indexOf("page__back")).toBeLessThan(out.indexOf("page__title"));
    expect(out.indexOf("page__back")).toBeGreaterThan(out.indexOf('<header class="page__head">'));
  });

  it("no arrow CHARACTER stands in for the glyph", () => {
    const out = html(<PageHeader back={{ href: "/jobs", label: "Postings" }} title="Welder" />);
    expect(out).not.toContain("←");
    expect(out).not.toContain("&larr;");
  });

  it("an id title takes the id face; a name never does", () => {
    expect(html(<PageHeader title="5eeded00…" titleMono />)).toContain(
      '<h1 class="page__title mono">5eeded00…</h1>',
    );
    expect(html(<PageHeader title="Ramesh" />)).toContain('<h1 class="page__title">Ramesh</h1>');
  });

  it("renders the primary action FIRST, then the secondary ones — payer-web's order", () => {
    const out = html(
      <PageHeader
        title="Acme"
        secondaryActions={<a href="/t">View event timeline</a>}
        primaryAction={<button type="button">Suspend</button>}
      />,
    );
    const actions = out.slice(out.indexOf('<div class="page__actions">'));
    expect(actions.indexOf("Suspend")).toBeGreaterThan(-1);
    expect(actions.indexOf("Suspend")).toBeLessThan(actions.indexOf("View event timeline"));
  });

  it("renders the filter row directly BELOW the header, never inside it", () => {
    const out = html(
      <PageHeader title="Events" filters={<section className="panel">filter bar</section>} />,
    );
    const headerEnd = out.indexOf("</header>");
    expect(headerEnd).toBeGreaterThan(-1);
    expect(out.indexOf("filter bar")).toBeGreaterThan(headerEnd);
    expect(out.slice(headerEnd + "</header>".length).startsWith('<section class="panel">')).toBe(
      true,
    );
  });
});

/**
 * The fences. Every portal page renders its header through `PageHeader`, so one structure is a
 * property of the code rather than of a review — and a top-level page (one the sidebar opens)
 * never grows a back link, because the sidebar is its way back.
 */
const portalRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "(portal)");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function pageSources(): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === "page.tsx") {
        out.set(relative(portalRoot, full).replace(/\\/g, "/"), stripComments(readFileSync(full, "utf8")));
      }
    }
  })(portalRoot);
  return out;
}
const PAGES = pageSources();
/** `workers/[id]/page.tsx` → `/workers/[id]`; the dashboard's `page.tsx` → `/`. */
const routeOf = (file: string) => `/${file.replace(/\/?page\.tsx$/, "")}`;

/** The detectors, on their own inputs, before they are trusted with the tree. */
const hasInlineHeader = (code: string) => /className="page__head"/.test(code);
const hasBackProp = (code: string) => /\bback=\{/.test(code);

describe("header fences — the detectors catch what they must", () => {
  it("spot an inline header and a back prop, and nothing else", () => {
    expect(hasInlineHeader('<header className="page__head">')).toBe(true);
    expect(hasInlineHeader("<PageHeader title=\"x\" />")).toBe(false);
    expect(hasBackProp('<PageHeader back={{ href: "/x", label: "X" }} />')).toBe(true);
    expect(hasBackProp('<PageHeader title="Back to work" />')).toBe(false);
  });

  it("walk every portal page", () => {
    expect(PAGES.size).toBeGreaterThan(25);
    expect(PAGES.has("page.tsx")).toBe(true);
    expect(routeOf("workers/[id]/page.tsx")).toBe("/workers/[id]");
    expect(routeOf("page.tsx")).toBe("/");
  });
});

describe("header fences — the tree", () => {
  it("no portal page hand-builds a header: every one renders PageHeader (or a component that does)", () => {
    const inline = [...PAGES].filter(([, code]) => hasInlineHeader(code)).map(([f]) => f);
    expect(inline).toEqual([]);
  });

  it("no top-level page (a sidebar destination) has a back link", () => {
    const topLevel = new Set(NAV.flatMap((s) => s.items).map((i) => i.href));
    const offenders = [...PAGES]
      .filter(([file, code]) => topLevel.has(routeOf(file)) && hasBackProp(code))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
    // …and the check really looked at the top-level pages.
    const checked = [...PAGES.keys()].filter((f) => topLevel.has(routeOf(f)));
    expect(checked.length).toBe(topLevel.size);
  });
  /**
   * The topbar crumb names a section WITHOUT linking it on a page directly below it, because that
   * page's back link is the link to the list (sweep AW-16: one target, one link). That is only
   * sound while every such page has a back link — so each `/<section>/[param]` page declares one:
   * a `back` prop, a header object's `back`, or the shared customer route that builds it.
   */
  it("every page directly below a section declares a back link — the crumb leaves it unlinked", () => {
    const sections = new Set(NAV.flatMap((s) => s.items).map((i) => i.href));
    const firstLevel = [...PAGES].filter(([file]) => {
      const route = routeOf(file);
      const cut = route.lastIndexOf("/");
      return sections.has(route.slice(0, cut)) && /^\[[^\]]+\]$/.test(route.slice(cut + 1));
    });
    const declaresBack = (code: string) =>
      hasBackProp(code) || /\bback:\s*\{/.test(code) || code.includes("<PayerDetailRoute");
    expect(firstLevel.filter(([, code]) => !declaresBack(code)).map(([f]) => f)).toEqual([]);
    // …and it really found the seven detail routes the sweep measured.
    expect(firstLevel.map(([f]) => routeOf(f)).sort()).toEqual([
      "/agencies/[id]",
      "/ai-calls/[id]",
      "/companies/[id]",
      "/events/[id]",
      "/jobs/[id]",
      "/skills/discovery/[id]",
      "/workers/[id]",
    ]);
  });
});
