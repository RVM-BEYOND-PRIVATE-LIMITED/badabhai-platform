import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Agency job detail — owner naming ruling (labels only): the facts panel is "Posting details" and
 * the card beside it is labelled for what it is, a preview of the WORKER's card.
 */

const getAgencyJob = vi.fn();
vi.mock("../../../../../lib/payer-api", () => ({ getAgencyJob: (id: string) => getAgencyJob(id) }));
vi.mock("../../../../../lib/auth/roles", () => ({ requireAgent: async () => ({ payerId: "a" }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/link", () => ({
  // The pending cue inside each link reads its status (components/nav-pending.tsx): idle.
  useLinkStatus: () => ({ pending: false }),
  default: ({ children }: { children: ReactNode }) => children,
}));

const { default: AgencyJobDetailPage } = await import("./page");

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const JOB = {
  id: JOB_ID,
  title: "CNC Operator",
  roleKind: "cnc_turner",
  tradeKey: "cnc_operator",
  status: "open",
  city: "Pune",
  area: "Chakan",
  payMin: 18000,
  payMax: 26000,
  payType: "in_hand",
  minExperienceYears: 1,
  maxExperienceYears: 5,
  shift: "day",
  neededBy: "soon",
  requirements: [],
  benefits: [],
  description: null,
  applicantsReceived: 3,
  createdAt: "2026-09-28T10:00:00.000Z",
};

async function page(): Promise<string> {
  getAgencyJob.mockResolvedValueOnce(JOB);
  const el = (await AgencyJobDetailPage({ params: Promise.resolve({ jobId: JOB_ID }) })) as ReactElement;
  return renderToStaticMarkup(el);
}

describe("AgencyJobDetailPage — Posting naming", () => {
  it("the facts panel is 'Posting details' (never 'Vacancy details')", async () => {
    const out = await page();
    expect(out).toContain('<h2 class="panel__title">Posting details</h2>');
    expect(out).not.toContain("Vacancy details");
  });

  it("the card beside it is labelled as the worker card preview (not 'Job card')", async () => {
    const out = await page();
    expect(out).toContain('<aside class="posting-preview" aria-label="Worker card preview">');
    expect(out).not.toContain('aria-label="Job card"');
  });
});

/**
 * R1 (final re-sweep) — at 1280x720 the agency card sat at 277-801 (long data 303-827): the head
 * stood ABOVE the layout, and once "Edit posting" joined "Applicants" its actions wrapped to a
 * second row and pushed the whole layout, card included, down. The company detail fixed the same
 * thing in #2037 (F03); this page now has its structure: the head LEADS the details column, so the
 * card rail starts at the top of the page. Layout itself is pinned in job-card-preview.css.test.ts.
 */
describe("AgencyJobDetailPage — the card rail starts at the top of the page (R1)", () => {
  /** Where each landmark of the page starts in the markup (-1 when absent). */
  const at = (out: string) => ({
    grid: out.indexOf('<div class="posting-layout posting-layout--detail">'),
    head: out.indexOf('<div class="posting-layout__head">'),
    h1: out.indexOf('<h1 class="page-head__title">'),
    // The action group (status · Applicants · Edit posting) — the actions that wrapped (R1).
    actions: out.indexOf('<div class="page-head__actions">'),
    details: out.indexOf('<section class="panel">'),
    card: out.indexOf('<aside class="posting-preview"'),
  });

  it("ONE grid holds the head, the details and the card — the head first, the card last", async () => {
    const i = at(await page());
    expect(i.grid).toBe(0);
    expect(i.head).toBeGreaterThan(i.grid);
    expect(i.h1).toBeGreaterThan(i.head);
    expect(i.details).toBeGreaterThan(i.h1);
    expect(i.card).toBeGreaterThan(i.details);
  });

  it("the head's actions sit in the head column (above the details), never above the grid", async () => {
    const i = at(await page());
    // The head column exists (inside the grid, which opens the page) and holds the action group.
    expect(i.head, "the head column").toBeGreaterThan(0);
    expect(i.actions).toBeGreaterThan(i.head);
    expect(i.actions).toBeLessThan(i.details);
  });
});
