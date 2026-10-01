import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Posting detail — owner naming ruling (labels only): the headcount is "Openings", and the card
 * beside the facts is labelled for what it is, a preview of the WORKER's card.
 */

const getPostingDetail = vi.fn();
vi.mock("../../../../lib/payer-api", () => ({
  getPostingDetail: (id: string) => getPostingDetail(id),
}));
vi.mock("../../../../lib/auth", () => ({ requirePayer: async () => ({ payerId: "p" }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

const { default: PostingDetailPage } = await import("./page");

const ID = "11111111-1111-4111-8111-111111111111";
const DETAIL = {
  summary: {
    id: ID,
    roleTitle: "CNC Turner",
    locationLabel: null,
    vacancyBand: "2-5",
    status: "open",
    applicantCount: 4,
    applicantQuota: 20,
    createdAt: "2026-09-28T10:00:00.000Z",
  },
  card: {
    role_title: "CNC Turner",
    role_kind: "cnc_turner",
    city: "Pune",
    area: "Chakan",
    pay_min: 18000,
    pay_max: 26000,
    pay_type: "in_hand",
    min_experience_years: 1,
    max_experience_years: 5,
    shift: "day",
    needed_by: "soon",
    requirements: [],
    benefits: [],
  },
  description: null,
  skills: [],
  matchSkillIds: [],
  untickedRelatedIds: [],
  updatedAt: "2026-09-29T10:00:00.000Z",
};

async function page(): Promise<string> {
  getPostingDetail.mockResolvedValueOnce(DETAIL);
  const el = (await PostingDetailPage({ params: Promise.resolve({ id: ID }) })) as ReactElement;
  return renderToStaticMarkup(el);
}

describe("PostingDetailPage — Posting naming", () => {
  it("the headcount row is 'Openings' (never 'Vacancies')", async () => {
    const out = await page();
    expect(out).toContain('<dt class="kv__k">Openings</dt><dd class="kv__v bb-mono">2-5</dd>');
    expect(out).not.toContain(">Vacancies<");
  });

  it("the card beside the facts is labelled as the worker card preview (not 'Job card')", async () => {
    const out = await page();
    expect(out).toContain('<aside class="posting-preview" aria-label="Worker card preview">');
    expect(out).not.toContain('aria-label="Job card"');
  });
});
