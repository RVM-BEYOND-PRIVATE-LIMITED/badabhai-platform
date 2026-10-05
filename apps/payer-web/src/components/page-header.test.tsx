import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PageHeader, type PageHeaderProps } from "./page-header";

/**
 * PageHeader — the ONE header structure every portal page renders (owner ruling 2026-10-01):
 *   [back (child pages only)] · H1 + one-sentence description | status · ONE primary · secondaries
 *   · [toolbar row].
 * Rendered through React's real server renderer (node env) so the assertions are on markup: the
 * classes the shared CSS keys on, the order inside the action group, icon + text on every
 * action, and the md control size (the DS tap floor) for the head's actions.
 */

vi.mock("next/link", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  return {
    default: ({
      children,
      href,
      className,
    }: {
      children: ReactNode;
      href: string;
      className?: string;
    }) => React.createElement("a", { href, className }, children),
  };
});

const html = (props: PageHeaderProps) => renderToStaticMarkup(PageHeader(props) as ReactElement);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PageHeader — markup", () => {
  it("a top-level page: no back link, the H1 and its one-line description", () => {
    const out = html({ title: "Postings", description: "Every posting you have opened." });
    expect(out).not.toContain("page-back");
    expect(out).toBe(
      '<div class="page-head"><div class="page-head__text"><h1 class="page-head__title">Postings</h1>' +
        '<p class="page-head__sub">Every posting you have opened.</p></div></div>',
    );
  });

  it("a child page: the back link comes FIRST — an arrow-left icon + the parent's name", () => {
    const out = html({ title: "Applicants", back: { href: "/postings/p1", label: "Posting details" } });
    expect(out.startsWith('<p class="page-back"><a href="/postings/p1">')).toBe(true);
    expect(out).toContain(
      '<a href="/postings/p1"><i class="ph-fill ph-arrow-left" aria-hidden="true"></i><span>Posting details</span></a>',
    );
    // No glyph arrow anywhere (icons only).
    expect(out).not.toMatch(/[←→]/);
    expect(out.indexOf("page-back")).toBeLessThan(out.indexOf("page-head__title"));
  });

  it("actions: status first, then the ONE primary, then the secondaries — each icon + text, md size", () => {
    const out = html({
      title: "CNC Turner",
      status: <span className="status-marker">open</span>,
      primaryAction: { href: "/a", label: "View applicants", icon: "users-three" },
      secondaryActions: [{ href: "/b", label: "Edit posting", icon: "pencil-simple" }],
    });
    const actions = out.slice(out.indexOf('<div class="page-head__actions">'));
    const order = ["status-marker", 'href="/a"', 'href="/b"'].map((n) => actions.indexOf(n));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(actions).toContain(
      '<a href="/a" class="bb-btn bb-btn--primary"><i class="ph-fill ph-users-three" aria-hidden="true"></i><span>View applicants</span></a>',
    );
    expect(actions).toContain(
      '<a href="/b" class="bb-btn bb-btn--secondary"><i class="ph-fill ph-pencil-simple" aria-hidden="true"></i><span>Edit posting</span></a>',
    );
    // The head's actions are md controls (44px): a primary at sm is below the DS tap floor.
    expect(actions).not.toContain("bb-btn--sm");
    // Exactly one primary.
    expect(actions.match(/bb-btn--primary/g)).toHaveLength(1);
  });

  it("no action group at all when there is nothing to put in it", () => {
    expect(html({ title: "Team" })).not.toContain("page-head__actions");
  });

  it("the toolbar is its own row INSIDE the head, after the actions", () => {
    const out = html({
      title: "Applicants",
      primaryAction: { href: "/a", label: "A", icon: "plus" },
      toolbar: <span className="tb">filters</span>,
    });
    expect(out).toContain('<div class="page-head__toolbar"><span class="tb">filters</span></div></div>');
    expect(out.indexOf("page-head__actions")).toBeLessThan(out.indexOf("page-head__toolbar"));
  });

  it("an extra class rides on .page-head (the QR page's print hook)", () => {
    expect(html({ title: "QR invite", className: "dash-sub" })).toMatch(
      /^<div class="page-head dash-sub">/,
    );
  });
});

