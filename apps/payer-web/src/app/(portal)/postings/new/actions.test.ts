import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * createPostingAction — the "Reached N workers" half (demo liveness). The create → publish
 * contract itself is pinned by the seam tests; these pin only that a SUCCESSFUL publish reads
 * reach-preview with the SAME selection, and that nothing else ever claims a count.
 */

const createPosting = vi.fn();
const publishPostingWithMatchSkills = vi.fn();
const previewReach = vi.fn();

vi.mock("../../../../lib/payer-api", () => ({
  createPosting: (input: unknown) => createPosting(input),
  publishPostingWithMatchSkills: (id: unknown, sel: unknown) => publishPostingWithMatchSkills(id, sel),
  previewReach: (input: unknown) => previewReach(input),
}));

const { createPostingAction } = await import("./actions");

const POSTING_ID = "cccc3333-0000-4000-8000-000000000001";
const SELECTION = { matchSkillIds: ["mskill_cnc_turning"], untickedRelatedIds: [] as string[] };
const INPUT = {
  roleKind: "cnc_turner",
  roleTitle: "CNC Machinist",
  locationLabel: "",
  description: "Two-shift CNC role, PPE provided.",
  vacancies: 3,
  city: "Pune",
  area: "Chakan",
  payMin: 20000,
  payMax: 35000,
  payType: "in_hand",
  minExperienceYears: 1,
  maxExperienceYears: 5,
  shift: "rotational",
  neededBy: "immediate",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
  ...SELECTION,
};

beforeEach(() => {
  createPosting.mockReset().mockResolvedValue({ id: POSTING_ID });
  publishPostingWithMatchSkills.mockReset().mockResolvedValue({ id: POSTING_ID, status: "open" });
  previewReach.mockReset().mockResolvedValue({ reach_total: 18 });
});

describe("createPostingAction — Reached N workers", () => {
  it("a published posting returns reach-preview's total for the SAME selection", async () => {
    const res = await createPostingAction(INPUT);
    expect(res).toEqual({ ok: true, postingId: POSTING_ID, published: true, reached: 18 });
    expect(previewReach).toHaveBeenCalledWith(SELECTION);
  });

  it("a publish that left a draft claims no reach (and never reads it)", async () => {
    publishPostingWithMatchSkills.mockResolvedValueOnce(null);
    const res = await createPostingAction(INPUT);
    expect(res).toEqual({ ok: true, postingId: POSTING_ID, published: false, reached: null });
    expect(previewReach).not.toHaveBeenCalled();
  });

  it("a failed publish is still reported as a draft, with no count", async () => {
    publishPostingWithMatchSkills.mockRejectedValueOnce(new Error("down"));
    const res = await createPostingAction(INPUT);
    expect(res).toEqual({ ok: true, postingId: POSTING_ID, published: false, reached: null });
  });

  it("a failed reach read keeps the publish a success with no count (never a fabricated 0)", async () => {
    previewReach.mockRejectedValueOnce(new Error("503"));
    const res = await createPostingAction(INPUT);
    expect(res).toEqual({ ok: true, postingId: POSTING_ID, published: true, reached: null });
  });
});
