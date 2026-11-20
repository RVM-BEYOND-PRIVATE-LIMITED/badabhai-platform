import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * previewReachAction — #2635: a COMPANY form's trade rides the reach preview as `roleKind`, so the
 * figure scopes the posted skills as publish will. It is re-validated against the closed role set
 * here (the boundary); an agency form sends none and its read is unchanged.
 */

const previewReach = vi.fn();
vi.mock("../../../../lib/payer-api", () => ({
  previewReach: (input: unknown) => previewReach(input),
}));

const { previewReachAction } = await import("./match-actions");

const SELECTION = { matchSkillIds: ["mskill_cnc_turner"], untickedRelatedIds: [] as string[] };
const PREVIEW = { reach_total: 7 };

beforeEach(() => previewReach.mockReset().mockResolvedValue(PREVIEW));

describe("previewReachAction — the trade scope (#2635)", () => {
  it("forwards a company job's trade with the selection", async () => {
    const res = await previewReachAction({ ...SELECTION, roleKind: "cnc_turner" });
    expect(res).toEqual({ ok: true, preview: PREVIEW });
    expect(previewReach).toHaveBeenCalledWith({ ...SELECTION, roleKind: "cnc_turner" });
  });

  it("without one (an agency form) the read carries no role", async () => {
    await previewReachAction(SELECTION);
    expect(previewReach).toHaveBeenCalledWith(SELECTION);
    expect(previewReach.mock.calls[0]![0]).not.toHaveProperty("roleKind");
  });

  it("a role outside the closed set is refused before the wire", async () => {
    const res = await previewReachAction({ ...SELECTION, roleKind: "rocket_surgeon" });
    expect(res).toEqual({ ok: false, error: "Could not check reach right now. Please retry." });
    expect(previewReach).not.toHaveBeenCalled();
  });

  it("no skill is still the selection's own refusal", async () => {
    const res = await previewReachAction({ matchSkillIds: [], untickedRelatedIds: [], roleKind: "cnc_turner" });
    expect(res.ok).toBe(false);
    expect(previewReach).not.toHaveBeenCalled();
  });
});
