import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The agency-jobs detail screen's Server Actions (`setAgencyJobMatchSkillsAction`
 * + `readMatchVocabularyAction`). `adminFetch` is replaced with a spy, so what
 * matters here is which request each action actually builds and how it maps a
 * response/error onto the outcome the client renders.
 */

const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  body?: Record<string, unknown>;
  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
    this.body = body;
  }
}

vi.mock("../../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: (e: unknown) => e instanceof FakeRequestError && e.status === 401,
  isAdminForbidden: (e: unknown) => e instanceof FakeRequestError && e.status === 403,
}));

const { setAgencyJobMatchSkillsAction, readMatchVocabularyAction } = await import("./actions");

beforeEach(() => {
  adminFetch.mockReset();
});

const JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("setAgencyJobMatchSkillsAction", () => {
  it("client-errors before any network call on a non-mskill id", async () => {
    const res = await setAgencyJobMatchSkillsAction(JOB_ID, { match_skill_ids: ["welder"] });
    expect(res.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("PUTs the ids and reports a change", async () => {
    adminFetch.mockResolvedValueOnce({
      job_id: JOB_ID,
      match_skill_ids: ["mskill_cnc_operate"],
      changed: true,
    });
    const res = await setAgencyJobMatchSkillsAction(JOB_ID, {
      match_skill_ids: ["mskill_cnc_operate"],
    });
    expect(adminFetch).toHaveBeenCalledWith(
      `/admin/agency-jobs/${JOB_ID}/match-skills`,
      expect.objectContaining({ method: "PUT" }),
    );
    expect(res).toEqual({ ok: true, changed: true, message: "Match skills saved." });
  });

  it("an unchanged selection is success, never an error", async () => {
    adminFetch.mockResolvedValueOnce({
      job_id: JOB_ID,
      match_skill_ids: ["mskill_cnc_operate"],
      changed: false,
    });
    const res = await setAgencyJobMatchSkillsAction(JOB_ID, {
      match_skill_ids: ["mskill_cnc_operate"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(false);
  });

  it("an empty selection clears (sends [])", async () => {
    adminFetch.mockResolvedValueOnce({ job_id: JOB_ID, match_skill_ids: [], changed: true });
    const res = await setAgencyJobMatchSkillsAction(JOB_ID, { match_skill_ids: [] });
    expect(adminFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: { match_skill_ids: [] } }),
    );
    expect(res.ok).toBe(true);
  });

  it("a closed posting renders the server's 400 verbatim", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(400, "Job is closed and cannot be edited"),
    );
    const res = await setAgencyJobMatchSkillsAction(JOB_ID, {
      match_skill_ids: ["mskill_cnc_operate"],
    });
    expect(res).toEqual({ ok: false, error: "Job is closed and cannot be edited" });
  });

  it("an unknown id renders the server's 404 verbatim", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404, "Job not found"));
    const res = await setAgencyJobMatchSkillsAction(JOB_ID, {
      match_skill_ids: ["mskill_cnc_operate"],
    });
    expect(res).toEqual({ ok: false, error: "Job not found" });
  });

  it("a 403 renders the denied copy, a 5xx the neutral copy", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(403, "Forbidden"));
    await expect(
      setAgencyJobMatchSkillsAction(JOB_ID, { match_skill_ids: ["mskill_cnc_operate"] }),
    ).resolves.toEqual({ ok: false, error: "Your role no longer has permission to do that." });
    adminFetch.mockRejectedValueOnce(new FakeRequestError(500, "boom"));
    await expect(
      setAgencyJobMatchSkillsAction(JOB_ID, { match_skill_ids: ["mskill_cnc_operate"] }),
    ).resolves.toEqual({
      ok: false,
      error: "The admin API is unreachable or returned an error. Try again.",
    });
  });
});

describe("readMatchVocabularyAction", () => {
  it("GETs the vocabulary and returns it", async () => {
    const vocabulary = {
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
    adminFetch.mockResolvedValueOnce(vocabulary);
    await expect(readMatchVocabularyAction()).resolves.toEqual({ ok: true, vocabulary });
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/match/skills",
      expect.objectContaining({}),
    );
  });

  it("an unreadable vocabulary degrades to ok:false (the editor is withheld)", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(404, "Not found"));
    await expect(readMatchVocabularyAction()).resolves.toEqual({ ok: false });
  });
});
