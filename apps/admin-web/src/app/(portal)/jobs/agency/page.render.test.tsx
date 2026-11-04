import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the Agency postings list RENDERS (route `/jobs/agency`, was `/agency-jobs`
 * until A6 #2576): the gate, the way back to Postings, one row per posting with
 * its agency + skill count + a link to the posting, the empty state, and the
 * outage recovery (never a 500).
 */
const stub = vi.hoisted(() => ({
  gates: [] as string[],
  jobs: null as unknown[] | null,
  failure: null as unknown,
}));

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "super_admin", capabilities: ["manage_agency_match_skills"] };
  },
}));

vi.mock("../../../../lib/agency-jobs", () => ({
  listAgencyJobs: async () => {
    if (stub.failure) throw stub.failure;
    return stub.jobs;
  },
}));

const { default: AgencyPostingsPage } = await import("./page");

const JOB = {
  job_id: "11111111-1111-4111-8111-111111111111",
  payer_id: "22222222-2222-4222-8222-222222222222",
  title: "CNC Turner",
  city: "Ludhiana",
  status: "live",
  match_skill_ids: ["mskill_cnc_operate", "mskill_vmc_setting"],
  updated_at: "2026-10-01T10:00:00.000Z",
};

beforeEach(() => {
  stub.gates.length = 0;
  stub.jobs = [JOB];
  stub.failure = null;
});

const render = async () => renderToStaticMarkup(await AgencyPostingsPage());

describe("the gate", () => {
  it("is manage_agency_match_skills", async () => {
    await render();
    expect(stub.gates).toEqual(["manage_agency_match_skills"]);
  });
});

describe("the header", () => {
  it("is a view of Postings: titled Agency postings, with the back link to /jobs", async () => {
    const html = await render();
    expect(html).toContain('<h1 class="page__title">Agency postings</h1>');
    expect(html).toContain(
      '<p class="page__back"><a class="backlink" href="/jobs"><i class="ph-fill ph-arrow-left" aria-hidden="true"></i><span>Postings</span></a></p>',
    );
    expect(html).not.toContain("Agency match skills");
  });
});

describe("the table", () => {
  it("renders one row per job with agency, city, status, skill count and link", async () => {
    const html = await render();
    expect(html).toContain("CNC Turner");
    expect(html).toContain("Ludhiana");
    expect(html).toContain("Live");
    // The row opens the posting (its Overview tab), filed under Postings.
    expect(html).toContain('href="/jobs/agency/11111111-1111-4111-8111-111111111111"');
    expect(html).not.toContain("/agency-jobs");
    // The skill COUNT, not the ids (ids live on the detail screen).
    expect(html).toContain(">2<");
    // Agency persona is stated beside the id (agent-owned by construction).
    expect(html).toContain("Agency");
  });

  it("empty reads as empty, never an error", async () => {
    stub.jobs = [];
    const html = await render();
    expect(html).toContain("No agency jobs yet.");
  });

  it("a failed read offers retry of this list, never a 500", async () => {
    stub.failure = new Error("outage");
    stub.jobs = null;
    const html = await render();
    expect(html).toMatch(/href="\/jobs\/agency">(<i [^>]*><\/i>)?Retry<\/a>/);
    expect(html).not.toContain("CNC Turner");
  });
});
