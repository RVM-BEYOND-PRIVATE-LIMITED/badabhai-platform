import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostingSummary } from "../../../../../lib/contracts";

/**
 * Edit-posting Server Action tests. The seam is mocked — these pin:
 *  - the uuid gate (neutral not-found, seam untouched);
 *  - server-side re-validation incl. the PII refine on description;
 *  - empty-string optional fields are OMITTED (kept server-side, never sent as "");
 *  - an OMITTED vacancies never reaches the PATCH (the band-downgrade guard);
 *  - 400 → "No changes to save." / 409 → "no longer be edited" / other → retry copy;
 *  - success revalidates BOTH /postings and the detail path.
 */

const updatePosting = vi.fn();
const revalidatePath = vi.fn();

vi.mock("../../../../../lib/payer-api", () => ({
  updatePosting: (id: unknown, input: unknown) => updatePosting(id, input),
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

beforeEach(() => {
  updatePosting.mockReset().mockResolvedValue(POSTING);
  revalidatePath.mockReset();
});

describe("updatePostingAction — validation gates", () => {
  it("an invalid posting uuid returns the neutral not-found without calling the seam", async () => {
    const res = await updatePostingAction({ postingId: "nope", roleTitle: "CNC Machinist" });
    expect(res).toEqual({ ok: false, error: "That posting could not be found." });
    expect(updatePosting).not.toHaveBeenCalled();
  });

  it("a PII-looking description is rejected server-side with the refine message", async () => {
    const res = await updatePostingAction({
      postingId: ID,
      roleTitle: "CNC Machinist",
      description: "Call me at 9876543210",
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
    });
    const [, input] = updatePosting.mock.calls[0] as [string, Record<string, unknown>];
    expect(input).toEqual({ roleTitle: "CNC Machinist" });
    expect(input).not.toHaveProperty("vacancies");
    expect(input).not.toHaveProperty("locationLabel");
    expect(input).not.toHaveProperty("description");
  });
});

describe("updatePostingAction — outcome mapping", () => {
  it("success returns the posting and revalidates the list AND the detail path", async () => {
    const res = await updatePostingAction({ postingId: ID, roleTitle: "CNC Machinist II" });
    expect(res.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/postings");
    expect(revalidatePath).toHaveBeenCalledWith(`/postings/${ID}`);
  });

  it("null (neutral 404) → not-found; 400 → 'No changes'; 409 → 'no longer'; other → retry", async () => {
    updatePosting.mockResolvedValueOnce(null);
    expect(await updatePostingAction({ postingId: ID, roleTitle: "CNC" })).toEqual({
      ok: false,
      error: "That posting could not be found.",
    });

    updatePosting.mockRejectedValueOnce(new Error("payer API x returned 400"));
    expect(await updatePostingAction({ postingId: ID, roleTitle: "CNC" })).toEqual({
      ok: false,
      error: "No changes to save.",
    });

    updatePosting.mockRejectedValueOnce(new Error("payer API x returned 409"));
    expect(await updatePostingAction({ postingId: ID, roleTitle: "CNC" })).toEqual({
      ok: false,
      error: "This posting can no longer be edited.",
    });

    updatePosting.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await updatePostingAction({ postingId: ID, roleTitle: "CNC" })).toEqual({
      ok: false,
      error: "Could not save the changes right now. Please retry.",
    });
  });
});
