import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NarrowQueueItem } from "../../../../../lib/campus-narrow";
import type { NarrowLevels } from "../../../../../lib/campus-narrow-view";

/**
 * #3050 — the queue as an operator reads it: job title, company, the Campus role text, when it
 * was posted, and one "Set trade" action. The server sends the rows oldest first and the table
 * does not reorder them.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  readNarrowDescriptionAction: vi.fn(),
  narrowTradeAction: vi.fn(),
}));

const { CampusNarrowTable } = await import("./campus-narrow-table");

const LEVELS: NarrowLevels = {
  cnc_turner: [{ value: "operator", label: "Operator" }],
  vmc_milling: [],
  cnc_grinding: [],
  sheet_metal_worker: [],
  press_operator: [],
  injection_moulding_operator: [],
};

const row = (over: Partial<NarrowQueueItem>): NarrowQueueItem => ({
  posting_id: "00000000-0000-4000-8000-000000000000",
  company_id: "11111111-1111-4111-8111-111111111111",
  company_label: "Acme Works",
  title: "Machine Operator",
  campus_role_text: "Machine Operator",
  origin: "campus_posted",
  posted_at: "2026-11-01T10:00:00.000Z",
  ...over,
});

const THREE = [
  row({
    posting_id: "00000000-0000-4000-8000-000000000001",
    company_label: "First Works",
    title: "CNC Operator",
    campus_role_text: "CNC Operator",
    posted_at: "2026-11-01T10:00:00.000Z",
  }),
  row({
    posting_id: "00000000-0000-4000-8000-000000000002",
    company_label: "Second Works",
    title: "Machine Operator",
    campus_role_text: "Machine Operator",
    posted_at: "2026-11-02T10:00:00.000Z",
  }),
  row({
    posting_id: "00000000-0000-4000-8000-000000000003",
    company_label: "Third Works",
    title: "Lathe Operator",
    campus_role_text: "Lathe Operator",
    posted_at: "2026-11-03T10:00:00.000Z",
  }),
];

const render = (postings: NarrowQueueItem[] = THREE) =>
  renderToStaticMarkup(<CampusNarrowTable postings={postings} levels={LEVELS} />);

describe("the Campus narrow queue", () => {
  it("draws every queued job with its title, company, Campus role, date and one action", () => {
    const html = render();
    expect(html.match(/Set trade/g)).toHaveLength(3);
    for (const job of THREE) {
      expect(html).toContain(job.title);
      expect(html).toContain(job.company_label);
      expect(html).toContain(job.campus_role_text);
    }
    expect(html).toContain("1 Nov 2026");
    expect(html).toContain("2 Nov 2026");
    expect(html).toContain("3 Nov 2026");
    expect(html).toContain('href="/jobs/00000000-0000-4000-8000-000000000001"');
    expect(html).toContain('href="/companies/11111111-1111-4111-8111-111111111111"');
  });

  it("keeps the server's oldest-first order", () => {
    const html = render();
    const first = html.indexOf("CNC Operator");
    const second = html.indexOf("Machine Operator");
    const third = html.indexOf("Lathe Operator");
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it("an empty queue draws no rows", () => {
    const html = render([]);
    expect(html).not.toContain("Set trade");
    expect(html).toContain("<tbody></tbody>");
  });
});
