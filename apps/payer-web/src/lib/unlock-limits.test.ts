import { describe, expect, it } from "vitest";
import { mapUnlockResult } from "./unlock-view";

describe("#2750 part D — opening limits", () => {
  it("the weekly answer keeps the button for other workers", () => {
    expect(mapUnlockResult({ status: "worker_unavailable_this_week" })).toEqual({
      kind: "week_limit",
      message: "This worker isn't available this week. Try again in a few days.",
    });
  });
  it("the agency day answer names the server's limit", () => {
    expect(mapUnlockResult({ status: "daily_limit_reached", dailyLimit: 40 })).toEqual({
      kind: "daily_limit",
      dailyLimit: 40,
      message: "You've opened 40 contacts today. You can open more tomorrow.",
    });
  });
});
