import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { navSections } from "./nav-model";

/**
 * The header trail is SECTION context (header model 2026-10-01): the rail group, and on a page
 * below a nav destination that destination. It never names the current page (the page's H1
 * does), never invents a label no nav uses ("Portal"), never renders a path segment ("New").
 *
 * ONE DOOR PER DESTINATION (D5): a page ONE level below a destination carries a back link to it,
 * so there the trail names it as TEXT; deeper pages keep it as a LINK; a trail with no link is
 * not a `<nav>` landmark. (The shell + page integration test checks the same rule against the
 * pages' real back links — crumb-back.test.tsx.)
 */

let pathname = "/dashboard";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
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

const { PortalBreadcrumb } = await import("./portal-breadcrumb");

const COMPANY = navSections({ isAgency: false, isOwner: true, agencyPortalEnabled: true });
const AGENCY = navSections({ isAgency: true, isOwner: true, agencyPortalEnabled: true });
const RECRUITER = navSections({ isAgency: false, isOwner: false, agencyPortalEnabled: true });
const ID = "0b9f6e2a-1111-4111-8111-111111111111";

function crumb(path: string, sections = COMPANY): string {
  pathname = path;
  const tree = PortalBreadcrumb({ sections }) as ReactElement | null;
  return tree ? renderToStaticMarkup(tree) : "";
}
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const links = (html: string) =>
  [...html.matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], words(m[2]!)]);
const isLandmark = (html: string) => html.startsWith('<nav class="pcrumb" aria-label="Breadcrumb">');

beforeEach(() => {
  pathname = "/dashboard";
});

describe("the trail on a top-level page — the group only (the H1 names the page)", () => {
  it.each([
    ["/postings", "Hiring", "Postings", COMPANY],
    ["/postings/new", "Hiring", "New posting", COMPANY],
    ["/plans", "Billing", "Plans & capacity", COMPANY],
    ["/credits", "Billing", "Credits", COMPANY],
    ["/team", "Organisation", "Team", COMPANY],
    // The agency's own posting surface sits in its Demand group.
    ["/agency/jobs", "Demand", "Postings", AGENCY],
    ["/agency/jobs/new", "Demand", "New posting", AGENCY],
  ] as const)("%s → '%s' (never the page's own name, %s), and not a landmark", (path, group, page, sections) => {
    const out = crumb(path, sections);
    expect(words(out)).toBe(group);
    expect(words(out)).not.toContain(page);
    expect(links(out)).toEqual([]);
    expect(isLandmark(out)).toBe(false);
    expect(out).toMatch(/^<div class="pcrumb">/);
  });

  it("the dashboard (no group) and pages no nav item owns render NO trail — never 'Portal'", () => {
    for (const path of ["/dashboard", "/account", "/agency/bulk-upload", "/nowhere"]) {
      expect(crumb(path), path).toBe("");
    }
    // /team/accept: an owner's Team is in the nav; a recruiter's is not.
    expect(crumb("/team/accept", RECRUITER)).toBe("");
  });
});

describe("one level below a destination whose pages link back to it — the GROUP only", () => {
  // F16 (final sweep): the trail printed the destination ("Hiring › Postings") right above a back
  // link naming it again ("← Postings"). The back link is the way up AND names the parent, so the
  // trail keeps only the group. Post with AI is a mode of New posting (its own way back is the
  // in-card "Use the manual form instead"), so it reads like New posting itself: the group.
  it.each([
    [`/postings/${ID}`, "Hiring", "Postings", COMPANY],
    ["/postings/ai/new", "Hiring", "New posting", COMPANY],
    [`/agency/jobs/${ID}`, "Demand", "Postings", AGENCY],
  ] as const)("%s → '%s' (never '%s' again), no link, no landmark", (path, group, parent, s) => {
    const out = crumb(path, s);
    expect(words(out)).toBe(group);
    expect(words(out)).not.toContain(parent);
    expect(links(out)).toEqual([]);
    expect(isLandmark(out)).toBe(false);
    expect(out).not.toContain("aria-current");
  });
});

describe("deeper pages, and children with no back link — the section as a LINK", () => {
  it.each([
    [`/postings/${ID}/applicants`, "/postings", "Postings"],
    [`/postings/${ID}/edit`, "/postings", "Postings"],
    ["/team/accept", "/team", "Team"],
  ])("%s → links %s ('%s'), inside a Breadcrumb landmark", (path, href, label) => {
    const out = crumb(path);
    expect(links(out)).toEqual([[href, label]]);
    expect(isLandmark(out)).toBe(true);
    // No id, no path word ("Applicants", "Edit", "New", "AI assistant"), no "current" claim.
    expect(words(out)).not.toMatch(/[0-9a-f]{8}-|Applicants|Edit\b|\bNew\b(?! posting)|AI assistant/);
    expect(out).not.toContain("aria-current");
  });
});

describe("the trail never repeats the page's H1 (every route the rail offers)", () => {
  for (const [name, sections] of [
    ["company", COMPANY],
    ["agency", AGENCY],
  ] as const) {
    it(`${name}: on each nav destination, the trail does not contain its label`, () => {
      for (const item of sections.flatMap((s) => s.items)) {
        expect(words(crumb(item.href, sections)), item.href).not.toContain(item.label);
      }
    });
  }
});
