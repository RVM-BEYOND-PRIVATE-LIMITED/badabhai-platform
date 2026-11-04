import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * An agency posting's Overview tab (route `/jobs/agency/:jobId`, A6 #2576): the gate, the
 * header and tab row it shares with the Match skills tab, the posting's facts, and not-found for
 * an id the API does not serve. The match skills themselves are the other tab's.
 */
const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    gates: [] as string[],
    job: null as unknown,
    failure: null as unknown,
  };
});

vi.mock("../../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "super_admin", capabilities: ["manage_agency_match_skills"] };
  },
}));

vi.mock("../../../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../../../lib/agency-jobs", () => ({
  getAgencyJobMatchSkills: async () => {
    if (stub.failure) throw stub.failure;
    return stub.job;
  },
}));

const { default: OverviewTab } = await import("./page");

const JOB = {
  job_id: "11111111-1111-4111-8111-111111111111",
  payer_id: "22222222-2222-4222-8222-222222222222",
  title: "CNC Turner",
  city: "Ludhiana",
  status: "live",
  match_skill_ids: ["mskill_cnc_operate", "mskill_vmc_setting"],
  updated_at: "2026-10-01T10:00:00.000Z",
};

const params = { jobId: JOB.job_id };

beforeEach(() => {
  stub.gates.length = 0;
  stub.job = JOB;
  stub.failure = null;
});

const render = async () =>
  renderToStaticMarkup(await OverviewTab({ params: Promise.resolve(params) }));

describe("the gate", () => {
  it("is manage_agency_match_skills — every agency-job read sits on it", async () => {
    await render();
    expect(stub.gates).toEqual(["manage_agency_match_skills"]);
  });
});

describe("the header and tabs", () => {
  it("titles the posting, links back to Agency postings, and marks Overview current", async () => {
    const html = await render();
    expect(html).toContain('<h1 class="page__title">CNC Turner</h1>');
    expect(html).toContain("Agency posting · Ludhiana");
    expect(html).toContain('<a class="backlink" href="/jobs/agency">');
    const tabs = html.slice(html.indexOf('role="group" aria-label="Agency posting"'));
    expect(tabs).toContain('<span aria-current="true" class="btn btn--sm btn--selected">Overview</span>');
    expect(tabs).toContain(`href="/jobs/agency/${JOB.job_id}/match-skills">Match skills`);
  });
});

describe("the facts", () => {
  it("shows the id, the agency (linked as a customer), city, status and the skill count", async () => {
    const html = await render();
    expect(html).toContain(JOB.job_id);
    expect(html).toContain(`title="${JOB.payer_id}"`);
    expect(html).toContain("Agency");
    expect(html).toContain("Ludhiana");
    expect(html).toContain("Live");
    expect(html).toContain("2 chosen");
    // The ids and the editor are the Match skills tab's.
    expect(html).not.toContain("mskill_cnc_operate");
    expect(html).not.toContain("Change selection");
  });

  it("no skills yet reads as such, not as zero of something", async () => {
    stub.job = { ...JOB, match_skill_ids: [] };
    expect(await render()).toContain("None chosen yet");
  });
});

describe("an id the API does not serve", () => {
  it.each([404, 400])("a %i reads as not-found", async (status) => {
    stub.failure = new stub.RequestError(status);
    const err = await OverviewTab({ params: Promise.resolve(params) }).then(
      () => {
        throw new Error("expected the page to throw");
      },
      (e: unknown) => e,
    );
    expect((err as { digest?: string }).digest).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("an outage is not hidden as not-found", async () => {
    stub.failure = new stub.RequestError(503);
    await expect(OverviewTab({ params: Promise.resolve(params) })).rejects.toBe(stub.failure);
  });
});
