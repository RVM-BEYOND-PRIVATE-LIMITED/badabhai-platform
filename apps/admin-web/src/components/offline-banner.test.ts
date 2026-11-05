import { describe, expect, it } from "vitest";
import {
  BACK_ONLINE_MESSAGE,
  OFFLINE_MESSAGE,
  offlineNotice,
} from "./offline-banner";

/** #2689 rule 3 — one band while offline, one "Back online" toast on reconnect. */
describe("offlineNotice", () => {
  it("shows the band when the browser goes offline", () => {
    expect(offlineNotice(false, false)).toEqual({
      offline: true,
      announceBackOnline: false,
    });
  });

  it("stays quiet while still offline", () => {
    expect(offlineNotice(false, true).announceBackOnline).toBe(false);
  });

  it("hides the band and announces once when the connection returns", () => {
    expect(offlineNotice(true, true)).toEqual({
      offline: false,
      announceBackOnline: true,
    });
    expect(offlineNotice(true, false).announceBackOnline).toBe(false);
  });

  it("has calm copy for both states", () => {
    expect(OFFLINE_MESSAGE).toContain("We'll retry");
    expect(BACK_ONLINE_MESSAGE).toBe("Back online.");
  });
});
