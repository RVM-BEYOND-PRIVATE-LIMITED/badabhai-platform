import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
