import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Agency-job match-skills seam — reads only. The write is exercised through
 * the route's `actions.test.ts` (a Server Action, not this seam). The picker
 * vocabulary schema is pinned by the actions test that reads it.
 */

vi.mock("./auth/session-cookie", () => ({
  readAdminToken: async () => "fake.admin.jwt.value",
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

const VIEW = {
  job_id: "11111111-1111-4111-8111-111111111111",
  payer_id: "22222222-2222-4222-8222-222222222222",
  title: "CNC Turner",
  city: "Ludhiana",
  status: "live",
  match_skill_ids: ["mskill_cnc_operate"],
  updated_at: "2026-10-01T10:00:00.000Z",
};

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function lastUrl(): string {
  const [url] = fetchMock.mock.calls.at(-1)!;
  return String(url);
}

describe("listAgencyJobs", () => {
  it("GETs the bounded list with the default limit", async () => {
    fetchMock.mockResolvedValueOnce(okJson([VIEW]));
    const { listAgencyJobs } = await import("./agency-jobs");
    const out = await listAgencyJobs();
    expect(lastUrl()).toContain("/admin/agency-jobs?limit=50");
    expect(out).toHaveLength(1);
    expect(out[0]!.job_id).toBe(VIEW.job_id);
  });

  it("clamps the limit into the API's 1..100 window", async () => {
    // A fresh Response per call: one object serves its body exactly once.
    fetchMock.mockImplementation(async () => okJson([VIEW]));
    const { listAgencyJobs } = await import("./agency-jobs");
    await listAgencyJobs(5000);
    expect(lastUrl()).toContain("limit=100");
    await listAgencyJobs(-3);
    expect(lastUrl()).toContain("limit=1");
  });

  it("a future status renders — the schema never enums it", async () => {
    fetchMock.mockResolvedValueOnce(okJson([{ ...VIEW, status: "mystery_status" }]));
    const { listAgencyJobs } = await import("./agency-jobs");
    const out = await listAgencyJobs();
    expect(out[0]!.status).toBe("mystery_status");
  });
});

describe("getAgencyJobMatchSkills", () => {
  it("GETs the job's selection by encoded id", async () => {
    fetchMock.mockResolvedValueOnce(okJson(VIEW));
    const { getAgencyJobMatchSkills } = await import("./agency-jobs");
    const out = await getAgencyJobMatchSkills(VIEW.job_id);
    expect(lastUrl()).toContain(`/admin/agency-jobs/${VIEW.job_id}/match-skills`);
    expect(out.match_skill_ids).toEqual(["mskill_cnc_operate"]);
  });
});
