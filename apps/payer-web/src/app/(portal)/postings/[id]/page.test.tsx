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

async function page(status = "open"): Promise<string> {
  getPostingDetail.mockResolvedValueOnce({ ...DETAIL, summary: { ...DETAIL.summary, status } });
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

/**
 * F03 (final sweep) — at 1280x720 the card ended at y=749: the head's actions wrapped under a long
 * description and pushed the whole layout (card included) down a row. The head now LEADS the
 * details column, so the card rail starts at the top of the page whatever the title, the
 * description or the actions measure. Layout itself is pinned in job-card-preview.css.test.ts.
 */
describe("PostingDetailPage — the card rail starts at the top of the page (F03)", () => {
  /** Where each landmark of the page starts in the markup (-1 when absent). */
  const at = (out: string) => ({
    grid: out.indexOf('<div class="posting-layout posting-layout--detail">'),
    head: out.indexOf('<div class="posting-layout__head">'),
    h1: out.indexOf('<h1 class="page-head__title">'),
    alert: out.indexOf('<div class="alert alert--info">'),
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

  it("a draft's note sits in the head, above the details — not above the card", async () => {
    const i = at(await page("draft"));
    expect(i.alert).toBeGreaterThan(i.h1);
    expect(i.alert).toBeLessThan(i.details);
    expect(i.head).toBeGreaterThan(i.grid);
  });
});

describe("PostingDetailPage — Reached N workers (post-publish confirmation)", () => {
  async function landed(reached: string | undefined, status = "open"): Promise<string> {
    getPostingDetail.mockResolvedValueOnce({ ...DETAIL, summary: { ...DETAIL.summary, status } });
    const el = (await PostingDetailPage({
      params: Promise.resolve({ id: ID }),
      searchParams: Promise.resolve(reached === undefined ? {} : { reached }),
    })) as ReactElement;
    return renderToStaticMarkup(el);
  }

  it("a publish landing with ?reached=N confirms the real count", async () => {
    const out = await landed("23");
    expect(out).toContain("Posting published");
    expect(out).toContain("Reached 23 workers");
  });

  it("no param, a malformed one, or a posting that is not live → no count at all", async () => {
    expect(await landed(undefined)).not.toContain("Reached");
    expect(await landed("lots")).not.toContain("Reached");
    expect(await landed("23", "draft")).not.toContain("Reached");
  });

  it("the notice sits in the head, under the title and above the details — never above the card rail (F03)", async () => {
    // In the head column it adds height to the details column only, so on a laptop the card
    // still starts at the top of the page; on a phone it follows the title, before the card.
    const out = await landed("23");
    const notice = out.indexOf('<div class="alert alert--success" role="status">');
    expect(notice).toBeGreaterThan(out.indexOf('<div class="posting-layout__head">'));
    expect(notice).toBeGreaterThan(out.indexOf('<h1 class="page-head__title">'));
    expect(notice).toBeLessThan(out.indexOf('<section class="panel">'));
    expect(out.indexOf('<div class="posting-layout posting-layout--detail">')).toBe(0);
  });
});
