import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the agency-job detail RENDERS (route `/agency-jobs/:jobId`): the gate,
 * the posting facts, the current selection with labels, and exactly one of —
 * the editor, the closed notice, or the vocabulary-unavailable notice. The
 * client form itself is stubbed (its rendering is pinned in
 * `match-skill-form.render.test.tsx`); 404/400 read as not-found.
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
    vocabulary: null as unknown,
  };
});

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gates.push(capability);
    return { adminId: "a-1", role: "super_admin", capabilities: ["manage_agency_match_skills"] };
  },
}));

vi.mock("../../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../../lib/agency-jobs", () => ({
  getAgencyJobMatchSkills: async () => {
    if (stub.failure) throw stub.failure;
    return stub.job;
  },
}));

vi.mock("./actions", () => ({
  readMatchVocabularyAction: async () =>
    stub.vocabulary === null ? { ok: false as const } : { ok: true as const, vocabulary: stub.vocabulary },
}));

vi.mock("./match-skill-form", () => ({
  // Rendered for real in match-skill-form.render.test.tsx (it calls
  // useRouter, which has no context in this renderer).
  MatchSkillForm: () => null,
}));

const { default: AgencyJobDetailPage } = await import("./page");

const JOB = {
  job_id: "11111111-1111-4111-8111-111111111111",
  payer_id: "22222222-2222-4222-8222-222222222222",
  title: "CNC Turner",
  city: "Ludhiana",
  status: "live",
  match_skill_ids: ["mskill_cnc_operate"],
  updated_at: "2026-10-01T10:00:00.000Z",
};

const VOCABULARY = {
  skills: [
    {
      skill_id: "mskill_cnc_operate",
      label: "CNC operating",
      industry_id: "ind_manufacturing",
      related_skill_ids: [],
    },
  ],
  max_skills_per_posting: 5,
};

const params = { jobId: JOB.job_id };

beforeEach(() => {
  stub.gates.length = 0;
  stub.job = JOB;
  stub.failure = null;
  stub.vocabulary = VOCABULARY;
});

const render = async () =>
  renderToStaticMarkup(await AgencyJobDetailPage({ params: Promise.resolve(params) }));

describe("the gate", () => {
  it("is manage_agency_match_skills", async () => {
    await render();
    expect(stub.gates).toEqual(["manage_agency_match_skills"]);
  });
});

describe("the detail", () => {
  it("renders the posting facts and the current selection with labels", async () => {
    const html = await render();
    expect(html).toContain("CNC Turner");
    expect(html).toContain("Ludhiana");
    expect(html).toContain("Live");
    expect(html).toContain("CNC operating");
    expect(html).toContain("mskill_cnc_operate");
  });

  it("a closed posting shows the terminal notice and no editor", async () => {
    stub.job = { ...JOB, status: "closed" };
    const html = await render();
    expect(html).toContain("cannot be changed on a closed posting");
  });

  it("without the vocabulary the editor is withheld, the selection stays", async () => {
    stub.vocabulary = null;
    const html = await render();
    expect(html).toContain("could not be loaded");
    expect(html).toContain("CNC Turner");
  });

  it("an unknown id reads as not-found", async () => {
    stub.failure = new stub.RequestError(404);
    const { default: AgencyJobDetailPageFn } = await import("./page");
    const err = await AgencyJobDetailPageFn({
      params: Promise.resolve(params),
    }).then(
      () => {
        throw new Error("expected the page to throw");
      },
      (e: unknown) => e,
    );
    expect((err as { digest?: string }).digest).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("a malformed id reads as not-found, not an outage", async () => {
    stub.failure = new stub.RequestError(400);
    const { default: AgencyJobDetailPageFn } = await import("./page");
    const err = await AgencyJobDetailPageFn({
      params: Promise.resolve(params),
    }).then(
      () => {
        throw new Error("expected the page to throw");
      },
      (e: unknown) => e,
    );
    expect((err as { digest?: string }).digest).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});
