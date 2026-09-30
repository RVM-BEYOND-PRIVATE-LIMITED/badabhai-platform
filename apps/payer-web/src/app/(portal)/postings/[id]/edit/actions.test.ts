import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostingSummary } from "../../../../../lib/contracts";
import type { PostingEditInitial } from "../../../../../lib/payer-api";
import type { UpdatePostingActionInput } from "./actions";

/**
 * Edit-posting Server Action tests (PR-B). The seam is mocked — these pin:
 *  - the uuid gate (neutral not-found, seam untouched);
 *  - server-side re-validation incl. the PII refine on description;
 *  - empty-string optional fields are OMITTED (kept server-side, never sent as "");
 *  - an OMITTED vacancies never reaches the PATCH (the band-downgrade guard);
 *  - `initial` is threaded to the seam (the clear diff), and publish carries the match half;
 *  - the workerCardGap rule BLOCKS a thin publish but NOT a save (owner ruling);
 *  - 400 → "No changes to save." / 409 → "no longer be edited" / other → retry copy.
 */

const updatePosting = vi.fn();
const revalidatePath = vi.fn();

vi.mock("../../../../../lib/payer-api", () => ({
  updatePosting: (id: unknown, input: unknown, options: unknown) => updatePosting(id, input, options),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const { updatePostingAction } = await import("./actions");

const ID = "bbbb2222-0000-4000-8000-000000000001";
const POSTING: PostingSummary = {
  id: ID,
  roleTitle: "CNC Machinist",
  locationLabel: "Pune, MH",
  vacancyBand: "6-10",
  status: "open",
  applicantCount: 0,
  createdAt: "2026-06-22T00:00:00.000Z",
};

const INITIAL: PostingEditInitial = {
  locationLabel: null,
  description: null,
  roleKind: null,
  city: null,
  area: null,
  payMin: null,
  payMax: null,
  payType: null,
  minExperienceYears: null,
  maxExperienceYears: null,
  shift: null,
  neededBy: null,
  requirements: [],
  benefits: [],
};

/** A COMPLETE card — passes the workerCardGap rule (used on the publish path). */
const FULL_CARD: Partial<UpdatePostingActionInput> = {
  roleKind: "cnc_turner",
  city: "Pune",
  payMin: 20000,
  payMax: 35000,
  payType: "in_hand",
  minExperienceYears: 1,
  maxExperienceYears: 5,
  shift: "rotational",
  neededBy: "immediate",
  description: "Two-shift CNC role, PPE provided.",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
};

beforeEach(() => {
  updatePosting.mockReset().mockResolvedValue(POSTING);
  revalidatePath.mockReset();
});

describe("updatePostingAction — validation gates", () => {
  it("an invalid posting uuid returns the neutral not-found without calling the seam", async () => {
    const res = await updatePostingAction({ postingId: "nope", roleTitle: "CNC Machinist", initial: INITIAL });
    expect(res).toEqual({ ok: false, error: "That posting could not be found." });
    expect(updatePosting).not.toHaveBeenCalled();
  });

  it("a PII-looking description is rejected server-side with the refine message", async () => {
    const res = await updatePostingAction({
      postingId: ID,
      roleTitle: "CNC Machinist",
      description: "Call me at 9876543210",
      initial: INITIAL,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Remove contact details/);
    expect(updatePosting).not.toHaveBeenCalled();
  });

  it("empty-string optionals are OMITTED and an omitted vacancies stays omitted (band guard)", async () => {
    await updatePostingAction({
      postingId: ID,
      roleTitle: "CNC Machinist",
      locationLabel: "",
      description: "",
      city: "",
      shift: "",
      neededBy: "",
      initial: INITIAL,
    });
    const [, input] = updatePosting.mock.calls[0] as [string, Record<string, unknown>];
    expect(input).toEqual({ roleTitle: "CNC Machinist" });
    expect(input).not.toHaveProperty("vacancies");
  });

  it("threads `initial` to the seam (the clear diff) as the 3rd argument", async () => {
    await updatePostingAction({ postingId: ID, roleTitle: "CNC Machinist", initial: INITIAL });
    const [, , options] = updatePosting.mock.calls[0] as [string, unknown, { initial: unknown }];
    expect(options.initial).toBe(INITIAL);
  });

  it("the wider card fields are re-validated and threaded to the seam", async () => {
    await updatePostingAction({
      postingId: ID,
      roleTitle: "CNC Machinist",
      roleKind: "cnc_turner",
      city: "Pune",
      payMin: 20000,
      payMax: 35000,
      shift: "rotational",
      neededBy: "immediate",
      initial: INITIAL,
    });
    const [, input] = updatePosting.mock.calls[0] as [string, Record<string, unknown>];
    expect(input).toMatchObject({
      roleTitle: "CNC Machinist",
      roleKind: "cnc_turner",
      city: "Pune",
      payMin: 20000,
      payMax: 35000,
      shift: "rotational",
      neededBy: "immediate",
    });
  });

  it("an off-enum shift is rejected server-side", async () => {
    const res = await updatePostingAction({ postingId: ID, roleTitle: "CNC Machinist", shift: "graveyard", initial: INITIAL });
    expect(res.ok).toBe(false);
    expect(updatePosting).not.toHaveBeenCalled();
  });

  it("an inverted pay band (max < min) is rejected by the server refine", async () => {
    const res = await updatePostingAction({ postingId: ID, roleTitle: "CNC Machinist", payMin: 40000, payMax: 20000, initial: INITIAL });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Max pay/);
    expect(updatePosting).not.toHaveBeenCalled();
  });
});

describe("updatePostingAction — publish (gap rule + skill), save (no block)", () => {
  it("SAVE does NOT block on a thin card (owner ruling — editing a live posting saves)", async () => {
    const res = await updatePostingAction({ postingId: ID, roleTitle: "CNC Machinist", initial: INITIAL });
    expect(res.ok).toBe(true);
    expect(updatePosting).toHaveBeenCalledTimes(1);
  });

  it("PUBLISH BLOCKS a thin card (a live posting must trace to a full card)", async () => {
    const res = await updatePostingAction({
      postingId: ID,
      roleTitle: "CNC Machinist",
      initial: INITIAL,
      publish: { matchSkillIds: ["mskill_cnc_turning"], untickedRelatedIds: [] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Pick the role|Add the city/);
    expect(updatePosting).not.toHaveBeenCalled();
  });

  it("PUBLISH with a FULL card + ≥1 skill threads the match half to the seam", async () => {
    await updatePostingAction({
      postingId: ID,
      roleTitle: "CNC Machinist",
      ...FULL_CARD,
      initial: INITIAL,
      publish: { matchSkillIds: ["mskill_cnc_turning"], untickedRelatedIds: ["mskill_vmc_operating"] },
    });
    const [, , options] = updatePosting.mock.calls[0] as [
      string,
      unknown,
      { publish?: { matchSkillIds: string[]; untickedRelatedIds: string[] } },
    ];
    expect(options.publish).toEqual({
      matchSkillIds: ["mskill_cnc_turning"],
      untickedRelatedIds: ["mskill_vmc_operating"],
    });
  });

  it("PUBLISH with a full card but NO skill is refused (reaches nobody)", async () => {
    const res = await updatePostingAction({
      postingId: ID,
      roleTitle: "CNC Machinist",
      ...FULL_CARD,
      initial: INITIAL,
      publish: { matchSkillIds: [], untickedRelatedIds: [] },
    });
    expect(res.ok).toBe(false);
    expect(updatePosting).not.toHaveBeenCalled();
  });
});

describe("updatePostingAction — outcome mapping", () => {
  it("success returns the posting and revalidates the list AND the detail path", async () => {
    const res = await updatePostingAction({ postingId: ID, roleTitle: "CNC Machinist II", initial: INITIAL });
    expect(res.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/postings");
    expect(revalidatePath).toHaveBeenCalledWith(`/postings/${ID}`);
  });

  it("null (neutral 404) → not-found; 400 → 'No changes'; 409 → 'no longer'; other → retry", async () => {
    updatePosting.mockResolvedValueOnce(null);
    expect(await updatePostingAction({ postingId: ID, roleTitle: "CNC", initial: INITIAL })).toEqual({
      ok: false,
      error: "That posting could not be found.",
    });

    updatePosting.mockRejectedValueOnce(new Error("payer API x returned 400"));
    expect(await updatePostingAction({ postingId: ID, roleTitle: "CNC", initial: INITIAL })).toEqual({
      ok: false,
      error: "No changes to save.",
    });

    updatePosting.mockRejectedValueOnce(new Error("payer API x returned 409"));
    expect(await updatePostingAction({ postingId: ID, roleTitle: "CNC", initial: INITIAL })).toEqual({
      ok: false,
      error: "This posting can no longer be edited.",
    });

    updatePosting.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await updatePostingAction({ postingId: ID, roleTitle: "CNC", initial: INITIAL })).toEqual({
      ok: false,
      error: "Could not save the changes right now. Please retry.",
    });
  });
});
