import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/payer-api", () => ({
  draftJobDescription: vi.fn(),
}));

import { draftJobDescription } from "../../../lib/payer-api";
import { draftDescriptionAction } from "./voice-description-action";

const draftJobDescriptionMock = vi.mocked(draftJobDescription);

describe("draftDescriptionAction (#2720)", () => {
  beforeEach(() => {
    draftJobDescriptionMock.mockReset();
  });

  it("sends the transcript and the Step-1 trade/role labels", async () => {
    draftJobDescriptionMock.mockResolvedValue({
      description: "Operate CNC machines on the night shift.",
      isMock: false,
    });

    const result = await draftDescriptionAction({
      spokenText: "raat ki shift mein CNC machine chalani hai",
      tradeLabel: "CNC Turner",
      roleLabel: "Senior CNC Operator",
    });

    expect(result).toEqual({
      ok: true,
      description: "Operate CNC machines on the night shift.",
      isMock: false,
    });
    expect(draftJobDescriptionMock).toHaveBeenCalledWith({
      spokenText: "raat ki shift mein CNC machine chalani hai",
      tradeLabel: "CNC Turner",
      roleLabel: "Senior CNC Operator",
    });
  });

  it("passes a null draft through — the poster's text stands", async () => {
    draftJobDescriptionMock.mockResolvedValue({ description: null, isMock: true });

    const result = await draftDescriptionAction({ spokenText: "kuch bhi" });

    expect(result).toEqual({ ok: true, description: null, isMock: true });
    expect(draftJobDescriptionMock).toHaveBeenCalledWith({ spokenText: "kuch bhi" });
  });

  it("refuses a blank or over-long transcript before any API call", async () => {
    const blank = await draftDescriptionAction({ spokenText: "   " });
    const overlong = await draftDescriptionAction({ spokenText: "a".repeat(2001) });

    expect(blank.ok).toBe(false);
    expect(overlong.ok).toBe(false);
    expect(draftJobDescriptionMock).not.toHaveBeenCalled();
  });

  it("fails closed with honest copy when the API throws", async () => {
    draftJobDescriptionMock.mockRejectedValue(new Error("boom"));

    const result = await draftDescriptionAction({ spokenText: "welding ka kaam" });

    expect(result).toEqual({
      ok: false,
      error: "Could not draft the description. Try again.",
    });
  });
});
