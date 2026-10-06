import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PageHeader } from "./page-header";
import { NAV } from "./nav-model";
import { CUSTOMER_SECTION_HREF } from "../lib/customer";

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
   * sound while every such page — `/<section>/[param]` or a static `/<section>/<view>` — has a
   * back link TO THAT SECTION. Read from the AST: every `href` in a `back` the page writes (a
   * prop, or a header object's property), or, for the two pages that delegate to the shared
   * customer route, the section that route resolves their `kind` to.
   */
  it("every page directly below a section links back to exactly that section", () => {
    const pages = firstLevelPages();
    const wrong = pages
      .map(([file, code, section]) => ({ file, section, hrefs: declaredBackHrefs(file, code) }))
      .filter(({ section, hrefs }) => hrefs.length === 0 || hrefs.some((h) => h !== section))
      .map(({ file, section, hrefs }) => `${file}: back ${JSON.stringify(hrefs)}, section ${section}`);
    expect(wrong).toEqual([]);
    // …and it really looked at the seven detail routes the sweep measured (and any page that
    // joins them later, static or dynamic, is checked the same way).
    expect(pages.map(([f]) => routeOf(f))).toEqual(
      expect.arrayContaining([
        "/agencies/[id]",
        "/ai-calls/[id]",
        "/companies/[id]",
        "/events/[id]",
        "/jobs/[id]",
        "/skills/discovery/[id]",
        "/workers/[id]",
      ]),
    );
  });
});

/** The sidebar destinations — the sections a crumb can name. */
const SECTIONS = new Set(NAV.flatMap((s) => s.items).map((i) => i.href));

/** The section a route sits one segment below, or null — static views and `[param]` alike. */
function sectionAbove(route: string): string | null {
  const section = route.slice(0, route.lastIndexOf("/"));
  return route !== "/" && !SECTIONS.has(route) && SECTIONS.has(section) ? section : null;
}

/** Every page exactly one segment below a section (and not a sidebar destination itself). */
function firstLevelPages(): [file: string, code: string, section: string][] {
  const out: [string, string, string][] = [];
  for (const [file, code] of PAGES) {
    const section = sectionAbove(routeOf(file));
    if (section) out.push([file, code, section]);
  }
  return out;
}

/**
 * Every href a page declares for its back link: the `href` of each object literal inside a `back`
 * JSX attribute or a `back:` property, whatever wraps it (a ternary included). A non-literal href
 * reads as `<expression>`, which matches no section. A page that renders `<PayerDetailRoute
 * kind="…" />` declares the section that kind resolves to — the route's own mapping, pinned by
 * `payer-detail-route.render.test.tsx`.
 */
function declaredBackHrefs(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const hrefsIn = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "href") {
          out.push(ts.isStringLiteral(p.initializer) ? p.initializer.text : `<${p.initializer.getText(sf)}>`);
        }
      }
    }
    ts.forEachChild(node, hrefsIn);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "back" && node.initializer) {
      hrefsIn(node.initializer);
    } else if (ts.isPropertyAssignment(node) && node.name.getText(sf) === "back") {
      hrefsIn(node.initializer);
    } else if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(sf) === "PayerDetailRoute"
    ) {
      const kind = node.attributes.properties.find(
        (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "kind",
      )?.initializer;
      const value = kind && ts.isStringLiteral(kind) ? kind.text : "";
      out.push(Object.hasOwn(CUSTOMER_SECTION_HREF, value)
        ? CUSTOMER_SECTION_HREF[value as keyof typeof CUSTOMER_SECTION_HREF]
        : `<kind ${value}>`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("header fences — the back-link reader", () => {
  const read = (src: string) => declaredBackHrefs("t.tsx", src);

  it("reads a back prop, a header object's back, and one inside a ternary", () => {
    expect(read('<PageHeader back={{ href: "/events", label: "Events" }} />')).toEqual(["/events"]);
    expect(read('const header = { back: { href: "/workers", label: "Workers" }, title: t };')).toEqual([
      "/workers",
    ]);
    expect(read('<PageHeader back={b ? { href: "/ai-calls", label: "AI calls" } : undefined} />')).toEqual([
      "/ai-calls",
    ]);
  });

  it("reports a computed href as an expression, never as a section", () => {
    expect(read("<PageHeader back={{ href: `/workers/${id}`, label: l }} />")).toEqual([
      "<`/workers/${id}`>",
    ]);
  });

  it("ignores hrefs that are not the back link, and a back that is not an object", () => {
    expect(read('<Link href="/jobs">Jobs</Link>')).toEqual([]);
    expect(read("<Frame back={false} />")).toEqual([]);
  });

  it("resolves the customer route's kind to its section", () => {
    expect(read('<PayerDetailRoute id={id} kind="Company" />')).toEqual(["/companies"]);
    expect(read('<PayerDetailRoute id={id} kind="Agency" />')).toEqual(["/agencies"]);
    expect(read('<PayerDetailRoute id={id} kind="Reseller" />')).toEqual(["<kind Reseller>"]);
  });

  it("finds static first-level children as well as [param] ones", () => {
    // A static view one segment below a section is held to the same rule as a record page.
    expect(sectionAbove("/workers/[id]")).toBe("/workers");
    expect(sectionAbove("/workers/export")).toBe("/workers");
    expect(sectionAbove("/skills/discovery/[id]")).toBe("/skills/discovery");
    expect(sectionAbove("/workers")).toBeNull();
    expect(sectionAbove("/workers/[id]/journey")).toBeNull();
    expect(sectionAbove("/")).toBeNull();
  });
});