describe("PageHeader — one destination is one action (dev guard)", () => {
  it("warns when two header actions open the same page", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    html({
      title: "Draft",
      primaryAction: { href: "/postings/p1/edit", label: "Finish and publish", icon: "rocket-launch" },
      secondaryActions: [{ href: "/postings/p1/edit", label: "Edit posting", icon: "pencil-simple" }],
    });
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain('two header actions open "/postings/p1/edit"');
  });

  it("stays silent for distinct destinations (the guard permits what it must)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    html({
      title: "Live",
      primaryAction: { href: "/postings/p1/applicants", label: "View applicants", icon: "users-three" },
      secondaryActions: [{ href: "/postings/p1/edit", label: "Edit posting", icon: "pencil-simple" }],
    });
    html({ title: "Only status", status: <span>open</span> });
    expect(err).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------------------------ *
 * Every portal page renders its header through PageHeader, with a one-sentence description.
 * ------------------------------------------------------------------------------------------ */
const PORTAL = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "(portal)");

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return pageFiles(full);
    return e.name === "page.tsx" ? [full] : [];
  });
}
const rel = (f: string) => f.slice(PORTAL.length + 1).split("\\").join("/");

/** Pages that render nothing of their own: a server redirect to another route. */
const REDIRECT_ONLY = new Set([
  "profile/page.tsx",
  "agency/dashboard/page.tsx",
  // Hiring capacity is a section of Plans & capacity (2026-10-01).
  "capacity/page.tsx",
]);

/**
 * Every string literal inside each `description=` attribute value of a source — and inside each
 * `description:` property value (a header handed to a component as an object: the applicants
 * page builds its head once for both of its branches).
 */
function descriptionLiterals(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf("description="); at >= 0; at = src.indexOf("description=", at + 1)) {
    let i = at + "description=".length;
    let value = "";
    if (src[i] === '"') {
      value = src.slice(i, src.indexOf('"', i + 1) + 1);
    } else if (src[i] === "{") {
      let depth = 0;
      for (; i < src.length; i += 1) {
        if (src[i] === "{") depth += 1;
        else if (src[i] === "}") depth -= 1;
        value += src[i];
        if (depth === 0) break;
      }
    }
    for (const m of value.matchAll(/"([^"]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? "");
  }
  for (let at = src.indexOf("description:"); at >= 0; at = src.indexOf("description:", at + 1)) {
    // The property's value runs to the first `,` / `;` / `}` outside a string literal.
    let value = "";
    let quote: string | null = null;
    for (let i = at + "description:".length; i < src.length; i += 1) {
      const c = src[i]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "`") {
        quote = c;
      } else if (c === "," || c === ";" || c === "}") {
        break;
      }
      value += c;
    }
    for (const m of value.matchAll(/"([^"]*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? "");
  }
  return out;
}

/** More than one sentence: a terminator followed by a new capitalised sentence. */
const multiSentence = (s: string) => /[.!?]\s+[A-Z]/.test(s);

describe("every portal page uses PageHeader", () => {
  const pages = pageFiles(PORTAL);

  it("finds the portal pages (the scan is not vacuous)", () => {
    expect(pages.length).toBeGreaterThanOrEqual(22);
  });

  it("each page renders <PageHeader>, except the pure redirects", () => {
    const missing = pages
      .map((f) => [rel(f), readFileSync(f, "utf8")] as const)
      .filter(([r]) => !REDIRECT_ONLY.has(r))
      .filter(([, src]) => !src.includes("<PageHeader"))
      .map(([r]) => r);
    expect(missing).toEqual([]);
    // …and the redirect-only ones really are just a redirect.
    for (const r of REDIRECT_ONLY) {
      const src = readFileSync(join(PORTAL, r), "utf8");
      expect(src, r).toMatch(/redirect\(/);
      expect(src, r).not.toMatch(/<[a-z]/);
    }
  });

  it("every literal description is ONE sentence", () => {
    const sources = pages.map((f) => [rel(f), readFileSync(f, "utf8")] as const);
    const literals = sources.flatMap(([r, src]) => descriptionLiterals(src).map((d) => [r, d]));
    expect(literals.length).toBeGreaterThanOrEqual(15);
    // The object-property form is scanned too (the applicants head: both of its descriptions).
    expect(
      literals.filter(
        ([r, d]) => r === "postings/[id]/applicants/page.tsx" && d!.startsWith("Everyone who"),
      ),
    ).toHaveLength(2);
    expect(literals.filter(([, d]) => multiSentence(d!))).toEqual([]);
    // The checker can fail.
    expect(multiSentence("Describe the role. Applicants appear faceless.")).toBe(true);
    expect(multiSentence("Describe the role — applicants appear faceless.")).toBe(false);
  });
});
