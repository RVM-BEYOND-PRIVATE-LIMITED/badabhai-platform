import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayerBadRequestError } from "../../../../lib/payer-errors";

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
  it("a published posting returns reach-preview's total for the SAME selection, scoped by its trade", async () => {
    const res = await createPostingAction(INPUT);
    expect(res).toEqual({ ok: true, postingId: POSTING_ID, published: true, reached: 18 });
    // #2635 — the confirmation's read scopes the posted skills by the job's trade, as publish did.
    expect(previewReach).toHaveBeenCalledWith({ ...SELECTION, roleKind: "cnc_turner" });
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

describe("createPostingAction — #2645: a company job is always one of the 16 trades", () => {
  it("no trade is refused AT the picker before anything is created", async () => {
    const res = await createPostingAction({ ...INPUT, roleKind: "" });
    expect(res).toEqual({
      ok: false,
      error: "Pick one of the 16 trades",
      fieldErrors: { roleKind: "Pick one of the 16 trades" },
    });
    expect(createPosting).not.toHaveBeenCalled();
    expect(publishPostingWithMatchSkills).not.toHaveBeenCalled();
  });

  it("the create always carries the trade form — {} when no chip was picked", async () => {
    await createPostingAction(INPUT);
    const created = createPosting.mock.calls[0]![0] as { roleKind?: unknown; tradeAnswers?: unknown };
    expect(created.roleKind).toBe("cnc_turner");
    // Strictly `{}`: `toMatchObject({ tradeAnswers: {} })` also passes for a key holding undefined —
    // and a create without trade answers takes the API's pre-0141 path (the client's skill ids).
    expect(created.tradeAnswers).toStrictEqual({});
    await createPostingAction({ ...INPUT, tradeLevel: "setter", tradeAnswers: { x_y: ["a_b"] } });
    expect(createPosting.mock.calls[1]![0]).toMatchObject({
      tradeLevel: "setter",
      tradeAnswers: { x_y: ["a_b"] },
    });
  });

  it("a publish refused with posting_trade_required reports the draft AND the refusal", async () => {
    publishPostingWithMatchSkills.mockRejectedValueOnce(
      new PayerBadRequestError("/payer/job-postings/x", "posting_trade_required"),
    );
    const res = await createPostingAction(INPUT);
    expect(res).toEqual({
      ok: true,
      postingId: POSTING_ID,
      published: false,
      reached: null,
      tradeRequired: true,
    });
    expect(previewReach).not.toHaveBeenCalled();
  });

  it("any other refused publish is a plain draft — the reason, not the status, decides", async () => {
    publishPostingWithMatchSkills.mockRejectedValueOnce(
      new PayerBadRequestError("/payer/job-postings/x", "something_else"),
    );
    const res = await createPostingAction(INPUT);
    expect(res).toEqual({ ok: true, postingId: POSTING_ID, published: false, reached: null });
  });
});
