import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the agency-jobs list RENDERS (route `/agency-jobs`): the gate, one row
 * per posting with its agency + skill count + detail link, the empty state,
 * and the outage recovery (never a 500).
 */
const stub = vi.hoisted(() => ({
  gates: [] as string[],
  jobs: null as unknown[] | null,
  failure: null as unknown,
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "super_admin", capabilities: ["manage_agency_match_skills"] };
  },
}));

vi.mock("../../../lib/agency-jobs", () => ({
  listAgencyJobs: async () => {
    if (stub.failure) throw stub.failure;
    return stub.jobs;
  },
}));

const { default: AgencyJobsPage } = await import("./page");

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

const render = async () => renderToStaticMarkup(await AgencyJobsPage());

describe("the gate", () => {
  it("is manage_agency_match_skills", async () => {
    await render();
    expect(stub.gates).toEqual(["manage_agency_match_skills"]);
  });
});

describe("the table", () => {
  it("renders one row per job with agency, city, status, skill count and link", async () => {
    const html = await render();
    expect(html).toContain("CNC Turner");
    expect(html).toContain("Ludhiana");
    expect(html).toContain("Live");
    expect(html).toContain("/agency-jobs/11111111-1111-4111-8111-111111111111");
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

  it("a failed read offers retry, never a 500", async () => {
    stub.failure = new Error("outage");
    stub.jobs = null;
    const html = await render();
    expect(html).toContain("Retry");
    expect(html).not.toContain("CNC Turner");
  });
});
