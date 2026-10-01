import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { navSections } from "./nav-model";

/**
 * The header trail is SECTION context (header model 2026-10-01): the rail group, and on a page
 * below a nav destination that destination as a LINK back up. It never names the current page
 * (the page's H1 does) — so it can never repeat the H1, never marks a list "current" on a detail
 * page, and never invents a label no nav uses ("Portal") or renders a path segment ("New").
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

function crumb(path: string, sections = COMPANY): string {
  pathname = path;
  const tree = PortalBreadcrumb({ sections }) as ReactElement | null;
  return tree ? renderToStaticMarkup(tree) : "";
}
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const links = (html: string) =>
  [...html.matchAll(/<a href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], words(m[2]!)]);

beforeEach(() => {
  pathname = "/dashboard";
});

describe("the trail on a top-level page — the group only (the H1 names the page)", () => {
  it.each([
    ["/postings", "Hiring", "Postings"],
    ["/postings/new", "Hiring", "New posting"],
    ["/plans", "Billing", "Plans & capacity"],
    ["/credits", "Billing", "Credits"],
    ["/team", "Organisation", "Team"],
  ])("%s → '%s' (never the page's own name, %s)", (path, group, page) => {
    const out = crumb(path);
    expect(words(out)).toBe(group);
    expect(words(out)).not.toContain(page);
    expect(links(out)).toEqual([]);
  });

  it("the dashboard (no group) and pages no nav item owns render NO trail — never 'Portal'", () => {
    for (const path of ["/dashboard", "/account", "/agency/bulk-upload", "/nowhere"]) {
      expect(crumb(path), path).toBe("");
    }
    // /team/accept: an owner's Team is in the nav; a recruiter's is not.
    expect(crumb("/team/accept", RECRUITER)).toBe("");
  });
});

describe("the trail on a page below a destination — the section, as a link back up", () => {
  it.each([
    ["/postings/0b9f6e2a-1111-4111-8111-111111111111", "/postings", "Postings"],
    ["/postings/0b9f6e2a-1111-4111-8111-111111111111/applicants", "/postings", "Postings"],
    ["/postings/0b9f6e2a-1111-4111-8111-111111111111/edit", "/postings", "Postings"],
    ["/postings/ai/new", "/postings/new", "New posting"],
    ["/capacity", "/plans", "Plans & capacity"],
    ["/team/accept", "/team", "Team"],
  ])("%s → links %s ('%s')", (path, href, label) => {
    const out = crumb(path);
    expect(links(out)).toEqual([[href, label.replace("&", "&amp;")]]);
    // No id, no path word ("Applicants", "Edit", "New", "AI assistant"), no "current" claim.
    expect(words(out)).not.toMatch(/[0-9a-f]{8}-|Applicants|Edit\b|\bNew\b(?! posting)|AI assistant/);
    expect(out).not.toContain("aria-current");
  });

  it("the agency's postings: detail and applicants link Demand › Postings (/agency/jobs)", () => {
    const job = "/agency/jobs/0b9f6e2a-1111-4111-8111-111111111111";
    for (const path of [job, `${job}/applicants`]) {
      const out = crumb(path, AGENCY);
      expect(words(out)).toBe("Demand Postings");
      expect(links(out)).toEqual([["/agency/jobs", "Postings"]]);
    }
    expect(words(crumb("/agency/jobs", AGENCY))).toBe("Demand");
    expect(words(crumb("/agency/jobs/new", AGENCY))).toBe("Demand");
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
