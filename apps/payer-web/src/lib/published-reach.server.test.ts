import { beforeEach, describe, expect, it, vi } from "vitest";

const previewReach = vi.fn();
vi.mock("./payer-api", () => ({ previewReach: (input: unknown) => previewReach(input) }));

const { reachAfterPublish } = await import("./published-reach.server");

const SELECTION = { matchSkillIds: ["mskill_cnc_turning"], untickedRelatedIds: ["mskill_vmc"] };

describe("reachAfterPublish", () => {
  beforeEach(() => previewReach.mockReset());

  it("is reach-preview's reach_total for the published selection", async () => {
    previewReach.mockResolvedValueOnce({ reach_total: 37, zero_reach: false });
    await expect(reachAfterPublish(SELECTION)).resolves.toBe(37);
    expect(previewReach).toHaveBeenCalledWith(SELECTION);
  });

  it("a failed read is null — the posting is live, the confirmation just shows no count", async () => {
    previewReach.mockRejectedValueOnce(new Error("503"));
    await expect(reachAfterPublish(SELECTION)).resolves.toBeNull();
  });
});
