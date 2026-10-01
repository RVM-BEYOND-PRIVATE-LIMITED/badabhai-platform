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
